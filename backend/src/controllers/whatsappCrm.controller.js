const fs = require('fs');
const pool = require('../config/db');
const { MetaApiError, lireConfiguration, listerJournal } = require('../services/whatsapp');
const { MESSAGE_CRM_ABSENT, crmDisponible, estErreurMigration } = require('../utils/whatsappSchema');
const modeles = require('../services/whatsappModeles');
const regles = require('../services/whatsappRegles');
const conversations = require('../services/whatsappConversations');
const ev = require('../services/whatsappEvenements');
const { lireParametresCrm, enregistrerParametresCrm } = require('../services/whatsappParametres');
const { statistiques } = require('../services/whatsappStatistiques');
const { etatFile, annulerEnvoi, renvoyerEnvoi } = require('../jobs/whatsappFile');
const { loadAdminParcel } = require('./parcelsAdmin.controller');

/*
 * CRM WhatsApp — routes /api/whatsapp/* (fonctions 1 et 2 ; service API_LIAISON
 * ou WHATSAPP_DISCUSSIONS selon la route, voir whatsapp.routes.js) :
 * modèles, actions automatiques, discussions, réponses rapides, paramètres,
 * statistiques, file d'envoi, envois depuis un colis. La logique est dans
 * services/whatsapp*.js ; ici : lecture des paramètres, validation légère,
 * codes HTTP. Sans la migration sql/2026-09-13_whatsapp-crm.sql : 503.
 */

/** Réponse HTTP pour une erreur métier / Meta / migration ; autre erreur → gestionnaire global. */
function repondre(res, err, next) {
  if (err instanceof MetaApiError) {
    return res.status(err.http || 502).json({ message: err.message, metaCode: err.metaCode, journalId: err.journalId ?? null });
  }
  if (err instanceof conversations.ConversationError) return res.status(err.http || 400).json({ message: err.message });
  if (estErreurMigration(err)) return res.status(503).json({ message: MESSAGE_CRM_ABSENT });
  return next(err);
}

function id(req) {
  const n = parseInt(req.params.id, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dropFile(file) {
  if (file) fs.promises.unlink(file.path).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* État, catalogue, référentiels                                       */
/* ------------------------------------------------------------------ */

/** GET /crm/etat */
async function getEtatCrm(req, res, next) {
  try {
    const [migration, cfg, file, params] = await Promise.all([crmDisponible(), lireConfiguration(), etatFile(), lireParametresCrm()]);
    res.json({ migration, migrationFichier: 'sql/2026-09-13_whatsapp-crm.sql', etat: cfg.etat, actif: cfg.actif, file, parametres: params });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /evenements */
function getCatalogue(req, res) {
  res.json(ev.catalogue());
}

/** GET /referentiels */
async function getReferentiels(req, res, next) {
  try {
    res.json(await conversations.referentiels());
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Modèles                                                             */
/* ------------------------------------------------------------------ */

/** GET /modeles?statut&recherche&utilisables=1 */
async function listModeles(req, res, next) {
  try {
    const rows = await modeles.listerModeles({
      statut: req.query.statut,
      recherche: String(req.query.recherche || '').trim().slice(0, 100),
      utilisables: req.query.utilisables === '1'
    });
    res.json({ rows });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /modeles/synchroniser */
async function syncModeles(req, res, next) {
  try {
    const cfg = await lireConfiguration({ avecSecrets: true });
    if (cfg.etat === 'non_configure') {
      return res.status(400).json({ message: "Renseignez d'abord le Phone Number ID et le jeton d'accès dans la configuration." });
    }
    const bilan = await modeles.synchroniserModeles(cfg);
    const rows = await modeles.listerModeles();
    res.json({
      ...bilan,
      rows,
      message: `Synchronisation terminée : ${bilan.total} modèle(s) chez Meta, ${bilan.crees} nouveau(x), ${bilan.maj} mis à jour${bilan.disparus ? `, ${bilan.disparus} disparu(s)` : ''}.`
    });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PUT /modeles/:id — { actif?, mappingDefaut?, description? } */
async function updateModele(req, res, next) {
  try {
    const mid = id(req);
    if (!mid) return res.status(404).json({ message: 'Modèle introuvable.' });
    const body = req.body || {};
    let mapping;
    if (body.mappingDefaut !== undefined) {
      if (!Array.isArray(body.mappingDefaut)) return res.status(400).json({ message: 'Correspondance des variables invalide.' });
      mapping = body.mappingDefaut.map((m) => {
        if (typeof m === 'string') return { type: 'variable', code: m };
        if (m && m.type === 'fixe') return { type: 'fixe', texte: String(m.texte || '').trim().slice(0, 300) };
        return { type: 'variable', code: String(m?.code || '') };
      });
      const codesOk = new Set(ev.variablesPourContexte('COLIS').map((v) => v.code));
      const mauvais = mapping.find((m) => m.type === 'variable' && m.code && !codesOk.has(m.code));
      if (mauvais) return res.status(400).json({ message: `Variable inconnue : ${mauvais.code}.` });
    }
    const modele = await modeles.enregistrerModeleLocal(mid, { actif: body.actif, mappingDefaut: mapping, description: body.description });
    if (!modele) return res.status(404).json({ message: 'Modèle introuvable.' });
    res.json(modele);
  } catch (err) {
    repondre(res, err, next);
  }
}

/**
 * POST /modeles/:id/apercu — { parcelId?, conversationId? } : paramètres
 * préremplis (correspondance par défaut, contexte colis) + texte rendu.
 */
async function apercuModele(req, res, next) {
  try {
    const mid = id(req);
    const modele = mid ? await modeles.modeleParId(mid) : null;
    if (!modele) return res.status(404).json({ message: 'Modèle introuvable.' });
    let parcelId = Number(req.body?.parcelId) || null;
    if (!parcelId && Number(req.body?.conversationId) > 0) {
      const conv = await conversations.conversationParId(Number(req.body.conversationId));
      parcelId = conv?.dernierColisId || null;
    }
    const data = parcelId ? await ev.resoudreContexte('COLIS', { parcelId }) : null;
    let params;
    if (data && modele.mappingDefaut.length) params = ev.construireParams(modele.mappingDefaut, data, modele.langue);
    else params = Array.from({ length: modele.nbVariables }, (_, i) => (data && modele.mappingDefaut[i] ? '' : ''));
    params = params.slice(0, modele.nbVariables);
    while (params.length < modele.nbVariables) params.push('');
    res.json({
      params,
      texte: modeles.rendreModele(modele, params),
      variables: data ? Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_'))) : null,
      parcelId
    });
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Règles                                                              */
/* ------------------------------------------------------------------ */

/** GET /regles */
async function listRegles(req, res, next) {
  try {
    res.json({ rows: await regles.listerRegles() });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /regles */
async function createRegle(req, res, next) {
  try {
    const v = await regles.validerRegle(req.body);
    if (v.erreurs.length) return res.status(400).json({ message: v.erreurs.join(' '), erreurs: v.erreurs });
    const regle = await regles.creerRegle(v.regle, req.user.id);
    res.status(201).json({ ...regle, avertissements: v.avertissements, message: 'Règle enregistrée.' });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PUT /regles/:id */
async function updateRegle(req, res, next) {
  try {
    const rid = id(req);
    if (!rid) return res.status(404).json({ message: 'Règle introuvable.' });
    const v = await regles.validerRegle(req.body);
    if (v.erreurs.length) return res.status(400).json({ message: v.erreurs.join(' '), erreurs: v.erreurs });
    const regle = await regles.modifierRegle(rid, v.regle);
    if (!regle) return res.status(404).json({ message: 'Règle introuvable.' });
    res.json({ ...regle, avertissements: v.avertissements, message: 'Règle enregistrée.' });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PATCH /regles/:id/actif — { actif } */
async function setRegleActive(req, res, next) {
  try {
    const rid = id(req);
    const regle = rid ? await regles.activerRegle(rid, Boolean(req.body?.actif)) : null;
    if (!regle) return res.status(404).json({ message: 'Règle introuvable.' });
    res.json(regle);
  } catch (err) {
    repondre(res, err, next);
  }
}

/** DELETE /regles/:id */
async function deleteRegle(req, res, next) {
  try {
    const rid = id(req);
    if (!rid || !(await regles.supprimerRegle(rid))) return res.status(404).json({ message: 'Règle introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /regles/tester — { regle, parcelCode?, envoyer? } */
async function testerRegle(req, res, next) {
  try {
    const body = req.body || {};
    const r = await regles.testerRegle(body.regle || body, {
      parcelCode: String(body.parcelCode || '').trim().slice(0, 50),
      envoyer: Boolean(body.envoyer),
      userId: req.user.id
    });
    if (r.erreurs?.length) return res.status(400).json({ message: r.erreurs.join(' '), ...r });
    res.json(r);
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Discussions                                                         */
/* ------------------------------------------------------------------ */

/** GET /conversations?statut&affectation&type&nonLus&q&page&pageSize */
async function listConversations(req, res, next) {
  try {
    const q = req.query;
    res.json(
      await conversations.listerConversations(
        {
          statut: q.statut,
          affectation: q.affectation,
          type: q.type,
          nonLus: q.nonLus === '1',
          recherche: String(q.q || '').slice(0, 100),
          page: q.page,
          pageSize: q.pageSize
        },
        req.user.id
      )
    );
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /conversations — { phone | parcelId(+audience) | customerId | usersId, modele/langue/params | texte } */
async function createConversation(req, res, next) {
  try {
    const r = await conversations.demarrerConversation(req.body || {}, req.user.id);
    res.status(201).json(r);
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /conversations/:id — détail (marque lu). */
async function getConversation(req, res, next) {
  try {
    const cid = id(req);
    const r = cid ? await conversations.detailConversation(cid, { userId: req.user.id }) : null;
    if (!r) return res.status(404).json({ message: 'Discussion introuvable.' });
    res.json(r);
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PATCH /conversations/:id — { statut?, affecteA?, dernierColis?, optOut?, langue?, nom? } */
async function updateConversation(req, res, next) {
  try {
    const cid = id(req);
    if (!cid) return res.status(404).json({ message: 'Discussion introuvable.' });
    res.json(await conversations.modifierConversation(cid, req.body || {}, req.user.id));
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /conversations/:id/messages?after&depuis */
async function getMessagesConversation(req, res, next) {
  try {
    const cid = id(req);
    const r = cid ? await conversations.messagesDepuis(cid, { after: req.query.after, depuis: req.query.depuis }) : null;
    if (!r) return res.status(404).json({ message: 'Discussion introuvable.' });
    res.json(r);
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /conversations/:id/messages — JSON { texte } | { modele, langue, params } ; multipart { image, legende } | { audio } */
async function sendMessageConversation(req, res, next) {
  try {
    const cid = id(req);
    if (!cid) {
      dropFile(req.file);
      return res.status(404).json({ message: 'Discussion introuvable.' });
    }
    const b = req.body || {};
    let params = b.params;
    if (typeof params === 'string') {
      try {
        params = JSON.parse(params);
      } catch {
        params = [];
      }
    }
    const message = await conversations.envoyerDansConversation(cid, {
      texte: b.texte,
      modele: b.modele,
      langue: b.langue,
      params,
      fichier: req.file || null,
      legende: b.legende,
      reponseA: b.reponseA ? String(b.reponseA).slice(0, 191) : null,
      forcer: b.forcer === true || b.forcer === '1' || b.forcer === 'true',
      userId: req.user.id
    });
    res.status(201).json(message);
  } catch (err) {
    if (!(err instanceof MetaApiError)) dropFile(req.file);
    repondre(res, err, next);
  }
}

/** POST /conversations/:id/notes — { texte } */
async function addNote(req, res, next) {
  try {
    const cid = id(req);
    if (!cid) return res.status(404).json({ message: 'Discussion introuvable.' });
    res.status(201).json(await conversations.ajouterNote(cid, req.body?.texte, req.user.id));
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Réponses rapides                                                    */
/* ------------------------------------------------------------------ */

const SELECT_RR = `SELECT wrr_id AS id, wrr_titre AS titre, wrr_texte AS texte, wrr_ordre AS ordre, wrr_actif AS actif
                     FROM delevery_whatsapp_reponse_rapide`;

function validerReponseRapide(body) {
  const titre = String(body?.titre || '').trim().slice(0, 100);
  const texte = String(body?.texte || '').trim();
  if (!titre) return { erreur: 'Le titre est obligatoire.' };
  if (!texte) return { erreur: 'Le texte est obligatoire.' };
  if (texte.length > 4096) return { erreur: 'Texte trop long (max 4096 caractères).' };
  const ordre = Number.isInteger(Number(body?.ordre)) ? Number(body.ordre) : 0;
  return { titre, texte, ordre, actif: body?.actif === undefined ? 1 : body.actif ? 1 : 0 };
}

/** GET /reponses-rapides?tous=1 */
async function listReponsesRapides(req, res, next) {
  try {
    const [rows] = await pool.query(`${SELECT_RR} ${req.query.tous === '1' ? '' : 'WHERE wrr_actif = 1'} ORDER BY wrr_ordre, wrr_titre`);
    res.json({ rows: rows.map((r) => ({ ...r, actif: Number(r.actif) === 1 })) });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /reponses-rapides */
async function createReponseRapide(req, res, next) {
  try {
    const v = validerReponseRapide(req.body);
    if (v.erreur) return res.status(400).json({ message: v.erreur });
    const [ins] = await pool.query(
      `INSERT INTO delevery_whatsapp_reponse_rapide (wrr_titre, wrr_texte, wrr_ordre, wrr_actif, wrr_created_by, wrr_created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [v.titre, v.texte, v.ordre, v.actif, req.user.id]
    );
    const [[row]] = await pool.query(`${SELECT_RR} WHERE wrr_id = ?`, [ins.insertId]);
    res.status(201).json({ ...row, actif: Number(row.actif) === 1 });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PUT /reponses-rapides/:id */
async function updateReponseRapide(req, res, next) {
  try {
    const rid = id(req);
    const v = validerReponseRapide(req.body);
    if (v.erreur) return res.status(400).json({ message: v.erreur });
    const [r] = await pool.query(
      `UPDATE delevery_whatsapp_reponse_rapide
          SET wrr_titre = ?, wrr_texte = ?, wrr_ordre = ?, wrr_actif = ?, wrr_updated_at = NOW() WHERE wrr_id = ?`,
      [v.titre, v.texte, v.ordre, v.actif, rid]
    );
    if (!r.affectedRows) return res.status(404).json({ message: 'Réponse rapide introuvable.' });
    const [[row]] = await pool.query(`${SELECT_RR} WHERE wrr_id = ?`, [rid]);
    res.json({ ...row, actif: Number(row.actif) === 1 });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** DELETE /reponses-rapides/:id */
async function deleteReponseRapide(req, res, next) {
  try {
    const [r] = await pool.query('DELETE FROM delevery_whatsapp_reponse_rapide WHERE wrr_id = ?', [id(req)]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Réponse rapide introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Paramètres, statistiques, file                                      */
/* ------------------------------------------------------------------ */

/** GET /parametres-crm */
async function getParametresCrm(req, res, next) {
  try {
    res.json(await lireParametresCrm());
  } catch (err) {
    repondre(res, err, next);
  }
}

/** PUT /parametres-crm */
async function saveParametresCrm(req, res, next) {
  try {
    const r = await enregistrerParametresCrm(req.body || {});
    if (r.erreurs.length) return res.status(400).json({ message: r.erreurs.join(' ') });
    res.json({ ...(await lireParametresCrm()), message: 'Paramètres enregistrés.' });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /statistiques?from&to */
async function getStatistiques(req, res, next) {
  try {
    res.json(await statistiques({ from: req.query.from, to: req.query.to }));
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /file?statut=planifie|en_attente|echec&limit */
async function listFile(req, res, next) {
  try {
    const statut = ['planifie', 'en_attente', 'echec'].includes(req.query.statut) ? req.query.statut : 'planifie';
    const rows = await listerJournal({ statut, direction: 'sortant', limit: req.query.limit || 200 });
    res.json({ rows, file: await etatFile() });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /file/:id/annuler */
async function annulerFile(req, res, next) {
  try {
    if (!(await annulerEnvoi(id(req)))) return res.status(409).json({ message: 'Seul un envoi planifié peut être annulé.' });
    res.json({ ok: true, message: 'Envoi annulé.' });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /file/:id/renvoyer */
async function renvoyerFile(req, res, next) {
  try {
    if (!(await renvoyerEnvoi(id(req)))) return res.status(409).json({ message: 'Seul un envoi en échec peut être renvoyé.' });
    res.json({ ok: true, message: 'Envoi remis dans la file (quelques secondes).' });
  } catch (err) {
    repondre(res, err, next);
  }
}

/* ------------------------------------------------------------------ */
/* Colis                                                               */
/* ------------------------------------------------------------------ */

/** GET /colis/recherche?q= */
async function rechercherColis(req, res, next) {
  try {
    res.json({ rows: await conversations.rechercherColis(String(req.query.q || '').slice(0, 60)) });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** GET /colis/:id/messages — timeline WhatsApp d'un colis (scope agence via loadAdminParcel). */
async function messagesColis(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, 'p.parcel_id, p.parcel_code, p.parcel_phone, p.parcel_receiver');
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    res.json({ parcel, ...(await conversations.messagesColis(parcel)) });
  } catch (err) {
    repondre(res, err, next);
  }
}

/** POST /colis/:id/envoyer — { audience, modele, langue, params } */
async function envoyerPourColis(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, 'p.parcel_id');
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    const r = await conversations.demarrerConversation({ ...(req.body || {}), parcelId: parcel.parcel_id }, req.user.id);
    res.status(201).json(r);
  } catch (err) {
    repondre(res, err, next);
  }
}

module.exports = {
  getEtatCrm,
  getCatalogue,
  getReferentiels,
  listModeles,
  syncModeles,
  updateModele,
  apercuModele,
  listRegles,
  createRegle,
  updateRegle,
  setRegleActive,
  deleteRegle,
  testerRegle,
  listConversations,
  createConversation,
  getConversation,
  updateConversation,
  getMessagesConversation,
  sendMessageConversation,
  addNote,
  listReponsesRapides,
  createReponseRapide,
  updateReponseRapide,
  deleteReponseRapide,
  getParametresCrm,
  saveParametresCrm,
  getStatistiques,
  listFile,
  annulerFile,
  renvoyerFile,
  rechercherColis,
  messagesColis,
  envoyerPourColis
};
