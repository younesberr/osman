const pool = require('../config/db');

/*
 * Filtre d'agence des employés type 3 (Responsable d'agence), 4 (Agent
 * d'agence) et 6 (Ramasseur) : ils ne voient que les données de leur agence.
 * Chaîne de rattachement legacy : ville (delevery_tarifs.ville_id) → zone
 * (delevery_tarifs.zone → delevery_zone) → agence (zone_agence_id).
 * L'agence de l'employé est dérivée de sa ville de fonction (users_ville_id)
 * via cette même chaîne ; repli sur users_agence_id (colonne legacy) pour les
 * comptes sans ville de fonction.
 */

const AGENCE_SCOPED_TYPES = [3, 4, 6];

/*
 * Statuts d'un colis encore chez son agence d'origine : un colis entrant
 * (destination = mon agence, ramassé ailleurs) n'apparaît qu'à partir de
 * RECEIVED.
 */
const STATUTS_AVANT_RECEPTION = ['NEW_PARCEL', 'WAITING_PICKUP', 'PICKED_UP', 'SENT'];

/**
 * Agence de l'employé connecté si son type est restreint par agence.
 * Relue en base à chaque requête (le JWT ne la contient pas, et elle peut
 * changer sans re-login, comme users_services dans /me).
 * Retourne null (aucune restriction) ou un agence_id ; 0 = compte restreint
 * sans agence affectée → aucune donnée visible (les conditions SQL ne
 * matchent alors rien).
 */
async function getAgenceScope(user) {
  if (!user || user.kind !== 'employee' || !AGENCE_SCOPED_TYPES.includes(Number(user.role))) {
    return null;
  }
  const [[row]] = await pool.query(
    `SELECT ${userAgenceSql('u')} AS agence_id
       FROM delevery_users u
      WHERE u.users_id = ? LIMIT 1`,
    [user.id]
  );
  return Number(row?.agence_id) || 0;
}

/**
 * Condition SQL : la ville (expression ville_id) appartient à l'agence `?`.
 * Sous-requête corrélée : à réserver aux tables de petite taille (clients,
 * produits) — sur delevery_parcel utiliser parcelInAgence (liste IN
 * pré-calculée, ~13× plus rapide sur 250k lignes).
 */
function villeInAgenceSql(villeExpr) {
  return `EXISTS (
    SELECT 1 FROM delevery_tarifs sc_t
    JOIN delevery_zone sc_z ON sc_z.zone_id = sc_t.zone
    WHERE sc_t.ville_id = ${villeExpr} AND sc_z.zone_agence_id = ?)`;
}

/**
 * Expression SQL : agence d'un utilisateur (alias de delevery_users), dérivée
 * de sa ville de fonction (users_ville_id → zone → zone_agence_id), avec repli
 * sur users_agence_id (colonne legacy) pour les comptes sans ville de fonction.
 */
function userAgenceSql(alias = 'u') {
  return `COALESCE(
    (SELECT ua_z.zone_agence_id
       FROM delevery_tarifs ua_t
       JOIN delevery_zone ua_z ON ua_z.zone_id = ua_t.zone
      WHERE ua_t.ville_id = ${alias}.users_ville_id LIMIT 1),
    ${alias}.users_agence_id)`;
}

/** agence_id de la zone d'une ville (null si ville absente ou sans agence). */
async function agenceIdFromVille(villeId) {
  if (villeId == null) return null;
  const [[row]] = await pool.query(
    `SELECT z.zone_agence_id
       FROM delevery_tarifs t
       LEFT JOIN delevery_zone z ON z.zone_id = t.zone
      WHERE t.ville_id = ? LIMIT 1`,
    [villeId]
  );
  return row ? Number(row.zone_agence_id) || null : null;
}

/** ville_id des villes rattachées à l'agence (référentiel court, requête rapide). */
async function getAgenceVilleIds(agenceId) {
  const [rows] = await pool.query(
    `SELECT t.ville_id
       FROM delevery_tarifs t
       JOIN delevery_zone z ON z.zone_id = t.zone
      WHERE z.zone_agence_id = ?`,
    [agenceId]
  );
  return rows.map((r) => r.ville_id);
}

/**
 * Condition de visibilité d'un colis pour une agence (alias de
 * delevery_parcel en paramètre) : ville de ramassage dans l'agence (tous
 * statuts), ou ville de destination dans l'agence à partir de RECEIVED.
 * Retourne { sql, params } à insérer dans un WHERE ; les listes de villes
 * sont passées en IN (mysql2 développe les paramètres tableau de query()).
 */
async function parcelInAgence(agenceId, alias = 'p') {
  const villeIds = await getAgenceVilleIds(agenceId);
  if (!villeIds.length) return { sql: '1 = 0', params: [] };
  const statuts = STATUTS_AVANT_RECEPTION.map(() => '?').join(', ');
  return {
    sql: `(${alias}.parcel_ramassage_city IN (?)
      OR (${alias}.parcel_city IN (?) AND ${alias}.parcel_status NOT IN (${statuts})))`,
    params: [villeIds, villeIds, ...STATUTS_AVANT_RECEPTION]
  };
}

/** Vrai si la ville de ramassage du client appartient à l'agence. */
async function clientDansAgence(clientId, agenceId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok
       FROM delevery_customers c
       JOIN delevery_tarifs t ON t.ville_id = c.customers_pickup_city
       JOIN delevery_zone z   ON z.zone_id = t.zone
      WHERE c.customers_id = ? AND z.zone_agence_id = ?
      LIMIT 1`,
    [clientId, agenceId]
  );
  return Boolean(row);
}

/** Vrai si le client propriétaire du produit appartient à l'agence. */
async function produitDansAgence(productId, agenceId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok
       FROM delevery_product p
       JOIN delevery_customers c ON c.customers_id = p.product_customer
       JOIN delevery_tarifs t    ON t.ville_id = c.customers_pickup_city
       JOIN delevery_zone z      ON z.zone_id = t.zone
      WHERE p.product_id = ? AND z.zone_agence_id = ?
      LIMIT 1`,
    [productId, agenceId]
  );
  return Boolean(row);
}

module.exports = {
  AGENCE_SCOPED_TYPES,
  STATUTS_AVANT_RECEPTION,
  getAgenceScope,
  getAgenceVilleIds,
  villeInAgenceSql,
  userAgenceSql,
  agenceIdFromVille,
  parcelInAgence,
  clientDansAgence,
  produitDansAgence
};
