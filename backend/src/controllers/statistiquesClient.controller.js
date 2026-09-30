const pool = require('../config/db');

/*
 * Statistiques du dashboard client (/client/statistiques) : volumes, KPIs
 * et tableaux repris de l'ancien système PHP (
 * data_statistique.php + fonctions statClient* de includes/functions.php) ;
 * le chiffre d'affaires est lui basé sur les factures clients payées
 * (chiffreAffairesFactures). Période sur parcel_time (date de création),
 * bornes en timestamps unix.
 */

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/** Timestamp du début du jour d'il y a n jours (00:00:00 heure locale). */
function startOfDayAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return Math.floor(d.getTime() / 1000);
}

/* COD d'un colis (parcel_price est un varchar — même expression que la
 * facturation clients). */
const COD_SQL = `COALESCE(CAST(p.parcel_price AS DECIMAL(12,2)), 0)`;

const MOIS_FR_COURT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'
];

const num = (v) => Number(v) || 0;

/**
 * Volumes par statut + KPIs (mêmes règles que statClientParcelCounts /
 * statClientKpis) en une passe : groupement par statut / statut second.
 * KPIs hors NEW_PARCEL / WAITING_PICKUP (colis pas encore pris en charge) ;
 * volumes toutes créations confondues.
 */
async function kpisEtVolumes(customerId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT p.parcel_status AS st, p.parcel_status_second AS st2,
            COUNT(*) AS n,
            COALESCE(SUM(${COD_SQL}), 0)                     AS cod,
            COALESCE(SUM(p.parcel_delivered_fees), 0)        AS df,
            COALESCE(SUM(p.parcel_returned_fees), 0)         AS rf,
            COALESCE(SUM(p.parcel_refused_fees), 0)          AS xf
       FROM delevery_parcel p
      WHERE p.parcel_customer = ? AND p.parcel_time >= ? AND p.parcel_time <= ?
      GROUP BY p.parcel_status, p.parcel_status_second`,
    [customerId, dateFrom, dateTo]
  );

  // Bandeau « Statistiques colis » : en_cours = IN_PROGRESS + DISTRIBUTION + RECEIVED.
  // attente (NEW_PARCEL + WAITING_PICKUP) sert au donut de répartition.
  const colis = { total: 0, livres: 0, retournes: 0, ramasses: 0, expedies: 0, en_cours: 0, attente: 0 };
  // KPIs : créés = hors NEW_PARCEL / WAITING_PICKUP (comme le legacy).
  const k = {
    crees: 0, livres: 0, retournes: 0, refuses: 0, en_circuit: 0,
    cod_livre: 0, cod_en_cours: 0, cod_perdu: 0,
    frais_livres: 0, frais_retournes: 0, frais_refuses: 0
  };

  for (const r of rows) {
    const n = num(r.n);
    colis.total += n;
    switch (r.st) {
      case 'DELIVERED': colis.livres += n; break;
      case 'RETURNED': colis.retournes += n; break;
      case 'PICKED_UP': colis.ramasses += n; break;
      case 'SENT': colis.expedies += n; break;
      case 'IN_PROGRESS':
      case 'DISTRIBUTION':
      case 'RECEIVED': colis.en_cours += n; break;
      case 'NEW_PARCEL':
      case 'WAITING_PICKUP': colis.attente += n; break;
      default: break;
    }

    if (r.st === 'NEW_PARCEL' || r.st === 'WAITING_PICKUP') continue;
    k.crees += n;
    if (r.st === 'DELIVERED') {
      k.livres += n;
      k.cod_livre += num(r.cod);
      k.frais_livres += num(r.df);
    } else if (r.st === 'RETURNED' && r.st2 === 'REFUSE') {
      k.refuses += n;
      k.cod_perdu += num(r.cod);
      k.frais_refuses += num(r.xf);
    } else if (r.st === 'RETURNED') {
      k.retournes += n;
      k.cod_perdu += num(r.cod);
      k.frais_retournes += num(r.rf);
    } else {
      // Colis encore en circuit (PICKED_UP, SENT, IN_PROGRESS, ...).
      k.en_circuit += n;
      k.cod_en_cours += num(r.cod);
    }
  }

  k.traites = k.livres + k.retournes + k.refuses;
  k.frais_total = k.frais_livres + k.frais_retournes + k.frais_refuses;
  k.taux_livraison = k.traites > 0 ? Math.round((k.livres / k.traites) * 1000) / 10 : 0;
  k.taux_retour = k.traites > 0 ? Math.round(((k.retournes + k.refuses) / k.traites) * 1000) / 10 : 0;
  k.panier_moyen = k.livres > 0 ? Math.round((k.cod_livre / k.livres) * 100) / 100 : 0;

  // Délai moyen de livraison (jours) : ramassage → livraison sur les livrés.
  const [[delai]] = await pool.query(
    `SELECT AVG(p.parcel_delivery_time - p.parcel_pickup_time) AS sec
       FROM delevery_parcel p
      WHERE p.parcel_customer = ? AND p.parcel_status = 'DELIVERED'
        AND p.parcel_delivery_time > 0 AND p.parcel_pickup_time > 0
        AND p.parcel_delivery_time >= p.parcel_pickup_time
        AND p.parcel_time >= ? AND p.parcel_time <= ?`,
    [customerId, dateFrom, dateTo]
  );
  k.delai_moyen_jours = delai.sec !== null ? Math.round((Number(delai.sec) / 86400) * 10) / 10 : 0;

  return { colis, kpis: k };
}

/**
 * Chiffre d'affaires basé sur les factures clients payées (delevery_invoice,
 * invoice_statut = 2 « Payé » + lignes delevery_invoice_parcels), colis de la
 * période :
 *  - CA facturé : COD des lignes livrées (DELIVERED) des factures payées ;
 *  - frais payés : frais de livraison des lignes de factures payées
 *    (invoice_parcels_parcel_fees — jamais les frais supp parcel_extra_fees
 *    ni delevery_client_frais) ;
 *  - CA à facturer : COD des colis livrés absents de toute facture payée.
 */
async function chiffreAffairesFactures(customerId, dateFrom, dateTo) {
  const [[payes]] = await pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                          THEN COALESCE(ip.invoice_parcels_parcel_cod, 0) ELSE 0 END), 0) AS cod_facture,
        COALESCE(SUM(ip.invoice_parcels_statut = 'DELIVERED'), 0) AS nb_livres_factures,
        COALESCE(SUM(COALESCE(ip.invoice_parcels_parcel_fees, 0)), 0) AS frais_payes
       FROM delevery_invoice_parcels ip
       JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
       JOIN delevery_parcel p ON p.parcel_id = ip.invoice_parcels_parcel
      WHERE i.invoice_customer = ? AND i.invoice_statut = 2
        AND p.parcel_time >= ? AND p.parcel_time <= ?`,
    [customerId, dateFrom, dateTo]
  );

  const [[aFacturer]] = await pool.query(
    `SELECT COUNT(*) AS nb, COALESCE(SUM(${COD_SQL}), 0) AS cod
       FROM delevery_parcel p
      WHERE p.parcel_customer = ? AND p.parcel_status = 'DELIVERED'
        AND p.parcel_time >= ? AND p.parcel_time <= ?
        AND NOT EXISTS (
          SELECT 1
            FROM delevery_invoice_parcels ip
            JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
           WHERE ip.invoice_parcels_parcel = p.parcel_id AND i.invoice_statut = 2)`,
    [customerId, dateFrom, dateTo]
  );

  return {
    cod_facture: num(payes.cod_facture),
    nb_livres_factures: num(payes.nb_livres_factures),
    frais_payes: num(payes.frais_payes),
    cod_a_facturer: num(aFacturer.cod),
    nb_livres_non_payes: num(aFacturer.nb)
  };
}

/**
 * Séries « colis créés vs livrés par jour » (dataParcelsPerDay) : comptage par
 * jour de création ; livrés = colis créés ce jour-là ayant le statut DELIVERED.
 * Au-delà de 60 jours, regroupement par mois calendaire (comme le legacy).
 */
async function seriesParJour(customerId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT FROM_UNIXTIME(p.parcel_time, '%Y-%m-%d') AS jour,
            COUNT(*) AS crees,
            COALESCE(SUM(p.parcel_status = 'DELIVERED'), 0) AS livres
       FROM delevery_parcel p
      WHERE p.parcel_customer = ? AND p.parcel_time >= ? AND p.parcel_time <= ?
      GROUP BY jour
      ORDER BY jour ASC`,
    [customerId, dateFrom, dateTo]
  );
  const parJour = new Map(rows.map((r) => [r.jour, { crees: num(r.crees), livres: num(r.livres) }]));

  const jours = [];
  const cursor = new Date(dateFrom * 1000);
  cursor.setHours(0, 0, 0, 0);
  const fin = new Date(dateTo * 1000);
  while (cursor.getTime() <= fin.getTime()) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    jours.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }

  if (jours.length <= 60) {
    return {
      labels: jours.map((j) => `${j.slice(8, 10)}/${j.slice(5, 7)}`),
      crees: jours.map((j) => parJour.get(j)?.crees || 0),
      livres: jours.map((j) => parJour.get(j)?.livres || 0)
    };
  }

  // Période longue : regroupement par mois calendaire.
  const mois = [];
  const parMois = new Map();
  for (const j of jours) {
    const cle = j.slice(0, 7);
    if (!parMois.has(cle)) {
      parMois.set(cle, { crees: 0, livres: 0 });
      mois.push(cle);
    }
  }
  for (const [j, v] of parJour) {
    const agg = parMois.get(j.slice(0, 7));
    if (agg) {
      agg.crees += v.crees;
      agg.livres += v.livres;
    }
  }
  return {
    labels: mois.map((m) => `${MOIS_FR_COURT[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`),
    crees: mois.map((m) => parMois.get(m).crees),
    livres: mois.map((m) => parMois.get(m).livres)
  };
}

/**
 * GET /api/dashboard/client/statistiques?dateFrom&dateTo — page Statistiques
 * du dashboard client. Défauts identiques au legacy : 30 derniers jours ;
 * « Toutes les dates » (dateFrom vide) part du premier colis du client.
 */
async function clientStatistiques(req, res, next) {
  try {
    const customerId = Number(req.user.id);

    let dateTo = dayToUnix(req.query.dateTo, true);
    if (dateTo === null) dateTo = startOfDayAgo(0) + 86399;
    let dateFrom = dayToUnix(req.query.dateFrom, false);
    if (dateFrom === null) {
      const [[premier]] = await pool.query(
        'SELECT MIN(parcel_time) AS t FROM delevery_parcel WHERE parcel_customer = ?',
        [customerId]
      );
      if (num(premier.t) > 0) {
        const d = new Date(num(premier.t) * 1000);
        d.setHours(0, 0, 0, 0);
        dateFrom = Math.floor(d.getTime() / 1000);
      } else {
        dateFrom = startOfDayAgo(30);
      }
    }
    if (dateFrom > dateTo) {
      dateFrom = startOfDayAgo(30);
      dateTo = startOfDayAgo(0) + 86399;
    }

    const [{ colis, kpis }, ca, parJour] = await Promise.all([
      kpisEtVolumes(customerId, dateFrom, dateTo),
      chiffreAffairesFactures(customerId, dateFrom, dateTo),
      seriesParJour(customerId, dateFrom, dateTo)
    ]);

    // Performance par ville (par volume, hors colis non pris en charge) —
    // liste complète : tri + pagination côté client.
    const villesQ = pool.query(
      `SELECT COALESCE(t.nom_ville, CONCAT('Ville #', p.parcel_city)) AS ville,
              COUNT(*) AS total,
              COALESCE(SUM(p.parcel_status = 'DELIVERED'), 0) AS livres,
              COALESCE(SUM(p.parcel_status = 'RETURNED'), 0)  AS retours,
              COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED' THEN ${COD_SQL} ELSE 0 END), 0) AS cod
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
        WHERE p.parcel_customer = ?
          AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')
          AND p.parcel_time >= ? AND p.parcel_time <= ?
        GROUP BY p.parcel_city, t.nom_ville
        ORDER BY total DESC`,
      [customerId, dateFrom, dateTo]
    );

    // Top produits stock : 1 ligne de parcel_content = 1 unité ; un colis
    // multi-produits compte pour chacun d'eux, son prix une fois par produit.
    const produitsQ = pool.query(
      `SELECT MAX(t.product) AS produit,
              COUNT(*) AS total,
              COALESCE(SUM(t.qty), 0) AS quantite,
              COALESCE(SUM(t.st = 'DELIVERED'), 0) AS livres,
              COALESCE(SUM(CASE WHEN t.st = 'DELIVERED' THEN t.price ELSE 0 END), 0) AS cod
         FROM (
            SELECT pc.parcel_content_product_id AS pid,
                   MAX(pc.parcel_content_product_name) AS product,
                   COUNT(*) AS qty,
                   MAX(p.parcel_status) AS st,
                   MAX(${COD_SQL}) AS price
              FROM delevery_parcel_content pc
              INNER JOIN delevery_parcel p ON p.parcel_id = pc.parcel_content_parcel_id
             WHERE p.parcel_customer = ?
               AND p.parcel_from_stock = '1'
               AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')
               AND p.parcel_time >= ? AND p.parcel_time <= ?
             GROUP BY pc.parcel_content_product_id, pc.parcel_content_parcel_id
         ) t
        GROUP BY t.pid
        ORDER BY total DESC
        LIMIT 500`,
      [customerId, dateFrom, dateTo]
    );

    // Top marchandises : colis hors stock, groupés par nom de produit saisi.
    const marchandisesQ = pool.query(
      `SELECT p.parcel_product_name AS produit,
              COUNT(*) AS total,
              COALESCE(SUM(p.parcel_product_qty), 0) AS quantite,
              COALESCE(SUM(p.parcel_status = 'DELIVERED'), 0) AS livres,
              COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED' THEN ${COD_SQL} ELSE 0 END), 0) AS cod
         FROM delevery_parcel p
        WHERE p.parcel_customer = ?
          AND p.parcel_from_stock != '1'
          AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')
          AND p.parcel_product_name <> '' AND p.parcel_product_name <> ' '
          AND p.parcel_time >= ? AND p.parcel_time <= ?
        GROUP BY p.parcel_product_name
        ORDER BY total DESC
        LIMIT 500`,
      [customerId, dateFrom, dateTo]
    );

    const [[villes], [produits], [marchandises]] = await Promise.all([villesQ, produitsQ, marchandisesQ]);

    res.json({
      colis,
      kpis,
      ca,
      // Bénéfice net = CA facturé − frais de livraison des factures payées.
      benefice_net: ca.cod_facture - ca.frais_payes,
      parJour,
      villes,
      produits,
      marchandises
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { clientStatistiques };
