const pool = require('../config/db');
const { isSecretKeyConfigured, encryptSecret, SECRET_KEY_ENV, SECRET_KEY_MIN } = require('../utils/secrets');
const { normalizePhone, isValidPhone, PHONE_ERROR } = require('../utils/phone');
const { MESSAGE_CRM_ABSENT } = require('../utils/whatsappSchema');
const {
  API_VERSION_DEFAUT,
  API_VERSION_RE,
  WEBHOOK_PATH,
  TEMPLATE_TEST,
  SECRET_FIELDS,
  MetaApiError,
  lireConfiguration,
  enregistrerConfiguration,
  enregistrerDernierTest,
  marquerWebhookVerifie,
  getPhoneNumberInfo,
  abonnerApp,
  envoyerWhatsApp,
  egalSecurise,
  verifierSignature,
  traiterWebhook,
  listerJournal,
  detailJournal
} = require('../services/whatsapp');

/*
 * Page admin API liaison › Configuration (/admin/api-liaison/configuration) :
 * liaison WhatsApp Business Cloud API (Meta). Routes admin (service
 * API_LIAISON, fonctions 1 et 2) + webhook public appelé par Meta.
 * Toute la logique Meta est dans services/whatsapp.js.
 */

const ID_RE = /^\d{5,32}$/;
const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET_LIMITES = {
  accessToken: { min: 20, max: 600, message: "Jeton d'accès invalide : 20 à 600 caractères sans espace." },
  appSecret: { min: 16, max: 128, message: "Clé secrète de l'app invalide : 16 à 128 caractères sans espace." }
};
const MESSAGE_CLE_MANQUANTE =
  `Clé de chiffrement absente : ajoutez ${SECRET_KEY_ENV} (≥ ${SECRET_KEY_MIN} caractères) dans backend/.env en local ` +
  "ou dans les variables d'environnement de l'application Node sur Hostinger hPanel, puis redémarrez le serveur. " +
  'Les autres champs ont été enregistrés.';
const MESSAGE_TABLE_ABSENTE =
  'Table du journal WhatsApp absente : exécutez sql/2026-09-05_whatsapp-journal.sql dans phpMyAdmin.';

/** Configuration renvoyée au frontend (jamais de secret en clair) + compteurs CRM pour la checklist du guide. */
async function configurationPublique() {
  const cfg = await lireConfiguration();
  let nbModelesUtilisables = 0;
  let nbReglesActives = 0;
  try {
    const [[m]] = await pool.query(
      "SELECT COUNT(*) AS n FROM delevery_whatsapp_modele WHERE wamo_statut = 'APPROVED' AND wamo_actif = 1 AND (wamo_motif_rejet IS NULL OR wamo_motif_rejet NOT LIKE 'ORTALOG : %')"
    );
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM delevery_whatsapp_regle WHERE wamr_actif = 1');
    nbModelesUtilisables = Number(m?.n) || 0;
    nbReglesActives = Number(r?.n) || 0;
  } catch {
    // Migration CRM non exécutée : compteurs à zéro.
  }
  return {
    ...cfg,
    apiVersionDefaut: API_VERSION_DEFAUT,
    webhookPath: WEBHOOK_PATH,
    templateTest: TEMPLATE_TEST,
    nbModelesUtilisables,
    nbReglesActives
  };
}

/** Réponse HTTP pour une erreur Meta / configuration ; autre erreur → gestionnaire global. */
function repondreErreur(res, err, next) {
  if (err instanceof MetaApiError) {
    return res.status(err.http || 502).json({
      message: err.message,
      metaCode: err.metaCode,
      journalId: err.journalId ?? null
    });
  }
  if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ message: MESSAGE_TABLE_ABSENTE });
  if (err.code === 'ER_BAD_FIELD_ERROR') return res.status(503).json({ message: MESSAGE_CRM_ABSENT });
  return next(err);
}

/** GET /api/whatsapp/configuration */
async function getConfiguration(req, res, next) {
  try {
    res.json(await configurationPublique());
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/whatsapp/configuration
 * Secrets : absent ou "" = conserver, null = effacer, chaîne = chiffrer et remplacer.
 * Sans clé maître, les champs non secrets sont enregistrés puis 409 explicite.
 */
async function saveConfiguration(req, res, next) {
  try {
    const body = req.body || {};
    const champs = {};
    const erreurs = [];

    if (body.actif !== undefined) champs.actif = body.actif ? '1' : '0';

    for (const [field, libelle] of [
      ['phoneNumberId', 'Phone Number ID'],
      ['wabaId', 'WhatsApp Business Account ID']
    ]) {
      if (body[field] === undefined) continue;
      const v = String(body[field] ?? '').trim();
      if (v && !ID_RE.test(v)) erreurs.push(`${libelle} invalide : uniquement des chiffres (5 à 32).`);
      else champs[field] = v;
    }
    if (body.apiVersion !== undefined) {
      const v = String(body.apiVersion ?? '').trim();
      if (v && !API_VERSION_RE.test(v)) erreurs.push(`Version de l'API invalide (ex. ${API_VERSION_DEFAUT}).`);
      else champs.apiVersion = v || API_VERSION_DEFAUT;
    }
    if (body.testPhone !== undefined) {
      const v = normalizePhone(body.testPhone);
      if (v && !isValidPhone(v)) erreurs.push(`Numéro de test : ${PHONE_ERROR}`);
      else champs.testPhone = v;
    }
    if (body.verifyToken !== undefined) {
      const v = String(body.verifyToken ?? '').trim();
      if (v && !VERIFY_TOKEN_RE.test(v)) {
        erreurs.push('Jeton de vérification invalide : 16 à 128 caractères (lettres, chiffres, - ou _).');
      } else champs.verifyToken = v;
    }

    let cleManquante = false;
    for (const field of SECRET_FIELDS) {
      const v = body[field];
      if (v === undefined || v === '') continue;
      if (v === null) {
        champs[field] = '';
        continue;
      }
      const lim = SECRET_LIMITES[field];
      if (typeof v !== 'string') {
        erreurs.push(lim.message);
        continue;
      }
      const s = v.trim();
      if (/\s/.test(s) || s.length < lim.min || s.length > lim.max) {
        erreurs.push(lim.message);
        continue;
      }
      if (!isSecretKeyConfigured()) {
        cleManquante = true;
        continue;
      }
      champs[field] = encryptSecret(s);
    }

    if (erreurs.length) return res.status(400).json({ message: erreurs.join(' ') });

    await enregistrerConfiguration(champs);
    const configuration = await configurationPublique();
    if (cleManquante) return res.status(409).json({ message: MESSAGE_CLE_MANQUANTE, configuration });
    res.json({ ...configuration, message: 'Configuration WhatsApp enregistrée.' });
  } catch (err) {
    next(err);
  }
}

/** POST /api/whatsapp/test-connexion — informations du numéro chez Meta (aucun message envoyé). */
async function testerConnexion(req, res, next) {
  try {
    const cfg = await lireConfiguration({ avecSecrets: true });
    if (cfg.etat === 'non_configure') {
      return res.status(400).json({
        message: "Renseignez d'abord le Phone Number ID et le jeton d'accès, puis enregistrez."
      });
    }
    try {
      const info = await getPhoneNumberInfo(cfg);
      const dernierTest = { date: new Date().toISOString(), ok: true, ...info };
      await enregistrerDernierTest(dernierTest);
      res.json({ ...dernierTest, apiVersion: cfg.apiVersion });
    } catch (err) {
      if (err instanceof MetaApiError) {
        await enregistrerDernierTest({
          date: new Date().toISOString(),
          ok: false,
          erreur: err.message,
          metaCode: err.metaCode
        });
      }
      repondreErreur(res, err, next);
    }
  } catch (err) {
    next(err);
  }
}

/** POST /api/whatsapp/test-message — modèle hello_world au numéro de test (ou body.to). */
async function envoyerMessageTest(req, res, next) {
  try {
    const cfg = await lireConfiguration();
    const to = normalizePhone(req.body?.to || cfg.testPhone);
    if (!to) {
      return res.status(400).json({ message: 'Renseignez un numéro de test dans la configuration, puis enregistrez.' });
    }
    if (!isValidPhone(to)) return res.status(400).json({ message: PHONE_ERROR });
    const r = await envoyerWhatsApp({
      to,
      template: TEMPLATE_TEST.nom,
      langue: TEMPLATE_TEST.langue,
      contexte: 'test',
      createdBy: req.user.id,
      exigerActif: false
    });
    res.json({ ok: true, ...r, message: `Message de test envoyé au ${to} (vérifiez WhatsApp sur ce téléphone).` });
  } catch (err) {
    repondreErreur(res, err, next);
  }
}

/** POST /api/whatsapp/abonner-webhook — abonne l'app au WABA (facultatif, passage en production). */
async function abonnerWebhook(req, res, next) {
  try {
    const cfg = await lireConfiguration({ avecSecrets: true });
    if (cfg.etat === 'non_configure') {
      return res.status(400).json({ message: "Renseignez d'abord le Phone Number ID et le jeton d'accès." });
    }
    const json = await abonnerApp(cfg);
    res.json({
      ok: true,
      success: json.success !== false,
      message: 'Application abonnée aux webhooks du compte WhatsApp Business.'
    });
  } catch (err) {
    repondreErreur(res, err, next);
  }
}

/** GET /api/whatsapp/journal?limit&direction&statut */
async function listJournal(req, res, next) {
  try {
    const rows = await listerJournal({
      limit: req.query.limit,
      direction: req.query.direction,
      statut: req.query.statut,
      parcelId: req.query.parcelId,
      conversationId: req.query.conversationId
    });
    res.json({ rows });
  } catch (err) {
    repondreErreur(res, err, next);
  }
}

/** GET /api/whatsapp/journal/:id — ligne + payload JSON. */
async function getJournalItem(req, res, next) {
  try {
    const row = await detailJournal(req.params.id);
    if (!row) return res.status(404).json({ message: 'Message introuvable.' });
    res.json(row);
  } catch (err) {
    repondreErreur(res, err, next);
  }
}

/**
 * GET /api/whatsapp/webhook — vérification par Meta (« Vérifier et enregistrer ») :
 * hub.mode=subscribe & hub.verify_token=<jeton> & hub.challenge=<nombre> → renvoyer le challenge.
 */
async function webhookVerify(req, res, next) {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const cfg = await lireConfiguration();
    if (mode === 'subscribe' && cfg.verifyToken && egalSecurise(token, cfg.verifyToken)) {
      await marquerWebhookVerifie();
      return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }
    res.status(403).json({ message: 'Jeton de vérification invalide.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/whatsapp/webhook — accusés et messages entrants. Signature
 * X-Hub-Signature-256 vérifiée si la clé secrète de l'app est enregistrée ;
 * réponse 200 immédiate puis traitement (Meta réessaie pendant 36 h sinon).
 */
async function webhookReceive(req, res, next) {
  try {
    const cfg = await lireConfiguration({ avecSecrets: true });
    if (cfg.appSecretClair) {
      if (!verifierSignature(req.rawBody, req.get('x-hub-signature-256'), cfg.appSecretClair)) {
        return res.status(401).json({ message: 'Signature invalide.' });
      }
    } else {
      console.warn("[whatsapp] webhook accepté sans vérification de signature (clé secrète de l'app non enregistrée).");
    }
    res.sendStatus(200);
    traiterWebhook(req.body).catch((err) => {
      console.error(`[whatsapp] traitement webhook : ${err.message}`);
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getConfiguration,
  saveConfiguration,
  testerConnexion,
  envoyerMessageTest,
  abonnerWebhook,
  listJournal,
  getJournalItem,
  webhookVerify,
  webhookReceive
};
