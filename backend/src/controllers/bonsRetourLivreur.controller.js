const pool = require('../config/db');
const { getScanSonUrls } = require('../utils/scanSons');
const { statutLabel } = require('../utils/statutLabels');
const { STATUT_ATTENTE_REEXPEDITION } = require('../utils/reexpedition');

/*
 * Bons de retour livreur (delevery_return_note + delevery_rn_parcels, tables
 * de l'application — sql/2026-08-21_bons-retour-livreur.sql) : un bon regroupe les
 * colis « En cours » (IN_PROGRESS) d'un livreur à retourner vers l'agence
 * principale, ainsi que ses colis échange livrés (parcel_replace = 1) dont la
 * marchandise échangée n'est pas encore retournée (parcel_returned_livreur =
 * 0). La zone du livreur (ville de fonction → delevery_tarifs.zone) est
 * mémorisée sur le bon à la création (return_note_zone).
 *
 * Statut d'un bon :
 *  - return_note_delivered = 1 → « Reçu » (lecture seule) ;
 *  - sinon → « Nouveau » (modifiable, sauf si tous ses colis sont déjà reçus
 *    par scan — contrôle côté interface).
 *
 * Ajout d'un colis au bon : parcel_status → RETURNED (convention legacy : le
 * colis entre dans le circuit retour) et parcel_status_second →
 * EXPEDIE_AGENCE_PRINCIPALE (+ ligne d'historique), le statut second précédent
 * est mémorisé dans rn_parcels_status_before. Retrait : parcel_status →
 * IN_PROGRESS + statut second restauré + suppression de la ligne
 * d'historique. Exception colis échange livré : le colis garde parcel_status
 * = DELIVERED sur tout le circuit (sa livraison et sa facturation restent
 * acquises, c'est la marchandise échangée qui revient) — seul le statut
 * second suit le circuit, et parcel_returned_livreur passe à 1 à la réception
 * par l'agence (annulé par « Bon non reçu »). Les colis dont le statut second
 * est « Programmé », « Reporté », « Client intéressé », « Relance nouveau
 * client » ou « En attente de relance » sont listés mais ne peuvent pas être
 * ajoutés.
 *
 * Réception : par scan (colis par colis, douchette ou caméra) ou via « Bon
 * reçu » (tous les colis restants) → parcel_status_second = RECU_PAR_AGENCE
 * (+ historique). « Bon non reçu » annule tout : les colis reçus reviennent
 * en EXPEDIE_AGENCE_PRINCIPALE (ligne d'historique RECU_PAR_AGENCE supprimée).
 * Les colis reçus alimentent ensuite les bons de retour clients
 * (bonsRetourClient.controller.js) : un colis placé sur un bon de retour
 * client ne peut plus être retiré du bon de retour livreur ni annulé par
 * « Bon non reçu » tant qu'il n'a pas été retiré du bon client.
 */

const MAX_BONS = 1000;
const SCAN_MODES = ['douchette', 'camera'];

/* Statut second posé à l'ajout au bon / à la réception. */
const STATUT_EXPEDIE = 'EXPEDIE_AGENCE_PRINCIPALE';
const STATUT_RECU = 'RECU_PAR_AGENCE';

/* Statuts seconds du circuit client (bonsRetourClient.controller.js) : un
 * colis engagé côté client n'est plus retournable côté livreur
 * (RETURNED_TO_STOCK = colis de stock réintégré, état final). */
const STATUTS_CIRCUIT_CLIENT = ['RETURNED_TO_CUSTOMER', 'RECU_BY_CUSTOMER', 'RETURNED_TO_STOCK'];

/* Statuts seconds listés mais non ajoutables à un bon de retour (dont
 * « Attente réexpédition » : le colis repart par un bon d'envoi, pas par le
 * circuit retour — utils/reexpedition). */
const STATUTS_NON_AJOUTABLES = [
  'PROGRAMMER',
  'POSTPONED',
  'CLIENT_INTERESE',
  'RELENCE_NEW_CLIENT',
  'WAIT_RELANCE',
  STATUT_ATTENTE_REEXPEDITION
];

/* Colis retournable (alias p) : « En cours », ou colis échange livré dont la
 * marchandise échangée n'est pas encore retournée — même règle que le suivi
 * de retour (parcelsAdmin.controller.js). */
const RETOURNABLE_SQL = `(p.parcel_status = 'IN_PROGRESS'
    OR (p.parcel_status = 'DELIVERED' AND p.parcel_replace = '1'
        AND p.parcel_returned_livreur = '0'))`;

/** Statut principal d'un colis dans le circuit retour : un colis échange
 * livré garde « Livré » (livraison et facturation acquises), les autres
 * passent RETURNED (convention legacy). */
function statutCircuit(status) {
  return status === 'DELIVERED' ? 'DELIVERED' : 'RETURNED';
}

/** Valeur affichée quand le statut second est vide : « Livré » pour un colis
 * échange livré, sinon vide (le frontend affiche « En cours »). */
function statutAffiche(second, status) {
  return second || (status === 'DELIVERED' ? 'DELIVERED' : '');
}

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
    `SELECT rn.return_note_id             AS id,
            rn.return_note_ref            AS ref,
            rn.return_note_time           AS time,
            rn.return_note_delivered      AS delivered,
            rn.return_note_delivered_time AS received_time,
            rn.return_note_livreur        AS livreur_id,
            u.users_name                  AS livreur_name,
            z.zone_name                   AS zone
       FROM delevery_return_note rn
       LEFT JOIN delevery_users u ON u.users_id = rn.return_note_livreur
       LEFT JOIN delevery_zone z  ON z.zone_id = rn.return_note_zone
      WHERE rn.return_note_id = ? LIMIT 1`,
    [bonId]
  );
  return bon || null;
}

/** Un bon est modifiable tant qu'il n'est pas reçu. */
function bonEditable(bon) {
  return Number(bon.delivered) !== 1;
}

/** Mode de scan depuis le body : 'douchette' | 'camera' | null (manuel). */
function parseScanMode(value) {
  const scan = String(value || '').trim();
  return SCAN_MODES.includes(scan) ? scan : null;
}

/** Compteur reçus / total d'un bon (après un scan de réception). */
async function countRecus(conn, bonId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(rn_parcels_received = 1), 0) AS recus
       FROM delevery_rn_parcels WHERE rn_parcels_rn = ?`,
    [bonId]
  );
  return { total: Number(row.total), recus: Number(row.recus) };
}

/**
 * Bon de retour client contenant le colis ({ ref }), ou null. Tant que la
 * migration sql/2026-08-23_bons-retour-client.sql n'est pas exécutée, les
 * tables client n'existent pas : aucun colis n'est alors engagé côté client.
 */
async function bonClientDuColis(db, parcelId) {
  try {
    const [[row]] = await db.query(
      `SELECT b.rnc_ref AS ref
         FROM delevery_rnc_parcels cp
         JOIN delevery_return_note_client b ON b.rnc_id = cp.rnc_parcels_rnc
        WHERE cp.rnc_parcels_parcel = ? LIMIT 1`,
      [parcelId]
    );
    return row || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}

/** Nombre de colis du bon livreur présents sur un bon de retour client. */
async function nbColisSurBonClient(db, bonId) {
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS nb
         FROM delevery_rn_parcels rp
         JOIN delevery_rnc_parcels cp ON cp.rnc_parcels_parcel = rp.rn_parcels_parcel
        WHERE rp.rn_parcels_rn = ?`,
      [bonId]
    );
    return Number(row.nb);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return 0;
    throw err;
  }
}

/**
 * GET /api/bons-retour-livreur/livreurs — livreurs actifs (users_type = 5)
 * avec leur zone (ville de fonction → delevery_tarifs.zone → delevery_zone ;
 * vide si la ville de fonction n'est pas renseignée) et leur nombre de colis
 * retournables (IN_PROGRESS ou échange livré à retourner, statut second ni
 * bloqué ni déjà dans le circuit de retour agence). Sert la modale de
 * création (livreurs avec retournable > 0) et le filtre livreur de la page.
 */
async function listLivreurs(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT u.users_id AS id, u.users_name AS nom, vz.zone_name AS zone,
              COALESCE(cnt.retournable, 0) AS retournable
         FROM delevery_users u
         LEFT JOIN delevery_tarifs vf ON vf.ville_id = u.users_ville_id
         LEFT JOIN delevery_zone vz   ON vz.zone_id = vf.zone
         LEFT JOIN (
           SELECT p.parcel_livreur, COUNT(*) AS retournable
             FROM delevery_parcel p
            WHERE ${RETOURNABLE_SQL}
              AND COALESCE(p.parcel_status_second, '') NOT IN (?)
            GROUP BY p.parcel_livreur
         ) cnt ON cnt.parcel_livreur = u.users_id
        WHERE u.users_active = 1 AND u.users_type = '5'
        ORDER BY u.users_name`,
      [[...STATUTS_NON_AJOUTABLES, STATUT_EXPEDIE, STATUT_RECU, ...STATUTS_CIRCUIT_CLIENT]]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-livreur — liste des bons pour la datatable.
 * Query : livreur (users_id), status (new | received, '' = tous),
 * dateFrom / dateTo (AAAA-MM-JJ, sur la date de création). 1000 bons max,
 * du plus récent au plus ancien (pagination côté client). nb_recus permet à
 * l'interface de masquer « Modifier » quand tous les colis sont déjà reçus
 * par scan.
 */
async function listBons(req, res, next) {
  try {
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    if (livreur) {
      where.push('rn.return_note_livreur = ?');
      params.push(livreur);
    }
    if (status === 'new') where.push('rn.return_note_delivered = 0');
    else if (status === 'received') where.push('rn.return_note_delivered = 1');
    if (dateFrom !== null) {
      where.push('rn.return_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('rn.return_note_time <= ?');
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT rn.return_note_id             AS id,
              rn.return_note_ref            AS ref,
              rn.return_note_time           AS time,
              rn.return_note_delivered      AS delivered,
              rn.return_note_delivered_time AS received_time,
              rn.return_note_livreur        AS livreur_id,
              u.users_name                  AS livreur_name,
              z.zone_name                   AS zone,
              cb.users_name                 AS created_by,
              rb.users_name                 AS received_by,
              (SELECT COUNT(*) FROM delevery_rn_parcels rp
                WHERE rp.rn_parcels_rn = rn.return_note_id) AS nb_colis,
              (SELECT COUNT(*) FROM delevery_rn_parcels rp
                WHERE rp.rn_parcels_rn = rn.return_note_id
                  AND rp.rn_parcels_received = 1) AS nb_recus
         FROM delevery_return_note rn
         LEFT JOIN delevery_users u  ON u.users_id = rn.return_note_livreur
         LEFT JOIN delevery_zone z   ON z.zone_id = rn.return_note_zone
         LEFT JOIN delevery_users cb ON cb.users_id = rn.return_note_by
         LEFT JOIN delevery_users rb ON rb.users_id = rn.return_note_delivered_by
         ${whereSql}
         ORDER BY rn.return_note_time DESC, rn.return_note_id DESC
         LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-retour-livreur — body { livreur }. Crée un bon « Nouveau »
 * pour le livreur (sa zone est mémorisée sur le bon) et génère sa référence :
 * BRL-JJMMAA-0{id}0-{2 chiffres} (l'id du bon la rend unique).
 * Renvoie { id, ref }.
 */
async function createBon(req, res, next) {
  try {
    const livreur = parseInt(req.body?.livreur, 10);
    if (!Number.isInteger(livreur) || livreur <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un livreur.' });
    }
    // Zone du livreur : ville de fonction → delevery_tarifs.zone ; reste
    // vide (0) si la ville de fonction n'est pas renseignée.
    const [[livreurRow]] = await pool.query(
      `SELECT u.users_id AS id, vf.zone AS zone_id
         FROM delevery_users u
         LEFT JOIN delevery_tarifs vf ON vf.ville_id = u.users_ville_id
        WHERE u.users_id = ? AND u.users_active = 1 AND u.users_type = '5' LIMIT 1`,
      [livreur]
    );
    if (!livreurRow) {
      return res.status(400).json({ message: 'Livreur introuvable ou désactivé.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_return_note
           (return_note_ref, return_note_livreur, return_note_zone,
            return_note_time, return_note_by, return_note_delivered)
         VALUES ('', ?, ?, ?, ?, 0)`,
        [livreur, Number(livreurRow.zone_id) || 0, now, Number(req.user.id)]
      );
      const bonId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `BRL-${jj}${mm}${aa}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(
        `UPDATE delevery_return_note SET return_note_ref = ? WHERE return_note_id = ?`,
        [ref, bonId]
      );
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
 * GET /api/bons-retour-livreur/:id — détail d'un bon : informations
 * (référence, date, livreur, zone, statut) + colis du bon (code, magasin,
 * ville, adresse, statut avant ajout au bon, réception, mode d'ajout), du
 * plus récemment ajouté au plus ancien. Sert la page de modification, la
 * modale « Détail du bon », la modale de réception par scan et l'export PDF.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const [parcels] = await pool.query(
      `SELECT p.parcel_id       AS id,
              p.parcel_code     AS code,
              p.parcel_address  AS adresse,
              t.nom_ville       AS ville,
              c.customers_store AS magasin,
              p.parcel_replace  AS replace_flag,
              p.parcel_report_time AS report_time,
              IF(p.parcel_status = 'DELIVERED' AND COALESCE(rp.rn_parcels_status_before, '') = '',
                 'DELIVERED', rp.rn_parcels_status_before) AS statut_avant,
              rp.rn_parcels_received      AS received,
              rp.rn_parcels_received_time AS received_time,
              rp.rn_parcels_scan          AS scan
         FROM delevery_rn_parcels rp
         JOIN delevery_parcel p ON p.parcel_id = rp.rn_parcels_parcel
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE rp.rn_parcels_rn = ?
        ORDER BY rp.rn_parcels_id DESC`,
      [bon.id]
    );
    res.json({ ...bon, parcels });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-livreur/:id/available — colis retournables du livreur
 * du bon (« En cours », ou échange livré à retourner — affiché « Livré »),
 * hors circuit de retour agence (déjà expédiés / reçus). Les colis au statut
 * second bloqué (Programmé, Reporté, Client intéressé, Relance nouveau
 * client, En attente de relance) sont renvoyés avec bloque = true : listés
 * mais non ajoutables. report_time (parcel_report_time, "JJ/MM/AAAA" ou
 * "AAAA-MM-JJ") : date programmée / de report affichée sous le statut.
 */
async function listAvailable(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const [rows] = await pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_replace AS replace_flag,
              p.parcel_report_time AS report_time,
              IF(p.parcel_status = 'DELIVERED' AND COALESCE(p.parcel_status_second, '') = '',
                 'DELIVERED', COALESCE(p.parcel_status_second, '')) AS statut,
              t.nom_ville AS ville, c.customers_store AS magasin
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE ${RETOURNABLE_SQL} AND p.parcel_livreur = ?
          AND COALESCE(p.parcel_status_second, '') NOT IN (?)
        ORDER BY p.parcel_last_update DESC, p.parcel_id DESC`,
      [bon.livreur_id, [STATUT_EXPEDIE, STATUT_RECU, ...STATUTS_CIRCUIT_CLIENT]]
    );
    res.json(
      rows.map((r) => ({ ...r, bloque: STATUTS_NON_AJOUTABLES.includes(r.statut) }))
    );
  } catch (err) {
    next(err);
  }
}

/**
 * Ajoute un colis (déjà chargé et validé) dans le bon, dans la transaction
 * fournie : parcel_status → RETURNED (un colis échange livré garde
 * DELIVERED), parcel_status_second → EXPEDIE_AGENCE_PRINCIPALE, ligne
 * d'historique, ligne delevery_rn_parcels avec le statut second précédent
 * (restauré au retrait) et le mode d'ajout.
 */
async function insertParcelIntoBon(conn, bon, parcel, scan, userId, now) {
  const statut = statutCircuit(parcel.status);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [statut, STATUT_EXPEDIE, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_status_second,
        parcel_history_time, parcel_history_livreur, parcel_history_by)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
    [parcel.id, parcel.situation || '', statut, STATUT_EXPEDIE, now, Number(bon.livreur_id) || 0, userId]
  );
  await conn.query(
    `INSERT INTO delevery_rn_parcels
       (rn_parcels_rn, rn_parcels_parcel, rn_parcels_time,
        rn_parcels_status_before, rn_parcels_scan)
     VALUES (?, ?, ?, ?, ?)`,
    [bon.id, parcel.id, now, parcel.second || '', scan]
  );
}

/**
 * Valide un colis chargé (FOR UPDATE) avant son ajout au bon ; renvoie null
 * si tout est bon, sinon { status, message }.
 */
async function validateForAdd(bon, parcel) {
  if (Number(parcel.livreur) !== Number(bon.livreur_id)) {
    return { status: 409, message: `Colis « ${parcel.code} » affecté à un autre livreur.` };
  }
  // Contrôles du circuit retour avant le statut : un colis en circuit est
  // RETURNED, le message « déjà dans un bon » est plus utile que le statut.
  if (parcel.second === STATUT_EXPEDIE || parcel.second === STATUT_RECU) {
    return { status: 409, message: `Colis « ${parcel.code} » déjà dans un bon de retour.` };
  }
  if (STATUTS_CIRCUIT_CLIENT.includes(parcel.second)) {
    return { status: 409, message: `Colis « ${parcel.code} » déjà dans un bon de retour client.` };
  }
  // Un colis livré n'est ajoutable que s'il est un colis échange (à
  // remplacer) dont la marchandise échangée n'est pas encore retournée.
  const echangeLivre = parcel.status === 'DELIVERED' && Number(parcel.replace_flag) === 1;
  if (parcel.status !== 'IN_PROGRESS' && !echangeLivre) {
    return {
      status: 409,
      message: `Colis « ${parcel.code} » non ajoutable (statut actuel : ${await statutLabel(parcel.status)}).`
    };
  }
  if (echangeLivre && Number(parcel.returned_livreur) === 1) {
    return {
      status: 409,
      message: `Colis « ${parcel.code} » : la marchandise échangée est déjà retournée.`
    };
  }
  if (STATUTS_NON_AJOUTABLES.includes(parcel.second)) {
    return {
      status: 409,
      message: `Colis « ${parcel.code} » non ajoutable (statut : ${await statutLabel(parcel.second)}).`
    };
  }
  return null;
}

const PARCEL_SELECT = `
  SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
         COALESCE(p.parcel_status_second, '') AS second,
         p.parcel_situation AS situation, p.parcel_livreur AS livreur,
         p.parcel_replace AS replace_flag,
         p.parcel_returned_livreur AS returned_livreur,
         t.nom_ville AS ville, c.customers_store AS magasin
    FROM delevery_parcel p
    LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer`;

/**
 * POST /api/bons-retour-livreur/:id/parcels — body { ids: [parcel_id], scan? }.
 * Ajout (manuel ou par sélection) de colis au bon : chaque colis doit être
 * IN_PROGRESS, affecté au livreur du bon et hors statuts bloqués ; les autres
 * sont ignorés avec un motif. Renvoie { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est reçu : ajout impossible.' });
    }

    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    const scan = parseScanMode(req.body?.scan);

    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const parcelId of ids) {
        const [[parcel]] = await conn.query(
          `${PARCEL_SELECT} WHERE p.parcel_id = ? LIMIT 1 FOR UPDATE`,
          [parcelId]
        );
        if (!parcel) {
          skipped.push({ code: `#${parcelId}`, reason: 'Colis introuvable.' });
          continue;
        }
        const failure = await validateForAdd(bon, parcel);
        if (failure) {
          skipped.push({ code: parcel.code, reason: failure.message });
          continue;
        }
        await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
        added.push({
          id: parcel.id,
          code: parcel.code,
          ville: parcel.ville,
          magasin: parcel.magasin,
          replace_flag: parcel.replace_flag,
          statut_avant: statutAffiche(parcel.second, parcel.status),
          scan
        });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({ added, skipped });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-retour-livreur/:id/scan — body { code, scan }.
 * Scan d'un code colis (douchette ou caméra) pour l'AJOUTER au bon : mêmes
 * règles que l'ajout manuel, ligne colis verrouillée (FOR UPDATE). Messages
 * d'erreur précis pour le retour sonore.
 */
async function scanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est reçu : ajout impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });
    const scan = parseScanMode(req.body?.scan) || 'douchette';

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let addedParcel = null;
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `${PARCEL_SELECT}
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (parcel.second === STATUT_EXPEDIE || parcel.second === STATUT_RECU) {
        const [[inBon]] = await conn.query(
          `SELECT rn_parcels_id FROM delevery_rn_parcels
            WHERE rn_parcels_rn = ? AND rn_parcels_parcel = ? LIMIT 1`,
          [bon.id, parcel.id]
        );
        failure = inBon
          ? { status: 409, message: `Colis « ${parcel.code} » déjà dans ce bon.` }
          : { status: 409, message: `Colis « ${parcel.code} » déjà dans un autre bon de retour.` };
      } else {
        failure = await validateForAdd(bon, parcel);
        if (!failure) {
          await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
          addedParcel = {
            id: parcel.id,
            code: parcel.code,
            ville: parcel.ville,
            magasin: parcel.magasin,
            replace_flag: parcel.replace_flag,
            statut_avant: statutAffiche(parcel.second, parcel.status),
            scan
          };
        }
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
    res.json({ message: `Colis « ${addedParcel.code} » ajouté au bon.`, parcel: addedParcel });
  } catch (err) {
    next(err);
  }
}

/**
 * Retire un colis du bon dans la transaction fournie : parcel_status →
 * IN_PROGRESS (un colis échange livré reste DELIVERED) + statut second
 * restauré (rn_parcels_status_before) + suppression de la dernière ligne
 * d'historique EXPEDIE_AGENCE_PRINCIPALE et de la ligne delevery_rn_parcels.
 */
async function deleteParcelFromBon(conn, row, now) {
  await conn.query(`DELETE FROM delevery_rn_parcels WHERE rn_parcels_id = ?`, [row.link_id]);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [row.status === 'DELIVERED' ? 'DELIVERED' : 'IN_PROGRESS', row.statut_avant || '', now, row.id]
  );
  await conn.query(
    `DELETE FROM delevery_parcel_history
      WHERE parcel_history_parcel = ? AND parcel_history_status_second = ?
      ORDER BY parcel_history_id DESC LIMIT 1`,
    [row.id, STATUT_EXPEDIE]
  );
}

/**
 * POST /api/bons-retour-livreur/:id/scan-retrait — body { code }.
 * Scan d'un code colis pour le RETIRER du bon : le colis doit être dans ce
 * bon et pas encore reçu. Le statut second d'avant l'ajout est restauré.
 */
async function removeScanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est reçu : retrait impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let removedParcel = null;
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_code AS code, t.nom_ville AS ville,
                c.customers_store AS magasin,
                p.parcel_status AS status, p.parcel_replace AS replace_flag,
                rp.rn_parcels_id AS link_id,
                rp.rn_parcels_received AS received,
                rp.rn_parcels_status_before AS statut_avant
           FROM delevery_parcel p
           LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
           LEFT JOIN delevery_rn_parcels rp
             ON rp.rn_parcels_rn = ? AND rp.rn_parcels_parcel = p.parcel_id
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [bon.id, code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (!parcel.link_id) {
        failure = { status: 409, message: `Colis « ${parcel.code} » absent de ce bon.` };
      } else {
        // Un colis engagé sur un bon de retour client doit d'abord en être retiré.
        const bonClient = await bonClientDuColis(conn, parcel.id);
        if (bonClient) {
          failure = {
            status: 409,
            message: `Colis « ${parcel.code} » est sur le bon de retour client « ${bonClient.ref} » : retirez-le d'abord du bon client.`
          };
        } else if (Number(parcel.received) === 1) {
          failure = { status: 409, message: `Colis « ${parcel.code} » déjà reçu : retrait impossible.` };
        }
      }
      if (!failure && parcel && parcel.link_id) {
        await deleteParcelFromBon(conn, parcel, now);
        removedParcel = {
          id: parcel.id,
          code: parcel.code,
          ville: parcel.ville,
          magasin: parcel.magasin,
          replace_flag: parcel.replace_flag,
          statut: statutAffiche(parcel.statut_avant, parcel.status)
        };
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
 * DELETE /api/bons-retour-livreur/:id/parcels/:parcelId — retire un colis du
 * bon : statut second restauré (statut d'avant l'ajout). Un colis déjà reçu
 * ne peut pas être retiré.
 */
async function removeParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est reçu : suppression impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10);
    const [[row]] = await pool.query(
      `SELECT rp.rn_parcels_id AS link_id, rp.rn_parcels_received AS received,
              rp.rn_parcels_status_before AS statut_avant,
              p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_status AS status, p.parcel_replace AS replace_flag
         FROM delevery_rn_parcels rp
         JOIN delevery_parcel p ON p.parcel_id = rp.rn_parcels_parcel
        WHERE rp.rn_parcels_rn = ? AND rp.rn_parcels_parcel = ? LIMIT 1`,
      [bon.id, parcelId || 0]
    );
    if (!row) return res.status(404).json({ message: 'Colis introuvable dans ce bon.' });
    // Un colis engagé sur un bon de retour client doit d'abord en être retiré.
    const bonClient = await bonClientDuColis(pool, row.id);
    if (bonClient) {
      return res.status(400).json({
        message: `Colis « ${row.code} » est sur le bon de retour client « ${bonClient.ref} » : retirez-le d'abord du bon client.`
      });
    }
    if (Number(row.received) === 1) {
      return res.status(400).json({ message: `Colis « ${row.code} » déjà reçu : retrait impossible.` });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await deleteParcelFromBon(conn, row, now);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({
      id: row.id,
      code: row.code,
      replace_flag: row.replace_flag,
      statut: statutAffiche(row.statut_avant, row.status)
    });
  } catch (err) {
    next(err);
  }
}

/** Passe un colis du bon en « Reçu par l'agence », dans la transaction
 * fournie. Un colis échange livré garde parcel_status = DELIVERED et sa
 * marchandise échangée est marquée retournée (parcel_returned_livreur = 1). */
async function receiveParcel(conn, bon, parcel, scan, userId, now) {
  const statut = statutCircuit(parcel.status);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?, parcel_last_update = ?
            ${statut === 'DELIVERED' ? `, parcel_returned_livreur = '1'` : ''}
      WHERE parcel_id = ?`,
    [statut, STATUT_RECU, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_status_second,
        parcel_history_time, parcel_history_livreur, parcel_history_by)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
    [parcel.id, parcel.situation || '', statut, STATUT_RECU, now, Number(bon.livreur_id) || 0, userId]
  );
  await conn.query(
    `UPDATE delevery_rn_parcels
        SET rn_parcels_received = 1, rn_parcels_received_time = ?,
            rn_parcels_received_scan = ?
      WHERE rn_parcels_id = ?`,
    [now, scan, parcel.link_id]
  );
}

/**
 * POST /api/bons-retour-livreur/:id/scan-reception — body { code, scan }.
 * Réception par scan (modale de la liste) : le colis doit être dans CE bon et
 * pas encore reçu → parcel_status_second = RECU_PAR_AGENCE (+ historique).
 * Renvoie le compteur { recus, total } du bon pour la progression.
 */
async function scanReception(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });
    const scan = parseScanMode(req.body?.scan) || 'douchette';

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let receivedParcel = null;
    let counts = null;
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_code AS code,
                p.parcel_situation AS situation, p.parcel_status AS status,
                rp.rn_parcels_id AS link_id, rp.rn_parcels_received AS received
           FROM delevery_parcel p
           LEFT JOIN delevery_rn_parcels rp
             ON rp.rn_parcels_rn = ? AND rp.rn_parcels_parcel = p.parcel_id
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [bon.id, code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (!parcel.link_id) {
        failure = { status: 409, message: `Colis « ${parcel.code} » n'est pas sur ce bon.` };
      } else if (Number(parcel.received) === 1) {
        failure = { status: 409, message: `Colis « ${parcel.code} » déjà reçu.` };
      } else {
        await receiveParcel(conn, bon, parcel, scan, Number(req.user.id), now);
        counts = await countRecus(conn, bon.id);
        receivedParcel = { id: parcel.id, code: parcel.code, received_time: now };
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
    res.json({
      message: `Colis « ${receivedParcel.code} » reçu par l'agence.`,
      parcel: receivedParcel,
      recus: counts.recus,
      total: counts.total
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-retour-livreur/:id/receive — body { received: 0|1 }.
 * received = 1 : bon « Reçu » + tous ses colis pas encore reçus passent en
 * RECU_PAR_AGENCE (ligne d'historique chacun) — les colis déjà reçus par scan
 * ne sont pas retouchés. Ces colis alimenteront les bons de retour clients.
 * received = 0 : bon « non reçu » → tout est annulé : les colis reçus (scan
 * compris) reviennent en EXPEDIE_AGENCE_PRINCIPALE, la ligne d'historique
 * RECU_PAR_AGENCE est supprimée et les indicateurs de réception réinitialisés.
 */
async function setReceived(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const received = Number(req.body?.received) === 1 ? 1 : 0;

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (received === 1) {
        await conn.query(
          `UPDATE delevery_return_note
              SET return_note_delivered = 1, return_note_delivered_time = ?,
                  return_note_delivered_by = ?
            WHERE return_note_id = ?`,
          [now, Number(req.user.id), bon.id]
        );
        const [parcels] = await conn.query(
          `SELECT p.parcel_id AS id, p.parcel_situation AS situation,
                  p.parcel_status AS status, rp.rn_parcels_id AS link_id
             FROM delevery_rn_parcels rp
             JOIN delevery_parcel p ON p.parcel_id = rp.rn_parcels_parcel
            WHERE rp.rn_parcels_rn = ? AND rp.rn_parcels_received = 0
            ORDER BY p.parcel_id FOR UPDATE`,
          [bon.id]
        );
        for (const parcel of parcels) {
          await receiveParcel(conn, bon, parcel, null, Number(req.user.id), now);
        }
        await conn.commit();
        return res.json({ id: bon.id, delivered: 1, received_time: now, receivedCount: parcels.length });
      }

      // Bon non reçu : impossible tant que des colis du bon sont engagés sur
      // un bon de retour client (les en retirer d'abord côté client).
      const nbClient = await nbColisSurBonClient(conn, bon.id);
      if (nbClient > 0) {
        await conn.rollback();
        return res.status(400).json({
          message: `${nbClient} colis de ce bon ${nbClient > 1 ? 'sont' : 'est'} sur un bon de retour client : retirez-les du bon client avant de passer ce bon en non reçu.`
        });
      }

      // Tout annuler — les colis reçus encore en
      // RECU_PAR_AGENCE (statut inchangé entre-temps) reviennent en
      // RETURNED / EXPEDIE_AGENCE_PRINCIPALE (toujours dans le circuit
      // retour ; un colis échange livré reste DELIVERED et sa marchandise
      // échangée redevient non retournée) et perdent leur ligne d'historique.
      const [parcels] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_status AS status,
                rp.rn_parcels_id AS link_id
           FROM delevery_rn_parcels rp
           JOIN delevery_parcel p ON p.parcel_id = rp.rn_parcels_parcel
          WHERE rp.rn_parcels_rn = ? AND rp.rn_parcels_received = 1
            AND COALESCE(p.parcel_status_second, '') = ?
          ORDER BY p.parcel_id FOR UPDATE`,
        [bon.id, STATUT_RECU]
      );
      for (const parcel of parcels) {
        const statut = statutCircuit(parcel.status);
        await conn.query(
          `UPDATE delevery_parcel
              SET parcel_status = ?, parcel_status_second = ?,
                  parcel_last_update = ?
                  ${statut === 'DELIVERED' ? `, parcel_returned_livreur = '0'` : ''}
            WHERE parcel_id = ?`,
          [statut, STATUT_EXPEDIE, now, parcel.id]
        );
        await conn.query(
          `DELETE FROM delevery_parcel_history
            WHERE parcel_history_parcel = ? AND parcel_history_status_second = ?
            ORDER BY parcel_history_id DESC LIMIT 1`,
          [parcel.id, STATUT_RECU]
        );
        await conn.query(
          `UPDATE delevery_rn_parcels
              SET rn_parcels_received = 0, rn_parcels_received_time = 0,
                  rn_parcels_received_scan = NULL
            WHERE rn_parcels_id = ?`,
          [parcel.link_id]
        );
      }
      await conn.query(
        `UPDATE delevery_return_note
            SET return_note_delivered = 0, return_note_delivered_time = 0,
                return_note_delivered_by = 0
          WHERE return_note_id = ?`,
        [bon.id]
      );
      await conn.commit();
      res.json({ id: bon.id, delivered: 0, received_time: 0 });
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
 * DELETE /api/bons-retour-livreur/:id — supprime un bon vide (aucun colis)
 * uniquement.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_rn_parcels WHERE rn_parcels_rn = ?`,
      [bon.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Ce bon contient des colis : suppression impossible.' });
    }
    await pool.query(`DELETE FROM delevery_return_note WHERE return_note_id = ?`, [bon.id]);
    res.json({ id: bon.id });
  } catch (err) {
    next(err);
  }
}

/** GET /api/bons-retour-livreur/sons — sons de l'étape retour (Options). */
async function getSons(req, res, next) {
  try {
    const urls = await getScanSonUrls();
    res.json({ success: urls.retour_success, error: urls.retour_error });
  } catch (err) {
    next(err);
  }
}

/*
 * Dashboard livreur (page /livreur/bon-retour, routes /livreur/*) : mêmes bons
 * que l'admin mais limités au livreur connecté (users_type 5). Le livreur crée
 * et modifie SES bons (ajout / retrait de colis, scan, suppression d'un bon
 * vide, PDF) ; la réception (« Bon reçu / non reçu », réception par scan)
 * reste réservée au service RETOUR : ces routes ne sont pas exposées côté
 * livreur.
 */

/**
 * Garde des routes /livreur/:id — vérifie que le bon appartient au livreur
 * connecté (sinon 404, comme un bon inexistant) puis délègue au handler admin.
 */
function ownBon(handler) {
  return async (req, res, next) => {
    try {
      const bon = await loadBon(req.params.id);
      if (!bon || Number(bon.livreur_id) !== Number(req.user.id)) {
        return res.status(404).json({ message: 'Bon introuvable.' });
      }
      return handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

/**
 * GET /api/bons-retour-livreur/livreur — bons du livreur connecté uniquement,
 * mêmes colonnes et filtres (status, dateFrom / dateTo) que la liste admin.
 */
async function listBonsLivreur(req, res, next) {
  req.query = { ...req.query, livreur: String(req.user.id) };
  return listBons(req, res, next);
}

/**
 * POST /api/bons-retour-livreur/livreur — crée un bon pour le livreur
 * connecté. Même prérequis que la modale admin : au moins un colis « En
 * cours » retournable.
 */
async function createBonLivreur(req, res, next) {
  try {
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_parcel p
        WHERE ${RETOURNABLE_SQL} AND p.parcel_livreur = ?
          AND COALESCE(p.parcel_status_second, '') NOT IN (?)`,
      [
        Number(req.user.id),
        [...STATUTS_NON_AJOUTABLES, STATUT_EXPEDIE, STATUT_RECU, ...STATUTS_CIRCUIT_CLIENT]
      ]
    );
    if (!Number(nb)) {
      return res.status(400).json({ message: "Vous n'avez aucun colis retournable." });
    }
    req.body = { livreur: Number(req.user.id) };
    return createBon(req, res, next);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listLivreurs,
  listBons,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  scanReception,
  setReceived,
  deleteBon,
  getSons,
  // Dashboard livreur : bons du livreur connecté uniquement.
  listBonsLivreur,
  createBonLivreur,
  getBonLivreur: ownBon(getBon),
  listAvailableLivreur: ownBon(listAvailable),
  addParcelsLivreur: ownBon(addParcels),
  scanParcelLivreur: ownBon(scanParcel),
  removeScanParcelLivreur: ownBon(removeScanParcel),
  removeParcelLivreur: ownBon(removeParcel),
  deleteBonLivreur: ownBon(deleteBon)
};
