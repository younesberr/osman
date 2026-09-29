const pool = require('../config/db');
const { TYPES_ENTREE, ajouterEntreeCaisse } = require('../utils/caisse');

/*
 * Page admin "Colis montant zéro" (/admin/colis-montant-zero, service
 * COLIS_ZERO) — colis à prix 0 déjà ramassés dont les frais de livraison
 * restent à encaisser auprès du magasin (mêmes règles que colis_zero.php
 * legacy : prix = 0, statut hors NEW_PARCEL / WAITING_PICKUP, clients
 * exemptés customers_colis_zero = 1 exclus). Contrairement au legacy qui
 * listait tous les colis, la page groupe par magasin : liste des magasins
 * avec compteurs par situation CRBT, puis détail des colis d'un magasin en
 * modale. Situation CRBT (parcel_crbt_zero) : 0/NULL = en attente,
 * 1 = payé, 2 = avisé.
 *  - Payé : parcel_crbt_zero = 1 + recette de caisse (delevery_spent,
 *    « frais de livraison », montant = frais de livraison du colis),
 *    comptée sur la caisse de l'agence si l'utilisateur est un responsable
 *    d'agence (type 3), sinon « Sans agence » (utils/caisse) ;
 *  - Avisé : parcel_crbt_zero = 2, aucune écriture comptable.
 */

const BASE_WHERE = `p.parcel_price = '0'
  AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')
  AND COALESCE(c.customers_colis_zero, 0) <> 1`;

/* Filtres SQL par situation CRBT (onglets de la page). */
const CRBT_FILTERS = {
  EN_ATTENTE: 'AND COALESCE(p.parcel_crbt_zero, 0) NOT IN (1, 2)',
  PAYE: 'AND COALESCE(p.parcel_crbt_zero, 0) = 1',
  AVISE: 'AND COALESCE(p.parcel_crbt_zero, 0) = 2',
  TOUS: ''
};

/* Colis montant zéro dont les frais restent à encaisser (en attente ou avisé). */
const CRBT_NON_PAYE = 'AND COALESCE(p.parcel_crbt_zero, 0) <> 1';

/* Colis « en cours » : ramassé et pas encore livré ni retourné (même règle
 * que le dashboard admin). */
const EN_COURS_WHERE = `p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP', 'DELIVERED', 'RETURNED')`;

/* Date de ramassage effective d'un colis (repli sur la date de création pour
 * les anciens colis sans parcel_pickup_time). */
const PICKUP_TIME_SQL = 'COALESCE(NULLIF(p.parcel_pickup_time, 0), p.parcel_time)';

/*
 * Statut effectif du colis (même règle que parcels.controller) : INVOICED,
 * sinon statut second d'un colis IN_PROGRESS, sinon statut brut.
 */
const STATUT_CODE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 'INVOICED'
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> ''
      THEN p.parcel_status_second
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK'
      THEN 'RETURNED_TO_STOCK'
    ELSE p.parcel_status
  END`;

const STATUT_TYPE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 1
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> '' THEN 3
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK' THEN 3
    ELSE 2
  END`;

/**
 * GET /api/colis-zero/magasins — magasins ayant au moins un colis montant
 * zéro, avec compteurs par situation CRBT (en_attente / paye / avise / total).
 * Le filtrage par onglet et la recherche se font côté client sur ces lignes.
 */
async function listMagasins(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT p.parcel_customer AS customer_id,
              COALESCE(NULLIF(c.customers_store, ''), c.customers_name) AS store,
              c.customers_code_store AS code_store,
              SUM(CASE WHEN COALESCE(p.parcel_crbt_zero, 0) NOT IN (1, 2) THEN 1 ELSE 0 END) AS en_attente,
              SUM(CASE WHEN COALESCE(p.parcel_crbt_zero, 0) = 1 THEN 1 ELSE 0 END) AS paye,
              SUM(CASE WHEN COALESCE(p.parcel_crbt_zero, 0) = 2 THEN 1 ELSE 0 END) AS avise,
              COUNT(*) AS total
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE ${BASE_WHERE}
        GROUP BY p.parcel_customer, store, code_store
        ORDER BY store ASC`
    );
    res.json(
      rows.map((r) => ({
        customer_id: Number(r.customer_id) || 0,
        store: r.store || `Client #${r.customer_id}`,
        code_store: r.code_store || '',
        en_attente: Number(r.en_attente) || 0,
        paye: Number(r.paye) || 0,
        avise: Number(r.avise) || 0,
        total: Number(r.total) || 0
      }))
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/colis-zero/magasins/:id/colis — colis montant zéro d'un magasin
 * pour la modale (query statut : EN_ATTENTE | PAYE | AVISE | TOUS, TOUS par
 * défaut). Chaque ligne porte les villes, les frais de livraison, le statut
 * effectif du colis (avec sa couleur) et la situation CRBT.
 */
async function listColisMagasin(req, res, next) {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(404).json({ message: 'Magasin introuvable.' });
    }
    let statut = String(req.query.statut || 'TOUS').trim().toUpperCase();
    if (!(statut in CRBT_FILTERS)) statut = 'TOUS';

    const [rows] = await pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code,
              vr.nom_ville AS ville_ramassage, vl.nom_ville AS ville,
              p.parcel_delivered_fees AS frais,
              COALESCE(p.parcel_crbt_zero, 0) AS crbt,
              (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statut_color
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs vr ON vr.ville_id = p.parcel_ramassage_city
         LEFT JOIN delevery_tarifs vl ON vl.ville_id = p.parcel_city
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = (${STATUT_CODE_SQL})
          AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
        WHERE p.parcel_customer = ? AND ${BASE_WHERE} ${CRBT_FILTERS[statut]}
        ORDER BY p.parcel_id DESC`,
      [customerId]
    );
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        code: r.code || '',
        ville_ramassage: r.ville_ramassage || '',
        ville: r.ville || '',
        frais: Number(r.frais) || 0,
        crbt: Number(r.crbt) === 1 || Number(r.crbt) === 2 ? Number(r.crbt) : 0,
        statut: r.statut || '',
        statut_color: r.statut_color || ''
      }))
    );
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/colis-zero/magasins/:id/colis-en-cours — colis en cours du
 * magasin (ramassés, ni livrés ni retournés, montant non nul) dont la date de
 * ramassage est postérieure à celle du plus récent colis montant zéro non
 * payé (en attente ou avisé) du magasin : colis en circuit sur lesquels les
 * frais de livraison impayés peuvent encore être récupérés.
 * Réponse : { reference: { pickup_time, nb_colis_zero } | null, rows } —
 * reference vaut null (et rows est vide) si le magasin n'a aucun colis
 * montant zéro non payé.
 */
async function listColisEnCoursMagasin(req, res, next) {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(404).json({ message: 'Magasin introuvable.' });
    }

    const [[ref]] = await pool.query(
      `SELECT MAX(${PICKUP_TIME_SQL}) AS pickup_time, COUNT(*) AS nb
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE p.parcel_customer = ? AND ${BASE_WHERE} ${CRBT_NON_PAYE}`,
      [customerId]
    );
    const refTime = Number(ref?.pickup_time) || 0;
    if (!Number(ref?.nb) || !refTime) return res.json({ reference: null, rows: [] });

    const [rows] = await pool.query(
      `SELECT p.parcel_id AS id, p.parcel_code AS code,
              p.parcel_receiver AS destinataire, p.parcel_phone AS telephone,
              vl.nom_ville AS ville, p.parcel_price AS montant,
              ${PICKUP_TIME_SQL} AS pickup_time,
              u.users_name AS livreur,
              (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statut_color
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs vl ON vl.ville_id = p.parcel_city
         LEFT JOIN delevery_users u ON u.users_id = p.parcel_livreur
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = (${STATUT_CODE_SQL})
          AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
        WHERE p.parcel_customer = ? AND ${EN_COURS_WHERE}
          AND COALESCE(p.parcel_price, '0') <> '0'
          AND ${PICKUP_TIME_SQL} > ?
        ORDER BY pickup_time DESC, p.parcel_id DESC`,
      [customerId, refTime]
    );
    res.json({
      reference: { pickup_time: refTime, nb_colis_zero: Number(ref.nb) || 0 },
      rows: rows.map((r) => ({
        id: Number(r.id),
        code: r.code || '',
        destinataire: r.destinataire || '',
        telephone: r.telephone || '',
        ville: r.ville || '',
        montant: Number(r.montant) || 0,
        pickup_time: Number(r.pickup_time) || 0,
        livreur: r.livreur || '',
        statut: r.statut || '',
        statut_color: r.statut_color || ''
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Charge un colis montant zéro actionnable (prix 0, client non exempté).
 * Retourne null si introuvable.
 */
async function loadColisZero(parcelId) {
  if (!Number.isInteger(parcelId) || parcelId <= 0) return null;
  const [[parcel]] = await pool.query(
    `SELECT p.parcel_id, p.parcel_code, p.parcel_delivered_fees,
            COALESCE(p.parcel_crbt_zero, 0) AS crbt
       FROM delevery_parcel p
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
      WHERE p.parcel_id = ? AND ${BASE_WHERE}
      LIMIT 1`,
    [parcelId]
  );
  return parcel || null;
}

/**
 * POST /api/colis-zero/:id/paye — marque le colis payé (parcel_crbt_zero = 1)
 * et enregistre la recette de caisse (« frais de livraison », montant =
 * frais de livraison du colis), comme colis_zero.php.
 */
async function marquerPaye(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const parcel = await loadColisZero(parseInt(req.params.id, 10));
    if (!parcel) return res.status(404).json({ message: 'Colis montant zéro introuvable.' });
    if (Number(parcel.crbt) === 1) {
      return res.status(400).json({ message: 'Ce colis est déjà marqué payé.' });
    }

    const now = Math.floor(Date.now() / 1000);
    await conn.beginTransaction();
    await conn.query(`UPDATE delevery_parcel SET parcel_crbt_zero = 1 WHERE parcel_id = ?`, [
      parcel.parcel_id
    ]);
    await ajouterEntreeCaisse(conn, {
      type: TYPES_ENTREE.RECETTE,
      titre: 'frais de livraison',
      description: parcel.parcel_code || '',
      montant: parcel.parcel_delivered_fees,
      date: now,
      userId: req.user.id
    });
    await conn.commit();
    res.json({ id: parcel.parcel_id, crbt: 1 });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/** POST /api/colis-zero/:id/avise — marque le colis avisé (parcel_crbt_zero = 2). */
async function marquerAvise(req, res, next) {
  try {
    const parcel = await loadColisZero(parseInt(req.params.id, 10));
    if (!parcel) return res.status(404).json({ message: 'Colis montant zéro introuvable.' });
    if (Number(parcel.crbt) === 2) {
      return res.status(400).json({ message: 'Ce colis est déjà marqué avisé.' });
    }
    await pool.query(`UPDATE delevery_parcel SET parcel_crbt_zero = 2 WHERE parcel_id = ?`, [
      parcel.parcel_id
    ]);
    res.json({ id: parcel.parcel_id, crbt: 2 });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMagasins,
  listColisMagasin,
  listColisEnCoursMagasin,
  marquerPaye,
  marquerAvise
};
