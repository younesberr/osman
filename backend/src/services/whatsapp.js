const crypto = require('crypto');
const pool = require('../config/db');
const { isSecretKeyConfigured, decryptSecret, maskSecret } = require('../utils/secrets');
const { crmDisponible } = require('../utils/whatsappSchema');

/*
 * Service WhatsApp Business Cloud API (Meta Graph API) — menu admin
 * « API liaison » (service API_LIAISON, fonctions 1 et 2).
 *
 * - Configuration : clés ortalog_whatsapp_* de delevery_configs (une ligne par
 *   clé, même idiome que platform.controller.js). Le jeton d'accès et la clé
 *   secrète de l'app sont chiffrés (utils/secrets.js) et jamais renvoyés en clair.
 * - Appels Meta : fetch natif de Node (24.x déclaré dans package.json) avec un
 *   délai de 15 s ; aucune dépendance. Le jeton n'apparaît jamais dans les logs.
 * - Journal : table delevery_whatsapp_message (sql/2026-09-05_whatsapp-journal.sql,
 *   colonnes CRM ajoutées par sql/2026-09-13_whatsapp-crm.sql).
 * - Envoi en trois temps : preparerEnvoi() (validation + payload) →
 *   journaliserSortant() (ligne du journal) → executerEnvoi() (appel Meta +
 *   statut). envoyerWhatsApp() enchaîne les trois (tests, boîte de réception) ;
 *   planifierEnvoi() ne fait que les deux premiers avec le statut 'planifie' :
 *   la file jobs/whatsappFile.js exécute l'envoi (actions automatiques).
 * - Webhook : accusés sent/delivered/read/failed, messages entrants (→ CRM :
 *   services/whatsappConversations.js) et statut des modèles
 *   (services/whatsappModeles.js). Les modules CRM sont chargés paresseusement
 *   pour éviter les cycles de require.
 */

const GRAPH_URL = 'https://graph.facebook.com';
/** Version courante de la Graph API (vérifiée le 2026-09-05) ; modifiable dans la page. */
const API_VERSION_DEFAUT = 'v26.0';
const API_VERSION_RE = /^v\d{1,2}\.\d{1,2}$/;
const TIMEOUT_MS = 15000;
const TIMEOUT_MEDIA_MS = 30000;
/** Taille maximale d'un média entrant téléchargé (Meta : 5 Mo image, 16 Mo audio/vidéo, 100 Mo document). */
const MEDIA_MAX_OCTETS = 20 * 1024 * 1024;
const WEBHOOK_PATH = '/api/whatsapp/webhook';
/** Modèle pré-approuvé fourni par Meta avec le numéro de test. */
const TEMPLATE_TEST = { nom: 'hello_world', langue: 'en_US' };
const TEXTE_MAX = 4096;
const LEGENDE_MAX = 1024;

const KEYS = {
  actif: 'ortalog_whatsapp_actif',
  phoneNumberId: 'ortalog_whatsapp_phone_number_id',
  wabaId: 'ortalog_whatsapp_waba_id',
  apiVersion: 'ortalog_whatsapp_api_version',
  accessToken: 'ortalog_whatsapp_access_token',
  appSecret: 'ortalog_whatsapp_app_secret',
  verifyToken: 'ortalog_whatsapp_verify_token',
  testPhone: 'ortalog_whatsapp_test_phone',
  dernierTest: 'ortalog_whatsapp_dernier_test',
  webhookVerifieLe: 'ortalog_whatsapp_webhook_verifie_le'
};
const SECRET_FIELDS = ['accessToken', 'appSecret'];

/** Erreur renvoyée par Meta (ou réseau) déjà traduite en français. */
class MetaApiError extends Error {
  constructor(message, { metaCode = null, details = null, fbtrace = null, http = 502 } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.metaCode = metaCode;
    this.details = details;
    this.fbtrace = fbtrace;
    this.http = http;
  }
}

/* ------------------------------------------------------------------ */
/* Configuration (delevery_configs)                                    */
/* ------------------------------------------------------------------ */

/** Valeurs de plusieurs clés de delevery_configs : { configs_var: valeur ('' si absente) }. */
async function lireConfigs(vars) {
  if (!vars.length) return {};
  const [rows] = await pool.query(
    'SELECT configs_var, configs_val FROM delevery_configs WHERE configs_var IN (?)',
    [vars]
  );
  const byVar = {};
  for (const v of vars) byVar[v] = '';
  for (const r of rows) byVar[r.configs_var] = r.configs_val == null ? '' : String(r.configs_val);
  return byVar;
}

async function readRaw() {
  const byVar = await lireConfigs(Object.values(KEYS));
  const raw = {};
  for (const [field, key] of Object.entries(KEYS)) raw[field] = byVar[key] || '';
  return raw;
}

/** Insère ou met à jour une clé (la table n'a pas d'index unique sur configs_var). */
async function upsertConfig(key, value) {
  const [rows] = await pool.query(
    'SELECT configs_id FROM delevery_configs WHERE configs_var = ? ORDER BY configs_id LIMIT 1',
    [key]
  );
  if (rows.length) {
    await pool.query('UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?', [value, rows[0].configs_id]);
  } else {
    await pool.query('INSERT INTO delevery_configs (configs_var, configs_val) VALUES (?, ?)', [key, value]);
  }
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** non_configure | inactif | pret — « pret » = identifiants complets ET interrupteur activé. */
function computeEtat(cfg) {
  const complet = cfg.phoneNumberId && cfg.accessToken.defini && cfg.accessToken.dechiffrable;
  if (!complet) return 'non_configure';
  return cfg.actif ? 'pret' : 'inactif';
}

/**
 * Configuration courante. Les secrets sont décrits ({ defini, masque,
 * dechiffrable }) ; avec { avecSecrets: true }, les clairs sont ajoutés dans
 * accessTokenClair / appSecretClair — usage interne uniquement, jamais renvoyés.
 */
async function lireConfiguration({ avecSecrets = false } = {}) {
  const raw = await readRaw();
  const cfg = {
    secretKeyConfigured: isSecretKeyConfigured(),
    actif: raw.actif === '1',
    phoneNumberId: raw.phoneNumberId,
    wabaId: raw.wabaId,
    apiVersion: API_VERSION_RE.test(raw.apiVersion) ? raw.apiVersion : API_VERSION_DEFAUT,
    verifyToken: raw.verifyToken,
    testPhone: raw.testPhone,
    dernierTest: parseJson(raw.dernierTest),
    webhookVerifieLe: raw.webhookVerifieLe || null
  };
  for (const field of SECRET_FIELDS) {
    const stored = raw[field];
    const clair = stored ? decryptSecret(stored) : '';
    cfg[field] = {
      defini: Boolean(stored),
      masque: clair ? maskSecret(clair) : '',
      dechiffrable: !stored || clair !== null
    };
    if (avecSecrets) cfg[`${field}Clair`] = clair || '';
  }
  cfg.etat = computeEtat(cfg);
  return cfg;
}

/** Enregistre les champs fournis (undefined = inchangé ; les secrets arrivent déjà chiffrés, '' = effacé). */
async function enregistrerConfiguration(champs) {
  for (const [field, value] of Object.entries(champs)) {
    if (value === undefined || !KEYS[field]) continue;
    await upsertConfig(KEYS[field], value === null ? '' : String(value));
  }
}

async function enregistrerDernierTest(info) {
  await upsertConfig(KEYS.dernierTest, JSON.stringify(info));
}

async function marquerWebhookVerifie() {
  await upsertConfig(KEYS.webhookVerifieLe, new Date().toISOString());
}

/* ------------------------------------------------------------------ */
/* Numéros                                                             */
/* ------------------------------------------------------------------ */

/**
 * Numéro marocain → format Meta (E.164 sans « + ») : "06 12 34 56 78",
 * "+212612345678", "00212612345678", "212612345678" → "212612345678".
 * null si le format n'est pas reconnu.
 */
function toE164Maroc(value) {
  let d = String(value || '').replace(/[\s.\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (/^0\d{9}$/.test(d)) return `212${d.slice(1)}`;
  if (/^212\d{9}$/.test(d)) return d;
  return null;
}

/* ------------------------------------------------------------------ */
/* Erreurs Meta                                                        */
/* ------------------------------------------------------------------ */

const ERREURS_META = {
  190: "Jeton d'accès invalide ou expiré. Un jeton temporaire ne dure que 24 h : générez un jeton permanent (utilisateur système, Guide étape 6) et enregistrez-le de nouveau.",
  200: 'Permissions insuffisantes pour ce jeton (whatsapp_business_messaging et whatsapp_business_management requises).',
  10: 'Permissions insuffisantes pour ce jeton (whatsapp_business_messaging et whatsapp_business_management requises).',
  100: "Paramètre invalide (#100) : vérifiez le Phone Number ID, la version de l'API et le format du numéro (ex. 212612345678).",
  131030: "Numéro destinataire non autorisé : avec un numéro de test Meta, ajoutez d'abord ce numéro (max 5) dans « API Setup › À (To) » de l'espace développeur et validez le code reçu.",
  132001: 'Modèle introuvable ou non approuvé pour cette langue (ex. hello_world / en_US).',
  132000: 'Paramètres du modèle incorrects (nombre de variables différent de celui du modèle).',
  132012: "Paramètres du modèle incorrects (format d'une variable : pas de retour à la ligne ni d'espaces multiples).",
  132015: 'Modèle suspendu par Meta (qualité insuffisante).',
  132016: 'Modèle désactivé par Meta (qualité insuffisante).',
  130429: 'Limite de débit Meta atteinte : réessayez dans quelques instants.',
  4: 'Limite de débit Meta atteinte : réessayez dans quelques instants.',
  80007: 'Limite de débit Meta atteinte : réessayez dans quelques instants.',
  131056: 'Trop de messages envoyés au même numéro en peu de temps : patientez quelques secondes.',
  131026: "Message non délivrable : le numéro n'est pas sur WhatsApp, ou sa version / ses paramètres de confidentialité le bloquent.",
  131047: 'Fenêtre de 24 h expirée : seul un message modèle approuvé peut être envoyé à ce destinataire.',
  131048: 'Envoi bloqué par Meta : limite de messages atteinte (qualité du numéro).',
  131049: "Envoi bloqué par Meta pour préserver l'engagement des utilisateurs.",
  131050: 'Le destinataire a demandé à ne plus recevoir de messages marketing.',
  131021: 'Expéditeur et destinataire identiques.',
  133010: "Numéro non enregistré sur la plateforme WhatsApp Business (à enregistrer dans l'espace développeur).",
  131045: "Numéro non enregistré : erreur de certificat / d'enregistrement du numéro chez Meta.",
  131042: 'Problème de moyen de paiement sur le compte WhatsApp Business (WhatsApp Manager › Paramètres).',
  131031: 'Compte WhatsApp Business restreint ou désactivé par Meta.',
  368: 'Compte temporairement bloqué par Meta pour non-respect des règles.',
  131016: 'Service Meta temporairement indisponible : réessayez.',
  131000: 'Erreur interne Meta : réessayez.',
  131053: 'Média refusé par Meta (format ou taille non pris en charge).',
  131052: 'Téléchargement du média impossible chez Meta.'
};

/** Codes Meta pour lesquels un nouvel essai a un sens (file d'envoi). */
const CODES_TEMPORAIRES = new Set([130429, 4, 80007, 131056, 131016, 131000]);

/** Message français pour un objet erreur Meta ({ code, message, error_data… }). */
function mapErreurMeta(error) {
  const code = Number(error?.code);
  const details = error?.error_data?.details;
  const base = ERREURS_META[code];
  if (base) return details ? `${base} (${details})` : base;
  const msg = error?.message || 'réponse inattendue';
  return `Erreur Meta ${Number.isFinite(code) ? code : '?'} : ${msg}${details ? ` — ${details}` : ''}`;
}

/** Vrai si l'erreur justifie un nouvel essai différé (jamais après un timeout : le message est peut-être parti). */
function estErreurTemporaire(err) {
  if (!(err instanceof MetaApiError)) return false;
  if (err.metaCode === 'reseau') return true;
  return CODES_TEMPORAIRES.has(Number(err.metaCode));
}

/* ------------------------------------------------------------------ */
/* Appels Graph API                                                    */
/* ------------------------------------------------------------------ */

/**
 * Appel Graph API authentifié. `body` (objet) est envoyé en JSON ; `form`
 * (FormData natif) en multipart — fetch pose lui-même la frontière.
 */
async function graphFetch(cfg, path, { method = 'GET', body, form, timeoutMs = TIMEOUT_MS } = {}) {
  if (!cfg.accessTokenClair) {
    throw new MetaApiError("Jeton d'accès non enregistré ou illisible : enregistrez-le dans la configuration.", {
      http: 400
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let json;
  try {
    const headers = { Authorization: `Bearer ${cfg.accessTokenClair}`, Accept: 'application/json' };
    let bodyInit;
    if (form) bodyInit = form;
    else if (body) {
      headers['Content-Type'] = 'application/json';
      bodyInit = JSON.stringify(body);
    }
    res = await fetch(`${GRAPH_URL}/${cfg.apiVersion}/${path}`, {
      method,
      headers,
      body: bodyInit,
      signal: controller.signal
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new MetaApiError(`Délai dépassé : l'API Meta ne répond pas (${Math.round(timeoutMs / 1000)} s).`, {
        metaCode: 'timeout'
      });
    }
    throw new MetaApiError('Connexion à graph.facebook.com impossible (réseau, DNS ou pare-feu du serveur).', {
      metaCode: 'reseau'
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || json.error) {
    const e = json.error || { code: res.status, message: res.statusText };
    throw new MetaApiError(mapErreurMeta(e), {
      metaCode: e.code ?? res.status,
      details: e.error_data?.details || null,
      fbtrace: e.fbtrace_id || null
    });
  }
  return json;
}

/** « Tester la connexion » : informations du numéro (nom vérifié, numéro affiché, qualité). */
async function getPhoneNumberInfo(cfg) {
  if (!cfg.phoneNumberId) throw new MetaApiError('Phone Number ID non renseigné.', { http: 400 });
  const json = await graphFetch(
    cfg,
    `${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`
  );
  return {
    verifiedName: json.verified_name || '',
    displayPhoneNumber: json.display_phone_number || '',
    qualityRating: json.quality_rating || '',
    codeVerificationStatus: json.code_verification_status || ''
  };
}

/** Ajoute la référence au message cité (réponse) si fournie. */
function avecContexte(payload, reponseA) {
  if (reponseA) payload.context = { message_id: String(reponseA) };
  return payload;
}

function payloadTemplate(to, nom, langue, params, { reponseA } = {}) {
  const template = { name: nom, language: { code: langue } };
  if (Array.isArray(params) && params.length) {
    template.components = [
      { type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }
    ];
  }
  return avecContexte(
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template },
    reponseA
  );
}

function payloadTexte(to, texte, { reponseA } = {}) {
  return avecContexte(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: texte }
    },
    reponseA
  );
}

/** Image déjà téléversée chez Meta (id de média) avec légende facultative. */
function payloadImage(to, mediaId, legende, { reponseA } = {}) {
  const image = { id: String(mediaId) };
  if (legende) image.caption = String(legende);
  return avecContexte(
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image', image },
    reponseA
  );
}

/** Message vocal déjà téléversé chez Meta (ogg/opus mono → note vocale ; mp4, aac, mpeg, amr → fichier audio). */
function payloadAudio(to, mediaId, { reponseA } = {}) {
  return avecContexte(
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id: String(mediaId) } },
    reponseA
  );
}

async function envoyerMessage(cfg, payload) {
  return graphFetch(cfg, `${cfg.phoneNumberId}/messages`, { method: 'POST', body: payload });
}

/** Abonne l'app au WABA (utile au passage en production si les webhooks n'arrivent plus). */
async function abonnerApp(cfg) {
  if (!cfg.wabaId) throw new MetaApiError('WhatsApp Business Account ID non renseigné.', { http: 400 });
  return graphFetch(cfg, `${cfg.wabaId}/subscribed_apps`, { method: 'POST' });
}

/** Accusé de lecture côté contact (double coche bleue) pour un message entrant. */
async function marquerLuChezMeta(cfg, wamid) {
  if (!wamid) return;
  await graphFetch(cfg, `${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: String(wamid) }
  });
}

/**
 * Média entrant : GET /{media_id} → URL temporaire (5 min) → téléchargement
 * authentifié. Renvoie { buffer, mime, taille }.
 */
async function telechargerMedia(cfg, mediaId) {
  const info = await graphFetch(cfg, String(mediaId));
  if (!info.url) throw new MetaApiError('URL du média introuvable chez Meta.', { metaCode: 'media' });
  if (Number(info.file_size) > MEDIA_MAX_OCTETS) {
    throw new MetaApiError('Média trop volumineux (max 20 Mo).', { metaCode: 'media' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MEDIA_MS);
  try {
    const res = await fetch(info.url, {
      headers: { Authorization: `Bearer ${cfg.accessTokenClair}`, 'User-Agent': 'ortalog/1.0' },
      signal: controller.signal
    });
    if (!res.ok) throw new MetaApiError(`Téléchargement du média refusé (${res.status}).`, { metaCode: 'media' });
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MEDIA_MAX_OCTETS) throw new MetaApiError('Média trop volumineux (max 20 Mo).', { metaCode: 'media' });
    return { buffer, mime: info.mime_type || res.headers.get('content-type') || 'application/octet-stream', taille: buffer.length };
  } catch (err) {
    if (err instanceof MetaApiError) throw err;
    throw new MetaApiError('Téléchargement du média impossible (réseau ou délai).', { metaCode: 'media' });
  } finally {
    clearTimeout(timer);
  }
}

/** Téléverse un fichier chez Meta (POST /{phoneNumberId}/media) → id de média réutilisable 30 jours. */
async function televerserMedia(cfg, { buffer, mime, nomFichier = 'fichier' }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), nomFichier);
  const json = await graphFetch(cfg, `${cfg.phoneNumberId}/media`, { method: 'POST', form, timeoutMs: TIMEOUT_MEDIA_MS });
  if (!json.id) throw new MetaApiError('Meta n’a pas renvoyé d’identifiant de média.', { metaCode: 'media' });
  return String(json.id);
}

/* ------------------------------------------------------------------ */
/* Envoi + journal                                                     */
/* ------------------------------------------------------------------ */

function tronquer(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

/** Vérifie que l'intégration peut envoyer (lève une MetaApiError 400 sinon). */
function verifierEtatEnvoi(cfg, exigerActif) {
  if (cfg.etat === 'non_configure') {
    throw new MetaApiError("L'API WhatsApp n'est pas configurée (Phone Number ID et jeton d'accès requis).", {
      http: 400
    });
  }
  if (exigerActif && !cfg.actif) {
    throw new MetaApiError("L'intégration WhatsApp est désactivée (interrupteur « Intégration activée »).", {
      http: 400
    });
  }
}

/**
 * Validation + construction du payload Meta, sans appel réseau ni écriture.
 *  - template + langue (+ params positionnels {{1}}, {{2}}…) : message modèle ;
 *  - texte : message libre (fenêtre de 24 h, sinon Meta renvoie 131047) ;
 *  - image : { mediaId, legende } (média déjà téléversé chez Meta) ;
 *  - audio : { mediaId } (message vocal déjà téléversé, sans légende).
 * `contenu` remplace le texte lisible journalisé (ex. rendu du modèle).
 * Renvoie { phone, type, payload, contenu, template }.
 */
function preparerEnvoi({ to, template, langue = 'fr', params = [], texte, image, audio, reponseA = null, contenu }) {
  const phone = toE164Maroc(to);
  if (!phone) {
    throw new MetaApiError(`Numéro destinataire invalide (${to}) : attendu 06XXXXXXXX ou 2126XXXXXXXX.`, {
      http: 400,
      metaCode: 'numero_invalide'
    });
  }
  if (audio) {
    if (!audio.mediaId) throw new MetaApiError('Média manquant.', { http: 400 });
    return {
      phone,
      type: 'audio',
      payload: payloadAudio(phone, audio.mediaId, { reponseA }),
      contenu: contenu ?? '🎤 Message vocal',
      template: null
    };
  }
  if (image) {
    if (!image.mediaId) throw new MetaApiError('Média manquant.', { http: 400 });
    const legende = image.legende ? tronquer(String(image.legende), LEGENDE_MAX) : '';
    return {
      phone,
      type: 'image',
      payload: payloadImage(phone, image.mediaId, legende, { reponseA }),
      contenu: contenu ?? (legende ? `📷 ${legende}` : '📷 Photo'),
      template: null
    };
  }
  if (texte != null) {
    const t = String(texte);
    if (!t.trim()) throw new MetaApiError('Le message est vide.', { http: 400 });
    if (t.length > TEXTE_MAX) throw new MetaApiError(`Texte trop long (max ${TEXTE_MAX} caractères).`, { http: 400 });
    return { phone, type: 'text', payload: payloadTexte(phone, t, { reponseA }), contenu: contenu ?? t, template: null };
  }
  if (!template) throw new MetaApiError('Nom du modèle manquant.', { http: 400 });
  const liste = Array.isArray(params) ? params.map((p) => String(p ?? '')) : [];
  return {
    phone,
    type: 'template',
    payload: payloadTemplate(phone, template, langue, liste, { reponseA }),
    contenu: contenu ?? `Modèle ${template} (${langue})${liste.length ? ` : ${liste.join(' · ')}` : ''}`,
    template: tronquer(template, 100)
  };
}

/**
 * Ligne du journal pour un envoi (statut 'en_attente' = envoi immédiat en
 * cours, 'planifie' = file d'envoi, exécuté dans `planifieDansSecondes`).
 * Les colonnes CRM ne sont écrites que si la migration est passée.
 */
async function journaliserSortant({
  phone,
  type,
  template,
  contenu,
  payload,
  contexte = null,
  parcelId = null,
  createdBy = 0,
  statut = 'en_attente',
  planifieDansSecondes = 0,
  regleId = null,
  conversationId = null,
  reponseA = null,
  media = null,
  mediaType = null
}) {
  const cols = [
    'wam_direction', 'wam_phone', 'wam_type', 'wam_template', 'wam_contenu', 'wam_payload',
    'wam_statut', 'wam_parcel_id', 'wam_created_by', 'wam_created_at'
  ];
  const marks = ["'sortant'", '?', '?', '?', '?', '?', '?', '?', '?', 'NOW()'];
  const vals = [
    phone,
    type,
    template ? tronquer(template, 100) : null,
    tronquer(contenu, 2000),
    JSON.stringify({ contexte, ...payload }),
    statut,
    parcelId || null,
    Number(createdBy) || 0
  ];
  if (await crmDisponible()) {
    cols.push('wam_conversation', 'wam_regle', 'wam_reponse_a', 'wam_media', 'wam_media_type', 'wam_planifie_le');
    marks.push('?', '?', '?', '?', '?', statut === 'planifie' ? 'DATE_ADD(NOW(), INTERVAL ? SECOND)' : 'NULL');
    vals.push(
      conversationId || null,
      regleId || null,
      reponseA ? tronquer(reponseA, 191) : null,
      media ? tronquer(media, 255) : null,
      mediaType ? tronquer(mediaType, 50) : null
    );
    if (statut === 'planifie') vals.push(Math.max(0, Math.round(Number(planifieDansSecondes) || 0)));
  }
  const [ins] = await pool.query(
    `INSERT INTO delevery_whatsapp_message (${cols.join(', ')}) VALUES (${marks.join(', ')})`,
    vals
  );
  return ins.insertId;
}

/**
 * Appel Meta pour une ligne du journal déjà créée ({ wam_id, wam_payload,
 * wam_conversation, wam_contenu }) puis mise à jour du statut : 'envoye'
 * (+ wam_wamid) ou 'echec' (+ erreur traduite). Lève l'erreur Meta après
 * l'avoir journalisée (err.journalId).
 */
async function executerEnvoi(cfg, row) {
  const id = Number(row.wam_id);
  const payload = parseJson(row.wam_payload) || {};
  delete payload.contexte;
  try {
    const json = await envoyerMessage(cfg, payload);
    const wamid = json.messages?.[0]?.id || null;
    await pool.query(
      `UPDATE delevery_whatsapp_message
          SET wam_statut = 'envoye', wam_wamid = ?, wam_erreur_code = NULL, wam_erreur_message = NULL,
              wam_updated_at = NOW()
        WHERE wam_id = ?`,
      [wamid, id]
    );
    if (row.wam_conversation) {
      await pool.query(
        `UPDATE delevery_whatsapp_conversation
            SET wac_dernier_sortant_le = NOW(), wac_dernier_message_le = NOW(),
                wac_dernier_apercu = ?, wac_updated_at = NOW()
          WHERE wac_id = ?`,
        [tronquer(row.wam_contenu || '', 255), Number(row.wam_conversation)]
      ).catch(() => {});
    }
    return { id, wamid, phone: payload.to, statut: 'envoye' };
  } catch (err) {
    const metaCode = err instanceof MetaApiError && err.metaCode != null ? tronquer(err.metaCode, 20) : null;
    await pool.query(
      `UPDATE delevery_whatsapp_message
          SET wam_statut = 'echec', wam_erreur_code = ?, wam_erreur_message = ?, wam_updated_at = NOW()
        WHERE wam_id = ?`,
      [metaCode, tronquer(err.message, 500), id]
    );
    err.journalId = id;
    throw err;
  }
}

/**
 * Envoie un message WhatsApp immédiatement et le journalise.
 * Options : to, template/langue/params | texte | image { mediaId, legende } |
 * audio { mediaId }, contexte, parcelId, createdBy, exigerActif (false pour les tests de la page),
 * conversationId, regleId, reponseA, media/mediaType (fichier local), contenu.
 * Lève une MetaApiError (avec err.journalId) en cas de refus Meta.
 */
async function envoyerWhatsApp(options) {
  const { contexte = null, parcelId = null, createdBy = 0, exigerActif = true } = options;
  const cfg = await lireConfiguration({ avecSecrets: true });
  verifierEtatEnvoi(cfg, exigerActif);
  const prep = preparerEnvoi(options);
  const id = await journaliserSortant({
    ...prep,
    contexte,
    parcelId,
    createdBy,
    statut: 'en_attente',
    regleId: options.regleId,
    conversationId: options.conversationId,
    reponseA: options.reponseA,
    media: options.media,
    mediaType: options.mediaType
  });
  return executerEnvoi(cfg, {
    wam_id: id,
    wam_payload: JSON.stringify(prep.payload),
    wam_conversation: options.conversationId || null,
    wam_contenu: prep.contenu
  });
}

/**
 * Met un envoi dans la file (statut 'planifie', exécuté par jobs/whatsappFile.js
 * dans `planifieDansSecondes`) sans appel Meta. Mêmes options que
 * envoyerWhatsApp ; lève une MetaApiError 400 si le numéro / le contenu est invalide.
 */
async function planifierEnvoi(options) {
  const prep = preparerEnvoi(options);
  const id = await journaliserSortant({
    ...prep,
    contexte: options.contexte ?? null,
    parcelId: options.parcelId ?? null,
    createdBy: options.createdBy ?? 0,
    statut: 'planifie',
    planifieDansSecondes: options.planifieDansSecondes ?? 0,
    regleId: options.regleId,
    conversationId: options.conversationId,
    reponseA: options.reponseA
  });
  return { id, phone: prep.phone, statut: 'planifie', contenu: prep.contenu };
}

/** Variante « best-effort » : ne lève jamais, renvoie { ok, message }. */
async function envoyerWhatsAppSansErreur(options) {
  try {
    const r = await envoyerWhatsApp(options);
    return { ok: true, ...r };
  } catch (err) {
    console.warn(`[whatsapp] envoi refusé (${err.metaCode ?? err.code ?? 'erreur'}) : ${err.message}`);
    return { ok: false, message: err.message, journalId: err.journalId ?? null };
  }
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

/** Comparaison à temps constant de deux chaînes (jeton de vérification). */
function egalSecurise(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Vérifie l'en-tête X-Hub-Signature-256 ("sha256=<hex>") = HMAC-SHA256(corps brut, App Secret). */
function verifierSignature(rawBody, header, appSecret) {
  if (!rawBody || !appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const recu = header.slice(7).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recu)) return false;
  const attendu = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(recu, 'hex'), Buffer.from(attendu, 'hex'));
}

const STATUT_META = { sent: 'envoye', delivered: 'remis', read: 'lu', failed: 'echec' };

/** Accusé Meta → journal, sans jamais rétrograder (en_attente < envoye < remis < lu ; echec gagne toujours). */
async function appliquerStatut(st) {
  const statut = STATUT_META[st?.status];
  if (!statut || !st.id) return;
  const err = Array.isArray(st.errors) && st.errors.length ? st.errors[0] : null;
  const [result] = await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_statut = CASE
              WHEN ? = 'echec' THEN 'echec'
              WHEN wam_statut = 'echec' THEN wam_statut
              WHEN FIELD(wam_statut, 'en_attente', 'envoye', 'remis', 'lu')
                   < FIELD(?, 'en_attente', 'envoye', 'remis', 'lu') THEN ?
              ELSE wam_statut
            END,
            wam_erreur_code = COALESCE(?, wam_erreur_code),
            wam_erreur_message = COALESCE(?, wam_erreur_message),
            wam_updated_at = NOW()
      WHERE wam_wamid = ? AND wam_direction = 'sortant'`,
    [statut, statut, statut, err ? tronquer(err.code, 20) : null, err ? tronquer(mapErreurMeta(err), 500) : null, st.id]
  );
  if (!result.affectedRows) {
    console.warn(`[whatsapp] accusé « ${st.status} » pour un message inconnu du journal (${tronquer(st.id, 40)}…).`);
  }
}

/** Texte lisible d'un message entrant Meta (texte, bouton, réaction, légende…). */
function contenuEntrant(msg) {
  const type = String(msg.type || 'inconnu');
  let contenu;
  if (type === 'text') contenu = msg.text?.body;
  else if (type === 'button') contenu = msg.button?.text;
  else if (type === 'interactive') {
    contenu = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
  } else if (type === 'reaction') contenu = msg.reaction?.emoji;
  else if (type === 'location') {
    const l = msg.location || {};
    contenu = l.name || l.address || (l.latitude != null ? `📍 ${l.latitude}, ${l.longitude}` : null);
  } else if (type === 'contacts') {
    contenu = (msg.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ');
    if (contenu) contenu = `👤 ${contenu}`;
  } else contenu = msg[type]?.caption;
  return { type, contenu: contenu ? String(contenu) : `[${type}]` };
}

/**
 * Message entrant → ligne « entrant / recu » (rejeu idempotent grâce à l'index
 * unique sur le wamid). Avec le CRM : texte brut (le nom du profil va dans la
 * conversation) et traitement par services/whatsappConversations.js.
 * Renvoie { id, nouveau }.
 */
async function enregistrerEntrant(msg, contacts, cfg) {
  if (!msg?.id || !msg.from) return { id: null, nouveau: false };
  const crm = await crmDisponible();
  const { type, contenu: brut } = contenuEntrant(msg);
  const nom = Array.isArray(contacts) ? contacts.find((c) => c.wa_id === msg.from)?.profile?.name : null;
  const contenu = nom && !crm ? `${nom} : ${brut}` : brut;
  const [result] = await pool.query(
    `INSERT INTO delevery_whatsapp_message
       (wam_direction, wam_wamid, wam_phone, wam_type, wam_contenu, wam_payload,
        wam_statut, wam_created_by, wam_created_at)
     VALUES ('entrant', ?, ?, ?, ?, ?, 'recu', 0, COALESCE(FROM_UNIXTIME(?), NOW()))
     ON DUPLICATE KEY UPDATE wam_id = wam_id`,
    [
      tronquer(msg.id, 191),
      tronquer(msg.from, 20),
      tronquer(type, 30),
      tronquer(contenu, 2000),
      JSON.stringify(msg),
      Number(msg.timestamp) || null
    ]
  );
  const nouveau = result.affectedRows === 1;
  const id = nouveau ? result.insertId : null;
  if (crm && nouveau) {
    try {
      // Require paresseux : whatsappConversations dépend de ce module.
      await require('./whatsappConversations').traiterEntrant({ messageId: id, msg, nom, type, contenu: brut, cfg });
    } catch (err) {
      console.error(`[whatsapp] traitement CRM du message entrant ${id} : ${err.message}`);
    }
  }
  return { id, nouveau };
}

/** Traite un POST webhook Meta : accusés, messages entrants, statut / qualité des modèles. */
async function traiterWebhook(body) {
  const bilan = { statuts: 0, messages: 0, modeles: 0 };
  if (!body || body.object !== 'whatsapp_business_account') return bilan;
  const cfg = await lireConfiguration({ avecSecrets: true });
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'message_template_status_update' || change.field === 'message_template_quality_update') {
        if (await crmDisponible()) {
          try {
            await require('./whatsappModeles').appliquerWebhookModele(change.field, change.value || {});
            bilan.modeles += 1;
          } catch (err) {
            console.error(`[whatsapp] webhook modèle : ${err.message}`);
          }
        }
        continue;
      }
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const pnid = value.metadata?.phone_number_id;
      if (cfg.phoneNumberId && pnid && String(pnid) !== String(cfg.phoneNumberId)) {
        console.warn(`[whatsapp] webhook ignoré : phone_number_id ${pnid} ≠ configuration.`);
        continue;
      }
      for (const st of value.statuses || []) {
        await appliquerStatut(st);
        bilan.statuts += 1;
      }
      for (const msg of value.messages || []) {
        await enregistrerEntrant(msg, value.contacts, cfg);
        bilan.messages += 1;
      }
    }
  }
  return bilan;
}

/* ------------------------------------------------------------------ */
/* Journal : lecture                                                   */
/* ------------------------------------------------------------------ */

const STATUTS = ['planifie', 'en_attente', 'envoye', 'remis', 'lu', 'echec', 'recu', 'note'];
const DIRECTIONS = ['sortant', 'entrant', 'note'];
const JOURNAL_LIMIT_MAX = 500;

const JOURNAL_SELECT = `
  SELECT m.wam_id AS id, m.wam_direction AS direction, m.wam_wamid AS wamid,
         m.wam_phone AS phone, m.wam_type AS type, m.wam_template AS template,
         m.wam_contenu AS contenu, m.wam_statut AS statut,
         m.wam_erreur_code AS erreurCode, m.wam_erreur_message AS erreurMessage,
         m.wam_parcel_id AS parcelId, m.wam_created_by AS createdBy,
         u.users_name AS createdByNom,
         m.wam_created_at AS createdAt, m.wam_updated_at AS updatedAt`;
const JOURNAL_SELECT_CRM = `,
         m.wam_conversation AS conversationId, m.wam_regle AS regleId, r.wamr_nom AS regleNom,
         m.wam_planifie_le AS planifieLe, m.wam_tentatives AS tentatives, m.wam_media AS media`;
const JOURNAL_FROM = `
    FROM delevery_whatsapp_message m
    LEFT JOIN delevery_users u ON u.users_id = m.wam_created_by`;
const JOURNAL_FROM_CRM = `
    LEFT JOIN delevery_whatsapp_regle r ON r.wamr_id = m.wam_regle`;

async function journalSql() {
  const crm = await crmDisponible();
  return {
    select: crm ? JOURNAL_SELECT + JOURNAL_SELECT_CRM : JOURNAL_SELECT,
    from: crm ? JOURNAL_FROM + JOURNAL_FROM_CRM : JOURNAL_FROM
  };
}

async function listerJournal({ limit, direction, statut, parcelId, conversationId } = {}) {
  const { select, from } = await journalSql();
  const where = [];
  const params = [];
  if (DIRECTIONS.includes(direction)) {
    where.push('m.wam_direction = ?');
    params.push(direction);
  }
  if (STATUTS.includes(statut)) {
    where.push('m.wam_statut = ?');
    params.push(statut);
  }
  if (Number(parcelId) > 0) {
    where.push('m.wam_parcel_id = ?');
    params.push(Number(parcelId));
  }
  if (Number(conversationId) > 0) {
    where.push('m.wam_conversation = ?');
    params.push(Number(conversationId));
  }
  const lim = Math.min(Math.max(Number(limit) || 200, 1), JOURNAL_LIMIT_MAX);
  const [rows] = await pool.query(
    `${select} ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY m.wam_id DESC LIMIT ${lim}`,
    params
  );
  return rows;
}

async function detailJournal(id) {
  const { select, from } = await journalSql();
  const [[row]] = await pool.query(`${select}, m.wam_payload AS payload ${from} WHERE m.wam_id = ? LIMIT 1`, [
    Number(id)
  ]);
  if (!row) return null;
  row.payload = parseJson(row.payload);
  return row;
}

module.exports = {
  API_VERSION_DEFAUT,
  API_VERSION_RE,
  WEBHOOK_PATH,
  TEMPLATE_TEST,
  SECRET_FIELDS,
  TEXTE_MAX,
  STATUTS,
  DIRECTIONS,
  MetaApiError,
  lireConfigs,
  upsertConfig,
  parseJson,
  tronquer,
  lireConfiguration,
  enregistrerConfiguration,
  enregistrerDernierTest,
  marquerWebhookVerifie,
  toE164Maroc,
  mapErreurMeta,
  estErreurTemporaire,
  graphFetch,
  getPhoneNumberInfo,
  abonnerApp,
  marquerLuChezMeta,
  telechargerMedia,
  televerserMedia,
  verifierEtatEnvoi,
  preparerEnvoi,
  journaliserSortant,
  executerEnvoi,
  envoyerWhatsApp,
  planifierEnvoi,
  envoyerWhatsAppSansErreur,
  egalSecurise,
  verifierSignature,
  traiterWebhook,
  listerJournal,
  detailJournal
};
