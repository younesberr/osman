const pool = require('../config/db');
const { getAgenceScope, parcelInAgence, villeInAgenceSql, userAgenceSql } = require('../utils/agenceScope');
const { fraisSql, CRBT_SQL } = require('./facturesLivreurs.controller');

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

// parcel_status stocke le code statut (ex: DELIVERED) ; type 2 = statuts de colis.
const RECENT_PARCELS_SQL = `
  SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
         p.parcel_price, p.parcel_product_name, p.parcel_time,
         p.parcel_status AS statut, s.parcel_statut_color AS statut_color
    FROM delevery_parcel p
    LEFT JOIN delevery_parcel_statut s
      ON s.parcel_statut_code = p.parcel_status AND s.parcel_statut_type = 2`;

/**
 * GET /api/dashboard/admin — types 1,2,3,4,6.
 * Employés type 3/4/6 : compteurs colis/clients/employés et listes limités à
 * leur agence.
 */
async function adminStats(req, res, next) {
  try {
    const agenceScope = await getAgenceScope(req.user);
    const scope = agenceScope !== null ? await parcelInAgence(agenceScope) : null;
    const clientCond = agenceScope !== null ? ` AND ${villeInAgenceSql('customers_pickup_city')}` : '';
    // Agence des employés dérivée de leur ville de fonction (users_ville_id).
    const userCond = agenceScope !== null ? ` AND ${userAgenceSql('du')} = ?` : '';

    // Plage de dates des statistiques (parcel_time) : dateFrom / dateTo
    // "AAAA-MM-JJ" envoyés par le sélecteur (30 derniers jours par défaut
    // côté frontend, vide = toutes les dates).
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);
    const statsConds = [];
    const statsParams = [];
    if (scope) {
      statsConds.push(scope.sql);
      statsParams.push(...scope.params);
    }
    if (dateFrom !== null) {
      statsConds.push('p.parcel_time >= ?');
      statsParams.push(dateFrom);
    }
    if (dateTo !== null) {
      statsConds.push('p.parcel_time <= ?');
      statsParams.push(dateTo);
    }
    const statsAnd = statsConds.length ? ` AND ${statsConds.join(' AND ')}` : '';

    // Compteurs colis : même logique que la page Statistiques globales
    // (statistiquesAdmin.controller volumesColis) :
    //  - total = colis hors attente de ramassage (NEW_PARCEL / WAITING_PICKUP,
    //    pas encore pris en charge) ;
    //  - en cours = tout statut hors attente, livré et retourné (ramassé,
    //    expédié, reçu, en distribution, en cours de livraison…) ;
    //  - taux (frontend tauxColis) : part / (total − en cours), donc sur les
    //    colis livrés + retournés.
    // Expédiés / ramassés / en distribution sont des détails de l'en cours.
    const [[colis]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN p.parcel_status IN ('NEW_PARCEL', 'WAITING_PICKUP')
                           THEN 0 ELSE 1 END), 0) AS total_colis,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED'   THEN 1 ELSE 0 END), 0) AS livres,
         COALESCE(SUM(CASE WHEN p.parcel_status IN ('NEW_PARCEL', 'WAITING_PICKUP', 'DELIVERED', 'RETURNED')
                           THEN 0 ELSE 1 END), 0) AS en_cours,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'RETURNED'    THEN 1 ELSE 0 END), 0) AS retournes,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'SENT'        THEN 1 ELSE 0 END), 0) AS expedies,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'PICKED_UP'   THEN 1 ELSE 0 END), 0) AS ramasses,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'DISTRIBUTION' THEN 1 ELSE 0 END), 0) AS distribution
       FROM delevery_parcel p${statsConds.length ? ` WHERE ${statsConds.join(' AND ')}` : ''}`,
      statsParams
    );

    const [[counts]] = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM delevery_customers WHERE customers_active = 1${clientCond}) AS clients_actifs,
        (SELECT COUNT(*) FROM delevery_users du WHERE du.users_active = 1${userCond})    AS employes_actifs,
        (SELECT COUNT(*) FROM delevery_users du WHERE du.users_active = 1 AND du.users_type = '5'${userCond}) AS livreurs_actifs
    `,
      agenceScope !== null ? [agenceScope, agenceScope, agenceScope] : []
    );

    const [parcelsByStatus] = await pool.query(
      `
      SELECT p.parcel_status AS statut, MAX(s.parcel_statut_color) AS color, COUNT(*) AS total
        FROM delevery_parcel p
        LEFT JOIN delevery_parcel_statut s
          ON s.parcel_statut_code = p.parcel_status AND s.parcel_statut_type = 2
       WHERE p.parcel_status IS NOT NULL${statsAnd}
       GROUP BY p.parcel_status
       ORDER BY total DESC
       LIMIT 8
    `,
      statsParams
    );

    const [recentParcels] = await pool.query(
      `${RECENT_PARCELS_SQL}${scope ? ` WHERE ${scope.sql}` : ''} ORDER BY p.parcel_id DESC LIMIT 10`,
      scope ? scope.params : []
    );

    res.json({ counts: { ...colis, ...counts }, parcelsByStatus, recentParcels });
  } catch (err) {
    next(err);
  }
}

/** GET /api/dashboard/livreur — type 5, données limitées au livreur connecté */
async function livreurStats(req, res, next) {
  try {
    const livreurId = Number(req.user.id);

    // Même plage de dates que le dashboard admin (parcel_time).
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);
    const conds = ['p.parcel_livreur = ?'];
    const params = [livreurId];
    if (dateFrom !== null) {
      conds.push('p.parcel_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      conds.push('p.parcel_time <= ?');
      params.push(dateTo);
    }
    const where = conds.join(' AND ');

    // Comptage par statut sur les colis assignés au livreur (même logique que
    // l'ancien dashboard PHP type 5) ; retournes sert au taux de retour.
    const [[counts]] = await pool.query(
      `SELECT
         COUNT(*) AS total_colis,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED'   THEN 1 ELSE 0 END), 0) AS livres,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'IN_PROGRESS' THEN 1 ELSE 0 END), 0) AS en_cours,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'RETURNED'    THEN 1 ELSE 0 END), 0) AS retournes
       FROM delevery_parcel p
       WHERE ${where}`,
      params
    );

    // Solde à percevoir (même logique que l'ancien « Solde à percevoir » PHP,
    // hors filtre de dates) : colis livrés du livreur absents de tout bon payé
    // (payment_note_statut = 1, tous types — comme le legacy). CRBT encaissé,
    // frais de livraison aux mêmes règles de tarifs que la facturation
    // livreurs, net = CRBT - frais.
    const [[solde]] = await pool.query(
      `SELECT
         COALESCE(SUM(${CRBT_SQL}), 0) AS total_crbt,
         COALESCE(SUM(${fraisSql('DELIVERED', 'p.parcel_livreur')}), 0) AS frais_livraison
       FROM delevery_parcel p
       WHERE p.parcel_livreur = ? AND p.parcel_status = 'DELIVERED'
         AND NOT EXISTS (
           SELECT 1
             FROM delevery_pay_parcels pp
             JOIN delevery_payment_note pn ON pn.payment_note_id = pp.pay_parcels_pay
            WHERE pp.pay_parcels_parcel = p.parcel_id
              AND pn.payment_note_statut = 1)`,
      [livreurId]
    );
    const totalCrbt = Number(solde.total_crbt) || 0;
    const fraisLivraison = Number(solde.frais_livraison) || 0;

    res.json({
      counts: {
        ...counts,
        total_crbt: totalCrbt,
        frais_livraison: fraisLivraison,
        net_a_payer: totalCrbt - fraisLivraison
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/client — données limitées au client connecté, filtrées
 * par le sélecteur de dates (parcel_time, comme les autres dashboards).
 * Compteurs colis (même logique que le dashboard admin) :
 *  - en attente de ramassage : NEW_PARCEL / WAITING_PICKUP (pas encore pris
 *    en charge), exclus du total ;
 *  - total = colis hors attente de ramassage ;
 *  - livrés (DELIVERED), retournés (RETURNED) ;
 *  - en cours = tout statut hors attente, livré et retourné ;
 *  - taux de livraison / de retour (frontend tauxColis) : part / (total − en
 *    cours), donc sur les colis livrés + retournés.
 * Montants, sur les colis « Facturés » de la période — lignes des factures
 * clients enregistrées ou payées (delevery_invoice.invoice_statut 1 / 2 +
 * delevery_invoice_parcels ; les brouillons ne comptent pas) :
 *  - CA encaissé = COD des lignes livrées (invoice_parcels_parcel_cod) ;
 *  - frais payés = frais de la ligne (livraison ou refus,
 *    invoice_parcels_parcel_fees) + frais supp de livraison du colis
 *    (parcel_extra_fees, facturés avec la ligne) ;
 *  - CA net = CA encaissé − frais payés.
 * Graphiques : répartition par statut + top 10 villes livrées.
 */
async function clientStats(req, res, next) {
  try {
    const customerId = Number(req.user.id);

    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);
    const conds = ['p.parcel_customer = ?'];
    const params = [customerId];
    if (dateFrom !== null) {
      conds.push('p.parcel_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      conds.push('p.parcel_time <= ?');
      params.push(dateTo);
    }
    const where = conds.join(' AND ');

    const [[row]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN p.parcel_status IN ('NEW_PARCEL', 'WAITING_PICKUP')
                           THEN 1 ELSE 0 END), 0) AS attente_ramassage,
         COALESCE(SUM(CASE WHEN p.parcel_status IN ('NEW_PARCEL', 'WAITING_PICKUP')
                           THEN 0 ELSE 1 END), 0) AS total_colis,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS livres,
         COALESCE(SUM(CASE WHEN p.parcel_status = 'RETURNED'  THEN 1 ELSE 0 END), 0) AS retournes,
         COALESCE(SUM(CASE WHEN p.parcel_status IN ('NEW_PARCEL', 'WAITING_PICKUP', 'DELIVERED', 'RETURNED')
                           THEN 0 ELSE 1 END), 0) AS en_cours
       FROM delevery_parcel p
       WHERE ${where}`,
      params
    );

    // Montants des colis facturés : lignes des factures clients enregistrées
    // ou payées (invoice_statut 1 / 2), colis du client sur la période.
    const [[factures]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                           THEN COALESCE(ip.invoice_parcels_parcel_cod, 0) ELSE 0 END), 0) AS ca_encaisse,
         COALESCE(SUM(COALESCE(ip.invoice_parcels_parcel_fees, 0)
                      + COALESCE(p.parcel_extra_fees, 0)), 0) AS frais_payes
       FROM delevery_invoice_parcels ip
       JOIN delevery_invoice i
         ON i.invoice_id = ip.invoice_parcels_invoice AND i.invoice_statut IN (1, 2)
       JOIN delevery_parcel p ON p.parcel_id = ip.invoice_parcels_parcel
       WHERE ${where}`,
      params
    );
    const caEncaisse = Number(factures.ca_encaisse) || 0;
    const fraisPayes = Number(factures.frais_payes) || 0;
    const counts = {
      attente_ramassage: Number(row.attente_ramassage) || 0,
      total_colis: Number(row.total_colis) || 0,
      livres: Number(row.livres) || 0,
      retournes: Number(row.retournes) || 0,
      en_cours: Number(row.en_cours) || 0,
      ca_encaisse: caEncaisse,
      frais_payes: fraisPayes,
      ca_net: caEncaisse - fraisPayes
    };

    const [parcelsByStatus] = await pool.query(
      `SELECT p.parcel_status AS statut, MAX(s.parcel_statut_color) AS color, COUNT(*) AS total
         FROM delevery_parcel p
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = p.parcel_status AND s.parcel_statut_type = 2
        WHERE p.parcel_status IS NOT NULL AND ${where}
        GROUP BY p.parcel_status
        ORDER BY total DESC
        LIMIT 12`,
      params
    );

    const [topVilles] = await pool.query(
      `SELECT COALESCE(t.nom_ville, '—') AS ville, COUNT(*) AS total
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
        WHERE p.parcel_status = 'DELIVERED' AND ${where}
        GROUP BY p.parcel_city, t.nom_ville
        ORDER BY total DESC
        LIMIT 10`,
      params
    );

    res.json({ counts, parcelsByStatus, topVilles });
  } catch (err) {
    next(err);
  }
}

module.exports = { adminStats, livreurStats, clientStats };
