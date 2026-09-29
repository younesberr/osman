const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const { getScanSonUrls } = require('../utils/scanSons');
const { getAgenceScope, getAgenceVilleIds, parcelInAgence } = require('../utils/agenceScope');
const { isBlockedByClient } = require('../utils/blocageClient');
const { statutLabel } = require('../utils/statutLabels');
const {
  STATUT_ATTENTE_REEXPEDITION,
  enAttenteReexpedition,
  aExpedierSql
} = require('../utils/reexpedition');

/*
 * Bons d'envoi (delevery_sent_note + delevery_sn_parcels, tables partagées
 * avec le legacy) : un bon regroupe des colis ramassés (PICKED_UP) — ou en
 * attente de réexpédition (IN_PROGRESS + WAITING_RESHIP, utils/reexpedition) —
 * d'une même zone de destination (sent_note_city = zone_id, la zone d'un colis
 * étant celle de sa ville de destination : delevery_tarifs.zone).
 *
 * Statut d'un bon :
 *  - sent_note_delivered = 1 → « Reçu » (automatiquement fermé) ;
 *  - sinon sent_note_closed = 1 → « Fermé » (lecture seule, colis inchangés) ;
 *  - sinon → « Nouveau » (modifiable).
 *
 * Ajout d'un colis au bon : PICKED_UP (ou attente réexpédition) → SENT, statut
 * second effacé (+ ligne d'historique) ; retrait : SENT → état d'avant l'ajout
 * (PICKED_UP, ou IN_PROGRESS + WAITING_RESHIP d'après l'historique) et
 * suppression de la ligne d'historique SENT. Passage en « Reçu » : les colis
 * SENT du bon passent en RECEIVED ; un retour en « non reçu » rouvre le bon
 * sans jamais faire revenir les colis déjà RECEIVED. sn_parcels_scan trace le
 * mode d'ajout (NULL = manuel, douchette, camera).
 */

const MAX_BONS = 1000;
const SCAN_MODES = ['douchette', 'camera'];

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/** Charge un bon ; renvoie null si l'id est invalide ou le bon introuvable. */
async function loadBon(id) {
  const bonId = parseInt(id, 10);
  if (!Number.isInteger(bonId) || bonId <= 0) return null;
  const [[bon]] = await pool.query(
    `SELECT sn.sent_note_id        AS id,
            sn.sent_note_ref       AS ref,
            sn.sent_note_time      AS time,
            sn.sent_note_closed    AS closed,
            sn.sent_note_delivered AS delivered,
            sn.sent_note_city      AS zone_id,
            z.zone_name            AS zone
       FROM delevery_sent_note sn
       LEFT JOIN delevery_zone z ON z.zone_id = sn.sent_note_city
      WHERE sn.sent_note_id = ? LIMIT 1`,
    [bonId]
  );
  return bon || null;
}

/** Un bon est modifiable tant qu'il n'est ni fermé ni reçu. */
function bonEditable(bon) {
  return Number(bon.closed) !== 1 && Number(bon.delivered) !== 1;
}

/**
 * Villes de l'agence de l'employé connecté (types 3/4/6), pour restreindre les
 * colis visibles / scannables : null = aucune restriction (autres types),
 * sinon Set de ville_id (vide = compte restreint sans agence → rien de visible).
 * Un colis en amont de la réception (PICKED_UP / SENT) est rattaché à son
 * agence par sa ville de ramassage (mêmes règles que utils/agenceScope).
 */
async function getScopeVilles(user) {
  const agenceScope = await getAgenceScope(user);
  if (agenceScope === null) return null;
  return new Set(await getAgenceVilleIds(agenceScope));
}

/** Vrai si le colis (ville de ramassage) est hors de l'agence de l'employé. */
function horsAgence(scopeVilles, ramassageCity) {
  return scopeVilles !== null && !scopeVilles.has(Number(ramassageCity));
}

/** Vrai si le colis chargé (status / status_second) est ajoutable au bon :
 * ramassé, ou en attente de réexpédition. */
function aExpedier(parcel) {
  return parcel.status === 'PICKED_UP' || enAttenteReexpedition(parcel.status, parcel.status_second);
}

/**
 * Ville qui rattache le colis à une agence pour l'ajout au bon : ville de
 * ramassage d'un colis ramassé (il est chez son agence d'origine) ; ville de
 * destination d'un colis en attente de réexpédition (il est chez le livreur de
 * l'agence de destination — même règle que utils/agenceScope pour IN_PROGRESS).
 */
function villeAgence(parcel) {
  return aExpedier(parcel) && parcel.status !== 'PICKED_UP' ? parcel.city : parcel.ramassage_city;
}

/** Libellé du statut effectif d'un colis chargé (statut second s'il est en cours). */
function libelleStatut(parcel) {
  const second = String(parcel.status_second || '').trim();
  return statutLabel(parcel.status === 'IN_PROGRESS' && second ? second : parcel.status);
}

/**
 * État du colis avant son ajout au bon, d'après la ligne d'historique qui
 * précède sa dernière ligne SENT : { status: 'IN_PROGRESS', second:
 * 'WAITING_RESHIP' } pour un colis qui attendait sa réexpédition, sinon
 * { status: 'PICKED_UP', second: '' } (colis ramassé, ou historique absent).
 */
async function etatAvantEnvoi(conn, parcelId) {
  const [[sent]] = await conn.query(
    `SELECT parcel_history_id AS id FROM delevery_parcel_history
      WHERE parcel_history_parcel = ? AND parcel_history_status = 'SENT'
      ORDER BY parcel_history_id DESC LIMIT 1`,
    [parcelId]
  );
  const [[avant]] = await conn.query(
    `SELECT parcel_history_status AS status, parcel_history_status_second AS second
       FROM delevery_parcel_history
      WHERE parcel_history_parcel = ?${sent ? ' AND parcel_history_id < ?' : ''}
      ORDER BY parcel_history_id DESC LIMIT 1`,
    sent ? [parcelId, sent.id] : [parcelId]
  );
  if (avant && enAttenteReexpedition(avant.status, avant.second)) {
    return { status: 'IN_PROGRESS', second: STATUT_ATTENTE_REEXPEDITION };
  }
  return { status: 'PICKED_UP', second: '' };
}

/**
 * Retire un colis SENT du bon dans la transaction fournie : suppression de la
 * ligne delevery_sn_parcels, retour du colis à son état d'avant l'ajout
 * (PICKED_UP avec parcel_sent_time remis à 0, ou IN_PROGRESS + attente de
 * réexpédition), suppression de la dernière ligne d'historique SENT.
 * Renvoie l'état restauré.
 */
async function retirerColisDuBon(conn, linkId, parcelId, now) {
  const avant = await etatAvantEnvoi(conn, parcelId);
  await conn.query(`DELETE FROM delevery_sn_parcels WHERE sn_parcels_id = ?`, [linkId]);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?,
            parcel_sent_time = IF(? = 'PICKED_UP', 0, parcel_sent_time),
            parcel_last_update = ?
      WHERE parcel_id = ?`,
    [avant.status, avant.second, avant.status, now, parcelId]
  );
  // Annule la trace d'expédition : dernière ligne d'historique SENT du colis.
  await conn.query(
    `DELETE FROM delevery_parcel_history
      WHERE parcel_history_parcel = ? AND parcel_history_status = 'SENT'
      ORDER BY parcel_history_id DESC LIMIT 1`,
    [parcelId]
  );
  return avant;
}

/**
 * GET /api/bons-envoi/zones — zones actives avec leur nombre de colis à
 * expédier : statut PICKED_UP ou attente de réexpédition (zone de la ville de
 * destination). Sert la liste déroulante de la modale de création et le
 * filtre par zone de la page.
 */
async function listZones(req, res, next) {
  try {
    // Types 3/4/6 : les compteurs ne comptent que les colis de leur agence.
    const agenceScope = await getAgenceScope(req.user);
    const scope = agenceScope !== null ? await parcelInAgence(agenceScope) : null;
    const [rows] = await pool.query(
      `SELECT z.zone_id AS id, z.zone_name AS label, COUNT(p.parcel_id) AS picked
         FROM delevery_zone z
         LEFT JOIN delevery_tarifs t ON t.zone = z.zone_id
         LEFT JOIN delevery_parcel p
           ON p.parcel_city = t.ville_id AND ${aExpedierSql('p')}
           ${scope ? `AND ${scope.sql}` : ''}
        WHERE z.zone_active = 1
        GROUP BY z.zone_id, z.zone_name
        ORDER BY z.zone_name`,
      scope ? scope.params : []
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-envoi — liste des bons pour la datatable.
 * Query : zone (zone_id), status (new | received | closed, '' = tous),
 * dateFrom / dateTo (AAAA-MM-JJ, sur la date de création). 1000 bons max,
 * du plus récent au plus ancien (pagination côté client).
 */
async function listBons(req, res, next) {
  try {
    const zone = parseInt(req.query.zone, 10) || 0;
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    if (zone) {
      where.push('sn.sent_note_city = ?');
      params.push(zone);
    }
    if (status === 'new') where.push('sn.sent_note_delivered = 0 AND sn.sent_note_closed = 0');
    else if (status === 'received') where.push('sn.sent_note_delivered = 1');
    else if (status === 'closed') where.push('sn.sent_note_delivered = 0 AND sn.sent_note_closed = 1');
    if (dateFrom !== null) {
      where.push('sn.sent_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('sn.sent_note_time <= ?');
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT sn.sent_note_id        AS id,
              sn.sent_note_ref       AS ref,
              sn.sent_note_time      AS time,
              sn.sent_note_closed    AS closed,
              sn.sent_note_delivered AS delivered,
              sn.sent_note_city      AS zone_id,
              z.zone_name            AS zone,
              (SELECT COUNT(*) FROM delevery_sn_parcels sp
                WHERE sp.sn_parcels_sn = sn.sent_note_id) AS nb_colis
         FROM delevery_sent_note sn
         LEFT JOIN delevery_zone z ON z.zone_id = sn.sent_note_city
         ${whereSql}
         ORDER BY sn.sent_note_time DESC, sn.sent_note_id DESC
         LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-envoi — body { zone }. Un seul bon « Nouveau » (ni fermé ni
 * reçu) à la fois par zone : s'il en existe déjà un — créé par n'importe quel
 * utilisateur, y compris d'une autre agence (types 3/4/6) — il est renvoyé
 * avec { existing: true } au lieu d'en créer un doublon, et l'appelant est
 * redirigé dessus. Sinon crée un bon « Nouveau » pour la zone et génère sa
 * référence unique au format legacy : BE-JJMMAA-0{id}0-{2 chiffres}
 * (l'id du bon la rend unique). Renvoie { id, ref }.
 */
async function createBon(req, res, next) {
  try {
    const zone = parseInt(req.body?.zone, 10);
    if (!Number.isInteger(zone) || zone <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une zone.' });
    }
    const [[zoneRow]] = await pool.query(
      `SELECT zone_id FROM delevery_zone WHERE zone_id = ? AND zone_active = 1 LIMIT 1`,
      [zone]
    );
    if (!zoneRow) return res.status(400).json({ message: 'Zone introuvable ou désactivée.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Bon ouvert existant pour la zone (verrouillé pour sérialiser deux
      // créations simultanées) → redirection vers ce bon, pas de doublon.
      const [[existing]] = await conn.query(
        `SELECT sent_note_id AS id, sent_note_ref AS ref
           FROM delevery_sent_note
          WHERE sent_note_city = ? AND sent_note_closed = 0 AND sent_note_delivered = 0
          ORDER BY sent_note_time DESC, sent_note_id DESC
          LIMIT 1 FOR UPDATE`,
        [zone]
      );
      if (existing) {
        await conn.commit();
        return res.json({ id: existing.id, ref: existing.ref, existing: true });
      }
      const [result] = await conn.query(
        `INSERT INTO delevery_sent_note
           (sent_note_city, sent_note_ref, sent_note_time, sent_note_closed,
            sent_note_delivered, sent_note_by)
         VALUES (?, '', ?, 0, 0, ?)`,
        [zone, now, Number(req.user.id)]
      );
      const bonId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `BE-${jj}${mm}${aa}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(`UPDATE delevery_sent_note SET sent_note_ref = ? WHERE sent_note_id = ?`, [
        ref,
        bonId
      ]);
      await conn.commit();
      res.status(201).json({ id: bonId, ref });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-envoi/:id — détail d'un bon : informations (référence, date,
 * zone, statut) + colis du bon (code, magasin, destinataire, téléphone, ville,
 * adresse, prix, commentaire, options échange / ouverture / essayage, statut
 * colis, mode d'ajout), du plus récemment ajouté au plus ancien.
 * Sert la page de modification, la modale « Détail du bon » et l'export Excel.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    // Types 3/4/6 : colis de leur agence uniquement (ramassage dans l'agence,
    // ou destination dans l'agence — le bon arrive chez eux, ils doivent
    // pouvoir contrôler son contenu avant de le marquer « reçu »).
    const scopeVilles = await getScopeVilles(req.user);
    let scopeSql = '';
    const scopeParams = [];
    if (scopeVilles !== null) {
      if (!scopeVilles.size) {
        scopeSql = 'AND 1 = 0';
      } else {
        scopeSql = 'AND (p.parcel_ramassage_city IN (?) OR p.parcel_city IN (?))';
        scopeParams.push([...scopeVilles], [...scopeVilles]);
      }
    }

    const [parcels] = await pool.query(
      `SELECT p.parcel_id      AS id,
              p.parcel_code    AS code,
              p.parcel_status  AS status,
              p.parcel_note    AS commentaire,
              p.parcel_address AS adresse,
              p.parcel_receiver AS destinataire,
              p.parcel_phone   AS telephone,
              p.parcel_price   AS prix,
              p.parcel_replace AS replace_flag,
              p.parcel_open    AS open_flag,
              p.parcel_essayage AS essayage_flag,
              t.nom_ville      AS ville,
              c.customers_store AS magasin,
              sp.sn_parcels_scan AS scan
         FROM delevery_sn_parcels sp
         JOIN delevery_parcel p ON p.parcel_id = sp.sn_parcels_parcel
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE sp.sn_parcels_sn = ? ${scopeSql}
        ORDER BY sp.sn_parcels_id DESC`,
      [bon.id, ...scopeParams]
    );
    res.json({ ...bon, parcels });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-envoi/:id/available — colis ajoutables au bon : statut
 * PICKED_UP ou attente de réexpédition, ville de destination dans la zone du
 * bon (recherche et pagination côté client). `statut` / `statut_color` :
 * statut effectif affiché en badge (Ramassé ou Attente réexpédition).
 */
async function listAvailable(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    // Types 3/4/6 : colis ramassés par leur agence, ou en attente de
    // réexpédition chez elle (destination dans l'agence — utils/agenceScope).
    const agenceScope = await getAgenceScope(req.user);
    const scope = agenceScope !== null ? await parcelInAgence(agenceScope) : null;

    const [rows] = await pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code,
              t.nom_ville AS ville, c.customers_store AS magasin,
              IF(p.parcel_status = 'PICKED_UP', 'PICKED_UP', p.parcel_status_second) AS statut,
              s.parcel_statut_color AS statut_color
         FROM delevery_parcel p
         JOIN delevery_tarifs t         ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = IF(p.parcel_status = 'PICKED_UP', 'PICKED_UP', p.parcel_status_second)
          AND s.parcel_statut_type = IF(p.parcel_status = 'PICKED_UP', 2, 3)
        WHERE ${aExpedierSql('p')} AND t.zone = ?
          ${scope ? `AND ${scope.sql}` : ''}
        ORDER BY p.parcel_pickup_time DESC, p.parcel_id DESC`,
      scope ? [bon.zone_id, ...scope.params] : [bon.zone_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Ajoute un colis (déjà chargé et validé PICKED_UP / attente de réexpédition
 * + zone du bon) dans le bon, dans la transaction fournie : → SENT (statut
 * second effacé), ligne d'historique SENT, ligne delevery_sn_parcels avec le
 * mode d'ajout.
 */
async function insertParcelIntoBon(conn, bon, parcel, scan, userId, now) {
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = 'SENT', parcel_status_second = '',
            parcel_sent_time = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [now, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_time, parcel_history_by)
     VALUES (?, 0, ?, 'SENT', ?, ?)`,
    [parcel.id, parcel.situation, now, userId]
  );
  await conn.query(
    `INSERT INTO delevery_sn_parcels
       (sn_parcels_sn, sn_parcels_parcel, sn_parcels_time, sn_parcels_scan)
     VALUES (?, ?, ?, ?)`,
    [bon.id, parcel.id, now, scan]
  );
}

/** Mode d'ajout depuis le body : 'douchette' | 'camera' | null (manuel). */
function parseScanMode(value) {
  const scan = String(value || '').trim();
  return SCAN_MODES.includes(scan) ? scan : null;
}

/**
 * POST /api/bons-envoi/:id/parcels — body { ids: [parcel_id], scan? }.
 * Ajout (manuel ou par sélection) de colis au bon : chaque colis doit être
 * PICKED_UP (ou en attente de réexpédition) et dans la zone du bon, les
 * autres sont ignorés avec un motif.
 * Renvoie { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est fermé : ajout impossible.' });
    }

    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    const scan = parseScanMode(req.body?.scan);
    const scopeVilles = await getScopeVilles(req.user);

    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const parcelId of ids) {
        const [[parcel]] = await conn.query(
          `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
                  p.parcel_status_second AS status_second,
                  p.parcel_situation AS situation, p.parcel_ramassage_city AS ramassage_city,
                  p.parcel_city AS city, t.nom_ville AS ville, t.zone AS zone
             FROM delevery_parcel p
             LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
            WHERE p.parcel_id = ? LIMIT 1 FOR UPDATE`,
          [parcelId]
        );
        if (!parcel) {
          skipped.push({ code: `#${parcelId}`, reason: 'Colis introuvable.' });
          continue;
        }
        if (horsAgence(scopeVilles, villeAgence(parcel))) {
          skipped.push({ code: parcel.code, reason: 'Hors de votre agence.' });
          continue;
        }
        if (!aExpedier(parcel)) {
          skipped.push({
            code: parcel.code,
            reason: `Statut actuel : ${await libelleStatut(parcel)} (ramassé ou attente réexpédition attendu).`
          });
          continue;
        }
        if (Number(parcel.zone) !== Number(bon.zone_id)) {
          skipped.push({ code: parcel.code, reason: 'Hors zone du bon.' });
          continue;
        }
        if (await isBlockedByClient(parcel.id, conn)) {
          skipped.push({ code: parcel.code, reason: 'Bloqué par le client, à ne pas envoyer.' });
          continue;
        }
        await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
        added.push({ id: parcel.id, code: parcel.code, ville: parcel.ville, scan });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    for (const a of added) emettreEvenement('STATUT', { parcelId: a.id, code: 'SENT', bonId: bon.id, userId: Number(req.user.id) || 0 });
    res.json({ added, skipped });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-envoi/:id/scan — body { code, scan: 'douchette' | 'camera' }.
 * Scan d'un code colis (douchette ou caméra) sur la page du bon : le colis
 * doit exister, être PICKED_UP (ou en attente de réexpédition) et dans la
 * zone du bon. La validation se fait
 * dans la transaction, ligne colis verrouillée (FOR UPDATE) : un colis déjà
 * expédié entre-temps par un autre utilisateur est refusé. Types 3/4/6 :
 * uniquement les colis de leur agence. Messages d'erreur précis (déjà dans le
 * bon, hors zone, hors agence, mauvais statut) pour le retour sonore.
 */
async function scanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est fermé : ajout impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });
    const scan = parseScanMode(req.body?.scan) || 'douchette';
    const scopeVilles = await getScopeVilles(req.user);

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let addedParcel = null;
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
                p.parcel_status_second AS status_second,
                p.parcel_situation AS situation, p.parcel_ramassage_city AS ramassage_city,
                p.parcel_city AS city, t.nom_ville AS ville, t.zone AS zone
           FROM delevery_parcel p
           LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (horsAgence(scopeVilles, villeAgence(parcel))) {
        failure = { status: 403, message: `Colis « ${parcel.code} » hors de votre agence.` };
      } else if (!aExpedier(parcel)) {
        const [[inBon]] = await conn.query(
          `SELECT sn_parcels_id FROM delevery_sn_parcels
            WHERE sn_parcels_sn = ? AND sn_parcels_parcel = ? LIMIT 1`,
          [bon.id, parcel.id]
        );
        failure = inBon
          ? { status: 409, message: `Colis « ${parcel.code} » déjà dans ce bon.` }
          : {
              status: 409,
              message: `Colis « ${parcel.code} » non ajoutable (statut actuel : ${await libelleStatut(parcel)}).`
            };
      } else if (Number(parcel.zone) !== Number(bon.zone_id)) {
        failure = {
          status: 409,
          message: `Colis « ${parcel.code} » hors zone du bon (${parcel.ville || 'ville inconnue'}).`
        };
      } else if (await isBlockedByClient(parcel.id, conn)) {
        // Blocage posé par le client (bouton « Bloquer l'expédition » de son
        // tableau de colis) → refus, son d'erreur.
        failure = {
          status: 409,
          message: `Colis « ${parcel.code} » bloqué par le client, à ne pas envoyer.`
        };
      } else {
        await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
        addedParcel = { id: parcel.id, code: parcel.code, ville: parcel.ville, scan };
      }
      if (failure) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (failure) return res.status(failure.status).json({ message: failure.message });
    emettreEvenement('STATUT', { parcelId: addedParcel.id, code: 'SENT', bonId: bon.id, userId: Number(req.user.id) || 0 });
    res.json({ message: `Colis « ${addedParcel.code} » ajouté au bon.`, parcel: addedParcel });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-envoi/:id/scan-retrait — body { code }.
 * Scan d'un code colis (douchette ou caméra) pour le RETIRER du bon : le
 * colis doit être dans ce bon et encore SENT (un colis déjà reçu — par
 * exemple validé côté serveur par un autre utilisateur — est refusé).
 * Ligne colis verrouillée (FOR UPDATE) pour éviter les scans concurrents.
 * Types 3/4/6 : colis de leur agence (ramassage ou destination, comme la
 * consultation du bon). Retrait = SENT → état d'avant l'ajout (PICKED_UP, ou
 * attente de réexpédition) + suppression de la dernière ligne d'historique
 * SENT (retirerColisDuBon).
 */
async function removeScanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est fermé : retrait impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });
    const scopeVilles = await getScopeVilles(req.user);

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let removedParcel = null;
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
                p.parcel_ramassage_city AS ramassage_city, p.parcel_city AS city,
                t.nom_ville AS ville, sp.sn_parcels_id AS link_id
           FROM delevery_parcel p
           LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_sn_parcels sp
             ON sp.sn_parcels_sn = ? AND sp.sn_parcels_parcel = p.parcel_id
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [bon.id, code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (horsAgence(scopeVilles, parcel.ramassage_city) && horsAgence(scopeVilles, parcel.city)) {
        failure = { status: 403, message: `Colis « ${parcel.code} » hors de votre agence.` };
      } else if (!parcel.link_id) {
        failure = { status: 409, message: `Colis « ${parcel.code} » absent de ce bon.` };
      } else if (parcel.status !== 'SENT') {
        failure = {
          status: 409,
          message: `Colis « ${parcel.code} » déjà ${parcel.status === 'RECEIVED' ? 'reçu' : parcel.status} : retrait impossible.`
        };
      } else {
        await retirerColisDuBon(conn, parcel.link_id, parcel.id, now);
        removedParcel = { id: parcel.id, code: parcel.code, ville: parcel.ville };
      }
      if (failure) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (failure) return res.status(failure.status).json({ message: failure.message });
    res.json({ message: `Colis « ${removedParcel.code} » retiré du bon.`, parcel: removedParcel });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bons-envoi/:id/parcels/:parcelId — retire un colis du bon :
 * SENT → état d'avant l'ajout (PICKED_UP, ou attente de réexpédition) et
 * suppression de la dernière ligne d'historique SENT (retirerColisDuBon).
 * Un colis déjà RECEIVED ne peut pas être retiré (son statut est conservé).
 */
async function removeParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est fermé : suppression impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10);
    const [[row]] = await pool.query(
      `SELECT sp.sn_parcels_id AS link_id, p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_status AS status, p.parcel_ramassage_city AS ramassage_city,
              p.parcel_city AS city
         FROM delevery_sn_parcels sp
         JOIN delevery_parcel p ON p.parcel_id = sp.sn_parcels_parcel
        WHERE sp.sn_parcels_sn = ? AND sp.sn_parcels_parcel = ? LIMIT 1`,
      [bon.id, parcelId || 0]
    );
    if (!row) return res.status(404).json({ message: 'Colis introuvable dans ce bon.' });
    // Types 3/4/6 : un colis d'une autre agence (ni ramassé chez elle, ni à
    // destination chez elle — comme la consultation du bon) ne peut pas être retiré.
    const scopeVilles = await getScopeVilles(req.user);
    if (horsAgence(scopeVilles, row.ramassage_city) && horsAgence(scopeVilles, row.city)) {
      return res.status(403).json({ message: `Colis « ${row.code} » hors de votre agence.` });
    }
    if (row.status !== 'SENT') {
      return res.status(400).json({
        message: `Colis « ${row.code} » déjà ${row.status === 'RECEIVED' ? 'reçu' : row.status} : retrait impossible.`
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await retirerColisDuBon(conn, row.link_id, row.id, now);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ id: row.id, code: row.code });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-envoi/:id/receive — body { received: 0|1 }.
 * received = 1 : bon « Reçu » (et fermé automatiquement) + tous ses colis
 * encore SENT passent en RECEIVED (ligne d'historique chacun) — les colis
 * déjà RECEIVED d'un précédent passage ne sont pas retouchés.
 * received = 0 : bon « non reçu » → redevient Nouveau (rouvert), les colis
 * déjà RECEIVED gardent leur statut.
 */
async function setReceived(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const received = Number(req.body?.received) === 1 ? 1 : 0;

    if (received === 0) {
      await pool.query(
        `UPDATE delevery_sent_note
            SET sent_note_delivered = 0, sent_note_closed = 0
          WHERE sent_note_id = ?`,
        [bon.id]
      );
      return res.json({ id: bon.id, delivered: 0, closed: 0 });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_sent_note
            SET sent_note_delivered = 1, sent_note_closed = 1
          WHERE sent_note_id = ?`,
        [bon.id]
      );
      // Colis du bon encore SENT (verrouillés) → RECEIVED + historique.
      const [parcels] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_situation AS situation
           FROM delevery_sn_parcels sp
           JOIN delevery_parcel p ON p.parcel_id = sp.sn_parcels_parcel
          WHERE sp.sn_parcels_sn = ? AND p.parcel_status = 'SENT'
          ORDER BY p.parcel_id FOR UPDATE`,
        [bon.id]
      );
      for (const parcel of parcels) {
        await conn.query(
          `UPDATE delevery_parcel
              SET parcel_status = 'RECEIVED', parcel_last_update = ?
            WHERE parcel_id = ?`,
          [now, parcel.id]
        );
        await conn.query(
          `INSERT INTO delevery_parcel_history
             (parcel_history_parcel, parcel_history_city, parcel_history_situation,
              parcel_history_status, parcel_history_time, parcel_history_by)
           VALUES (?, 0, ?, 'RECEIVED', ?, ?)`,
          [parcel.id, parcel.situation, now, Number(req.user.id)]
        );
      }
      await conn.commit();
      for (const p of parcels) emettreEvenement('STATUT', { parcelId: p.id, code: 'RECEIVED', bonId: bon.id, userId: Number(req.user.id) || 0 });
      res.json({ id: bon.id, delivered: 1, closed: 1, receivedCount: parcels.length });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-envoi/:id/close — body { closed: 0|1 }.
 * Ferme (lecture seule, sans toucher aux colis) ou rouvre un bon non reçu ;
 * un bon reçu reste fermé tant qu'il n'est pas repassé en « non reçu ».
 */
async function setClosed(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (Number(bon.delivered) === 1) {
      return res.status(400).json({ message: 'Un bon reçu reste fermé (passez-le en « non reçu » d’abord).' });
    }
    const closed = Number(req.body?.closed) === 1 ? 1 : 0;
    await pool.query(`UPDATE delevery_sent_note SET sent_note_closed = ? WHERE sent_note_id = ?`, [
      closed,
      bon.id
    ]);
    res.json({ id: bon.id, closed });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bons-envoi/:id — supprime un bon vide (aucun colis) uniquement.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_sn_parcels WHERE sn_parcels_sn = ?`,
      [bon.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Ce bon contient des colis : suppression impossible.' });
    }
    await pool.query(`DELETE FROM delevery_sent_note WHERE sent_note_id = ?`, [bon.id]);
    res.json({ id: bon.id });
  } catch (err) {
    next(err);
  }
}

/** GET /api/bons-envoi/sons — sons de l'étape envoi configurés (Options). */
async function getSons(req, res, next) {
  try {
    const urls = await getScanSonUrls();
    res.json({ success: urls.envoi_success, error: urls.envoi_error });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listZones,
  listBons,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  setReceived,
  setClosed,
  deleteBon,
  getSons
};
