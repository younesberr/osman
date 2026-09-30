const pool = require('../config/db');
const { getScanSonUrls } = require('../utils/scanSons');
const { getAgenceScope, userAgenceSql } = require('../utils/agenceScope');

/*
 * Bons de retour client (delevery_return_note_client + delevery_rnc_parcels,
 * tables de l'application — sql/2026-08-23_bons-retour-client.sql, colonnes du circuit
 * d'expédition : sql/2026-08-26_bons-retour-client-expedition.sql, REQUISE).
 * Un bon regroupe les colis d'un client à lui rendre. Même structure que les
 * bons de retour livreur (bonsRetourLivreur.controller.js), avec deux règles
 * propres :
 *
 *  - seuls les colis déjà sur un bon de retour livreur « Reçu » (ligne
 *    delevery_rn_parcels reçue + bon return_note_delivered = 1, statut second
 *    encore RECU_PAR_AGENCE) sont ajoutables ;
 *  - un colis sur un bon de retour client ne peut plus être retiré du bon de
 *    retour livreur tant qu'il n'est pas retiré du bon client (contrôles côté
 *    bonsRetourLivreur.controller.js).
 *
 * Cycle d'un bon : Nouveau → Expédié (scan du ticket + affectation à un
 * ramasseur type 6, rnc_expedited / rnc_affected_to) → Reçu (« retourné »
 * par le ramasseur, non vérifié ; ou par un admin, alors aussi vérifié,
 * rnc_delivered) → Vérifié (admin 1-4, rnc_verified). Statut dérivé :
 * verified → « Vérifié » ; sinon delivered → « Reçu (non vérifié) » ; sinon
 * expedited → « Expédié » ; sinon « Nouveau ». Un bon expédié pas encore
 * reçu peut être réaffecté à un autre ramasseur (PATCH /:id/affecter) : seul
 * rnc_affected_to change, l'expédition et les colis restent en l'état.
 *
 * Convention legacy : un colis en circuit retour est parcel_status = RETURNED
 * (posé dès son ajout à un bon de retour livreur), et parcel_status_second
 * porte l'étape du circuit. Exception colis échange livré (parcel_replace =
 * 1, retourné via un bon livreur) : il garde parcel_status = DELIVERED sur
 * tout le circuit (sa livraison et sa facturation restent acquises, c'est la
 * marchandise échangée qui revient) — seul le statut second suit le circuit.
 * L'AJOUT d'un colis au bon ne touche plus au
 * colis : seule la ligne delevery_rnc_parcels est créée (statut second du
 * moment mémorisé dans rnc_parcels_status_before, motif de retour — statut
 * d'origine avant le circuit, rn_parcels_status_before du bon retour
 * livreur — dans rnc_parcels_motif). C'est l'EXPÉDITION qui bascule les
 * colis du bon en RETURNED / RETURNED_TO_CUSTOMER (+ historique). Retrait
 * (bon non expédié seulement) : simple suppression de la ligne ; pour les
 * bons d'avant la refonte (colis déjà RETURNED_TO_CUSTOMER dès l'ajout), le
 * statut second est restauré et la ligne d'historique supprimée.
 *
 * Réception : par scan (colis par colis), via « Bon reçu » (admin), la
 * vérification d'un bon expédié, ou « Marquer comme retourné » (ramasseur
 * affecté) → parcel_status_second = RECU_BY_CUSTOMER (+ historique) — état
 * final. « Bon non reçu » annule tout : les colis reçus reviennent en
 * RETURNED_TO_CUSTOMER si le bon est expédié, sinon à leur statut d'avant
 * l'ajout (ligne d'historique RECU_BY_CUSTOMER supprimée) ; la vérification
 * est annulée, l'expédition et l'affectation conservées.
 *
 * Colis de stock (parcel_from_stock = 1) : même circuit jusqu'à la réception
 * du bon client, où le colis passe parcel_status_second = RETURNED_TO_STOCK
 * (« Retourné au stock », sql/2026-09-04_statut-retourne-au-stock.sql) au
 * lieu de RECU_BY_CUSTOMER, et les quantités de ses produits
 * (delevery_parcel_content, une ligne par unité) reviennent dans
 * delevery_product.product_qte avec un mouvement « colis retourné » dans
 * delevery_product_mvnt (mvnt_by = client, mvnt_validate_by = utilisateur,
 * mvnt_note = code du colis) — colis échange livré compris (il garde
 * DELIVERED). Produit introuvable ou colis sans contenu : le statut est posé
 * quand même, les lignes concernées sont ignorées et un avertissement est
 * renvoyé. État définitif : « Bon non reçu » ne touche ni au statut ni au
 * stock d'un colis de stock (sa ligne reste reçue, donc non retirable).
 */

const MAX_BONS = 1000;
const SCAN_MODES = ['douchette', 'camera'];

/* Statut second requis pour l'ajout (posé par la réception d'un bon retour livreur). */
const STATUT_SOURCE = 'RECU_PAR_AGENCE';
/* Statut second posé à l'ajout au bon / à la réception par le client. */
const STATUT_RETOURNE = 'RETURNED_TO_CUSTOMER';
const STATUT_RECU_CLIENT = 'RECU_BY_CUSTOMER';
/* Statut second posé à la réception d'un colis de stock (produits réintégrés). */
const STATUT_RETOURNE_STOCK = 'RETURNED_TO_STOCK';
/* Type de mouvement (delevery_product_mvnt.mvnt_type) de la réintégration. */
const MVNT_TYPE_COLIS_RETOURNE = 'colis retourné';

/** Vrai (SQL) si le colis est sur un bon de retour livreur « Reçu ». */
const SUR_BON_LIVREUR_RECU_SQL = `EXISTS (
  SELECT 1 FROM delevery_rn_parcels rp
    JOIN delevery_return_note rn ON rn.return_note_id = rp.rn_parcels_rn
   WHERE rp.rn_parcels_parcel = p.parcel_id
     AND rp.rn_parcels_received = 1 AND rn.return_note_delivered = 1)`;

/** Motif de retour (SQL) : statut d'avant l'ajout au bon retour livreur. */
const MOTIF_SQL = `(SELECT rp2.rn_parcels_status_before
    FROM delevery_rn_parcels rp2
   WHERE rp2.rn_parcels_parcel = p.parcel_id AND rp2.rn_parcels_received = 1
   ORDER BY rp2.rn_parcels_id DESC LIMIT 1)`;

/** Motif affiché / mémorisé (SQL) : « Livré » pour un colis échange livré
 * (statut second vide avant le circuit), sinon le statut d'avant l'ajout. */
const MOTIF_AFFICHE_SQL = `IF(p.parcel_status = 'DELIVERED' AND COALESCE(${MOTIF_SQL}, '') = '',
   'DELIVERED', COALESCE(${MOTIF_SQL}, ''))`;

/** Statut principal d'un colis dans le circuit retour : un colis échange
 * livré garde « Livré » (livraison et facturation acquises), les autres
 * passent RETURNED (convention legacy). */
function statutCircuit(status) {
  return status === 'DELIVERED' ? 'DELIVERED' : 'RETURNED';
}

/**
 * Vrai (SQL) si le colis est sur un bon de retour client « actif » (ligne pas
 * encore reçue, ou bon pas encore reçu). L'ajout ne changeant plus le statut
 * du colis, c'est cette présence qui le rend indisponible ; une ligne reçue
 * d'un bon reçu (cycle terminé) ne bloque pas un éventuel nouveau cycle.
 */
const SUR_BON_CLIENT_ACTIF_SQL = `EXISTS (
  SELECT 1 FROM delevery_rnc_parcels cp2
    JOIN delevery_return_note_client bb ON bb.rnc_id = cp2.rnc_parcels_rnc
   WHERE cp2.rnc_parcels_parcel = p.parcel_id
     AND (cp2.rnc_parcels_received = 0 OR bb.rnc_delivered = 0))`;

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
    `SELECT b.rnc_id             AS id,
            b.rnc_ref            AS ref,
            b.rnc_time           AS time,
            b.rnc_delivered      AS delivered,
            b.rnc_delivered_time AS received_time,
            b.rnc_affected_to    AS affected_to,
            b.rnc_expedited      AS expedited,
            b.rnc_expedited_time AS expedited_time,
            b.rnc_verified       AS verified,
            b.rnc_verified_time  AS verified_time,
            b.rnc_customer       AS client_id,
            c.customers_store    AS store,
            c.customers_name     AS client_name,
            c.customers_phone    AS phone,
            c.customers_address  AS address,
            t.nom_ville          AS ville,
            ru.users_name        AS ramasseur_nom
       FROM delevery_return_note_client b
       LEFT JOIN delevery_customers c ON c.customers_id = b.rnc_customer
       LEFT JOIN delevery_tarifs t    ON t.ville_id = c.customers_pickup_city
       LEFT JOIN delevery_users ru    ON ru.users_id = b.rnc_affected_to
      WHERE b.rnc_id = ? LIMIT 1`,
    [bonId]
  );
  return bon || null;
}

/** Un bon est modifiable tant qu'il n'est ni expédié ni reçu. */
function bonEditable(bon) {
  return Number(bon.delivered) !== 1 && Number(bon.expedited) !== 1;
}

/**
 * Reverrouille le bon dans la transaction fournie (FOR UPDATE) et revalide
 * qu'il est modifiable : ferme la course « expédition / réception pendant un
 * ajout ou retrait » (le premier contrôle bonEditable est fait hors verrou).
 */
async function lockBonEditable(conn, bonId) {
  const [[row]] = await conn.query(
    `SELECT rnc_delivered AS delivered, rnc_expedited AS expedited
       FROM delevery_return_note_client WHERE rnc_id = ? LIMIT 1 FOR UPDATE`,
    [bonId]
  );
  return Boolean(row) && bonEditable(row);
}

/** Mode de scan depuis le body : 'douchette' | 'camera' | null (manuel). */
function parseScanMode(value) {
  const scan = String(value || '').trim();
  return SCAN_MODES.includes(scan) ? scan : null;
}

/** Compteur reçus / total d'un bon (après un scan de réception). */
async function countRecus(conn, bonId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(rnc_parcels_received = 1), 0) AS recus
       FROM delevery_rnc_parcels WHERE rnc_parcels_rnc = ?`,
    [bonId]
  );
  return { total: Number(row.total), recus: Number(row.recus) };
}

/**
 * GET /api/bons-retour-client/clients — clients actifs avec leur nombre de
 * colis retournables (reçus par l'agence via un bon de retour livreur
 * « Reçu », statut second encore RECU_PAR_AGENCE). Sert la modale de création
 * (clients avec retournable > 0) et le filtre client de la page.
 */
async function listClients(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.customers_id AS id, c.customers_store AS store,
              c.customers_name AS nom, COALESCE(cnt.retournable, 0) AS retournable
         FROM delevery_customers c
         LEFT JOIN (
           SELECT p.parcel_customer, COUNT(*) AS retournable
             FROM delevery_parcel p
            WHERE p.parcel_status IN ('RETURNED', 'IN_PROGRESS', 'DELIVERED')
              AND COALESCE(p.parcel_status_second, '') = ?
              AND ${SUR_BON_LIVREUR_RECU_SQL}
              AND NOT ${SUR_BON_CLIENT_ACTIF_SQL}
            GROUP BY p.parcel_customer
         ) cnt ON cnt.parcel_customer = c.customers_id
        WHERE IFNULL(c.customers_active, 0) = 1
        ORDER BY c.customers_store, c.customers_name`,
      [STATUT_SOURCE]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Condition SQL du filtre statut d'une liste de bons (alias b) ; '' = tous.
 * new / expedited / received / received_unverified / verified — « received »
 * (tous les bons reçus) est conservé pour compatibilité (anciennes valeurs du
 * filtre, dashboard client).
 */
function statusWhereSql(status) {
  if (status === 'new') return 'b.rnc_delivered = 0 AND b.rnc_expedited = 0';
  if (status === 'expedited') return 'b.rnc_expedited = 1 AND b.rnc_delivered = 0';
  if (status === 'received') return 'b.rnc_delivered = 1';
  if (status === 'received_unverified') return 'b.rnc_delivered = 1 AND b.rnc_verified = 0';
  if (status === 'verified') return 'b.rnc_verified = 1';
  return '';
}

/**
 * GET /api/bons-retour-client — liste des bons pour la datatable.
 * Query : client (customers_id), ramasseur (users_id affecté, filtre
 * « Affecté à »), status (new | expedited | received | received_unverified |
 * verified, '' = tous), dateFrom / dateTo (AAAA-MM-JJ, sur la date de
 * création). 1000 bons max, du plus récent au plus ancien (pagination côté
 * client). nb_recus permet à l'interface de masquer « Modifier » quand tous
 * les colis sont déjà reçus par scan.
 */
async function listBons(req, res, next) {
  try {
    const client = parseInt(req.query.client, 10) || 0;
    const ramasseur = parseInt(req.query.ramasseur, 10) || 0;
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    if (client) {
      where.push('b.rnc_customer = ?');
      params.push(client);
    }
    if (ramasseur) {
      where.push('b.rnc_affected_to = ?');
      params.push(ramasseur);
    }
    const statusSql = statusWhereSql(status);
    if (statusSql) where.push(statusSql);
    if (dateFrom !== null) {
      where.push('b.rnc_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('b.rnc_time <= ?');
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT b.rnc_id             AS id,
              b.rnc_ref            AS ref,
              b.rnc_time           AS time,
              b.rnc_delivered      AS delivered,
              b.rnc_delivered_time AS received_time,
              b.rnc_affected_to    AS affected_to,
              b.rnc_expedited      AS expedited,
              b.rnc_expedited_time AS expedited_time,
              b.rnc_verified       AS verified,
              b.rnc_verified_time  AS verified_time,
              b.rnc_customer       AS client_id,
              c.customers_store    AS store,
              c.customers_name     AS client_name,
              cb.users_name        AS created_by,
              rb.users_name        AS received_by,
              ru.users_name        AS ramasseur_nom,
              vb.users_name        AS verified_by,
              (SELECT COUNT(*) FROM delevery_rnc_parcels cp
                WHERE cp.rnc_parcels_rnc = b.rnc_id) AS nb_colis,
              (SELECT COUNT(*) FROM delevery_rnc_parcels cp
                WHERE cp.rnc_parcels_rnc = b.rnc_id
                  AND cp.rnc_parcels_received = 1) AS nb_recus
         FROM delevery_return_note_client b
         LEFT JOIN delevery_customers c ON c.customers_id = b.rnc_customer
         LEFT JOIN delevery_users cb ON cb.users_id = b.rnc_by
         LEFT JOIN delevery_users rb ON rb.users_id = b.rnc_delivered_by
         LEFT JOIN delevery_users ru ON ru.users_id = b.rnc_affected_to
         LEFT JOIN delevery_users vb ON vb.users_id = b.rnc_verified_by
         ${whereSql}
         ORDER BY b.rnc_time DESC, b.rnc_id DESC
         LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-retour-client — body { client }. Crée un bon « Nouveau »
 * pour le client et génère sa référence : BRC-JJMMAA-0{id}0-{2 chiffres}
 * (l'id du bon la rend unique). Renvoie { id, ref }.
 */
async function createBon(req, res, next) {
  try {
    const client = parseInt(req.body?.client, 10);
    if (!Number.isInteger(client) || client <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un client.' });
    }
    const [[clientRow]] = await pool.query(
      `SELECT customers_id AS id FROM delevery_customers
        WHERE customers_id = ? AND IFNULL(customers_active, 0) = 1 LIMIT 1`,
      [client]
    );
    if (!clientRow) {
      return res.status(400).json({ message: 'Client introuvable ou désactivé.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_return_note_client
           (rnc_ref, rnc_customer, rnc_time, rnc_by, rnc_delivered)
         VALUES ('', ?, ?, ?, 0)`,
        [client, now, Number(req.user.id)]
      );
      const bonId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `BRC-${jj}${mm}${aa}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(
        `UPDATE delevery_return_note_client SET rnc_ref = ? WHERE rnc_id = ?`,
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

/** Colis d'un bon (code, magasin, destinataire, téléphone, ville, adresse,
 * motif de retour, réception, mode d'ajout), du plus récemment ajouté au plus
 * ancien. */
async function loadBonParcels(bonId) {
  const [parcels] = await pool.query(
    `SELECT p.parcel_id       AS id,
            p.parcel_code     AS code,
            p.parcel_receiver AS destinataire,
            p.parcel_phone    AS telephone,
            p.parcel_address  AS adresse,
            t.nom_ville       AS ville,
            c.customers_store AS magasin,
            p.parcel_replace  AS replace_flag,
            cp.rnc_parcels_motif         AS motif,
            cp.rnc_parcels_status_before AS statut_avant,
            cp.rnc_parcels_received      AS received,
            cp.rnc_parcels_received_time AS received_time,
            cp.rnc_parcels_scan          AS scan
       FROM delevery_rnc_parcels cp
       JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
       LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
      WHERE cp.rnc_parcels_rnc = ?
      ORDER BY cp.rnc_parcels_id DESC`,
    [bonId]
  );
  return parcels;
}

/**
 * GET /api/bons-retour-client/:id — détail d'un bon : informations
 * (référence, date, client, statut) + colis du bon. Sert la page de
 * modification, la modale « Détail du bon », la modale de réception par scan
 * et l'export PDF.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    res.json({ ...bon, parcels: await loadBonParcels(bon.id) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-client/client — dashboard client : bons de retour du
 * client connecté (kind customer), en lecture seule. Query : status
 * (new | expedited | received | received_unverified | verified, '' = tous),
 * dateFrom / dateTo (AAAA-MM-JJ, date de création). Même forme que la liste
 * admin, sans les noms des utilisateurs internes (créé par / reçu par).
 */
async function listBonsClient(req, res, next) {
  try {
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['b.rnc_customer = ?'];
    const params = [Number(req.user.id)];
    const statusSql = statusWhereSql(status);
    if (statusSql) where.push(statusSql);
    if (dateFrom !== null) {
      where.push('b.rnc_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('b.rnc_time <= ?');
      params.push(dateTo);
    }

    const [rows] = await pool.query(
      `SELECT b.rnc_id             AS id,
              b.rnc_ref            AS ref,
              b.rnc_time           AS time,
              b.rnc_delivered      AS delivered,
              b.rnc_delivered_time AS received_time,
              b.rnc_expedited      AS expedited,
              b.rnc_expedited_time AS expedited_time,
              b.rnc_verified       AS verified,
              b.rnc_verified_time  AS verified_time,
              (SELECT COUNT(*) FROM delevery_rnc_parcels cp
                WHERE cp.rnc_parcels_rnc = b.rnc_id) AS nb_colis,
              (SELECT COUNT(*) FROM delevery_rnc_parcels cp
                WHERE cp.rnc_parcels_rnc = b.rnc_id
                  AND cp.rnc_parcels_received = 1) AS nb_recus
         FROM delevery_return_note_client b
        WHERE ${where.join(' AND ')}
        ORDER BY b.rnc_time DESC, b.rnc_id DESC
        LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-client/client/:id — dashboard client : détail d'un bon
 * du client connecté (mêmes informations que le détail admin) pour la modale
 * « Détail du bon » et l'export PDF. Bon d'un autre client → 404.
 */
async function getBonClient(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon || Number(bon.client_id) !== Number(req.user.id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    res.json({ ...bon, parcels: await loadBonParcels(bon.id) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-client/:id/available — colis du client du bon
 * ajoutables : statut second RECU_PAR_AGENCE, présents sur un bon de retour
 * livreur « Reçu » et sur aucun bon de retour client actif (l'ajout ne
 * changeant plus le statut, la présence sur un bon se lit dans les lignes).
 * parcel_status = RETURNED (IN_PROGRESS toléré pour les colis entrés dans le
 * circuit avant cette convention, DELIVERED pour les colis échange livrés).
 * Le motif de retour (statut d'avant le circuit retour, « Livré » pour un
 * colis échange) est renvoyé pour l'affichage.
 */
async function listAvailable(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const [rows] = await pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_replace AS replace_flag,
              ${MOTIF_AFFICHE_SQL} AS motif,
              t.nom_ville AS ville, c.customers_store AS magasin
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE p.parcel_status IN ('RETURNED', 'IN_PROGRESS', 'DELIVERED') AND p.parcel_customer = ?
          AND COALESCE(p.parcel_status_second, '') = ?
          AND ${SUR_BON_LIVREUR_RECU_SQL}
          AND NOT ${SUR_BON_CLIENT_ACTIF_SQL}
        ORDER BY p.parcel_last_update DESC, p.parcel_id DESC`,
      [bon.client_id, STATUT_SOURCE]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Ajoute un colis (déjà chargé et validé) dans le bon, dans la transaction
 * fournie : seule la ligne delevery_rnc_parcels est créée (statut second du
 * moment, motif de retour, mode d'ajout) — le colis n'est plus touché, il
 * basculera en RETURNED_TO_CUSTOMER à l'expédition du bon (expediteParcel).
 */
async function insertParcelIntoBon(conn, bon, parcel, scan, userId, now) {
  await conn.query(
    `INSERT INTO delevery_rnc_parcels
       (rnc_parcels_rnc, rnc_parcels_parcel, rnc_parcels_time,
        rnc_parcels_status_before, rnc_parcels_motif, rnc_parcels_scan)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [bon.id, parcel.id, now, parcel.second || '', parcel.motif || '', scan]
  );
}

/**
 * Bascule un colis du bon en « Retourné au client » à l'expédition, dans la
 * transaction fournie : parcel_status → RETURNED (normalise les colis d'avant
 * la convention ; un colis échange livré garde DELIVERED),
 * parcel_status_second → RETURNED_TO_CUSTOMER + ligne d'historique.
 */
async function expediteParcel(conn, parcel, userId, now) {
  const statut = statutCircuit(parcel.status);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [statut, STATUT_RETOURNE, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_status_second,
        parcel_history_time, parcel_history_livreur, parcel_history_by)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
    [parcel.id, parcel.situation || '', statut, STATUT_RETOURNE, now, Number(parcel.livreur) || 0, userId]
  );
}

/**
 * Valide un colis chargé (FOR UPDATE) avant son ajout au bon ; renvoie null
 * si tout est bon, sinon { status, message }.
 */
function validateForAdd(bon, parcel) {
  if (Number(parcel.customer) !== Number(bon.client_id)) {
    return { status: 409, message: `Colis « ${parcel.code} » appartient à un autre client.` };
  }
  // Présence sur un bon actif (nouveau flux) ou statut d'un bon expédié /
  // reçu (bons d'avant la refonte) : déjà engagé côté client.
  if (Number(parcel.sur_bon_client)
      || parcel.second === STATUT_RETOURNE || parcel.second === STATUT_RECU_CLIENT
      || parcel.second === STATUT_RETOURNE_STOCK) {
    return { status: 409, message: `Colis « ${parcel.code} » déjà dans un bon de retour client.` };
  }
  // IN_PROGRESS toléré : colis entrés dans le circuit avant la convention
  // « RETURNED dès l'ajout » (normalisés à l'ajout au bon client).
  // DELIVERED : colis échange livré, qui garde son statut sur tout le circuit.
  if (!['RETURNED', 'IN_PROGRESS', 'DELIVERED'].includes(parcel.status)
      || parcel.second !== STATUT_SOURCE || !Number(parcel.sur_bon_livreur)) {
    return {
      status: 409,
      message: `Colis « ${parcel.code} » non ajoutable : il doit être sur un bon de retour livreur « Reçu » (statut « Reçu par l'agence »).`
    };
  }
  return null;
}

const PARCEL_SELECT = `
  SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
         COALESCE(p.parcel_status_second, '') AS second,
         p.parcel_situation AS situation, p.parcel_livreur AS livreur,
         p.parcel_customer AS customer,
         p.parcel_replace AS replace_flag,
         ${MOTIF_AFFICHE_SQL} AS motif,
         ${SUR_BON_LIVREUR_RECU_SQL} AS sur_bon_livreur,
         ${SUR_BON_CLIENT_ACTIF_SQL} AS sur_bon_client,
         t.nom_ville AS ville, c.customers_store AS magasin
    FROM delevery_parcel p
    LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer`;

/**
 * POST /api/bons-retour-client/:id/parcels — body { ids: [parcel_id], scan? }.
 * Ajout (manuel ou par sélection) de colis au bon : chaque colis doit
 * appartenir au client du bon et être reçu par l'agence via un bon de retour
 * livreur « Reçu » ; les autres sont ignorés avec un motif. Renvoie
 * { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est expédié ou reçu : ajout impossible.' });
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
      if (!(await lockBonEditable(conn, bon.id))) {
        await conn.rollback();
        return res.status(400).json({ message: 'Ce bon est expédié ou reçu : ajout impossible.' });
      }
      for (const parcelId of ids) {
        const [[parcel]] = await conn.query(
          `${PARCEL_SELECT} WHERE p.parcel_id = ? LIMIT 1 FOR UPDATE`,
          [parcelId]
        );
        if (!parcel) {
          skipped.push({ code: `#${parcelId}`, reason: 'Colis introuvable.' });
          continue;
        }
        const failure = validateForAdd(bon, parcel);
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
          motif: parcel.motif,
          statut_avant: parcel.second,
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
 * POST /api/bons-retour-client/:id/scan — body { code, scan }.
 * Scan d'un code colis (douchette ou caméra) pour l'AJOUTER au bon : mêmes
 * règles que l'ajout manuel, ligne colis verrouillée (FOR UPDATE). Messages
 * d'erreur précis pour le retour sonore.
 */
async function scanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est expédié ou reçu : ajout impossible.' });
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
      if (!(await lockBonEditable(conn, bon.id))) {
        await conn.rollback();
        return res.status(400).json({ message: 'Ce bon est expédié ou reçu : ajout impossible.' });
      }
      const [[parcel]] = await conn.query(
        `${PARCEL_SELECT}
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (Number(parcel.sur_bon_client)
          || parcel.second === STATUT_RETOURNE || parcel.second === STATUT_RECU_CLIENT) {
        // Déjà engagé côté client : lien actif (nouveau flux) ou statut d'un
        // bon expédié / reçu (bons d'avant la refonte). Le lien dit lequel.
        const [[inBon]] = await conn.query(
          `SELECT rnc_parcels_id FROM delevery_rnc_parcels
            WHERE rnc_parcels_rnc = ? AND rnc_parcels_parcel = ? LIMIT 1`,
          [bon.id, parcel.id]
        );
        failure = inBon
          ? { status: 409, message: `Colis « ${parcel.code} » déjà dans ce bon.` }
          : { status: 409, message: `Colis « ${parcel.code} » déjà dans un autre bon de retour client.` };
      } else {
        failure = validateForAdd(bon, parcel);
        if (!failure) {
          await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
          addedParcel = {
            id: parcel.id,
            code: parcel.code,
            ville: parcel.ville,
            magasin: parcel.magasin,
            replace_flag: parcel.replace_flag,
            motif: parcel.motif,
            statut_avant: parcel.second,
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
 * Retire un colis du bon dans la transaction fournie. Nouveau flux (colis non
 * touché à l'ajout) : simple suppression de la ligne delevery_rnc_parcels.
 * Bons d'avant la refonte (colis basculé en RETURNED_TO_CUSTOMER dès
 * l'ajout) : statut second restauré (rnc_parcels_status_before) + suppression
 * de la dernière ligne d'historique RETURNED_TO_CUSTOMER.
 */
async function deleteParcelFromBon(conn, row, now) {
  await conn.query(`DELETE FROM delevery_rnc_parcels WHERE rnc_parcels_id = ?`, [row.link_id]);
  if ((row.second || '') !== STATUT_RETOURNE) return;
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status_second = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [row.statut_avant || '', now, row.id]
  );
  await conn.query(
    `DELETE FROM delevery_parcel_history
      WHERE parcel_history_parcel = ? AND parcel_history_status_second = ?
      ORDER BY parcel_history_id DESC LIMIT 1`,
    [row.id, STATUT_RETOURNE]
  );
}

/**
 * POST /api/bons-retour-client/:id/scan-retrait — body { code }.
 * Scan d'un code colis pour le RETIRER du bon : le colis doit être dans ce
 * bon et pas encore reçu. Le statut second d'avant l'ajout est restauré.
 */
async function removeScanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est expédié ou reçu : retrait impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let removedParcel = null;
    try {
      await conn.beginTransaction();
      if (!(await lockBonEditable(conn, bon.id))) {
        await conn.rollback();
        return res.status(400).json({ message: 'Ce bon est expédié ou reçu : retrait impossible.' });
      }
      const [[parcel]] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_code AS code, t.nom_ville AS ville,
                c.customers_store AS magasin,
                p.parcel_replace AS replace_flag,
                COALESCE(p.parcel_status_second, '') AS second,
                cp.rnc_parcels_id AS link_id,
                cp.rnc_parcels_received AS received,
                cp.rnc_parcels_motif AS motif,
                cp.rnc_parcels_status_before AS statut_avant
           FROM delevery_parcel p
           LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
           LEFT JOIN delevery_rnc_parcels cp
             ON cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_parcel = p.parcel_id
          WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
          LIMIT 1 FOR UPDATE`,
        [bon.id, code, code]
      );
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (!parcel.link_id) {
        failure = { status: 409, message: `Colis « ${parcel.code} » absent de ce bon.` };
      } else if (Number(parcel.received) === 1) {
        failure = { status: 409, message: `Colis « ${parcel.code} » déjà reçu : retrait impossible.` };
      } else {
        await deleteParcelFromBon(conn, parcel, now);
        removedParcel = {
          id: parcel.id,
          code: parcel.code,
          ville: parcel.ville,
          magasin: parcel.magasin,
          replace_flag: parcel.replace_flag,
          motif: parcel.motif || '',
          statut: parcel.statut_avant || ''
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
 * DELETE /api/bons-retour-client/:id/parcels/:parcelId — retire un colis du
 * bon : statut second restauré (RECU_PAR_AGENCE, statut d'avant l'ajout).
 * Un colis déjà reçu ne peut pas être retiré.
 */
async function removeParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est expédié ou reçu : suppression impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10);
    const [[row]] = await pool.query(
      `SELECT cp.rnc_parcels_id AS link_id, cp.rnc_parcels_received AS received,
              cp.rnc_parcels_status_before AS statut_avant,
              cp.rnc_parcels_motif AS motif,
              p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_replace AS replace_flag,
              COALESCE(p.parcel_status_second, '') AS second
         FROM delevery_rnc_parcels cp
         JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
        WHERE cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_parcel = ? LIMIT 1`,
      [bon.id, parcelId || 0]
    );
    if (!row) return res.status(404).json({ message: 'Colis introuvable dans ce bon.' });
    if (Number(row.received) === 1) {
      return res.status(400).json({ message: `Colis « ${row.code} » déjà reçu : retrait impossible.` });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (!(await lockBonEditable(conn, bon.id))) {
        await conn.rollback();
        return res.status(400).json({ message: 'Ce bon est expédié ou reçu : suppression impossible.' });
      }
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
      motif: row.motif || '',
      statut: row.statut_avant || ''
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Réintègre au stock les produits d'un colis de stock reçu, dans la
 * transaction fournie : pour chaque produit du contenu du colis
 * (delevery_parcel_content, une ligne par unité → quantité groupée), la ligne
 * produit est verrouillée, product_qte incrémenté et un mouvement
 * « colis retourné » tracé (miroir du « colis envoyé » de la création :
 * mvnt_by = client du colis, mvnt_validate_by = utilisateur qui reçoit,
 * mvnt_note = code du colis, appliqué immédiatement). Les lignes sans produit
 * (product_id 0 / NULL) ou dont le produit n'existe plus sont ignorées ; un
 * colis sans contenu ne réintègre rien. Renvoie la liste des avertissements
 * (vide si tout a été réintégré).
 */
async function reintegrerStock(conn, parcel, userId, now) {
  const avertissements = [];
  const [contenus] = await conn.query(
    `SELECT pc.parcel_content_product_id AS product_id,
            MAX(pc.parcel_content_product_name) AS nom,
            COUNT(*) AS qty
       FROM delevery_parcel_content pc
      WHERE pc.parcel_content_parcel_id = ?
      GROUP BY pc.parcel_content_product_id
      ORDER BY pc.parcel_content_product_id`,
    [parcel.id]
  );
  if (!contenus.length) {
    avertissements.push(`Colis « ${parcel.code} » : aucun produit enregistré, rien à réintégrer au stock.`);
    return avertissements;
  }
  for (const c of contenus) {
    const productId = Number(c.product_id) || 0;
    const qty = Number(c.qty) || 0;
    if (!productId || qty <= 0) {
      avertissements.push(`Colis « ${parcel.code} » : ligne « ${c.nom || '—'} » sans produit, ignorée.`);
      continue;
    }
    const [[produit]] = await conn.query(
      `SELECT product_id FROM delevery_product WHERE product_id = ? LIMIT 1 FOR UPDATE`,
      [productId]
    );
    if (!produit) {
      avertissements.push(`Colis « ${parcel.code} » : produit « ${c.nom || productId} » introuvable, non réintégré.`);
      continue;
    }
    await conn.query(
      `UPDATE delevery_product SET product_qte = product_qte + ? WHERE product_id = ?`,
      [qty, productId]
    );
    await conn.query(
      `INSERT INTO delevery_product_mvnt
         (id_product, mvnt_qte, mvnt_type, mvnt_statut, mvnt_date, mvnt_by, mvnt_member,
          mvnt_commentaire, mvnt_validate_by, mvnt_note)
       VALUES (?, ?, ?, 1, FROM_UNIXTIME(?), ?, NULL, NULL, ?, ?)`,
      [productId, qty, MVNT_TYPE_COLIS_RETOURNE, now, Number(parcel.customer) || null, userId, parcel.code || '']
    );
  }
  return avertissements;
}

/**
 * Passe un colis du bon en « Reçu par le client », dans la transaction
 * fournie : parcel_status → RETURNED (état final, comme le legacy ; un colis
 * échange livré garde DELIVERED) + parcel_status_second → RECU_BY_CUSTOMER.
 * Colis de stock (from_stock = 1) : statut second RETURNED_TO_STOCK et
 * produits réintégrés (reintegrerStock). `parcel` doit porter id, code,
 * status, situation, livreur, link_id, from_stock et customer. Renvoie les
 * avertissements de la réintégration (vide pour un colis normal).
 */
async function receiveParcel(conn, bon, parcel, scan, userId, now) {
  const statut = statutCircuit(parcel.status);
  const fromStock = Number(parcel.from_stock) === 1;
  const second = fromStock ? STATUT_RETOURNE_STOCK : STATUT_RECU_CLIENT;
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, parcel_status_second = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [statut, second, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_status_second,
        parcel_history_time, parcel_history_livreur, parcel_history_by)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
    [parcel.id, parcel.situation || '', statut, second, now, Number(parcel.livreur) || 0, userId]
  );
  await conn.query(
    `UPDATE delevery_rnc_parcels
        SET rnc_parcels_received = 1, rnc_parcels_received_time = ?,
            rnc_parcels_received_scan = ?
      WHERE rnc_parcels_id = ?`,
    [now, scan, parcel.link_id]
  );
  // Garde-fou : un colis déjà « Retourné au stock » (statut inchangé entre
  // temps) n'est jamais réintégré deux fois.
  if (!fromStock || parcel.second === STATUT_RETOURNE_STOCK) return [];
  return reintegrerStock(conn, parcel, userId, now);
}

/** Colonnes colis communes aux SELECT de réception (voir receiveParcel). */
const RECEIVE_PARCEL_COLS = `p.parcel_id AS id, p.parcel_code AS code,
                p.parcel_situation AS situation, p.parcel_livreur AS livreur,
                p.parcel_status AS status,
                COALESCE(p.parcel_status_second, '') AS second,
                p.parcel_from_stock AS from_stock, p.parcel_customer AS customer,
                cp.rnc_parcels_id AS link_id`;

/** Reçoit tous les colis pas encore reçus d'un bon (transaction fournie) ;
 * renvoie { count, avertissements }. Colis verrouillés FOR UPDATE. */
async function receiveRemainingParcels(conn, bon, userId, now) {
  const [parcels] = await conn.query(
    `SELECT ${RECEIVE_PARCEL_COLS}
       FROM delevery_rnc_parcels cp
       JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
      WHERE cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_received = 0
      ORDER BY p.parcel_id FOR UPDATE`,
    [bon.id]
  );
  const avertissements = [];
  for (const parcel of parcels) {
    avertissements.push(...(await receiveParcel(conn, bon, parcel, null, userId, now)));
  }
  return { parcels, count: parcels.length, avertissements };
}

/**
 * POST /api/bons-retour-client/:id/scan-reception — body { code, scan }.
 * Réception par scan (modale de la liste) : le colis doit être dans CE bon et
 * pas encore reçu → RETURNED / RECU_BY_CUSTOMER (+ historique). Renvoie le
 * compteur { recus, total } du bon pour la progression.
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
    let avertissements = [];
    try {
      await conn.beginTransaction();
      const [[parcel]] = await conn.query(
        `SELECT ${RECEIVE_PARCEL_COLS}, cp.rnc_parcels_received AS received
           FROM delevery_parcel p
           LEFT JOIN delevery_rnc_parcels cp
             ON cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_parcel = p.parcel_id
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
      } else if (parcel.second !== STATUT_RETOURNE && parcel.second !== STATUT_SOURCE) {
        // Colis plus verrouillé à l'ajout : statut modifié entre temps
        // (ex. repassé « Livré ») — ne pas l'écraser en « Reçu par le client ».
        failure = {
          status: 409,
          message: `Colis « ${parcel.code} » n'est plus retournable (statut modifié) : retirez-le du bon.`
        };
      } else {
        avertissements = await receiveParcel(conn, bon, parcel, scan, Number(req.user.id), now);
        counts = await countRecus(conn, bon.id);
        receivedParcel = {
          id: parcel.id,
          code: parcel.code,
          received_time: now,
          from_stock: Number(parcel.from_stock) === 1 ? 1 : 0
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
    const base = receivedParcel.from_stock
      ? `Colis « ${receivedParcel.code} » retourné au stock (produits réintégrés).`
      : `Colis « ${receivedParcel.code} » reçu par le client.`;
    res.json({
      message: avertissements.length ? `${base} ${avertissements.join(' ')}` : base,
      parcel: receivedParcel,
      recus: counts.recus,
      total: counts.total,
      avertissements
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-retour-client/:id/receive — body { received: 0|1 }.
 * Endpoint admin (service RETOUR, jamais atteint par le ramasseur type 6).
 * received = 1 : bon « Reçu » ET « Vérifié » (une réception admin vaut
 * vérification) + tous ses colis pas encore reçus passent en RETURNED /
 * RECU_BY_CUSTOMER (ligne d'historique chacun) — les colis déjà reçus par
 * scan ne sont pas retouchés.
 * received = 0 : bon « non reçu » → réception et vérification annulées : les
 * colis reçus (scan compris) reviennent en RETURNED_TO_CUSTOMER si le bon
 * est expédié, sinon à leur statut d'avant l'ajout (RECU_PAR_AGENCE), la
 * ligne d'historique RECU_BY_CUSTOMER est supprimée et les indicateurs de
 * réception réinitialisés. L'expédition et l'affectation sont conservées :
 * le bon redevient « Expédié » s'il l'était, « Nouveau » sinon. Les colis de
 * stock déjà « Retourné au stock » ne sont pas concernés (statut, stock et
 * ligne reçue conservés : la requête ne cible que RECU_BY_CUSTOMER).
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
          `UPDATE delevery_return_note_client
              SET rnc_delivered = 1, rnc_delivered_time = ?, rnc_delivered_by = ?,
                  rnc_verified = 1, rnc_verified_time = ?, rnc_verified_by = ?
            WHERE rnc_id = ?`,
          [now, Number(req.user.id), now, Number(req.user.id), bon.id]
        );
        const [parcels] = await conn.query(
          `SELECT ${RECEIVE_PARCEL_COLS}
             FROM delevery_rnc_parcels cp
             JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
            WHERE cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_received = 0
            ORDER BY p.parcel_id FOR UPDATE`,
          [bon.id]
        );
        // Réception directe d'un bon jamais expédié : le colis n'est plus
        // verrouillé à l'ajout — s'il a changé de statut entre temps, ne pas
        // l'écraser (le retirer du bon d'abord).
        const bloque = parcels.find(
          (p) => p.second !== STATUT_RETOURNE && p.second !== STATUT_SOURCE
        );
        if (bloque) {
          await conn.rollback();
          return res.status(409).json({
            message: `Colis « ${bloque.code} » n'est plus retournable (statut modifié) : retirez-le du bon avant la réception.`
          });
        }
        const avertissements = [];
        for (const parcel of parcels) {
          avertissements.push(
            ...(await receiveParcel(conn, bon, parcel, null, Number(req.user.id), now))
          );
        }
        await conn.commit();
        return res.json({
          id: bon.id,
          delivered: 1,
          verified: 1,
          received_time: now,
          receivedCount: parcels.length,
          avertissements
        });
      }

      // Bon non reçu : tout annuler — les colis reçus encore en RETURNED /
      // RECU_BY_CUSTOMER (statut inchangé entre-temps) reviennent à l'état
      // d'avant réception (RETURNED_TO_CUSTOMER si le bon est expédié, sinon
      // statut d'avant l'ajout) et perdent leur ligne d'historique.
      const expedited = Number(bon.expedited) === 1;
      const [parcels] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_status AS status,
                cp.rnc_parcels_id AS link_id,
                cp.rnc_parcels_time AS link_time,
                cp.rnc_parcels_status_before AS statut_avant
           FROM delevery_rnc_parcels cp
           JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
          WHERE cp.rnc_parcels_rnc = ? AND cp.rnc_parcels_received = 1
            AND p.parcel_status IN ('RETURNED', 'DELIVERED')
            AND COALESCE(p.parcel_status_second, '') = ?
          ORDER BY p.parcel_id FOR UPDATE`,
        [bon.id, STATUT_RECU_CLIENT]
      );
      for (const parcel of parcels) {
        const cible = expedited ? STATUT_RETOURNE : (parcel.statut_avant || '');
        await conn.query(
          `UPDATE delevery_parcel
              SET parcel_status = ?, parcel_status_second = ?,
                  parcel_last_update = ?
            WHERE parcel_id = ?`,
          [statutCircuit(parcel.status), cible, now, parcel.id]
        );
        await conn.query(
          `DELETE FROM delevery_parcel_history
            WHERE parcel_history_parcel = ? AND parcel_history_status_second = ?
            ORDER BY parcel_history_id DESC LIMIT 1`,
          [parcel.id, STATUT_RECU_CLIENT]
        );
        if (cible !== STATUT_RETOURNE) {
          // Bon d'avant la refonte jamais expédié : la ligne d'historique
          // RETURNED_TO_CUSTOMER posée à l'ajout n'a plus d'équivalent dans le
          // nouveau flux — nettoyée pour que l'historique suive le statut. La
          // borne sur la date d'ajout au bon protège les lignes d'un éventuel
          // cycle de retour antérieur du colis.
          await conn.query(
            `DELETE FROM delevery_parcel_history
              WHERE parcel_history_parcel = ? AND parcel_history_status_second = ?
                AND parcel_history_time >= ?
              ORDER BY parcel_history_id DESC LIMIT 1`,
            [parcel.id, STATUT_RETOURNE, Number(parcel.link_time) || 0]
          );
        }
        await conn.query(
          `UPDATE delevery_rnc_parcels
              SET rnc_parcels_received = 0, rnc_parcels_received_time = 0,
                  rnc_parcels_received_scan = NULL
            WHERE rnc_parcels_id = ?`,
          [parcel.link_id]
        );
      }
      await conn.query(
        `UPDATE delevery_return_note_client
            SET rnc_delivered = 0, rnc_delivered_time = 0, rnc_delivered_by = 0,
                rnc_verified = 0, rnc_verified_time = 0, rnc_verified_by = 0
          WHERE rnc_id = ?`,
        [bon.id]
      );
      await conn.commit();
      res.json({ id: bon.id, delivered: 0, verified: 0, received_time: 0 });
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
 * GET /api/bons-retour-client/ramasseurs — ramasseurs actifs (comptes
 * principaux, users_type = 6) pour la liste déroulante de la modale
 * « Expédier au client » ; les types 3 / 4 ne voient que les ramasseurs de
 * leur agence. Copie du endpoint des demandes de ramassage (service
 * RAMASSAGE), non réutilisable ici : un admin peut avoir RETOUR sans
 * RAMASSAGE.
 */
async function listRamasseursRetour(req, res, next) {
  try {
    const where = [`u.users_active = 1`, `u.users_parent_id IS NULL`, `u.users_type = '6'`];
    const params = [];
    const scope = await getAgenceScope(req.user);
    if (scope !== null) {
      where.push(`${userAgenceSql('u')} = ?`);
      params.push(scope);
    }
    const [rows] = await pool.query(
      `SELECT u.users_id AS id, u.users_name AS nom
         FROM delevery_users u
        WHERE ${where.join(' AND ')}
        ORDER BY u.users_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Ramasseur cible d'une affectation (expédition, réaffectation) : mêmes
 * règles que la liste déroulante — ramasseur (type 6) actif, compte
 * principal, dans l'agence de l'appelant si celui-ci est restreint. Renvoie
 * { ramasseur: { id, nom } } ou { message } (erreur 400).
 */
async function resolveRamasseur(req, rawUserId) {
  const userId = parseInt(rawUserId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { message: 'Veuillez sélectionner un ramasseur.' };
  }
  const scope = await getAgenceScope(req.user);
  const [[ramasseur]] = await pool.query(
    `SELECT u.users_id AS id, u.users_name AS nom, ${userAgenceSql('u')} AS agence
       FROM delevery_users u
      WHERE u.users_id = ? AND u.users_active = 1
        AND u.users_parent_id IS NULL AND u.users_type = '6'
      LIMIT 1`,
    [userId]
  );
  if (!ramasseur) return { message: 'Ramasseur introuvable ou désactivé.' };
  if (scope !== null && Number(ramasseur.agence) !== scope) {
    return { message: 'Ce ramasseur n’appartient pas à votre agence.' };
  }
  return { ramasseur: { id: Number(ramasseur.id), nom: ramasseur.nom } };
}

/** Verrouille un bon par référence scannée (FOR UPDATE, transaction fournie). */
async function lockBonByRef(conn, ref) {
  const [[bon]] = await conn.query(
    `SELECT rnc_id AS id, rnc_ref AS ref, rnc_customer AS client_id,
            rnc_delivered AS delivered, rnc_expedited AS expedited,
            rnc_verified AS verified
       FROM delevery_return_note_client
      WHERE rnc_ref = ? LIMIT 1 FOR UPDATE`,
    [ref]
  );
  return bon || null;
}

/** Magasin / nom du client d'un bon (hors verrou, lecture seule). */
async function loadBonClient(conn, clientId) {
  const [[client]] = await conn.query(
    `SELECT customers_store AS store, customers_name AS client_name
       FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
    [clientId]
  );
  return client || {};
}

/**
 * POST /api/bons-retour-client/expedition/scan — body { code, userId, scan }.
 * Scan du ticket d'un bon (référence) dans la modale « Expédier au client » :
 * le bon « Nouveau » (avec au moins un colis) passe en « Expédié », est
 * affecté au ramasseur choisi (userId, type 6) et ses colis basculent en
 * RETURNED / RETURNED_TO_CUSTOMER (+ historique). Messages d'erreur précis
 * pour le retour sonore.
 */
async function scanExpedition(req, res, next) {
  try {
    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Référence du bon manquante.' });
    const cible = await resolveRamasseur(req, req.body?.userId);
    if (!cible.ramasseur) return res.status(400).json({ message: cible.message });
    const { ramasseur } = cible;

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let result = null;
    try {
      await conn.beginTransaction();
      const bon = await lockBonByRef(conn, code);
      if (!bon) {
        failure = { status: 404, message: `Bon « ${code} » introuvable.` };
      } else if (Number(bon.delivered) === 1 || Number(bon.verified) === 1) {
        failure = { status: 409, message: `Bon « ${bon.ref} » déjà reçu : expédition impossible.` };
      } else if (Number(bon.expedited) === 1) {
        failure = { status: 409, message: `Bon « ${bon.ref} » déjà expédié.` };
      } else {
        const [parcels] = await conn.query(
          `SELECT p.parcel_id AS id, p.parcel_code AS code,
                  p.parcel_situation AS situation, p.parcel_livreur AS livreur,
                  p.parcel_status AS status,
                  COALESCE(p.parcel_status_second, '') AS second,
                  cp.rnc_parcels_received AS received
             FROM delevery_rnc_parcels cp
             JOIN delevery_parcel p ON p.parcel_id = cp.rnc_parcels_parcel
            WHERE cp.rnc_parcels_rnc = ?
            ORDER BY p.parcel_id FOR UPDATE`,
          [bon.id]
        );
        // L'ajout ne verrouille plus le colis : si son statut a changé entre
        // temps (ex. repassé « Livré » depuis /admin/colis), ne surtout pas
        // l'écraser — le retirer du bon (encore modifiable) puis réexpédier.
        const bloque = parcels.find(
          (p) => Number(p.received) !== 1
            && p.second !== STATUT_RETOURNE && p.second !== STATUT_SOURCE
        );
        if (!parcels.length) {
          failure = { status: 409, message: `Bon « ${bon.ref} » vide : expédition impossible.` };
        } else if (bloque) {
          failure = {
            status: 409,
            message: `Colis « ${bloque.code} » n'est plus retournable (statut modifié) : retirez-le du bon avant l'expédition.`
          };
        } else {
          await conn.query(
            `UPDATE delevery_return_note_client
                SET rnc_expedited = 1, rnc_expedited_time = ?, rnc_expedited_by = ?,
                    rnc_affected_to = ?
              WHERE rnc_id = ?`,
            [now, Number(req.user.id), ramasseur.id, bon.id]
          );
          for (const parcel of parcels) {
            // Colis déjà reçu (scan de réception anticipé) ou déjà
            // RETURNED_TO_CUSTOMER (bon d'avant la refonte) : rien à basculer.
            if (Number(parcel.received) === 1 || parcel.second === STATUT_RETOURNE) continue;
            await expediteParcel(conn, parcel, Number(req.user.id), now);
          }
          const client = await loadBonClient(conn, bon.client_id);
          result = {
            id: bon.id,
            ref: bon.ref,
            store: client.store || '',
            client_name: client.client_name || '',
            nb_colis: parcels.length,
            ramasseur_nom: ramasseur.nom
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
    res.json({
      message: `Bon « ${result.ref} » expédié — affecté à ${result.ramasseur_nom}.`,
      bon: result
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-retour-client/:id/affecter — body { userId }. Réaffecte un
 * bon « Expédié » (pas encore reçu) à un autre ramasseur : seul
 * rnc_affected_to change — l'expédition (date, auteur) et les colis restent
 * en l'état ; le bon disparaît de l'onglet « À retourner » de l'ancien
 * ramasseur et apparaît dans celui du nouveau. Bon non expédié ou déjà reçu
 * → 409 ; même ramasseur → 400.
 */
async function affecterBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (Number(bon.expedited) !== 1) {
      return res.status(409).json({
        message: `Bon « ${bon.ref} » non expédié : affectez-le via « Expédier au client ».`
      });
    }
    if (Number(bon.delivered) === 1) {
      return res.status(409).json({ message: `Bon « ${bon.ref} » déjà reçu : réaffectation impossible.` });
    }

    const cible = await resolveRamasseur(req, req.body?.userId);
    if (!cible.ramasseur) return res.status(400).json({ message: cible.message });
    const { ramasseur } = cible;
    if (Number(bon.affected_to) === ramasseur.id) {
      return res.status(400).json({ message: `Bon « ${bon.ref} » déjà affecté à ${ramasseur.nom}.` });
    }

    // Mise à jour conditionnelle : ferme la course « réception / vérification
    // entre le contrôle et l'écriture » sans transaction.
    const [result] = await pool.query(
      `UPDATE delevery_return_note_client
          SET rnc_affected_to = ?
        WHERE rnc_id = ? AND rnc_expedited = 1 AND rnc_delivered = 0`,
      [ramasseur.id, bon.id]
    );
    if (!result.affectedRows) {
      return res.status(409).json({ message: `Bon « ${bon.ref} » modifié entre-temps : réaffectation impossible.` });
    }
    res.json({
      id: bon.id,
      affected_to: ramasseur.id,
      ramasseur_nom: ramasseur.nom,
      message: `Bon « ${bon.ref} » réaffecté à ${ramasseur.nom}.`
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Marque un bon « Vérifié » dans la transaction fournie ; s'il n'est pas
 * encore reçu (bon expédié), il est d'abord marqué « Reçu » et ses colis
 * restants passent en RECU_BY_CUSTOMER (+ historique). `bon` doit être
 * verrouillé (FOR UPDATE) et porter id / delivered. Renvoie
 * { markedReceived, avertissements } : true si le bon a aussi été marqué reçu,
 * et les avertissements de réintégration des colis de stock.
 */
async function verifyBonCore(conn, bon, userId, now) {
  let markedReceived = false;
  let avertissements = [];
  if (Number(bon.delivered) !== 1) {
    await conn.query(
      `UPDATE delevery_return_note_client
          SET rnc_delivered = 1, rnc_delivered_time = ?, rnc_delivered_by = ?
        WHERE rnc_id = ?`,
      [now, userId, bon.id]
    );
    ({ avertissements } = await receiveRemainingParcels(conn, bon, userId, now));
    markedReceived = true;
  }
  await conn.query(
    `UPDATE delevery_return_note_client
        SET rnc_verified = 1, rnc_verified_time = ?, rnc_verified_by = ?
      WHERE rnc_id = ?`,
    [now, userId, bon.id]
  );
  return { markedReceived, avertissements };
}

/** Contrôle commun avant vérification ; null si OK, sinon { status, message }. */
function validateForVerify(bon) {
  if (Number(bon.verified) === 1) {
    return { status: 409, message: `Bon « ${bon.ref} » déjà vérifié.` };
  }
  if (Number(bon.delivered) !== 1 && Number(bon.expedited) !== 1) {
    return { status: 409, message: `Bon « ${bon.ref} » non expédié : rien à vérifier.` };
  }
  return null;
}

/**
 * POST /api/bons-retour-client/verification/scan — body { code, scan }.
 * Scan du ticket d'un bon dans la modale « Vérifier par scan » : un bon
 * « Expédié » ou « Reçu (non vérifié) » (retourné par le ramasseur) passe en
 * « Vérifié » ; un bon seulement expédié est aussi marqué reçu (colis →
 * RECU_BY_CUSTOMER).
 */
async function scanVerification(req, res, next) {
  try {
    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Référence du bon manquante.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let result = null;
    try {
      await conn.beginTransaction();
      const bon = await lockBonByRef(conn, code);
      if (!bon) {
        failure = { status: 404, message: `Bon « ${code} » introuvable.` };
      } else {
        failure = validateForVerify(bon);
        if (!failure) {
          const { markedReceived, avertissements } =
            await verifyBonCore(conn, bon, Number(req.user.id), now);
          const client = await loadBonClient(conn, bon.client_id);
          result = {
            id: bon.id,
            ref: bon.ref,
            store: client.store || '',
            client_name: client.client_name || '',
            marked_received: markedReceived,
            avertissements
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
    const base = result.marked_received
      ? `Bon « ${result.ref} » vérifié (également marqué reçu).`
      : `Bon « ${result.ref} » vérifié.`;
    res.json({
      message: result.avertissements.length
        ? `${base} ${result.avertissements.join(' ')}`
        : base,
      bon: result
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-retour-client/:id/verifier — action « Vérifier » de la
 * liste : mêmes règles que la vérification par scan, bon ciblé par id.
 */
async function verifierBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const precheck = validateForVerify(bon);
    if (precheck) return res.status(precheck.status).json({ message: precheck.message });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let markedReceived = false;
    let avertissements = [];
    try {
      await conn.beginTransaction();
      const [[locked]] = await conn.query(
        `SELECT rnc_id AS id, rnc_ref AS ref, rnc_delivered AS delivered,
                rnc_expedited AS expedited, rnc_verified AS verified
           FROM delevery_return_note_client
          WHERE rnc_id = ? LIMIT 1 FOR UPDATE`,
        [bon.id]
      );
      failure = locked ? validateForVerify(locked) : { status: 404, message: 'Bon introuvable.' };
      if (!failure) {
        ({ markedReceived, avertissements } =
          await verifyBonCore(conn, locked, Number(req.user.id), now));
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
      id: bon.id, delivered: 1, verified: 1, marked_received: markedReceived, avertissements
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-retour-client/ramasseur — onglet « À retourner » du
 * ramasseur connecté (type 6, hors service RETOUR) : ses bons expédiés pas
 * encore retournés, avec les coordonnées du client pour la carte.
 */
async function listBonsRamasseur(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT b.rnc_id             AS id,
              b.rnc_ref            AS ref,
              b.rnc_time           AS time,
              b.rnc_expedited_time AS expedited_time,
              c.customers_store    AS store,
              c.customers_name     AS client_name,
              c.customers_phone    AS phone,
              c.customers_address  AS address,
              t.nom_ville          AS ville,
              (SELECT COUNT(*) FROM delevery_rnc_parcels cp
                WHERE cp.rnc_parcels_rnc = b.rnc_id) AS nb_colis
         FROM delevery_return_note_client b
         LEFT JOIN delevery_customers c ON c.customers_id = b.rnc_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = c.customers_pickup_city
        WHERE b.rnc_affected_to = ? AND b.rnc_expedited = 1 AND b.rnc_delivered = 0
        ORDER BY b.rnc_expedited_time DESC, b.rnc_id DESC
        LIMIT ${MAX_BONS}`,
      [Number(req.user.id)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-retour-client/:id/retourner — « Marquer comme retourné »
 * par le ramasseur affecté (type 6) : bon « Reçu » NON vérifié (la
 * vérification reste à faire par un admin 1-4) + colis restants →
 * RECU_BY_CUSTOMER. Bon non affecté à ce ramasseur ou non expédié → 404,
 * comme un bon inexistant (pattern demandes de ramassage).
 */
async function retournerBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (Number(bon.affected_to) !== Number(req.user.id) || Number(bon.expedited) !== 1) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (Number(bon.delivered) === 1) {
      return res.status(409).json({ message: 'Ce bon est déjà marqué retourné.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let avertissements = [];
    try {
      await conn.beginTransaction();
      const [[locked]] = await conn.query(
        `SELECT rnc_id AS id, rnc_delivered AS delivered,
                rnc_affected_to AS affected_to, rnc_expedited AS expedited
           FROM delevery_return_note_client
          WHERE rnc_id = ? LIMIT 1 FOR UPDATE`,
        [bon.id]
      );
      if (!locked || Number(locked.affected_to) !== Number(req.user.id)
          || Number(locked.expedited) !== 1) {
        failure = { status: 404, message: 'Bon introuvable.' };
      } else if (Number(locked.delivered) === 1) {
        failure = { status: 409, message: 'Ce bon est déjà marqué retourné.' };
      } else {
        await conn.query(
          `UPDATE delevery_return_note_client
              SET rnc_delivered = 1, rnc_delivered_time = ?, rnc_delivered_by = ?
            WHERE rnc_id = ?`,
          [now, Number(req.user.id), bon.id]
        );
        ({ avertissements } = await receiveRemainingParcels(conn, bon, Number(req.user.id), now));
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
    res.json({ id: bon.id, delivered: 1, received_time: now, avertissements });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bons-retour-client/:id — supprime un bon vide (aucun colis)
 * uniquement.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_rnc_parcels WHERE rnc_parcels_rnc = ?`,
      [bon.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Ce bon contient des colis : suppression impossible.' });
    }
    await pool.query(`DELETE FROM delevery_return_note_client WHERE rnc_id = ?`, [bon.id]);
    res.json({ id: bon.id });
  } catch (err) {
    next(err);
  }
}

/** GET /api/bons-retour-client/sons — sons de l'étape retour (Options). */
async function getSons(req, res, next) {
  try {
    const urls = await getScanSonUrls();
    res.json({ success: urls.retour_success, error: urls.retour_error });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listClients,
  listBons,
  listBonsClient,
  getBonClient,
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
  listRamasseursRetour,
  scanExpedition,
  affecterBon,
  scanVerification,
  verifierBon,
  listBonsRamasseur,
  retournerBon
};
