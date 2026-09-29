const pool = require('../config/db');
const { crmDisponible } = require('../utils/whatsappSchema');
const wa = require('./whatsapp');
const { lireParametresCrm, secondesAvantFinCalme } = require('./whatsappParametres');
const ev = require('./whatsappEvenements');
const { modeleParNomLangue, rendreModele } = require('./whatsappModeles');
const { assurerConversation } = require('./whatsappConversations');
const { notificationClientAutorisee } = require('./whatsappPreferencesClient');

/*
 * Actions automatiques WhatsApp (delevery_whatsapp_regle) — page
 * /admin/api-liaison/whatsapp/actions.
 * - CRUD + validation des règles (événement du catalogue, audience autorisée,
 *   correspondance des variables, nombre de paramètres du modèle).
 * - Émetteur : emettreEvenement(code, payload) est appelé par les contrôleurs
 *   métier APRÈS commit (une ligne, synchrone, ne lève jamais). Les événements
 *   sont empilés en mémoire et traités un par un (une seule promesse en vol :
 *   un import de 500 colis ne sature pas le pool MySQL). Chaque règle active
 *   de l'événement résout ses destinataires, applique conditions, préférences
 *   du client expéditeur (whatsappPreferencesClient), opt-out, anti-doublon,
 *   délai et heures calmes, puis met l'envoi dans la file (statut 'planifie',
 *   jobs/whatsappFile.js).
 * - testerRegle : rendu à blanc d'une règle (formulaire, sans sauvegarde) sur
 *   un colis réel, envoi optionnel au numéro de test.
 */

const CACHE_MS = 60 * 1000;
const FILE_MAX = 5000;
const DELAI_MAX_MINUTES = 7 * 24 * 60;
const DEDUP_MAX_HEURES = 720;
const LANGUES = ['fr', 'ar', 'en', 'en_US', 'en_GB', 'es', 'fr_FR'];

/* ------------------------------------------------------------------ */
/* Lecture / validation                                                */
/* ------------------------------------------------------------------ */

function toRegle(row) {
  const evt = ev.EVENEMENTS_PAR_CODE[row.wamr_evenement];
  const conditions = wa.parseJson(row.wamr_conditions) || {};
  return {
    id: row.wamr_id,
    nom: row.wamr_nom,
    evenement: row.wamr_evenement,
    evenementLabel: evt?.label || row.wamr_evenement,
    contexte: evt?.contexte || null,
    conditions: {
      codes: Array.isArray(conditions.codes) ? conditions.codes : [],
      clients: Array.isArray(conditions.clients) ? conditions.clients.map(Number) : []
    },
    audience: row.wamr_audience,
    audienceLabel: ev.AUDIENCES[row.wamr_audience] || row.wamr_audience,
    cibles: (wa.parseJson(row.wamr_cibles) || []).map(Number),
    modele: row.wamr_modele,
    langue: row.wamr_langue,
    params: wa.parseJson(row.wamr_params) || [],
    delaiMinutes: Number(row.wamr_delai_minutes) || 0,
    dedupHeures: Number(row.wamr_dedup_heures) || 0,
    heuresCalmes: Number(row.wamr_heures_calmes) === 1,
    actif: Number(row.wamr_actif) === 1,
    createdBy: row.wamr_created_by,
    createdAt: row.wamr_created_at,
    updatedAt: row.wamr_updated_at,
    envoyes30j: Number(row.envoyes30j) || 0,
    echecs30j: Number(row.echecs30j) || 0
  };
}

const SELECT_REGLE = `
  SELECT r.*,
         (SELECT COUNT(*) FROM delevery_whatsapp_message m
           WHERE m.wam_regle = r.wamr_id AND m.wam_statut IN ('envoye', 'remis', 'lu')
             AND m.wam_created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS envoyes30j,
         (SELECT COUNT(*) FROM delevery_whatsapp_message m
           WHERE m.wam_regle = r.wamr_id AND m.wam_statut = 'echec'
             AND m.wam_created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS echecs30j
    FROM delevery_whatsapp_regle r`;

async function listerRegles() {
  const [rows] = await pool.query(`${SELECT_REGLE} ORDER BY r.wamr_actif DESC, r.wamr_evenement, r.wamr_id`);
  return rows.map(toRegle);
}

async function regleParId(id) {
  const [[row]] = await pool.query(`${SELECT_REGLE} WHERE r.wamr_id = ? LIMIT 1`, [Number(id)]);
  return row ? toRegle(row) : null;
}

function entiersPositifs(liste) {
  return [...new Set((Array.isArray(liste) ? liste : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * Valide un corps de règle. Renvoie { erreurs: [], avertissements: [], regle }
 * (regle = valeurs normalisées prêtes à l'enregistrement).
 */
async function validerRegle(body) {
  const erreurs = [];
  const avertissements = [];
  const b = body || {};
  const evenement = String(b.evenement || '').trim();
  const evt = ev.EVENEMENTS_PAR_CODE[evenement];
  if (!evt) erreurs.push('Événement inconnu.');

  const audience = String(b.audience || '').trim();
  if (!ev.AUDIENCES[audience]) erreurs.push('Audience invalide.');
  else if (evt && !evt.audiences.includes(audience)) {
    erreurs.push(`Audience « ${ev.AUDIENCES[audience]} » non disponible pour cet événement.`);
  }

  const cibles = audience === 'admin' ? entiersPositifs(b.cibles) : [];
  if (audience === 'admin' && !cibles.length) erreurs.push('Choisissez au moins un employé à notifier.');

  const codes = evt?.statuts
    ? [...new Set((Array.isArray(b.conditions?.codes) ? b.conditions.codes : []).map((c) => String(c).trim().toUpperCase().slice(0, 50)).filter(Boolean))]
    : [];
  const clients = entiersPositifs(b.conditions?.clients);

  const modele = String(b.modele || '').trim().slice(0, 100);
  const langue = String(b.langue || 'fr').trim().slice(0, 10);
  if (!modele) erreurs.push('Choisissez un modèle de message.');
  if (!LANGUES.includes(langue) && !/^[a-z]{2}(_[A-Z]{2})?$/.test(langue)) erreurs.push('Langue du modèle invalide.');

  const paramsBruts = Array.isArray(b.params) ? b.params : [];
  const params = [];
  const contexte = evt?.contexte;
  const variablesOk = contexte ? new Set(ev.variablesPourContexte(contexte).map((v) => v.code)) : new Set();
  paramsBruts.forEach((p, i) => {
    const n = i + 1;
    if (typeof p === 'string') {
      if (!variablesOk.has(p)) erreurs.push(`Variable {{${n}}} : « ${p} » indisponible pour cet événement.`);
      else params.push({ type: 'variable', code: p });
      return;
    }
    if (!p || typeof p !== 'object') {
      erreurs.push(`Variable {{${n}}} : valeur manquante.`);
      return;
    }
    if (p.type === 'fixe') {
      const texte = String(p.texte ?? '').trim().slice(0, 300);
      if (!texte) erreurs.push(`Variable {{${n}}} : le texte fixe est vide.`);
      else params.push({ type: 'fixe', texte });
      return;
    }
    const code = String(p.code || '').trim();
    if (!variablesOk.has(code)) erreurs.push(`Variable {{${n}}} : « ${code || '—'} » indisponible pour cet événement.`);
    else params.push({ type: 'variable', code });
  });

  let modeleLocal = null;
  if (modele) {
    modeleLocal = await modeleParNomLangue(modele, langue);
    if (!modeleLocal) {
      avertissements.push(`Modèle « ${modele} » (${langue}) inconnu localement : synchronisez les modèles depuis Meta.`);
    } else {
      if (modeleLocal.nbVariables !== params.length) {
        erreurs.push(`Le modèle attend ${modeleLocal.nbVariables} variable(s), ${params.length} fournie(s).`);
      }
      if (!modeleLocal.utilisable) {
        avertissements.push(
          `Modèle non utilisable actuellement (${modeleLocal.statut}${modeleLocal.nonSupporte ? ` — ${modeleLocal.nonSupporte}` : ''}) : la règle n'enverra rien tant qu'il n'est pas approuvé.`
        );
      }
    }
  }

  const delaiMinutes = Number(b.delaiMinutes) || 0;
  if (!Number.isInteger(delaiMinutes) || delaiMinutes < 0 || delaiMinutes > DELAI_MAX_MINUTES) {
    erreurs.push(`Délai invalide (0 à ${DELAI_MAX_MINUTES} minutes).`);
  }
  const dedupHeures = Number(b.dedupHeures) || 0;
  if (!Number.isInteger(dedupHeures) || dedupHeures < 0 || dedupHeures > DEDUP_MAX_HEURES) {
    erreurs.push(`Anti-doublon invalide (0 à ${DEDUP_MAX_HEURES} heures).`);
  }
  const nom = String(b.nom || '').trim().slice(0, 100) || `${evt?.label || evenement} → ${ev.AUDIENCES[audience] || audience}`;

  return {
    erreurs,
    avertissements,
    regle: {
      nom,
      evenement,
      conditions: { codes, clients },
      audience,
      cibles,
      modele,
      langue,
      params,
      delaiMinutes,
      dedupHeures,
      heuresCalmes: b.heuresCalmes === undefined ? true : Boolean(b.heuresCalmes),
      actif: b.actif === undefined ? true : Boolean(b.actif)
    },
    modeleLocal
  };
}

async function creerRegle(regle, userId) {
  const [ins] = await pool.query(
    `INSERT INTO delevery_whatsapp_regle
       (wamr_nom, wamr_evenement, wamr_conditions, wamr_audience, wamr_cibles, wamr_modele, wamr_langue,
        wamr_params, wamr_delai_minutes, wamr_dedup_heures, wamr_heures_calmes, wamr_actif,
        wamr_created_by, wamr_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      regle.nom,
      regle.evenement,
      JSON.stringify(regle.conditions),
      regle.audience,
      JSON.stringify(regle.cibles),
      regle.modele,
      regle.langue,
      JSON.stringify(regle.params),
      regle.delaiMinutes,
      regle.dedupHeures,
      regle.heuresCalmes ? 1 : 0,
      regle.actif ? 1 : 0,
      Number(userId) || 0
    ]
  );
  invaliderCacheRegles();
  return regleParId(ins.insertId);
}

async function modifierRegle(id, regle) {
  const [r] = await pool.query(
    `UPDATE delevery_whatsapp_regle
        SET wamr_nom = ?, wamr_evenement = ?, wamr_conditions = ?, wamr_audience = ?, wamr_cibles = ?,
            wamr_modele = ?, wamr_langue = ?, wamr_params = ?, wamr_delai_minutes = ?, wamr_dedup_heures = ?,
            wamr_heures_calmes = ?, wamr_actif = ?, wamr_updated_at = NOW()
      WHERE wamr_id = ?`,
    [
      regle.nom,
      regle.evenement,
      JSON.stringify(regle.conditions),
      regle.audience,
      JSON.stringify(regle.cibles),
      regle.modele,
      regle.langue,
      JSON.stringify(regle.params),
      regle.delaiMinutes,
      regle.dedupHeures,
      regle.heuresCalmes ? 1 : 0,
      regle.actif ? 1 : 0,
      Number(id)
    ]
  );
  invaliderCacheRegles();
  return r.affectedRows ? regleParId(id) : null;
}

async function activerRegle(id, actif) {
  const [r] = await pool.query(
    'UPDATE delevery_whatsapp_regle SET wamr_actif = ?, wamr_updated_at = NOW() WHERE wamr_id = ?',
    [actif ? 1 : 0, Number(id)]
  );
  invaliderCacheRegles();
  return r.affectedRows ? regleParId(id) : null;
}

async function supprimerRegle(id) {
  const [r] = await pool.query('DELETE FROM delevery_whatsapp_regle WHERE wamr_id = ?', [Number(id)]);
  invaliderCacheRegles();
  return r.affectedRows > 0;
}

/* ------------------------------------------------------------------ */
/* Émetteur                                                            */
/* ------------------------------------------------------------------ */

let cacheRegles = { parCode: {}, expire: 0 };

async function reglesActivesParCode() {
  const now = Date.now();
  if (now < cacheRegles.expire) return cacheRegles.parCode;
  const [rows] = await pool.query('SELECT r.* FROM delevery_whatsapp_regle r WHERE r.wamr_actif = 1 ORDER BY r.wamr_id');
  const parCode = {};
  for (const row of rows) {
    const regle = toRegle(row);
    (parCode[regle.evenement] = parCode[regle.evenement] || []).push(regle);
  }
  cacheRegles = { parCode, expire: now + CACHE_MS };
  return parCode;
}

function invaliderCacheRegles() {
  cacheRegles = { parCode: {}, expire: 0 };
}

const file = [];
let traitement = false;
let avertiMigration = false;

/**
 * Point d'entrée des contrôleurs métier : synchrone, jamais d'exception.
 * À appeler après commit, avec un payload d'identifiants.
 */
function emettreEvenement(code, payload = {}) {
  if (!ev.EVENEMENTS_PAR_CODE[code]) {
    console.warn(`[whatsapp] événement inconnu ignoré : ${code}`);
    return;
  }
  if (file.length >= FILE_MAX) {
    console.warn(`[whatsapp] file d'événements saturée (${FILE_MAX}) : ${code} ignoré.`);
    return;
  }
  file.push({ code, payload: payload || {} });
  if (!traitement) traiterFile();
}

async function traiterFile() {
  traitement = true;
  try {
    while (file.length) {
      const item = file.shift();
      try {
        await traiterEvenement(item.code, item.payload);
      } catch (err) {
        console.warn(`[whatsapp] événement ${item.code} : ${err.message}`);
      }
    }
  } finally {
    traitement = false;
  }
}

async function traiterEvenement(code, payload) {
  if (!(await crmDisponible())) {
    if (!avertiMigration) {
      avertiMigration = true;
      console.warn('[whatsapp] actions automatiques inactives : migration CRM non exécutée.');
    }
    return;
  }
  const regles = (await reglesActivesParCode())[code] || [];
  if (!regles.length) return;
  const params = await lireParametresCrm();
  if (!params.automatisationsActif) return;
  const cfg = await wa.lireConfiguration();
  if (cfg.etat !== 'pret') return;
  const evt = ev.EVENEMENTS_PAR_CODE[code];
  const data = await ev.resoudreContexte(evt.contexte, payload);
  if (!data) return;
  for (const regle of regles) {
    try {
      await appliquerRegle(regle, evt, data, payload, params);
    } catch (err) {
      console.warn(`[whatsapp] règle ${regle.id} (${regle.nom}) : ${err.message}`);
    }
  }
}

/** Ligne 'echec' sans appel Meta (numéro invalide, modèle non utilisable…). */
async function journaliserEchec({ phone, regle, parcelId, conversationId, contenu, code, message }) {
  const id = await wa.journaliserSortant({
    phone: wa.tronquer(phone || '?', 20),
    type: 'template',
    template: regle.modele,
    contenu: contenu || `Modèle ${regle.modele} (${regle.langue})`,
    payload: { to: phone, template: { name: regle.modele, language: { code: regle.langue } } },
    contexte: `regle:${regle.evenement}`,
    parcelId,
    createdBy: 0,
    statut: 'echec',
    regleId: regle.id,
    conversationId
  });
  await pool.query(
    'UPDATE delevery_whatsapp_message SET wam_erreur_code = ?, wam_erreur_message = ?, wam_updated_at = NOW() WHERE wam_id = ?',
    [wa.tronquer(code, 20), wa.tronquer(message, 500), id]
  );
}

function conditionsOk(regle, evt, data, payload) {
  const cond = regle.conditions || {};
  if (evt.statuts && cond.codes.length) {
    const code = String(payload.code || data.statut_code || '').toUpperCase();
    if (!cond.codes.includes(code)) return false;
  }
  if (cond.clients.length) {
    const cid = Number(data._ids?.customerId);
    if (!cid || !cond.clients.includes(cid)) return false;
  }
  return true;
}

async function appliquerRegle(regle, evt, data, payload, params) {
  if (!conditionsOk(regle, evt, data, payload)) return;
  const destinataires = await ev.phonesAudience(regle.audience, data, regle.cibles);
  if (!destinataires.length) return;
  const modele = await modeleParNomLangue(regle.modele, regle.langue);
  const paramsMsg = ev.construireParams(regle.params, data, regle.langue);
  const contenu = modele ? rendreModele(modele, paramsMsg) : undefined;
  const delaiSecondes = (Number(regle.delaiMinutes) || 0) * 60;

  for (const d of destinataires) {
    // Client expéditeur ayant désactivé cette notification (/client/configuration
    // ou modale Options de /admin/clients) : rien n'est envoyé ni journalisé.
    if (d.type === 'client' && d.customerId && !(await notificationClientAutorisee(d.customerId, evt.code))) continue;
    const phone = wa.toE164Maroc(d.phone);
    const parcelId = d.parcelId || null;
    if (!phone) {
      await journaliserEchec({
        phone: d.phone,
        regle,
        parcelId,
        contenu,
        code: 'numero_invalide',
        message: `Numéro invalide pour ${d.nom || d.type} : « ${d.phone || '—'} ».`
      });
      continue;
    }
    const conv = await assurerConversation(phone, {
      nom: d.nom,
      type: d.type,
      customerId: d.customerId,
      userId: d.userId,
      parcelId
    });
    if (conv.optOut) continue;
    if (modele && !modele.utilisable) {
      await journaliserEchec({
        phone,
        regle,
        parcelId,
        conversationId: conv.id,
        contenu,
        code: 'modele',
        message: `Modèle ${regle.modele} (${regle.langue}) non utilisable : ${modele.statut}${modele.nonSupporte ? ` — ${modele.nonSupporte}` : ''}.`
      });
      continue;
    }
    if (modele && modele.nbVariables !== paramsMsg.length) {
      await journaliserEchec({
        phone,
        regle,
        parcelId,
        conversationId: conv.id,
        contenu,
        code: 'parametres',
        message: `Le modèle attend ${modele.nbVariables} variable(s), la règle en fournit ${paramsMsg.length}.`
      });
      continue;
    }
    if (regle.dedupHeures > 0) {
      const [[dup]] = await pool.query(
        `SELECT 1 AS x FROM delevery_whatsapp_message
          WHERE wam_regle = ? AND wam_phone = ? AND (? IS NULL OR wam_parcel_id = ?)
            AND wam_statut <> 'echec'
            AND wam_created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          LIMIT 1`,
        [regle.id, phone, parcelId, parcelId, regle.dedupHeures]
      );
      if (dup) continue;
    }
    // Anti-rafale : même modèle, même numéro (et même colis) depuis moins d'une minute.
    const [[rafale]] = await pool.query(
      `SELECT 1 AS x FROM delevery_whatsapp_message
        WHERE wam_direction = 'sortant' AND wam_phone = ? AND wam_template = ?
          AND (? IS NULL OR wam_parcel_id = ?) AND wam_statut <> 'echec'
          AND wam_created_at >= DATE_SUB(NOW(), INTERVAL 60 SECOND)
        LIMIT 1`,
      [phone, regle.modele, parcelId, parcelId]
    );
    if (rafale) continue;

    let attente = delaiSecondes;
    if (regle.heuresCalmes) {
      attente += secondesAvantFinCalme(new Date(Date.now() + attente * 1000), params);
    }
    try {
      await wa.planifierEnvoi({
        to: phone,
        template: regle.modele,
        langue: regle.langue,
        params: paramsMsg,
        contenu,
        contexte: `regle:${evt.code}`,
        parcelId,
        createdBy: 0,
        regleId: regle.id,
        conversationId: conv.id,
        planifieDansSecondes: attente
      });
    } catch (err) {
      console.warn(`[whatsapp] règle ${regle.id} : mise en file impossible (${err.message})`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Test d'une règle                                                    */
/* ------------------------------------------------------------------ */

/** Payload d'événement « réaliste » pour un contexte, à partir d'un code colis (ou du dernier objet). */
async function payloadDeTest(contexte, parcelCode) {
  let parcel = null;
  if (parcelCode) {
    const [[p]] = await pool.query(
      'SELECT parcel_id, parcel_customer, parcel_livreur, parcel_phone FROM delevery_parcel WHERE parcel_code = ? LIMIT 1',
      [String(parcelCode).trim()]
    );
    if (!p) return { erreur: `Colis « ${parcelCode} » introuvable.` };
    parcel = p;
  }
  const dernier = async (sql, params = []) => {
    const [[row]] = await pool.query(sql, params);
    return row || null;
  };
  switch (contexte) {
    case 'COLIS':
    case 'RECLAMATION':
    case 'REMBOURSEMENT':
    case 'MODIF': {
      if (!parcel) {
        parcel = await dernier('SELECT parcel_id, parcel_customer FROM delevery_parcel ORDER BY parcel_id DESC LIMIT 1');
        if (!parcel) return { erreur: 'Aucun colis en base.' };
      }
      if (contexte === 'COLIS') return { parcelId: parcel.parcel_id, commentaire: 'Commentaire de test' };
      if (contexte === 'RECLAMATION') {
        const r = await dernier(
          'SELECT reclamation_id FROM delevery_reclamation_suivre WHERE reclamation_parcel = ? ORDER BY reclamation_id DESC LIMIT 1',
          [parcel.parcel_id]
        );
        return r ? { reclamationId: r.reclamation_id, parcelId: parcel.parcel_id } : { erreur: 'Aucune réclamation sur ce colis.' };
      }
      if (contexte === 'REMBOURSEMENT') {
        const r = await dernier(
          'SELECT remb_id FROM delevery_remboursement WHERE remb_parcel_id = ? ORDER BY remb_id DESC LIMIT 1',
          [parcel.parcel_id]
        );
        return r ? { rembId: r.remb_id, parcelId: parcel.parcel_id } : { erreur: 'Aucune demande de remboursement sur ce colis.' };
      }
      const m = await dernier(
        'SELECT pmd_id FROM delevery_parcel_modif_demande WHERE pmd_parcel = ? ORDER BY pmd_id DESC LIMIT 1',
        [parcel.parcel_id]
      );
      return m ? { demandeId: m.pmd_id, parcelId: parcel.parcel_id } : { erreur: 'Aucune demande de modification sur ce colis.' };
    }
    case 'LOT_COLIS': {
      const customerId = parcel?.parcel_customer || (await dernier('SELECT customers_id FROM delevery_customers ORDER BY customers_id DESC LIMIT 1'))?.customers_id;
      return customerId ? { customerId, nb: 3, parcelIds: parcel ? [parcel.parcel_id] : [] } : { erreur: 'Aucun client en base.' };
    }
    case 'RAMASSAGE': {
      const r = parcel
        ? await dernier('SELECT pickup_request_id FROM delevery_pickup_request WHERE pickup_request_customer = ? ORDER BY pickup_request_id DESC LIMIT 1', [parcel.parcel_customer])
        : await dernier('SELECT pickup_request_id FROM delevery_pickup_request ORDER BY pickup_request_id DESC LIMIT 1');
      return r ? { demandeId: r.pickup_request_id } : { erreur: 'Aucune demande de ramassage trouvée.' };
    }
    case 'BON_DISTRIBUTION': {
      const b = parcel
        ? await dernier('SELECT dis_parcels_dis AS id FROM delevery_dis_parcels WHERE dis_parcels_parcel = ? ORDER BY dis_parcels_id DESC LIMIT 1', [parcel.parcel_id])
        : await dernier('SELECT distribution_note_id AS id FROM delevery_distribution_note ORDER BY distribution_note_id DESC LIMIT 1');
      return b ? { bonId: b.id } : { erreur: 'Aucun bon de distribution trouvé.' };
    }
    case 'BON_RETOUR_CLIENT': {
      const b = parcel
        ? await dernier('SELECT rnc_parcels_rnc AS id FROM delevery_rnc_parcels WHERE rnc_parcels_parcel = ? ORDER BY rnc_parcels_id DESC LIMIT 1', [parcel.parcel_id])
        : await dernier('SELECT rnc_id AS id FROM delevery_return_note_client ORDER BY rnc_id DESC LIMIT 1');
      return b ? { bonId: b.id } : { erreur: 'Aucun bon de retour client trouvé.' };
    }
    case 'FACTURE_CLIENT': {
      const f = parcel
        ? await dernier('SELECT invoice_id AS id FROM delevery_invoice WHERE invoice_customer = ? ORDER BY invoice_id DESC LIMIT 1', [parcel.parcel_customer])
        : await dernier('SELECT invoice_id AS id FROM delevery_invoice ORDER BY invoice_id DESC LIMIT 1');
      return f ? { factureId: f.id } : { erreur: 'Aucune facture client trouvée.' };
    }
    case 'FACTURE_LIVREUR': {
      const f = parcel?.parcel_livreur
        ? await dernier('SELECT payment_note_id AS id FROM delevery_payment_note WHERE payment_note_for = ? AND payment_note_type = 1 ORDER BY payment_note_id DESC LIMIT 1', [parcel.parcel_livreur])
        : await dernier('SELECT payment_note_id AS id FROM delevery_payment_note WHERE payment_note_type = 1 ORDER BY payment_note_id DESC LIMIT 1');
      return f ? { factureId: f.id } : { erreur: 'Aucune facture livreur trouvée.' };
    }
    case 'MESSAGE_RECU': {
      const c = await dernier('SELECT wac_id FROM delevery_whatsapp_conversation ORDER BY wac_dernier_entrant_le DESC LIMIT 1');
      return c ? { conversationId: c.wac_id } : { erreur: 'Aucune discussion WhatsApp en base.' };
    }
    default:
      return { erreur: 'Contexte inconnu.' };
  }
}

/**
 * Rendu à blanc d'une règle (corps du formulaire) : destinataires résolus,
 * paramètres et aperçu. `envoyer` = envoi réel au numéro de test de la
 * configuration (jamais aux vrais destinataires).
 */
async function testerRegle(body, { parcelCode, envoyer = false, userId = 0 } = {}) {
  const v = await validerRegle(body);
  if (v.erreurs.length) return { erreurs: v.erreurs };
  const { regle, modeleLocal } = v;
  const evt = ev.EVENEMENTS_PAR_CODE[regle.evenement];
  const payload = await payloadDeTest(evt.contexte, parcelCode);
  if (payload.erreur) return { erreurs: [payload.erreur] };
  if (evt.statuts && regle.conditions.codes.length) payload.code = regle.conditions.codes[0];
  const data = await ev.resoudreContexte(evt.contexte, payload);
  if (!data) return { erreurs: ['Données introuvables pour ce test.'] };
  const destinataires = [];
  for (const d of await ev.phonesAudience(regle.audience, data, regle.cibles)) {
    destinataires.push({
      ...d,
      phone: wa.toE164Maroc(d.phone) || d.phone,
      valide: Boolean(wa.toE164Maroc(d.phone)),
      // Client expéditeur ayant désactivé cette notification : signalé dans le
      // rendu du test (l'envoi réel de la règle l'ignorerait).
      desactiveParClient:
        d.type === 'client' && Boolean(d.customerId) && !(await notificationClientAutorisee(d.customerId, evt.code))
    });
  }
  const params = ev.construireParams(regle.params, data, regle.langue);
  const apercu = modeleLocal ? rendreModele(modeleLocal, params) : params.join(' · ');
  const resultat = {
    erreurs: [],
    avertissements: v.avertissements,
    conditionsOk: conditionsOk(regle, evt, data, payload),
    destinataires,
    params,
    apercu,
    modele: modeleLocal,
    variables: Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_')))
  };
  if (envoyer) {
    const cfg = await wa.lireConfiguration();
    if (!cfg.testPhone) return { ...resultat, erreurs: ['Renseignez un numéro de test dans la configuration.'] };
    const r = await wa.envoyerWhatsApp({
      to: cfg.testPhone,
      template: regle.modele,
      langue: regle.langue,
      params,
      contenu: apercu,
      contexte: `test_regle:${regle.evenement}`,
      parcelId: data._ids?.parcelId || null,
      createdBy: userId,
      exigerActif: false
    });
    resultat.envoi = { ok: true, journalId: r.id, to: cfg.testPhone };
  }
  return resultat;
}

module.exports = {
  listerRegles,
  regleParId,
  validerRegle,
  creerRegle,
  modifierRegle,
  activerRegle,
  supprimerRegle,
  invaliderCacheRegles,
  emettreEvenement,
  testerRegle
};
