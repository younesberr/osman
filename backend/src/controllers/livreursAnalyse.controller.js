const pool = require('../config/db');
const { statutLabel } = require('../utils/statutLabels');
const { secondesOuvrees } = require('./statistiquesAdmin.controller');

/*
 * Analyse d'un livreur — onglet "Analyse" de la fiche livreur
 * (/admin/livreurs/:id). Un seul endpoint qui renvoie les dix sections de la
 * page ; toutes sont filtrées par la plage de dates SAUF le score global
 * (section 1, toutes dates confondues).
 *
 * Notion centrale : la DATE D'AFFECTATION d'un colis = dernière mise en
 * distribution chez CE livreur (delevery_parcel_history, statut DISTRIBUTION,
 * parcel_history_livreur — repli sur la date de création pour le legacy sans
 * historique). C'est elle que filtre le sélecteur de dates, à l'exception de
 * l'encaissement (section 9) qui porte sur les colis CRÉÉS dans la période
 * (parcel_time), comme la facturation.
 *
 * Les délais s'appuient sur delevery_parcel_history via l'index
 * idx_history_status_parcel_time (sql/2026-09-01_statistiques-index-history.sql) ;
 * sans lui tout marche mais les sous-requêtes historique deviennent lentes.
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

/* Même périmètre que la page Livreurs (livreurs auto-entrepreneurs). */
const SCOPE_LIVREURS_SQL = 'u.users_parent_id IS NULL AND u.users_type = 5 AND u.users_is_salarie = 0';

/* Colis du livreur + date d'affectation (voir en-tête du fichier). Un seul
 * placeholder : l'id du livreur. */
const BASE_SQL = `
  SELECT p.parcel_id, p.parcel_status, p.parcel_status_second, p.parcel_city,
         p.parcel_delivery_time,
         COALESCE((SELECT MAX(h.parcel_history_time)
                     FROM delevery_parcel_history h
                    WHERE h.parcel_history_parcel = p.parcel_id
                      AND h.parcel_history_status = 'DISTRIBUTION'
                      AND (h.parcel_history_livreur IS NULL
                           OR h.parcel_history_livreur = p.parcel_livreur)),
                  p.parcel_time) AS t_affect
    FROM delevery_parcel p
   WHERE p.parcel_livreur = ?`;

const PERIODE_SQL = 'b.t_affect >= ? AND b.t_affect <= ?';

/** Moyenne arrondie à la seconde, null si aucune ligne. */
const sec = (r) => (r.sec === null ? null : Math.round(Number(r.sec)));

/**
 * Section 1 — score global (toutes dates) et classement parmi les livreurs
 * auto-entrepreneurs ayant au moins un colis traité (livré ou retourné) :
 *  - livraison    (60 pts) : taux de livraison sur les colis traités ;
 *  - réclamations (20 pts) : part des colis traités SANS réclamation ;
 *  - volume       (20 pts) : livrés rapportés au meilleur livreur.
 */
async function scoreEtClassement(livreurId) {
  const volumesQ = pool.query(
    `SELECT p.parcel_livreur AS lid,
            COUNT(*) AS affectes,
            COALESCE(SUM(p.parcel_status = 'DELIVERED'), 0) AS livres,
            COALESCE(SUM(p.parcel_status = 'RETURNED'), 0) AS retournes
       FROM delevery_parcel p
       JOIN delevery_users u ON u.users_id = p.parcel_livreur
      WHERE ${SCOPE_LIVREURS_SQL}
      GROUP BY p.parcel_livreur`
  );
  const reclamationsQ = pool.query(
    `SELECT p.parcel_livreur AS lid, COUNT(*) AS n
       FROM delevery_reclamation_suivre r
       JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
       JOIN delevery_users u ON u.users_id = p.parcel_livreur
      WHERE ${SCOPE_LIVREURS_SQL}
      GROUP BY p.parcel_livreur`
  );
  const [[volumes], [reclamations]] = await Promise.all([volumesQ, reclamationsQ]);

  const reclParLivreur = new Map(reclamations.map((r) => [num(r.lid), num(r.n)]));
  const maxLivres = Math.max(1, ...volumes.map((v) => num(v.livres)));

  const classes = volumes
    .filter((v) => num(v.livres) + num(v.retournes) > 0)
    .map((v) => {
      const livres = num(v.livres);
      const traites = livres + num(v.retournes);
      const recl = reclParLivreur.get(num(v.lid)) || 0;
      const ptsLivraison = 60 * (livres / traites);
      const ptsReclamations = 20 * Math.max(0, 1 - recl / traites);
      const ptsVolume = 20 * (livres / maxLivres);
      return {
        lid: num(v.lid),
        affectes: num(v.affectes),
        livres,
        retournes: num(v.retournes),
        reclamations: recl,
        pts: {
          livraison: Math.round(ptsLivraison * 10) / 10,
          reclamations: Math.round(ptsReclamations * 10) / 10,
          volume: Math.round(ptsVolume * 10) / 10
        },
        score: Math.round((ptsLivraison + ptsReclamations + ptsVolume) * 10) / 10
      };
    })
    .sort((a, b) => b.score - a.score || b.livres - a.livres);

  const rang = classes.findIndex((c) => c.lid === livreurId);
  if (rang === -1) {
    return { score: null, rang: null, total: classes.length };
  }
  const moi = classes[rang];
  return {
    score: moi.score,
    rang: rang + 1,
    total: classes.length,
    pts: moi.pts,
    affectes: moi.affectes,
    livres: moi.livres,
    retournes: moi.retournes,
    reclamations: moi.reclamations
  };
}

/**
 * Section 2 — productivité sur la période. Taux de livraison / retour
 * calculés hors colis en cours (base = affectés − en cours) ; taux en cours
 * sur le total affecté.
 */
async function productivite(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT b.parcel_status AS st, COUNT(*) AS n
       FROM (${BASE_SQL}) b
      WHERE ${PERIODE_SQL}
      GROUP BY b.parcel_status`,
    [livreurId, dateFrom, dateTo]
  );
  const c = { affectes: 0, livres: 0, retournes: 0, en_cours: 0 };
  for (const r of rows) {
    const n = num(r.n);
    c.affectes += n;
    if (r.st === 'DELIVERED') c.livres += n;
    else if (r.st === 'RETURNED') c.retournes += n;
    else c.en_cours += n;
  }
  const baseTraites = c.affectes - c.en_cours;
  const taux = (part, base) => (base > 0 ? Math.round((part / base) * 1000) / 10 : 0);
  c.taux_livraison = taux(c.livres, baseTraites);
  c.taux_retour = taux(c.retournes, baseTraites);
  c.taux_en_cours = taux(c.en_cours, c.affectes);
  return c;
}

const MOIS_FR_COURT = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'
];

/**
 * Section 3 — évolution : affectés / livrés par jour d'affectation, jours
 * d'activité uniquement (un jour sans affectation n'apparaît pas, comme le
 * graphique legacy). Au-delà de 60 jours d'activité : regroupement par mois.
 */
async function evolution(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT FROM_UNIXTIME(b.t_affect, '%Y-%m-%d') AS jour,
            COUNT(*) AS affectes,
            COALESCE(SUM(b.parcel_status = 'DELIVERED'), 0) AS livres
       FROM (${BASE_SQL}) b
      WHERE ${PERIODE_SQL}
      GROUP BY jour
      ORDER BY jour ASC`,
    [livreurId, dateFrom, dateTo]
  );
  if (rows.length <= 60) {
    return {
      labels: rows.map((r) => `${r.jour.slice(8, 10)}/${r.jour.slice(5, 7)}`),
      affectes: rows.map((r) => num(r.affectes)),
      livres: rows.map((r) => num(r.livres))
    };
  }
  const mois = [];
  const parMois = new Map();
  for (const r of rows) {
    const cle = r.jour.slice(0, 7);
    if (!parMois.has(cle)) {
      parMois.set(cle, { affectes: 0, livres: 0 });
      mois.push(cle);
    }
    const agg = parMois.get(cle);
    agg.affectes += num(r.affectes);
    agg.livres += num(r.livres);
  }
  return {
    labels: mois.map((m) => `${MOIS_FR_COURT[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`),
    affectes: mois.map((m) => parMois.get(m).affectes),
    livres: mois.map((m) => parMois.get(m).livres)
  };
}

/**
 * Délais de retour par colis retourné de la période : passage RETURNED −
 * dernier changement de statut précédent, en secondes (une ligne par colis,
 * avec sa ville — sert au temps moyen de retour ET au tableau par ville).
 */
async function delaisRetour(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT x.parcel_city AS city,
            x.t_ret - (SELECT MAX(h3.parcel_history_time)
                         FROM delevery_parcel_history h3
                        WHERE h3.parcel_history_parcel = x.parcel_id
                          AND h3.parcel_history_time < x.t_ret) AS diff
       FROM (
         SELECT b.parcel_id, b.parcel_city,
                (SELECT MAX(h2.parcel_history_time)
                   FROM delevery_parcel_history h2
                  WHERE h2.parcel_history_parcel = b.parcel_id
                    AND h2.parcel_history_status = 'RETURNED') AS t_ret
           FROM (${BASE_SQL}) b
          WHERE ${PERIODE_SQL} AND b.parcel_status = 'RETURNED'
       ) x
      WHERE x.t_ret IS NOT NULL`,
    [livreurId, dateFrom, dateTo]
  );
  // Seuil d'une heure : les régularisations en rafale ne comptent pas.
  return rows.filter((r) => num(r.diff) >= 3600).map((r) => ({ city: r.city, diff: num(r.diff) }));
}

/**
 * Section 4 — temps moyens (secondes), hors durées de moins d'une heure :
 *  - premier_changement : affectation → premier événement de suivi suivant ;
 *  - livraison : affectation → livraison (parcel_delivery_time) ;
 *  - retour : dernier statut précédent → passage RETURNED (delaisRetour).
 */
async function tempsMoyens(livreurId, dateFrom, dateTo, retours) {
  const premierQ = pool.query(
    `SELECT AVG(d.diff) AS sec, COUNT(*) AS nb
       FROM (
         SELECT (SELECT MIN(h2.parcel_history_time)
                   FROM delevery_parcel_history h2
                  WHERE h2.parcel_history_parcel = b.parcel_id
                    AND h2.parcel_history_time > b.t_affect) - b.t_affect AS diff
           FROM (${BASE_SQL}) b
          WHERE ${PERIODE_SQL}
       ) d
      WHERE d.diff >= 3600`,
    [livreurId, dateFrom, dateTo]
  );
  const livraisonQ = pool.query(
    `SELECT AVG(b.parcel_delivery_time - b.t_affect) AS sec, COUNT(*) AS nb
       FROM (${BASE_SQL}) b
      WHERE ${PERIODE_SQL} AND b.parcel_status = 'DELIVERED'
        AND b.parcel_delivery_time - b.t_affect >= 3600`,
    [livreurId, dateFrom, dateTo]
  );
  const [[[premier]], [[livraison]]] = await Promise.all([premierQ, livraisonQ]);

  const cumulRetour = retours.reduce((s, r) => s + r.diff, 0);
  return {
    premier_changement: { sec: sec(premier), nb: num(premier.nb) },
    livraison: { sec: sec(livraison), nb: num(livraison.nb) },
    retour: {
      sec: retours.length ? Math.round(cumulRetour / retours.length) : null,
      nb: retours.length
    }
  };
}

/* Tranches horaires de la section 5, dans l'ordre d'affichage. */
const TRANCHES = [
  { label: '08 - 10', from: 8, to: 10 },
  { label: '10 - 12', from: 10, to: 12 },
  { label: '12 - 14', from: 12, to: 14 },
  { label: '14 - 16', from: 14, to: 16 },
  { label: '16 - 18', from: 16, to: 18 },
  { label: '18 - 20', from: 18, to: 20 },
  { label: '20 - 22', from: 20, to: 22 },
  { label: '22 - 00', from: 22, to: 24 },
  { label: '00 - 08', from: 0, to: 8 }
];

/**
 * Section 5 — analyse des horaires : tous les changements de statut portant
 * sur les colis du livreur, survenus dans la période, ventilés par tranche
 * horaire (heure locale serveur).
 */
async function horaires(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT HOUR(FROM_UNIXTIME(h.parcel_history_time)) AS hh, COUNT(*) AS n
       FROM delevery_parcel_history h
       JOIN delevery_parcel p ON p.parcel_id = h.parcel_history_parcel
      WHERE p.parcel_livreur = ?
        AND h.parcel_history_time >= ? AND h.parcel_history_time <= ?
      GROUP BY hh`,
    [livreurId, dateFrom, dateTo]
  );
  const parHeure = new Map(rows.map((r) => [num(r.hh), num(r.n)]));
  let total = 0;
  const tranches = TRANCHES.map((t) => {
    let n = 0;
    for (let h = t.from; h < t.to; h += 1) n += parHeure.get(h) || 0;
    total += n;
    return { label: t.label, n };
  });
  for (const t of tranches) {
    t.pct = total > 0 ? Math.round((t.n / total) * 1000) / 10 : 0;
  }
  return { total, tranches };
}

/**
 * Section 6 — analyse géographique : colis de la période groupés par ville.
 * Délai moyen de livraison = affectation → livraison ; délai moyen de retour
 * injecté depuis delaisRetour (même seuil d'une heure partout).
 */
async function parVilles(livreurId, dateFrom, dateTo, retours) {
  const [rows] = await pool.query(
    `SELECT b.parcel_city AS city,
            COALESCE(t.nom_ville, CONCAT('Ville #', b.parcel_city)) AS ville,
            COUNT(*) AS affectes,
            COALESCE(SUM(b.parcel_status = 'DELIVERED'), 0) AS livres,
            COALESCE(SUM(b.parcel_status = 'RETURNED'), 0) AS retournes,
            AVG(CASE WHEN b.parcel_status = 'DELIVERED'
                      AND b.parcel_delivery_time - b.t_affect >= 3600
                     THEN b.parcel_delivery_time - b.t_affect END) AS delai_livraison
       FROM (${BASE_SQL}) b
       LEFT JOIN delevery_tarifs t ON t.ville_id = b.parcel_city
      WHERE ${PERIODE_SQL}
      GROUP BY b.parcel_city, t.nom_ville
      ORDER BY affectes DESC`,
    [livreurId, dateFrom, dateTo]
  );

  const retourParVille = new Map();
  for (const r of retours) {
    const agg = retourParVille.get(r.city) || { cumul: 0, nb: 0 };
    agg.cumul += r.diff;
    agg.nb += 1;
    retourParVille.set(r.city, agg);
  }

  return rows.map((r) => {
    const affectes = num(r.affectes);
    const livres = num(r.livres);
    const retournes = num(r.retournes);
    const traites = livres + retournes;
    const retour = retourParVille.get(r.city);
    return {
      ville: r.ville,
      affectes,
      livres,
      taux_livraison: traites > 0 ? Math.round((livres / traites) * 1000) / 10 : 0,
      retournes,
      taux_retour: traites > 0 ? Math.round((retournes / traites) * 1000) / 10 : 0,
      delai_livraison_sec: r.delai_livraison === null ? null : Math.round(Number(r.delai_livraison)),
      delai_retour_sec: retour ? Math.round(retour.cumul / retour.nb) : null
    };
  });
}

/**
 * Section 7 — analyse des retournés : colis RETURNED de la période groupés
 * par statut précédant le retour (parcel_status_second : refusé, annulé,
 * pas de réponse… — libellés delevery_string via statutLabel).
 */
async function retournes(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT COALESCE(b.parcel_status_second, '') AS code, COUNT(*) AS n
       FROM (${BASE_SQL}) b
      WHERE ${PERIODE_SQL} AND b.parcel_status = 'RETURNED'
      GROUP BY code
      ORDER BY n DESC`,
    [livreurId, dateFrom, dateTo]
  );
  const total = rows.reduce((s, r) => s + num(r.n), 0);
  return {
    total,
    statuts: await Promise.all(
      rows.map(async (r) => ({
        label: r.code ? await statutLabel(r.code) : 'Non précisé',
        n: num(r.n),
        pct: total > 0 ? Math.round((num(r.n) / total) * 1000) / 10 : 0
      }))
    )
  };
}

/**
 * Section 8 — réclamations créées dans la période sur les colis du livreur :
 * compteurs + délai moyen de traitement en heures ouvrées (9h00 – 18h30,
 * même règle que les statistiques globales admin).
 */
async function reclamationsLivreur(livreurId, dateFrom, dateTo) {
  const [[counts]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(r.reclamation_statut = 'TRAITE'), 0) AS traitees
       FROM delevery_reclamation_suivre r
       JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
      WHERE p.parcel_livreur = ?
        AND r.reclamation_time >= ? AND r.reclamation_time <= ?`,
    [livreurId, dateFrom, dateTo]
  );
  const total = num(counts.total);
  const traitees = num(counts.traitees);

  const [rows] = await pool.query(
    `SELECT r.reclamation_time AS t0, r.reclamation_treated_time AS t1
       FROM delevery_reclamation_suivre r
       JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
      WHERE p.parcel_livreur = ?
        AND r.reclamation_statut = 'TRAITE'
        AND r.reclamation_treated_time > r.reclamation_time
        AND r.reclamation_time >= ? AND r.reclamation_time <= ?`,
    [livreurId, dateFrom, dateTo]
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
 * Section 9 — encaissement : colis du livreur CRÉÉS dans la période
 * (parcel_time) présents sur factures clients payées (invoice_statut = 2) :
 *  - COD collecté : COD des lignes livrées de ces factures ;
 *  - frais facturés aux clients : frais de livraison de toutes leurs lignes ;
 *  - moyenne frais de livraison = frais clients / nb de colis facturés ;
 *  - frais du livreur : lignes de SES factures livreur payées
 *    (payment_note_type 1, statut 1) pour ces mêmes colis ;
 *  - coût moyen par colis = frais livreur / nb de colis payés au livreur ;
 *  - bénéfice société = frais clients − frais livreur.
 */
async function encaissement(livreurId, dateFrom, dateTo) {
  const clientsQ = pool.query(
    `SELECT COALESCE(SUM(CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                              THEN COALESCE(ip.invoice_parcels_parcel_cod, 0) ELSE 0 END), 0) AS cod,
            COALESCE(SUM(COALESCE(ip.invoice_parcels_parcel_fees, 0)), 0) AS frais,
            COUNT(DISTINCT ip.invoice_parcels_parcel) AS nb
       FROM delevery_invoice_parcels ip
       JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
       JOIN delevery_parcel p ON p.parcel_id = ip.invoice_parcels_parcel
      WHERE i.invoice_statut = 2 AND p.parcel_livreur = ?
        AND p.parcel_time >= ? AND p.parcel_time <= ?`,
    [livreurId, dateFrom, dateTo]
  );
  const livreurQ = pool.query(
    `SELECT COALESCE(SUM(COALESCE(pp.pay_parcels_fees, 0)), 0) AS frais,
            COUNT(DISTINCT pp.pay_parcels_parcel) AS nb
       FROM delevery_pay_parcels pp
       JOIN delevery_payment_note pn ON pn.payment_note_id = pp.pay_parcels_pay
       JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
      WHERE pn.payment_note_statut = 1 AND pn.payment_note_type = 1
        AND pn.payment_note_for = ?
        AND p.parcel_time >= ? AND p.parcel_time <= ?
        AND EXISTS (SELECT 1
                      FROM delevery_invoice_parcels ip2
                      JOIN delevery_invoice i2 ON i2.invoice_id = ip2.invoice_parcels_invoice
                     WHERE ip2.invoice_parcels_parcel = p.parcel_id AND i2.invoice_statut = 2)`,
    [livreurId, dateFrom, dateTo]
  );
  const [[[clients]], [[livreur]]] = await Promise.all([clientsQ, livreurQ]);

  const fraisClients = num(clients.frais);
  const fraisLivreur = num(livreur.frais);
  const nbClients = num(clients.nb);
  const nbLivreur = num(livreur.nb);
  return {
    cod_collecte: num(clients.cod),
    nb_colis_factures: nbClients,
    frais_clients: fraisClients,
    frais_moyen_client: nbClients > 0 ? Math.round((fraisClients / nbClients) * 100) / 100 : null,
    frais_livreur: fraisLivreur,
    nb_colis_livreur: nbLivreur,
    cout_moyen: nbLivreur > 0 ? Math.round((fraisLivreur / nbLivreur) * 100) / 100 : null,
    benefice: Math.round((fraisClients - fraisLivreur) * 100) / 100
  };
}

const JOURS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/**
 * Section 10 — analyse des jours : colis de la période par jour de la semaine
 * de leur affectation (WEEKDAY : 0 = lundi).
 */
async function parJours(livreurId, dateFrom, dateTo) {
  const [rows] = await pool.query(
    `SELECT WEEKDAY(FROM_UNIXTIME(b.t_affect)) AS jd, COUNT(*) AS n
       FROM (${BASE_SQL}) b
      WHERE ${PERIODE_SQL}
      GROUP BY jd`,
    [livreurId, dateFrom, dateTo]
  );
  const parJour = new Map(rows.map((r) => [num(r.jd), num(r.n)]));
  const total = rows.reduce((s, r) => s + num(r.n), 0);
  return {
    total,
    jours: JOURS_FR.map((label, i) => {
      const n = parJour.get(i) || 0;
      return { label, n, pct: total > 0 ? Math.round((n / total) * 1000) / 10 : 0 };
    })
  };
}

/**
 * GET /api/livreurs/:id/analyse?dateFrom&dateTo — les dix sections de
 * l'onglet Analyse. Plage vide → toutes les dates.
 */
async function getAnalyse(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const [[livreur]] = await pool.query(
      `SELECT u.users_id FROM delevery_users u WHERE u.users_id = ? AND ${SCOPE_LIVREURS_SQL}`,
      [id]
    );
    if (!livreur) return res.status(404).json({ message: 'Livreur introuvable.' });

    const dateFrom = dayToUnix(req.query.dateFrom, false) ?? 0;
    const dateTo = dayToUnix(req.query.dateTo, true) ?? Math.floor(Date.now() / 1000) + 86399;

    const retoursDelais = await delaisRetour(id, dateFrom, dateTo);
    const [score, prod, evo, temps, hor, villes, retours, reclamations, enc, jours] =
      await Promise.all([
        scoreEtClassement(id),
        productivite(id, dateFrom, dateTo),
        evolution(id, dateFrom, dateTo),
        tempsMoyens(id, dateFrom, dateTo, retoursDelais),
        horaires(id, dateFrom, dateTo),
        parVilles(id, dateFrom, dateTo, retoursDelais),
        retournes(id, dateFrom, dateTo),
        reclamationsLivreur(id, dateFrom, dateTo),
        encaissement(id, dateFrom, dateTo),
        parJours(id, dateFrom, dateTo)
      ]);

    res.json({
      score,
      productivite: prod,
      evolution: evo,
      temps,
      horaires: hor,
      villes,
      retours,
      reclamations,
      encaissement: enc,
      jours
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAnalyse };
