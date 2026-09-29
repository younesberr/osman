const pool = require('../config/db');

/*
 * Statistiques globales admin (/admin/statistiques/globales — service
 * STATISTIQUES, donc types 1 et 2 uniquement : pas de filtrage par agence).
 * Deux endpoints, un par onglet de la page :
 *  - structure : compteurs hors période (agences, clients, livreurs
 *    prestataires, employés, parc de moyens logistiques) ;
 *  - periode   : indicateurs des colis créés dans la plage (parcel_time),
 *    montants basés sur les factures payées, délais issus de l'historique
 *    des statuts et réclamations de la période.
 */

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

const num = (v) => Number(v) || 0;

/* COD d'un colis (parcel_price est un varchar — même expression que la
 * facturation clients). Les saisies aberrantes du legacy (numéros de
 * téléphone, « 1111… » : une centaine de colis, quasi tous restés en attente
 * de ramassage) fausseraient le COD total de centaines de millions : au-delà
 * de 100 000 DH la valeur est ignorée dans les sommes. */
const COD_SQL = `COALESCE(CAST(p.parcel_price AS DECIMAL(12,2)), 0)`;
const COD_PLAFONNE_SQL = `CASE WHEN ${COD_SQL} <= 100000 THEN ${COD_SQL} ELSE 0 END`;

/* « En cours » au sens de la page (définition métier de l'onglet Par
 * période) : ni en attente de prise en charge, ni livré, ni retourné.
 * NEW_PARCEL est rangé côté attente comme sur la page Statistiques client.
 * Les colis en attente (« Attente de ramassage ») sont exclus du total colis
 * (comme sur l'accueil admin) : ils ne sont pas encore pris en charge. */
const ATTENTE = ['NEW_PARCEL', 'WAITING_PICKUP'];

/**
 * GET /api/statistiques/globales/structure — onglet « Vue d'ensemble » :
 * compteurs indépendants de toute période.
 *  - livreurs = prestataires auto-entrepreneurs (users_type 5, is_salarie 0) ;
 *    employés = tous les autres comptes actifs, y compris livreurs salariés
 *    (même répartition que les pages Livreurs / Utilisateurs, users.controller).
 *  - parc par type (moto / vl / pl) : disponible = statut « actif »,
 *    indisponible = en maintenance / immobilisé / hors service ; les moyens
 *    vendus ne comptent plus dans le parc.
 */
async function statsStructure(req, res, next) {
  try {
    const [[counts]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM delevery_agences WHERE agence_active = 1) AS agences,
         (SELECT COUNT(*) FROM delevery_customers WHERE customers_active = 1) AS clients,
         (SELECT COUNT(*) FROM delevery_users u
           WHERE u.users_active = 1 AND u.users_parent_id IS NULL
             AND u.users_type = 5 AND u.users_is_salarie = 0) AS livreurs,
         (SELECT COUNT(*) FROM delevery_users u
           WHERE u.users_active = 1 AND u.users_parent_id IS NULL
             AND NOT (u.users_type = 5 AND IFNULL(u.users_is_salarie, 1) = 0)) AS employes`
    );

    // Parc de moyens : tables delevery_logistique_* (migration
    // sql/2026-08-25_logistiques.sql) ; absentes → parc à zéro.
    const parc = {
      moto: { total: 0, disponibles: 0, indisponibles: 0 },
      vl: { total: 0, disponibles: 0, indisponibles: 0 },
      pl: { total: 0, disponibles: 0, indisponibles: 0 }
    };
    try {
      const [rows] = await pool.query(
        `SELECT lm_type AS type,
                COALESCE(SUM(lm_statut = 'actif'), 0) AS disponibles,
                COALESCE(SUM(lm_statut IN ('en_maintenance', 'immobilise', 'hors_service')), 0) AS indisponibles
           FROM delevery_logistique_moyen
          WHERE lm_statut <> 'vendu'
          GROUP BY lm_type`
      );
      for (const r of rows) {
        if (!parc[r.type]) continue;
        parc[r.type].disponibles = num(r.disponibles);
        parc[r.type].indisponibles = num(r.indisponibles);
        parc[r.type].total = num(r.disponibles) + num(r.indisponibles);
      }
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    res.json({ ...counts, parc });
  } catch (err) {
    next(err);
  }
}

/**
 * Volumes et COD des colis créés dans la période, en une passe groupée par
 * statut. total = colis hors attente de ramassage (attente compté à part).
 * Taux (définitions de la page) :
 *  - livraison / retour : part des colis livrés / retournés hors colis en
 *    cours (base = total − en cours, comme tauxColis du dashboard) ;
 *  - en cours : part des colis en cours sur le total.
 */
async function volumesColis(dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT p.parcel_status AS st, COUNT(*) AS n, COALESCE(SUM(${COD_PLAFONNE_SQL}), 0) AS cod
       FROM delevery_parcel p
      WHERE p.parcel_time >= ? AND p.parcel_time <= ?
      GROUP BY p.parcel_status`,
    [dateFrom, dateTo]
  );

  const c = { total: 0, livres: 0, retournes: 0, attente: 0, en_cours: 0, cod_total: 0 };
  for (const r of rows) {
    const n = num(r.n);
    c.cod_total += num(r.cod);
    if (ATTENTE.includes(r.st)) {
      c.attente += n;
      continue;
    }
    c.total += n;
    if (r.st === 'DELIVERED') c.livres += n;
    else if (r.st === 'RETURNED') c.retournes += n;
    else c.en_cours += n;
  }

  const baseTraites = c.total - c.en_cours;
  const taux = (part, base) => (base > 0 ? Math.round((part / base) * 1000) / 10 : 0);
  c.taux_livraison = taux(c.livres, baseTraites);
  c.taux_retour = taux(c.retournes, baseTraites);
  c.taux_en_cours = taux(c.en_cours, c.total);
  return c;
}

/**
 * Montants basés sur les factures payées, colis créés dans la période :
 *  - COD facturé + frais de livraison moyen : lignes livrées des factures
 *    clients payées (invoice_statut = 2, codes facturesClients.controller) ;
 *  - coût de livraison moyen : lignes livrées des factures livreurs payées
 *    (payment_note_statut = 1 — codes inversés, cf. facturesLivreurs.controller).
 */
async function montantsFactures(dateFrom, dateTo) {
  const clientsQ = pool.query(
    `SELECT
        COALESCE(SUM(CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                          THEN COALESCE(ip.invoice_parcels_parcel_cod, 0) ELSE 0 END), 0) AS cod_facture,
        COALESCE(SUM(ip.invoice_parcels_statut = 'DELIVERED'), 0) AS nb_livres_factures,
        AVG(CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                 THEN COALESCE(ip.invoice_parcels_parcel_fees, 0) END) AS frais_moyen
       FROM delevery_invoice_parcels ip
       JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
       JOIN delevery_parcel p ON p.parcel_id = ip.invoice_parcels_parcel
      WHERE i.invoice_statut = 2 AND p.parcel_time >= ? AND p.parcel_time <= ?`,
    [dateFrom, dateTo]
  );
  // payment_note_type 1 = facture du livreur (le type 2 — bon de zone /
  // agence — porte les mêmes colis avec les frais de la zone, à exclure).
  const livreursQ = pool.query(
    `SELECT AVG(CASE WHEN pp.pay_parcels_statut = 'DELIVERED'
                     THEN COALESCE(pp.pay_parcels_fees, 0) END) AS cout_moyen,
            COALESCE(SUM(pp.pay_parcels_statut = 'DELIVERED'), 0) AS nb_livres_payes
       FROM delevery_pay_parcels pp
       JOIN delevery_payment_note pn ON pn.payment_note_id = pp.pay_parcels_pay
       JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
      WHERE pn.payment_note_statut = 1 AND pn.payment_note_type = 1
        AND p.parcel_time >= ? AND p.parcel_time <= ?`,
    [dateFrom, dateTo]
  );
  const [[[clients]], [[livreurs]]] = await Promise.all([clientsQ, livreursQ]);

  return {
    cod_facture: num(clients.cod_facture),
    nb_livres_factures: num(clients.nb_livres_factures),
    frais_moyen: clients.frais_moyen === null ? null : Math.round(Number(clients.frais_moyen) * 100) / 100,
    cout_moyen: livreurs.cout_moyen === null ? null : Math.round(Number(livreurs.cout_moyen) * 100) / 100,
    nb_livres_payes: num(livreurs.nb_livres_payes)
  };
}

/* Date du premier passage d'un colis à un statut donné, pour tous les colis
 * créés dans la période. S'appuie sur idx_history_status_parcel_time
 * (sql/2026-09-01_statistiques-index-history.sql) ; sans lui la requête
 * marche mais retombe sur un parcours complet de l'historique. */
const PREMIER_STATUT_SQL = `
  SELECT h.parcel_history_parcel AS pid, MIN(h.parcel_history_time) AS t0
    FROM delevery_parcel_history h
    JOIN delevery_parcel p ON p.parcel_id = h.parcel_history_parcel
   WHERE h.parcel_history_status = ? AND p.parcel_time >= ? AND p.parcel_time <= ?
   GROUP BY h.parcel_history_parcel`;

/**
 * Délais moyens (secondes) issus de delevery_parcel_history (une ligne par
 * événement de suivi, index (parcel, time)), colis créés dans la période :
 *  - premier_changement : mise en distribution → événement de suivi suivant
 *    (sous-requête couverte par l'index, sans lire le statut : les re-scans en
 *    distribution rapprochés sont neutralisés par le seuil d'une heure),
 *    hors changements de moins d'une heure ;
 *  - livraison : mise en distribution → livraison (parcel_delivery_time) ;
 *  - retour : dernier changement de statut avant le retour → passage RETURNED.
 */
async function delaisColis(dateFrom, dateTo) {
  const premierQ = pool.query(
    `SELECT AVG(d.diff) AS sec, COUNT(*) AS nb
       FROM (
         SELECT (SELECT MIN(h2.parcel_history_time)
                   FROM delevery_parcel_history h2
                  WHERE h2.parcel_history_parcel = t.pid
                    AND h2.parcel_history_time > t.t0) - t.t0 AS diff
           FROM (${PREMIER_STATUT_SQL}) t
       ) d
      WHERE d.diff >= 3600`,
    ['DISTRIBUTION', dateFrom, dateTo]
  );

  const livraisonQ = pool.query(
    `SELECT AVG(p.parcel_delivery_time - t.t0) AS sec, COUNT(*) AS nb
       FROM delevery_parcel p
       JOIN (${PREMIER_STATUT_SQL}) t ON t.pid = p.parcel_id
      WHERE p.parcel_status = 'DELIVERED'
        AND p.parcel_delivery_time > t.t0`,
    ['DISTRIBUTION', dateFrom, dateTo]
  );

  const retourQ = pool.query(
    `SELECT AVG(d.diff) AS sec, COUNT(*) AS nb
       FROM (
         SELECT t.t0 - (SELECT MAX(h2.parcel_history_time)
                          FROM delevery_parcel_history h2
                         WHERE h2.parcel_history_parcel = t.pid
                           AND h2.parcel_history_time < t.t0) AS diff
           FROM (${PREMIER_STATUT_SQL}) t
           JOIN delevery_parcel pr ON pr.parcel_id = t.pid AND pr.parcel_status = 'RETURNED'
       ) d
      WHERE d.diff > 0`,
    ['RETURNED', dateFrom, dateTo]
  );

  const [[[premier]], [[livraison]], [[retour]]] = await Promise.all([premierQ, livraisonQ, retourQ]);
  const sec = (r) => (r.sec === null ? null : Math.round(Number(r.sec)));
  return {
    premier_changement: { sec: sec(premier), nb: num(premier.nb) },
    livraison: { sec: sec(livraison), nb: num(livraison.nb) },
    retour: { sec: sec(retour), nb: num(retour.nb) }
  };
}

/**
 * Secondes ouvrées entre deux timestamps : seules les plages 9h00 → 18h30 de
 * chaque jour comptent (heures locales serveur ; 18h30 → 9h00 = hors travail).
 */
function secondesOuvrees(t0, t1) {
  if (!(t1 > t0)) return 0;
  let total = 0;
  const cur = new Date(t0 * 1000);
  cur.setHours(0, 0, 0, 0);
  // Garde-fou : au-delà de 2 ans, le reliquat est négligeable pour une moyenne.
  for (let i = 0; i < 731 && cur.getTime() / 1000 < t1; i += 1) {
    const debut = new Date(cur);
    debut.setHours(9, 0, 0, 0);
    const fin = new Date(cur);
    fin.setHours(18, 30, 0, 0);
    const from = Math.max(t0, debut.getTime() / 1000);
    const to = Math.min(t1, fin.getTime() / 1000);
    if (to > from) total += to - from;
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

/**
 * Réclamations créées dans la période (delevery_reclamation_suivre,
 * reclamation_time) : compteurs par statut + délai moyen de traitement en
 * heures ouvrées (création → reclamation_treated_time des traitées).
 */
async function reclamationsPeriode(dateFrom, dateTo) {
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(reclamation_statut = 'TRAITE'), 0) AS traitees
       FROM delevery_reclamation_suivre
      WHERE reclamation_time >= ? AND reclamation_time <= ?`,
    [dateFrom, dateTo]
  );
  const total = num(counts.total);
  const traitees = num(counts.traitees);

  const [rows] = await pool.query(
    `SELECT reclamation_time AS t0, reclamation_treated_time AS t1
       FROM delevery_reclamation_suivre
      WHERE reclamation_statut = 'TRAITE' AND reclamation_treated_time > reclamation_time
        AND reclamation_time >= ? AND reclamation_time <= ?`,
    [dateFrom, dateTo]
  );
  let cumul = 0;
  for (const r of rows) cumul += secondesOuvrees(num(r.t0), num(r.t1));

  const pctDe = (part) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);
  return {
    total,
    traitees,
    en_cours: total - traitees,
    pct_traitees: pctDe(traitees),
    pct_en_cours: pctDe(total - traitees),
    delai_moyen_sec: rows.length ? Math.round(cumul / rows.length) : null,
    nb_delai: rows.length
  };
}

/**
 * GET /api/statistiques/globales/periode?dateFrom&dateTo — onglet
 * « Par période » : tous les indicateurs portent sur les colis (et
 * réclamations) créés dans la plage. Plage vide → toutes les dates.
 */
async function statsPeriode(req, res, next) {
  try {
    const dateFrom = dayToUnix(req.query.dateFrom, false) ?? 0;
    const dateTo = dayToUnix(req.query.dateTo, true) ?? Math.floor(Date.now() / 1000) + 86399;

    const [colis, montants, delais, reclamations] = await Promise.all([
      volumesColis(dateFrom, dateTo),
      montantsFactures(dateFrom, dateTo),
      delaisColis(dateFrom, dateTo),
      reclamationsPeriode(dateFrom, dateTo)
    ]);

    res.json({ colis, montants, delais, reclamations });
  } catch (err) {
    next(err);
  }
}

module.exports = { statsStructure, statsPeriode, secondesOuvrees };
