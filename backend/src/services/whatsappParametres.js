const { lireConfigs, upsertConfig } = require('./whatsapp');

/*
 * Paramètres du CRM WhatsApp (onglet « Paramètres CRM » de
 * /admin/api-liaison/configuration) : clés ortalog_whatsapp_crm_* de
 * delevery_configs, une ligne par clé (upsertConfig). Lus par les actions
 * automatiques (heures calmes, expiration de la file), la boîte de réception
 * (accusé de lecture Meta, auto-affectation, réponse automatique, mots-clés
 * d'opt-out) et la file d'envoi. Cache de 60 s, invalidé à l'enregistrement.
 */

const KEYS = {
  automatisationsActif: 'ortalog_whatsapp_crm_automatisations_actif',
  calmeActif: 'ortalog_whatsapp_crm_calme_actif',
  calmeDebut: 'ortalog_whatsapp_crm_calme_debut',
  calmeFin: 'ortalog_whatsapp_crm_calme_fin',
  marquerLu: 'ortalog_whatsapp_crm_marquer_lu',
  autoAffectation: 'ortalog_whatsapp_crm_auto_affectation',
  autoReponseActif: 'ortalog_whatsapp_crm_auto_reponse_actif',
  autoReponseTexte: 'ortalog_whatsapp_crm_auto_reponse_texte',
  optOutMots: 'ortalog_whatsapp_crm_opt_out_mots',
  expirationHeures: 'ortalog_whatsapp_crm_expiration_heures'
};

const DEFAUT = {
  automatisationsActif: true,
  calmeActif: true,
  calmeDebut: '21:00',
  calmeFin: '08:00',
  marquerLu: true,
  autoAffectation: true,
  autoReponseActif: false,
  autoReponseTexte:
    'Bonjour, nous avons bien reçu votre message. Un conseiller ORTALOG vous répondra dès que possible.',
  optOutMots: ['STOP', 'ARRET', 'ARRÊT', 'DESABONNER', 'DÉSABONNER'],
  expirationHeures: 48
};

const HEURE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const AUTO_REPONSE_MAX = 1000;
const CACHE_MS = 60 * 1000;

let cache = null;
let cacheExpire = 0;

function bool(raw, defaut) {
  if (raw === '') return defaut;
  return raw === '1' || raw === 'true';
}

/** Paramètres courants (défauts pour les clés absentes). */
async function lireParametresCrm() {
  const now = Date.now();
  if (cache && now < cacheExpire) return cache;
  const byVar = await lireConfigs(Object.values(KEYS));
  const raw = {};
  for (const [field, key] of Object.entries(KEYS)) raw[field] = byVar[key] || '';
  const mots = raw.optOutMots
    ? raw.optOutMots.split(',').map((m) => m.trim()).filter(Boolean)
    : DEFAUT.optOutMots;
  const expiration = Number(raw.expirationHeures);
  cache = {
    automatisationsActif: bool(raw.automatisationsActif, DEFAUT.automatisationsActif),
    calmeActif: bool(raw.calmeActif, DEFAUT.calmeActif),
    calmeDebut: HEURE_RE.test(raw.calmeDebut) ? raw.calmeDebut : DEFAUT.calmeDebut,
    calmeFin: HEURE_RE.test(raw.calmeFin) ? raw.calmeFin : DEFAUT.calmeFin,
    marquerLu: bool(raw.marquerLu, DEFAUT.marquerLu),
    autoAffectation: bool(raw.autoAffectation, DEFAUT.autoAffectation),
    autoReponseActif: bool(raw.autoReponseActif, DEFAUT.autoReponseActif),
    autoReponseTexte: raw.autoReponseTexte || DEFAUT.autoReponseTexte,
    optOutMots: mots,
    expirationHeures: Number.isFinite(expiration) && expiration > 0 ? Math.min(expiration, 720) : DEFAUT.expirationHeures
  };
  cacheExpire = now + CACHE_MS;
  return cache;
}

/**
 * Valide et enregistre les champs fournis (undefined = inchangé).
 * Renvoie { erreurs: [] } ou lève ; les erreurs de validation sont renvoyées
 * sous forme de tableau de messages.
 */
async function enregistrerParametresCrm(body) {
  const erreurs = [];
  const champs = {};
  for (const f of ['automatisationsActif', 'calmeActif', 'marquerLu', 'autoAffectation', 'autoReponseActif']) {
    if (body[f] !== undefined) champs[f] = body[f] ? '1' : '0';
  }
  for (const f of ['calmeDebut', 'calmeFin']) {
    if (body[f] === undefined) continue;
    const v = String(body[f] ?? '').trim();
    if (!HEURE_RE.test(v)) erreurs.push(`Heure invalide pour « ${f === 'calmeDebut' ? 'début' : 'fin'} » (format HH:MM).`);
    else champs[f] = v;
  }
  if (body.autoReponseTexte !== undefined) {
    const v = String(body.autoReponseTexte ?? '').trim();
    if (v.length > AUTO_REPONSE_MAX) erreurs.push(`Réponse automatique trop longue (max ${AUTO_REPONSE_MAX} caractères).`);
    else champs.autoReponseTexte = v;
  }
  if (body.optOutMots !== undefined) {
    const liste = Array.isArray(body.optOutMots) ? body.optOutMots : String(body.optOutMots ?? '').split(',');
    const mots = [...new Set(liste.map((m) => String(m).trim().toUpperCase()).filter(Boolean))].slice(0, 30);
    if (mots.some((m) => m.length > 30)) erreurs.push('Mot-clé d’opt-out trop long (max 30 caractères).');
    else champs.optOutMots = mots.join(',');
  }
  if (body.expirationHeures !== undefined) {
    const n = Number(body.expirationHeures);
    if (!Number.isInteger(n) || n < 1 || n > 720) erreurs.push('Expiration de la file : entre 1 et 720 heures.');
    else champs.expirationHeures = String(n);
  }
  if (erreurs.length) return { erreurs };
  for (const [field, value] of Object.entries(champs)) await upsertConfig(KEYS[field], value);
  invaliderParametresCrm();
  return { erreurs: [] };
}

function invaliderParametresCrm() {
  cache = null;
  cacheExpire = 0;
}

function minutesDe(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Nombre de secondes à attendre pour sortir de la plage calme à partir de
 * `date` (0 si hors plage ou plage désactivée). Plage à cheval sur minuit
 * gérée (ex. 21:00 → 08:00).
 */
function secondesAvantFinCalme(date, params) {
  if (!params.calmeActif) return 0;
  const debut = minutesDe(params.calmeDebut);
  const fin = minutesDe(params.calmeFin);
  if (debut === fin) return 0;
  const m = date.getHours() * 60 + date.getMinutes();
  let attenteMinutes = 0;
  if (debut > fin) {
    if (m >= debut) attenteMinutes = 1440 - m + fin;
    else if (m < fin) attenteMinutes = fin - m;
  } else if (m >= debut && m < fin) attenteMinutes = fin - m;
  if (!attenteMinutes) return 0;
  return attenteMinutes * 60 - date.getSeconds();
}

/** Normalisation d'un texte pour la détection des mots-clés (majuscules, sans accents). */
function normaliserMotCle(texte) {
  return String(texte || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}

/** Vrai si le texte entrant est un mot-clé d'opt-out (message court, mot seul). */
function estOptOut(texte, params) {
  const t = normaliserMotCle(texte).replace(/[.!?\s]+$/g, '');
  if (!t || t.length > 30) return false;
  return params.optOutMots.some((m) => normaliserMotCle(m) === t);
}

module.exports = {
  DEFAUT,
  lireParametresCrm,
  enregistrerParametresCrm,
  invaliderParametresCrm,
  secondesAvantFinCalme,
  estOptOut
};
