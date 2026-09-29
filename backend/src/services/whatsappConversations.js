const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { phoneVariants, formatPhoneAffichage } = require('../utils/phone');
const { STATUT_CODE_SQL, STATUT_TYPE_SQL } = require('../utils/statutEffectif');
const { LIVREUR_PHONE_SQL } = require('../utils/livreurPhone');
const { statutLabel } = require('../utils/statutLabels');
const wa = require('./whatsapp');
const { lireParametresCrm, estOptOut } = require('./whatsappParametres');
const { modeleParNomLangue, rendreModele } = require('./whatsappModeles');
const { chargerColis, chargerClient, chargerUtilisateur, construireParams, TYPES_CONTACT } = require('./whatsappEvenements');

/*
 * Discussions WhatsApp (delevery_whatsapp_conversation) — page
 * /admin/api-liaison/whatsapp/discussions.
 * - Une conversation par numéro (E.164 sans « + ») ; le contact est résolu
 *   sur les 9 derniers chiffres : client (customers_phone / personnel),
 *   livreur ou employé (users_phone), destinataire (parcel_phone du dernier
 *   colis), sinon inconnu. Envoi à un client : téléphone personnel en
 *   priorité, téléphone du magasin en repli.
 * - Message entrant (webhook) : compteur de non lus, fenêtre de 24 h, aperçu,
 *   liaison au colis (message cité ou dernier colis), téléchargement du média,
 *   opt-out par mot-clé, étiquette « bouton:… » pour une réponse par bouton
 *   (jamais de changement de statut colis), réponse automatique, événement
 *   MESSAGE_RECU vers les actions automatiques.
 * - Boîte de réception : liste filtrée / paginée (uniquement les discussions
 *   où le contact a répondu au moins une fois : les envois sans réponse ne
 *   sont pas listés), détail (marque lu, accusé de lecture Meta,
 *   auto-affectation), envoi texte / image / message vocal (fenêtre ouverte)
 *   ou modèle, notes internes, affectation, statut, colis lié, opt-out.
 */

const STATUTS_CONVERSATION = ['nouveau', 'en_cours', 'termine'];
const MEDIA_DIR = path.join(UPLOADS_ROOT, 'whatsapp');
const ENVOI_DIR = path.join(MEDIA_DIR, 'envoi');
const MESSAGES_MAX = 500;
const EXT_PAR_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf'
};
const TYPES_MEDIA = ['image', 'audio', 'video', 'document', 'sticker'];

function ensureEnvoiDir() {
  fs.mkdirSync(ENVOI_DIR, { recursive: true });
  return ENVOI_DIR;
}

/* ------------------------------------------------------------------ */
/* Contact / conversation                                              */
/* ------------------------------------------------------------------ */

/** Qui est derrière ce numéro ? { type, nom, customerId, userId, parcelId }. */
async function resoudreContact(phone) {
  const variants = phoneVariants(phone);
  const [[c]] = await pool.query(
    `SELECT customers_id, COALESCE(NULLIF(TRIM(customers_store), ''), customers_name) AS nom
       FROM delevery_customers
      WHERE customers_phone IN (?) OR customers_phone_personal IN (?)
      ORDER BY customers_active DESC, customers_id DESC LIMIT 1`,
    [variants, variants]
  );
  if (c) return { type: 'client', nom: c.nom || '', customerId: c.customers_id };
  const [[u]] = await pool.query(
    `SELECT users_id, users_name, users_type FROM delevery_users
      WHERE users_phone IN (?) AND users_active = 1
      ORDER BY (users_type = '5') DESC, users_id DESC LIMIT 1`,
    [variants]
  );
  if (u) return { type: Number(u.users_type) === 5 ? 'livreur' : 'employe', nom: u.users_name || '', userId: u.users_id };
  const [[p]] = await pool.query(
    'SELECT parcel_id, parcel_receiver FROM delevery_parcel WHERE parcel_phone IN (?) ORDER BY parcel_id DESC LIMIT 1',
    [variants]
  );
  if (p) return { type: 'destinataire', nom: p.parcel_receiver || '', parcelId: p.parcel_id };
  return { type: 'inconnu', nom: '' };
}

/**
 * Conversation d'un numéro (créée si besoin). infos facultatives : nom, type,
 * customerId, userId, parcelId (dernier colis). Renvoie { id, optOut, nouveau }.
 */
async function assurerConversation(phone, infos = {}) {
  const [[existant]] = await pool.query(
    'SELECT wac_id, wac_opt_out, wac_type_contact FROM delevery_whatsapp_conversation WHERE wac_phone = ? LIMIT 1',
    [phone]
  );
  if (existant) {
    const sets = [];
    const params = [];
    if (infos.parcelId) {
      sets.push('wac_dernier_colis = ?');
      params.push(Number(infos.parcelId));
    }
    if (infos.nom) {
      sets.push("wac_nom = COALESCE(NULLIF(wac_nom, ''), ?)");
      params.push(wa.tronquer(infos.nom, 150));
    }
    if (existant.wac_type_contact === 'inconnu' && infos.type && infos.type !== 'inconnu') {
      sets.push('wac_type_contact = ?', 'wac_customer = COALESCE(wac_customer, ?)', 'wac_user_contact = COALESCE(wac_user_contact, ?)');
      params.push(infos.type, infos.customerId || null, infos.userId || null);
    }
    if (sets.length) {
      await pool.query(
        `UPDATE delevery_whatsapp_conversation SET ${sets.join(', ')}, wac_updated_at = NOW() WHERE wac_id = ?`,
        [...params, existant.wac_id]
      );
    }
    return { id: existant.wac_id, optOut: Number(existant.wac_opt_out) === 1, nouveau: false };
  }
  const contact = infos.type && infos.type !== 'inconnu' ? infos : { ...(await resoudreContact(phone)), ...infos };
  try {
    const [ins] = await pool.query(
      `INSERT INTO delevery_whatsapp_conversation
         (wac_phone, wac_nom, wac_type_contact, wac_customer, wac_user_contact, wac_dernier_colis, wac_created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        phone,
        contact.nom ? wa.tronquer(contact.nom, 150) : null,
        contact.type || 'inconnu',
        contact.customerId || null,
        contact.userId || null,
        contact.parcelId || null
      ]
    );
    return { id: ins.insertId, optOut: false, nouveau: true };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const [[row]] = await pool.query(
      'SELECT wac_id, wac_opt_out FROM delevery_whatsapp_conversation WHERE wac_phone = ? LIMIT 1',
      [phone]
    );
    return { id: row.wac_id, optOut: Number(row.wac_opt_out) === 1, nouveau: false };
  }
}

/* ------------------------------------------------------------------ */
/* Message entrant (webhook)                                           */
/* ------------------------------------------------------------------ */

function extensionPour(mime, nomFichier) {
  const ext = path.extname(nomFichier || '').toLowerCase().replace('.', '');
  if (ext && /^[a-z0-9]{1,5}$/.test(ext)) return ext;
  return EXT_PAR_MIME[String(mime || '').split(';')[0]] || 'bin';
}

/** Télécharge le média d'un message entrant sous uploads/whatsapp/AAAA-MM/ ; renvoie le chemin relatif ou null. */
async function enregistrerMediaEntrant(cfg, messageId, msg, type) {
  const media = msg[type];
  if (!media?.id) return null;
  const { buffer, mime } = await wa.telechargerMedia(cfg, media.id);
  const now = new Date();
  const dossier = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(MEDIA_DIR, dossier);
  fs.mkdirSync(dir, { recursive: true });
  const nom = `${messageId}-${crypto.randomBytes(4).toString('hex')}.${extensionPour(mime, media.filename)}`;
  await fs.promises.writeFile(path.join(dir, nom), buffer);
  return { chemin: `whatsapp/${dossier}/${nom}`, mime: String(mime || '').split(';')[0].slice(0, 50) };
}

/**
 * Traitement CRM d'un message entrant déjà journalisé (appelé par
 * services/whatsapp.js après l'INSERT, uniquement pour un message nouveau).
 */
async function traiterEntrant({ messageId, msg, nom, type, contenu, cfg }) {
  const phone = wa.toE164Maroc(msg.from) || wa.tronquer(String(msg.from), 20);
  const params = await lireParametresCrm();
  const conv = await assurerConversation(phone, { nom });
  const [[etat]] = await pool.query(
    'SELECT wac_non_lus, wac_dernier_colis, wac_opt_out, wac_auto_reponse_le FROM delevery_whatsapp_conversation WHERE wac_id = ? LIMIT 1',
    [conv.id]
  );

  // Colis lié : message cité (context.id → colis du sortant d'origine) sinon dernier colis.
  let parcelId = null;
  const citeWamid = msg.context?.id ? wa.tronquer(msg.context.id, 191) : null;
  if (citeWamid) {
    const [[orig]] = await pool.query('SELECT wam_parcel_id FROM delevery_whatsapp_message WHERE wam_wamid = ? LIMIT 1', [
      citeWamid
    ]);
    parcelId = orig?.wam_parcel_id || null;
  }
  if (!parcelId) parcelId = etat?.wac_dernier_colis || null;

  const optOut = type === 'text' && estOptOut(contenu, params);
  let etiquette = null;
  if (type === 'button' && msg.button?.payload) etiquette = `bouton:${msg.button.payload}`;
  else if (type === 'interactive' && msg.interactive?.button_reply?.id) etiquette = `bouton:${msg.interactive.button_reply.id}`;
  if (etiquette) etiquette = wa.tronquer(etiquette.replace(/[,\s]+/g, '_'), 60);

  await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_conversation = ?, wam_parcel_id = COALESCE(wam_parcel_id, ?), wam_reponse_a = ?
      WHERE wam_id = ?`,
    [conv.id, parcelId, citeWamid, messageId]
  );
  await pool.query(
    `UPDATE delevery_whatsapp_conversation
        SET wac_non_lus = wac_non_lus + 1,
            wac_dernier_entrant_le = COALESCE(FROM_UNIXTIME(?), NOW()),
            wac_dernier_message_le = COALESCE(FROM_UNIXTIME(?), NOW()),
            wac_dernier_apercu = ?,
            wac_statut = IF(wac_statut = 'termine', 'nouveau', wac_statut),
            wac_nom = COALESCE(NULLIF(?, ''), wac_nom),
            wac_opt_out = IF(? = 1, 1, wac_opt_out),
            wac_etiquettes = CASE
              WHEN ? IS NULL THEN wac_etiquettes
              WHEN wac_etiquettes IS NULL OR wac_etiquettes = '' THEN ?
              WHEN FIND_IN_SET(?, wac_etiquettes) THEN wac_etiquettes
              ELSE CONCAT(wac_etiquettes, ',', ?) END,
            wac_updated_at = NOW()
      WHERE wac_id = ?`,
    [
      Number(msg.timestamp) || null,
      Number(msg.timestamp) || null,
      wa.tronquer(contenu, 255),
      nom ? wa.tronquer(nom, 150) : '',
      optOut ? 1 : 0,
      etiquette,
      etiquette,
      etiquette,
      etiquette,
      conv.id
    ]
  );

  if (TYPES_MEDIA.includes(type) && cfg?.accessTokenClair) {
    try {
      const media = await enregistrerMediaEntrant(cfg, messageId, msg, type);
      if (media) {
        await pool.query('UPDATE delevery_whatsapp_message SET wam_media = ?, wam_media_type = ? WHERE wam_id = ?', [
          media.chemin,
          media.mime,
          messageId
        ]);
      }
    } catch (err) {
      console.warn(`[whatsapp] média du message ${messageId} non téléchargé : ${err.message}`);
    }
  }

  if (optOut) {
    await ajouterNote(
      conv.id,
      `Opt-out détecté : le contact a envoyé « ${wa.tronquer(contenu, 30)} ». Les envois automatiques sont bloqués (réactivables dans le volet Infos).`,
      0
    );
  }

  // Réponse automatique : une fois par 24 h, seulement si aucun employé n'a écrit depuis 24 h.
  if (params.autoReponseActif && params.autoReponseTexte && !optOut && Number(etat?.wac_opt_out) !== 1) {
    const [[ok]] = await pool.query(
      `SELECT (c.wac_auto_reponse_le IS NULL OR TIMESTAMPDIFF(HOUR, c.wac_auto_reponse_le, NOW()) >= 24)
              AND NOT EXISTS (SELECT 1 FROM delevery_whatsapp_message m
                               WHERE m.wam_conversation = c.wac_id AND m.wam_direction = 'sortant'
                                 AND m.wam_created_by > 0
                                 AND m.wam_created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS ok
         FROM delevery_whatsapp_conversation c WHERE c.wac_id = ?`,
      [conv.id]
    );
    if (Number(ok?.ok) === 1) {
      try {
        await wa.planifierEnvoi({
          to: phone,
          texte: params.autoReponseTexte,
          contexte: 'auto_reponse',
          parcelId,
          createdBy: 0,
          conversationId: conv.id,
          planifieDansSecondes: 0
        });
        await pool.query('UPDATE delevery_whatsapp_conversation SET wac_auto_reponse_le = NOW() WHERE wac_id = ?', [conv.id]);
      } catch (err) {
        console.warn(`[whatsapp] réponse automatique non planifiée : ${err.message}`);
      }
    }
  }

  if (Number(etat?.wac_non_lus) === 0) {
    // Require paresseux : whatsappRegles importe ce module.
    require('./whatsappRegles').emettreEvenement('MESSAGE_RECU', { conversationId: conv.id, messageId });
  }
}

/* ------------------------------------------------------------------ */
/* Lecture : liste, détail, messages                                   */
/* ------------------------------------------------------------------ */

const SELECT_CONVERSATION = `
  SELECT c.wac_id AS id, c.wac_phone AS phone, c.wac_nom AS nom, c.wac_type_contact AS typeContact,
         c.wac_customer AS customerId, c.wac_user_contact AS userContactId,
         c.wac_dernier_colis AS dernierColisId, p.parcel_code AS dernierColisCode,
         c.wac_statut AS statut, c.wac_affecte_a AS affecteA, ua.users_name AS affecteNom,
         c.wac_affecte_le AS affecteLe, c.wac_non_lus AS nonLus,
         c.wac_dernier_apercu AS dernierTexte, c.wac_dernier_message_le AS dernierLe,
         c.wac_dernier_entrant_le AS dernierEntrantLe, c.wac_dernier_sortant_le AS dernierSortantLe,
         (c.wac_dernier_entrant_le IS NOT NULL
            AND TIMESTAMPDIFF(SECOND, c.wac_dernier_entrant_le, NOW()) < 86400) AS fenetreOuverte,
         CASE WHEN c.wac_dernier_entrant_le IS NULL THEN 0
              ELSE GREATEST(0, 86400 - TIMESTAMPDIFF(SECOND, c.wac_dernier_entrant_le, NOW())) END AS fenetreRestantSecondes,
         c.wac_opt_out AS optOut, c.wac_langue AS langue, c.wac_etiquettes AS etiquettes,
         COALESCE(NULLIF(TRIM(cu.customers_store), ''), cu.customers_name) AS magasin,
         c.wac_created_at AS createdAt,
         (SELECT m.wam_direction FROM delevery_whatsapp_message m
           WHERE m.wam_conversation = c.wac_id AND m.wam_direction <> 'note'
           ORDER BY m.wam_id DESC LIMIT 1) AS derniereDirection
    FROM delevery_whatsapp_conversation c
    LEFT JOIN delevery_users ua ON ua.users_id = c.wac_affecte_a
    LEFT JOIN delevery_customers cu ON cu.customers_id = c.wac_customer
    LEFT JOIN delevery_parcel p ON p.parcel_id = c.wac_dernier_colis`;

function toConversation(row) {
  return {
    ...row,
    fenetreOuverte: Number(row.fenetreOuverte) === 1,
    fenetreRestantSecondes: Number(row.fenetreRestantSecondes) || 0,
    optOut: Number(row.optOut) === 1,
    nonLus: Number(row.nonLus) || 0,
    typeContactLabel: TYPES_CONTACT[row.typeContact] || 'Inconnu',
    phoneAffiche: formatPhoneAffichage(row.phone),
    etiquettes: row.etiquettes ? String(row.etiquettes).split(',').filter(Boolean) : []
  };
}

async function conversationParId(id) {
  const [[row]] = await pool.query(`${SELECT_CONVERSATION} WHERE c.wac_id = ? LIMIT 1`, [Number(id)]);
  return row ? toConversation(row) : null;
}

async function listerConversations({ statut, affectation, type, nonLus, recherche, page, pageSize }, userId) {
  // Seules les discussions où le contact a répondu au moins une fois sont
  // listées : une discussion qui ne contient que des envois (notification
  // automatique, modèle envoyé) reste consultable dans le journal et apparaît
  // ici dès le premier message entrant.
  const where = ['c.wac_dernier_entrant_le IS NOT NULL'];
  const params = [];
  if (statut === 'ouvertes') where.push("c.wac_statut <> 'termine'");
  else if (STATUTS_CONVERSATION.includes(statut)) {
    where.push('c.wac_statut = ?');
    params.push(statut);
  }
  if (affectation === 'moi') {
    where.push('c.wac_affecte_a = ?');
    params.push(Number(userId));
  } else if (affectation === 'aucune') where.push('c.wac_affecte_a IS NULL');
  else if (Number(affectation) > 0) {
    where.push('c.wac_affecte_a = ?');
    params.push(Number(affectation));
  }
  if (type && TYPES_CONTACT[type]) {
    where.push('c.wac_type_contact = ?');
    params.push(type);
  }
  if (nonLus) where.push('c.wac_non_lus > 0');
  const q = String(recherche || '').trim();
  if (q) {
    const chiffres = q.replace(/\D/g, '');
    if (chiffres.length >= 4 && chiffres.length >= q.length - 4) {
      where.push('c.wac_phone LIKE ?');
      params.push(`%${chiffres.slice(-9)}%`);
    } else {
      where.push(
        `(c.wac_nom LIKE ? OR cu.customers_store LIKE ? OR cu.customers_name LIKE ? OR p.parcel_code LIKE ?
          OR EXISTS (SELECT 1 FROM delevery_whatsapp_message m JOIN delevery_parcel pp ON pp.parcel_id = m.wam_parcel_id
                      WHERE m.wam_conversation = c.wac_id AND pp.parcel_code = ?))`
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const taille = Math.min(Math.max(Number(pageSize) || 30, 1), 200);
  const pageN = Math.max(Number(page) || 1, 1);
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM delevery_whatsapp_conversation c
       LEFT JOIN delevery_customers cu ON cu.customers_id = c.wac_customer
       LEFT JOIN delevery_parcel p ON p.parcel_id = c.wac_dernier_colis ${whereSql}`,
    params
  );
  const [rows] = await pool.query(
    `${SELECT_CONVERSATION} ${whereSql}
     ORDER BY c.wac_dernier_message_le DESC, c.wac_id DESC LIMIT ? OFFSET ?`,
    [...params, taille, (pageN - 1) * taille]
  );
  return { rows: rows.map(toConversation), total: Number(total) || 0, page: pageN, pageSize: taille, totalPages: Math.max(1, Math.ceil((Number(total) || 0) / taille)) };
}

const SELECT_MESSAGE = `
  SELECT m.wam_id AS id, m.wam_direction AS direction, m.wam_type AS type, m.wam_template AS template,
         m.wam_contenu AS texte, m.wam_statut AS statut, m.wam_erreur_code AS erreurCode,
         m.wam_erreur_message AS erreur, m.wam_media AS media, m.wam_media_type AS mediaType,
         m.wam_parcel_id AS parcelId, p.parcel_code AS parcelCode, m.wam_regle AS regleId,
         r.wamr_nom AS regleNom, m.wam_created_by AS createdBy, u.users_name AS auteurNom,
         m.wam_created_at AS date, m.wam_updated_at AS majLe, m.wam_planifie_le AS planifieLe,
         m.wam_wamid AS wamid, m.wam_reponse_a AS reponseA, q.wam_id AS reponseAId,
         q.wam_contenu AS reponseATexte, q.wam_direction AS reponseADirection, m.wam_payload AS payload
    FROM delevery_whatsapp_message m
    LEFT JOIN delevery_parcel p ON p.parcel_id = m.wam_parcel_id
    LEFT JOIN delevery_whatsapp_regle r ON r.wamr_id = m.wam_regle
    LEFT JOIN delevery_users u ON u.users_id = m.wam_created_by AND m.wam_created_by > 0
    LEFT JOIN delevery_whatsapp_message q ON q.wam_wamid = m.wam_reponse_a AND m.wam_reponse_a IS NOT NULL`;

function toMessage(row, conversation) {
  let bouton = null;
  if (row.direction === 'entrant' && (row.type === 'button' || row.type === 'interactive')) {
    const payload = wa.parseJson(row.payload);
    bouton = payload?.button?.payload || payload?.interactive?.button_reply?.id || null;
  }
  return {
    id: row.id,
    direction: row.direction,
    type: row.type,
    template: row.template,
    texte: row.texte || '',
    statut: row.statut,
    erreurCode: row.erreurCode,
    erreur: row.erreur,
    mediaUrl: row.media ? `/uploads/${row.media}` : null,
    mediaType: row.mediaType,
    parcelId: row.parcelId,
    parcelCode: row.parcelCode,
    regleId: row.regleId,
    regleNom: row.regleNom,
    auteurNom:
      row.direction === 'entrant' ? conversation?.nom || null : Number(row.createdBy) > 0 ? row.auteurNom : 'Automatique',
    date: row.date,
    majLe: row.majLe,
    planifieLe: row.planifieLe,
    reponseA: row.reponseA,
    reponseAId: row.reponseAId,
    reponseATexte: row.reponseATexte,
    reponseADirection: row.reponseADirection,
    bouton
  };
}

async function messagesConversation(conversation, { after } = {}) {
  const params = [conversation.id];
  let cond = '';
  if (Number(after) > 0) {
    cond = ' AND m.wam_id > ?';
    params.push(Number(after));
  }
  const [rows] = await pool.query(
    `${SELECT_MESSAGE} WHERE m.wam_conversation = ?${cond} ORDER BY m.wam_id DESC LIMIT ${MESSAGES_MAX}`,
    params
  );
  return rows.reverse().map((r) => toMessage(r, conversation));
}

/** Fiche contact : client, livreur / employé, colis récents du numéro (et liés aux messages). */
async function ficheContact(conv) {
  const variants = phoneVariants(conv.phone);
  const [client, contact, colis] = await Promise.all([
    conv.customerId ? chargerClient(conv.customerId) : null,
    conv.userContactId ? chargerUtilisateur(conv.userContactId) : null,
    pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_receiver AS destinataire,
              (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statutColor,
              t.nom_ville AS ville, p.parcel_price AS crbt, COALESCE(p.parcel_crbt_zero, 0) AS crbtZero,
              p.parcel_time AS time, COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin,
              u.users_name AS livreur
         FROM delevery_parcel p
         LEFT JOIN delevery_parcel_statut s ON s.parcel_statut_code = (${STATUT_CODE_SQL})
                                            AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_users u ON u.users_id = p.parcel_livreur
        WHERE p.parcel_phone IN (?)
           OR p.parcel_id IN (SELECT DISTINCT m.wam_parcel_id FROM delevery_whatsapp_message m
                               WHERE m.wam_conversation = ? AND m.wam_parcel_id IS NOT NULL)
        ORDER BY p.parcel_id DESC LIMIT 10`,
      [variants, conv.id]
    ).then(([rows]) => rows)
  ]);
  const colisListe = [];
  for (const c of colis) {
    colisListe.push({ ...c, statutLabel: await statutLabel(c.statut), crbt: Number(c.crbtZero) === 1 ? 0 : Number(c.crbt) || 0 });
  }
  return {
    client: client
      ? {
          id: client.customers_id,
          magasin: client.magasin,
          nom: client.customers_name,
          tel: client.customers_phone_personal || client.customers_phone,
          telAffiche: formatPhoneAffichage(client.customers_phone_personal || client.customers_phone),
          telMagasin: client.customers_phone,
          telMagasinAffiche: formatPhoneAffichage(client.customers_phone)
        }
      : null,
    utilisateur: contact
      ? { id: contact.users_id, nom: contact.users_name, tel: contact.phone, telAffiche: formatPhoneAffichage(contact.phone), type: conv.typeContact }
      : null,
    colis: colisListe
  };
}

/**
 * Détail d'une discussion : la marque lue (wam_lu, non lus = 0), l'affecte au
 * lecteur si le paramètre est actif, envoie l'accusé de lecture Meta (best-effort).
 */
async function detailConversation(id, { userId } = {}) {
  let conv = await conversationParId(id);
  if (!conv) return null;
  const params = await lireParametresCrm();
  if (params.autoAffectation && !conv.affecteA && userId) {
    await pool.query(
      'UPDATE delevery_whatsapp_conversation SET wac_affecte_a = ?, wac_affecte_le = NOW() WHERE wac_id = ? AND wac_affecte_a IS NULL',
      [Number(userId), conv.id]
    );
  }
  if (conv.nonLus > 0) {
    await pool.query(
      "UPDATE delevery_whatsapp_message SET wam_lu = 1 WHERE wam_conversation = ? AND wam_direction = 'entrant' AND wam_lu = 0",
      [conv.id]
    );
    await pool.query('UPDATE delevery_whatsapp_conversation SET wac_non_lus = 0 WHERE wac_id = ?', [conv.id]);
    if (params.marquerLu) {
      const [[dernier]] = await pool.query(
        "SELECT wam_wamid FROM delevery_whatsapp_message WHERE wam_conversation = ? AND wam_direction = 'entrant' ORDER BY wam_id DESC LIMIT 1",
        [conv.id]
      );
      if (dernier?.wam_wamid) {
        wa.lireConfiguration({ avecSecrets: true })
          .then((cfg) => (cfg.etat === 'non_configure' ? null : wa.marquerLuChezMeta(cfg, dernier.wam_wamid)))
          .catch((err) => console.warn(`[whatsapp] accusé de lecture Meta : ${err.message}`));
      }
    }
  }
  conv = await conversationParId(id);
  const [messages, contact] = await Promise.all([messagesConversation(conv), ficheContact(conv)]);
  return { conversation: conv, contact, messages };
}

/** Polling léger : nouveaux messages après `after` + statuts des sortants mis à jour depuis `depuis` (ISO). */
async function messagesDepuis(id, { after, depuis } = {}) {
  const conv = await conversationParId(id);
  if (!conv) return null;
  const nouveaux = await messagesConversation(conv, { after });
  let statuts = [];
  const d = depuis ? new Date(depuis) : null;
  if (d && !Number.isNaN(d.getTime())) {
    const [rows] = await pool.query(
      `SELECT wam_id AS id, wam_statut AS statut, wam_erreur_code AS erreurCode, wam_erreur_message AS erreur, wam_updated_at AS majLe
         FROM delevery_whatsapp_message
        WHERE wam_conversation = ? AND wam_direction = 'sortant' AND wam_updated_at IS NOT NULL
          AND wam_updated_at >= DATE_SUB(?, INTERVAL 60 SECOND)
          AND (? = 0 OR wam_id <= ?)`,
      [conv.id, d, Number(after) || 0, Number(after) || 0]
    );
    statuts = rows;
  }
  return { conversation: conv, nouveaux, statuts };
}

/* ------------------------------------------------------------------ */
/* Écritures : envoi, note, modification, création                     */
/* ------------------------------------------------------------------ */

/** Erreur métier renvoyée au contrôleur (code HTTP + message). */
class ConversationError extends Error {
  constructor(message, http = 400) {
    super(message);
    this.name = 'ConversationError';
    this.http = http;
  }
}

/** Type MIME déclaré à Meta pour un fichier sortant, d'après l'extension (le type
 *  envoyé par le navigateur peut porter « ;codecs=opus », que Meta refuse). */
const MIME_PAR_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr'
};
function mimeEnvoi(fichier) {
  const ext = path.extname(fichier.originalname || fichier.path || '').toLowerCase();
  return MIME_PAR_EXT[ext] || String(fichier.mimetype || 'application/octet-stream').split(';')[0].trim();
}

/**
 * Envoi dans une discussion : { texte } | { modele, langue, params } |
 * { fichier (multer), legende } — image avec légende, ou message vocal
 * (fichier audio, sans texte). Texte / média seulement dans la fenêtre de
 * 24 h ; opt-out bloquant sauf `forcer`. Renvoie le message créé.
 */
async function envoyerDansConversation(id, { texte, modele, langue, params, fichier, legende, reponseA, forcer, userId }) {
  const conv = await conversationParId(id);
  if (!conv) throw new ConversationError('Discussion introuvable.', 404);
  if (conv.optOut && !forcer) {
    throw new ConversationError('Contact désinscrit (opt-out) : réactivez les envois dans le volet Infos avant d’écrire.', 409);
  }
  const cfg = await wa.lireConfiguration({ avecSecrets: true });
  wa.verifierEtatEnvoi(cfg, true);

  const options = {
    to: conv.phone,
    contexte: forcer ? 'inbox:force' : 'inbox',
    parcelId: conv.dernierColisId || null,
    createdBy: userId,
    conversationId: conv.id,
    reponseA: reponseA || null
  };
  const modeleNom = String(modele || '').trim();
  if (modeleNom) {
    const m = await modeleParNomLangue(modeleNom, String(langue || 'fr'));
    if (!m) throw new ConversationError('Modèle inconnu : synchronisez les modèles depuis Meta.', 400);
    if (!m.utilisable) throw new ConversationError(`Modèle non utilisable (${m.statut}${m.nonSupporte ? ` — ${m.nonSupporte}` : ''}).`, 400);
    const liste = (Array.isArray(params) ? params : []).map((p) => String(p ?? '').replace(/\s+/g, ' ').trim());
    if (liste.length !== m.nbVariables || liste.some((p) => !p)) {
      throw new ConversationError(`Renseignez les ${m.nbVariables} variable(s) du modèle.`, 400);
    }
    Object.assign(options, { template: m.nom, langue: m.langue, params: liste, contenu: rendreModele(m, liste) });
  } else {
    if (!conv.fenetreOuverte) {
      throw new ConversationError('Fenêtre de 24 h fermée : seul un modèle approuvé peut être envoyé à ce contact.', 409);
    }
    if (fichier) {
      const mime = mimeEnvoi(fichier);
      const buffer = await fs.promises.readFile(fichier.path);
      const mediaId = await wa.televerserMedia(cfg, { buffer, mime, nomFichier: fichier.originalname });
      Object.assign(options, { media: `whatsapp/envoi/${path.basename(fichier.path)}`, mediaType: mime });
      if (mime.startsWith('audio/')) options.audio = { mediaId };
      else options.image = { mediaId, legende: String(legende || texte || '').trim() };
    } else {
      const t = String(texte || '').trim();
      if (!t) throw new ConversationError('Le message est vide.', 400);
      options.texte = t;
    }
  }

  const r = await wa.envoyerWhatsApp(options);
  await pool.query(
    `UPDATE delevery_whatsapp_conversation
        SET wac_statut = IF(wac_statut = 'nouveau', 'en_cours', wac_statut),
            wac_affecte_a = COALESCE(wac_affecte_a, ?), wac_affecte_le = COALESCE(wac_affecte_le, NOW()),
            wac_updated_at = NOW()
      WHERE wac_id = ?`,
    [Number(userId) || null, conv.id]
  );
  const [[row]] = await pool.query(`${SELECT_MESSAGE} WHERE m.wam_id = ? LIMIT 1`, [r.id]);
  return toMessage(row, conv);
}

async function ajouterNote(id, texte, userId) {
  const conv = await conversationParId(id);
  if (!conv) throw new ConversationError('Discussion introuvable.', 404);
  const t = String(texte || '').trim();
  if (!t) throw new ConversationError('La note est vide.', 400);
  const [ins] = await pool.query(
    `INSERT INTO delevery_whatsapp_message
       (wam_direction, wam_phone, wam_type, wam_contenu, wam_statut, wam_parcel_id, wam_created_by, wam_created_at,
        wam_conversation)
     VALUES ('note', ?, 'note', ?, 'note', ?, ?, NOW(), ?)`,
    [conv.phone, wa.tronquer(t, 2000), conv.dernierColisId || null, Number(userId) || 0, conv.id]
  );
  const [[row]] = await pool.query(`${SELECT_MESSAGE} WHERE m.wam_id = ? LIMIT 1`, [ins.insertId]);
  return toMessage(row, conv);
}

/** Modifie statut / affectation / colis lié / opt-out / langue ; renvoie la conversation à jour. */
async function modifierConversation(id, body, userId) {
  const conv = await conversationParId(id);
  if (!conv) throw new ConversationError('Discussion introuvable.', 404);
  const sets = [];
  const params = [];
  if (body.statut !== undefined) {
    if (!STATUTS_CONVERSATION.includes(body.statut)) throw new ConversationError('Statut invalide.', 400);
    sets.push('wac_statut = ?');
    params.push(body.statut);
  }
  if (body.affecteA !== undefined) {
    if (body.affecteA === null || body.affecteA === '' || Number(body.affecteA) === 0) {
      sets.push('wac_affecte_a = NULL', 'wac_affecte_le = NULL');
    } else {
      const uid = Number(body.affecteA);
      const [[u]] = await pool.query('SELECT users_id FROM delevery_users WHERE users_id = ? AND users_active = 1 LIMIT 1', [uid]);
      if (!u) throw new ConversationError('Utilisateur introuvable ou inactif.', 400);
      sets.push('wac_affecte_a = ?', 'wac_affecte_le = NOW()');
      params.push(uid);
    }
  }
  if (body.dernierColis !== undefined) {
    if (body.dernierColis === null || Number(body.dernierColis) === 0) sets.push('wac_dernier_colis = NULL');
    else {
      const pid = Number(body.dernierColis);
      const [[p]] = await pool.query('SELECT parcel_id FROM delevery_parcel WHERE parcel_id = ? LIMIT 1', [pid]);
      if (!p) throw new ConversationError('Colis introuvable.', 400);
      sets.push('wac_dernier_colis = ?');
      params.push(pid);
    }
  }
  if (body.optOut !== undefined) {
    sets.push('wac_opt_out = ?');
    params.push(body.optOut ? 1 : 0);
  }
  if (body.langue !== undefined) {
    const l = String(body.langue || 'fr').trim().slice(0, 5);
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(l)) throw new ConversationError('Langue invalide.', 400);
    sets.push('wac_langue = ?');
    params.push(l);
  }
  if (body.nom !== undefined) {
    sets.push('wac_nom = ?');
    params.push(wa.tronquer(String(body.nom || '').trim(), 150) || null);
  }
  if (!sets.length) return conv;
  sets.push('wac_updated_at = NOW()');
  await pool.query(`UPDATE delevery_whatsapp_conversation SET ${sets.join(', ')} WHERE wac_id = ?`, [...params, conv.id]);
  if (body.optOut !== undefined) {
    await ajouterNote(conv.id, body.optOut ? 'Envois bloqués (opt-out) par un employé.' : 'Envois réactivés par un employé.', userId).catch(() => {});
  }
  return conversationParId(id);
}

/**
 * Démarrer une discussion : cible = { phone } | { parcelId, audience } |
 * { customerId } | { usersId }, puis envoi (modèle, ou texte si la fenêtre est
 * ouverte). Renvoie { conversation, message }.
 */
async function demarrerConversation(body, userId) {
  let phone = null;
  const infos = {};
  if (body.parcelId) {
    const data = await chargerColis(body.parcelId);
    if (!data) throw new ConversationError('Colis introuvable.', 404);
    const audience = ['destinataire', 'expediteur', 'livreur'].includes(body.audience) ? body.audience : 'destinataire';
    phone = data._phones[audience];
    if (phone === null && data._ids.livreurId) phone = (await chargerUtilisateur(data._ids.livreurId))?.phone;
    Object.assign(infos, {
      nom: data._noms[audience],
      type: audience === 'expediteur' ? 'client' : audience,
      customerId: audience === 'expediteur' ? data._ids.customerId : undefined,
      userId: audience === 'livreur' ? data._ids.livreurId : undefined,
      parcelId: data._ids.parcelId
    });
    if (!phone) throw new ConversationError(`Aucun numéro pour ${audience === 'expediteur' ? 'le client expéditeur' : `le ${audience}`} de ce colis.`, 400);
  } else if (body.customerId) {
    const c = await chargerClient(body.customerId);
    if (!c) throw new ConversationError('Client introuvable.', 404);
    phone = c.customers_phone_personal || c.customers_phone;
    Object.assign(infos, { nom: c.magasin, type: 'client', customerId: c.customers_id });
    if (!phone) throw new ConversationError('Ce client n’a pas de numéro de téléphone.', 400);
  } else if (body.usersId) {
    const u = await chargerUtilisateur(body.usersId);
    if (!u) throw new ConversationError('Utilisateur introuvable.', 404);
    phone = u.phone;
    Object.assign(infos, { nom: u.users_name, type: 'livreur', userId: u.users_id });
    if (!phone) throw new ConversationError('Cet utilisateur n’a pas de numéro de téléphone.', 400);
  } else {
    phone = body.phone;
  }
  const e164 = wa.toE164Maroc(phone);
  if (!e164) throw new ConversationError('Numéro invalide : attendu 06XXXXXXXX ou 2126XXXXXXXX.', 400);
  const conv = await assurerConversation(e164, infos);
  const message = await envoyerDansConversation(conv.id, { ...body, userId });
  return { conversation: await conversationParId(conv.id), message };
}

/* ------------------------------------------------------------------ */
/* Outils : recherche colis, référentiels, timeline colis              */
/* ------------------------------------------------------------------ */

async function rechercherColis(q) {
  const s = String(q || '').trim();
  if (s.length < 3) return [];
  const chiffres = s.replace(/\D/g, '');
  const where = ['p.parcel_code LIKE ?', 'p.parcel_receiver LIKE ?'];
  const params = [`%${s}%`, `%${s}%`];
  if (chiffres.length >= 6) {
    where.push('p.parcel_phone IN (?)');
    params.push(phoneVariants(chiffres));
  }
  const [rows] = await pool.query(
    `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_receiver AS destinataire, p.parcel_phone AS phone,
            (${STATUT_CODE_SQL}) AS statut, t.nom_ville AS ville,
            COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin, c.customers_phone AS clientTel,
            u.users_name AS livreur
       FROM delevery_parcel p
       LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
       LEFT JOIN delevery_users u ON u.users_id = p.parcel_livreur
      WHERE ${where.join(' OR ')}
      ORDER BY p.parcel_id DESC LIMIT 10`,
    params
  );
  const out = [];
  for (const r of rows) out.push({ ...r, statutLabel: await statutLabel(r.statut), phoneAffiche: formatPhoneAffichage(r.phone) });
  return out;
}

const LANGUES = [
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'Arabe' },
  { code: 'en', label: 'Anglais' },
  { code: 'en_US', label: 'Anglais (US)' }
];

/** Listes pour les selects du CRM (utilisateurs, magasins, livreurs, statuts, langues). */
async function referentiels() {
  const [[utilisateurs], [magasins], [livreurs], [statuts]] = await Promise.all([
    pool.query(
      `SELECT users_id AS id, users_name AS label, users_type AS type FROM delevery_users
        WHERE users_active = 1 AND users_type IN ('1', '2', '3', '4', '6') AND users_parent_id IS NULL
        ORDER BY users_name`
    ),
    pool.query(
      `SELECT customers_id AS id, COALESCE(NULLIF(TRIM(customers_store), ''), customers_name) AS label
         FROM delevery_customers WHERE customers_active = 1 ORDER BY label`
    ),
    pool.query(
      `SELECT users_id AS id, users_name AS label FROM delevery_users
        WHERE users_active = 1 AND users_type = '5' ORDER BY users_name`
    ),
    pool.query(
      `SELECT parcel_statut_code AS code, parcel_statut_type AS type FROM delevery_parcel_statut
        WHERE parcel_statut_active = 1 AND parcel_statut_type IN (2, 3)
        ORDER BY parcel_statut_type, parcel_statut_id`
    )
  ]);
  const statutsListe = [];
  const vus = new Set();
  for (const s of statuts) {
    if (vus.has(s.code)) continue;
    vus.add(s.code);
    statutsListe.push({ code: s.code, label: await statutLabel(s.code), type: s.type });
  }
  return { utilisateurs, magasins, livreurs, statuts: statutsListe, langues: LANGUES };
}

/** Messages liés à un colis (wam_parcel_id) ou à la conversation de son numéro. */
async function messagesColis(parcel) {
  const e164 = wa.toE164Maroc(parcel.parcel_phone);
  const [rows] = await pool.query(
    `${SELECT_MESSAGE}
      WHERE m.wam_parcel_id = ?
         OR (? IS NOT NULL AND m.wam_conversation IN
              (SELECT wac_id FROM delevery_whatsapp_conversation WHERE wac_phone = ?))
      ORDER BY m.wam_id DESC LIMIT 100`,
    [Number(parcel.parcel_id), e164, e164]
  );
  const conv = e164 ? await pool.query('SELECT wac_id AS id, wac_nom AS nom FROM delevery_whatsapp_conversation WHERE wac_phone = ? LIMIT 1', [e164]).then(([r]) => r[0] || null) : null;
  return { conversationId: conv?.id || null, messages: rows.reverse().map((r) => toMessage(r, conv)) };
}

module.exports = {
  STATUTS_CONVERSATION,
  ConversationError,
  ensureEnvoiDir,
  resoudreContact,
  assurerConversation,
  traiterEntrant,
  conversationParId,
  listerConversations,
  detailConversation,
  messagesDepuis,
  envoyerDansConversation,
  ajouterNote,
  modifierConversation,
  demarrerConversation,
  rechercherColis,
  referentiels,
  messagesColis
};
