const pool = require('../config/db');
const { getAgenceScope, clientDansAgence } = require('../utils/agenceScope');

const MAX_PAGE_SIZE = 100;

/*
 * Page admin "Clients non vérifiés" (/admin/clients-non-verifies, service
 * CLIENTS_NON_VERIFIES) : comptes marchands non vérifiés
 * (customers_verified = 0 ou NULL) ayant saisi au moins un colis
 * (delevery_parcel.parcel_customer). Le but de la page est de traiter la file :
 * vérifier le client (customers_verified = 1), qui sort alors de la liste.
 * Mêmes chaînes de rattachement legacy que la page Clients : ville de
 * ramassage → zone → agence, banque via delevery_configs.
 */

const FROM_SQL = `
    FROM delevery_customers c
    LEFT JOIN delevery_tarifs t   ON t.ville_id = c.customers_pickup_city
    LEFT JOIN delevery_zone z     ON z.zone_id = t.zone
    LEFT JOIN delevery_agences ag ON ag.agence_id = z.zone_agence_id
    LEFT JOIN delevery_configs cb ON cb.configs_var = 'ws_config_banks_name'
                                 AND cb.configs_id = CAST(NULLIF(c.customers_bank, '') AS UNSIGNED)`;

/*
 * Colis par client : total (filtre minColis, fiche) et dates du premier et du
 * dernier colis saisis (parcel_time : timestamp unix en secondes, colonne
 * legacy en varchar → CAST pour min/max numériques). JOIN (pas LEFT JOIN) :
 * c'est ce join qui impose « au moins un colis saisi ».
 */
const STATS_JOIN_SQL = `
    JOIN (
      SELECT parcel_customer,
             COUNT(*) AS colis_total,
             MIN(CAST(parcel_time AS UNSIGNED)) AS premier_colis,
             MAX(CAST(parcel_time AS UNSIGNED)) AS dernier_colis
        FROM delevery_parcel
       GROUP BY parcel_customer
    ) pstats ON pstats.parcel_customer = c.customers_id`;

/* Colonnes de tri autorisées. */
const SORTS = {
  dernier_colis: 'pstats.dernier_colis'
};

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/**
 * GET /api/clients-non-verifies — liste paginée pour la datatable.
 * Query : page, pageSize, search (magasin, nom, CIN, tél personnel, tél
 * magasin, email), ville (ville_id de ramassage), agence (agence_id via la
 * zone de la ville), active (1|0), minColis (nombre minimum de colis saisis),
 * dernierFrom / dernierTo (AAAA-MM-JJ, plage du dernier colis saisi), sortBy
 * (dernier_colis, seul tri) et sortDir (asc|desc).
 * Employés type 3/4/6 : restreints aux clients de leur agence.
 */
async function listClientsNonVerifies(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const ville = parseInt(req.query.ville, 10);
    const agence = parseInt(req.query.agence, 10);
    const active = String(req.query.active || '').trim();
    const minColis = parseInt(req.query.minColis, 10) || 0;
    const dernierFrom = dayToUnix(req.query.dernierFrom, false);
    const dernierTo = dayToUnix(req.query.dernierTo, true);

    const sortExpr = SORTS[String(req.query.sortBy || '')] || SORTS.dernier_colis;
    const sortDir = String(req.query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderSql = `${sortExpr} ${sortDir}, c.customers_id DESC`;

    const where = ['IFNULL(c.customers_verified, 0) = 0'];
    const params = [];
    // Types 3/4/6 : uniquement les clients dont la ville de ramassage est
    // rattachée à leur agence (via la jointure zone → agence de FROM_SQL).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push('z.zone_agence_id = ?');
      params.push(agenceScope);
    }
    if (search) {
      where.push(`(c.customers_store LIKE ? OR c.customers_name LIKE ? OR c.customers_cin LIKE ?
                   OR c.customers_phone_personal LIKE ? OR c.customers_phone LIKE ?
                   OR c.customers_email LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like);
    }
    if (Number.isInteger(ville)) {
      where.push('c.customers_pickup_city = ?');
      params.push(ville);
    }
    if (Number.isInteger(agence)) {
      where.push('ag.agence_id = ?');
      params.push(agence);
    }
    if (active === '1' || active === '0') {
      where.push('IFNULL(c.customers_active, 0) = ?');
      params.push(Number(active));
    }
    if (minColis > 1) {
      where.push('pstats.colis_total >= ?');
      params.push(minColis);
    }
    if (dernierFrom !== null) {
      where.push('pstats.dernier_colis >= ?');
      params.push(dernierFrom);
    }
    if (dernierTo !== null) {
      where.push('pstats.dernier_colis <= ?');
      params.push(dernierTo);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${FROM_SQL} ${STATS_JOIN_SQL} ${whereSql}`,
      params
    );

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT c.customers_id, c.customers_store, c.customers_name, c.customers_cin,
              c.customers_phone, c.customers_phone_personal, c.customers_email,
              c.customers_city, c.customers_address, c.customers_rib,
              IFNULL(c.customers_active, 0) AS active,
              CAST(c.customers_time AS UNSIGNED) AS inscription,
              t.nom_ville    AS ville_ramassage,
              z.zone_name    AS zone,
              ag.agence_name AS agence,
              cb.configs_val AS banque,
              pstats.colis_total, pstats.premier_colis, pstats.dernier_colis
         ${FROM_SQL}
         ${STATS_JOIN_SQL}
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      rows: rows.map((r) => ({
        customers_id: r.customers_id,
        store: r.customers_store,
        name: r.customers_name,
        cin: r.customers_cin,
        phone: r.customers_phone,
        phone_personal: r.customers_phone_personal,
        email: r.customers_email,
        city: r.customers_city,
        address: r.customers_address,
        rib: r.customers_rib,
        banque: r.banque,
        ville_ramassage: r.ville_ramassage,
        zone: r.zone,
        agence: r.agence,
        active: Number(r.active),
        inscription: Number(r.inscription) || 0,
        colis_total: Number(r.colis_total),
        premier_colis: Number(r.premier_colis) || 0,
        dernier_colis: Number(r.dernier_colis) || 0
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/clients-non-verifies/filtres — villes de ramassage et agences
 * (dupliqué de /api/clients/filtres : le service CLIENTS_NON_VERIFIES
 * n'implique pas l'accès au service CLIENTS).
 */
async function listFiltres(req, res, next) {
  try {
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    const [agences] = await pool.query(
      `SELECT agence_id, agence_name FROM delevery_agences ORDER BY agence_name`
    );
    res.json({ villes, agences });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/clients-non-verifies/:id/verifier — marque le client vérifié
 * (customers_verified = 1) : il sort de la liste. 404 si le client n'existe
 * pas, est déjà vérifié, ou est hors agence pour un employé type 3/4/6.
 */
async function verifierClient(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Client introuvable ou déjà vérifié.' });
    }
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null && !(await clientDansAgence(id, agenceScope))) {
      return res.status(404).json({ message: 'Client introuvable ou déjà vérifié.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_customers SET customers_verified = 1
        WHERE customers_id = ? AND IFNULL(customers_verified, 0) = 0`,
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Client introuvable ou déjà vérifié.' });
    }
    res.json({ customers_id: id, verified: 1 });
  } catch (err) {
    next(err);
  }
}

module.exports = { listClientsNonVerifies, listFiltres, verifierClient };
