const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { TYPES_ENTREE, ajouterEntreeCaisse } = require('../utils/caisse');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { getAgenceScope } = require('../utils/agenceScope');

/*
 * Factures livreurs (page /admin/facturation-livreurs/factures) — réutilise les tables
 * legacy des « bons de paiement livreur », partagées avec le système de
 * production : delevery_payment_note (payment_note_type = 1, payment_note_for
 * = livreur, payment_note_city = zone du livreur) + delevery_pay_parcels
 * (lignes : statut DELIVERED / REFUSE, frais livreur, frais supp).
 *
 * Statuts d'une facture (payment_note_statut, mêmes codes que le legacy) :
 *  - 0 → « Brouillon » (« Attente de paiement » legacy : modifiable) ;
 *  - 2 → « Enregistré » (« En cours de traitement » legacy) ;
 *  - 1 → « Payé » (+ payment_note_paid_time / payment_note_paid_by, colonnes
 *    sql/2026-08-20_facturation-livreurs.sql).
 *
 * Drapeaux de paiement du colis (mêmes écritures que le legacy
 * payments_note.php) : parcel_paid_livreur (colis livré) / parcel_refuse_livreur
 * (colis refusé ou annulé) — 0 = payable, 1 = dans une facture non finalisée,
 * 2 = facture enregistrée ou payée. Ils évitent qu'un colis soit payé deux
 * fois, y compris depuis l'ancien système.
 *
 * Colis facturables d'un livreur :
 *  - livrés : parcel_status = DELIVERED, drapeau 0, livré par lui
 *    (parcel_delivered_by, repli parcel_livreur) ;
 *  - refusés / annulés : parcel_status IN_PROGRESS ou RETURNED avec
 *    parcel_status_second REFUSE / CANCELED, drapeau 0, refusé par lui
 *    (parcel_refused_by, repli parcel_livreur), et frais de refus > 0
 *    uniquement (frais nuls : rien à payer, colis non listé).
 *
 * Frais livreur d'un colis (ordre de priorité) : tarifs du livreur de l'application
 * (delevery_livreur_tarifs, fiche livreur) → tarifs legacy (delevery_liv_fees)
 * → tarif par défaut du livreur (users_livreur_delivered_price /
 * users_livreur_refused_price). Colis de remboursement livré (parcel_is_remb
 * = 1, créé par remboursements.controller) : frais = montant remboursé seul
 * (frais supp du colis, parcel_extra_fees), sans tarif de la ville.
 *
 * Prix d'une ligne : livré → CRBT (parcel_price) - frais ; refusé / annulé →
 * -frais. Montant total = somme des prix (mêmes règles que le legacy),
 * moins les frais supplémentaires du livreur rattachés à la facture.
 *
 * Frais supplémentaires (delevery_livreur_frais, table de l'application) : à la
 * création d'une facture, les frais « Nouveau » du livreur non rattachés et
 * datés du jour de la facture ou avant y sont rattachés (frais_facture_id).
 * Tant que la facture est en brouillon, les frais « Nouveau » non rattachés
 * du livreur peuvent aussi être ajoutés / retirés manuellement (boutons de la
 * section frais). Leur statut suit ensuite celui de la facture (enregistré /
 * payé, retour en brouillon → « Nouveau ») ; la suppression d'une facture les
 * libère.
 *
 * Génération automatique (même logique que la facturation clients) : livreur
 * ayant déjà une facture brouillon → sa facture brouillon la plus récente est
 * complétée (colis facturables + frais « Nouveau » du jour) au lieu d'en
 * créer une nouvelle ; sinon une nouvelle facture brouillon est créée.
 */

const MAX_FACTURES = 1000;

/* Codes API ↔ codes legacy payment_note_statut. */
const STATUTS = { draft: 0, paid: 1, saved: 2 };

/* Codes API ↔ codes frais_statut (delevery_livreur_frais : 0 = Nouveau,
 * 1 = Enregistré, 2 = Payé — différents des codes legacy des factures). */
const FRAIS_STATUTS = { draft: 0, saved: 1, paid: 2 };

const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'versements');

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/** Fin du jour (23:59:59, heure locale serveur) contenant le timestamp unix. */
function finDeJour(unix) {
  const d = new Date(unix * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000) + 86399;
}

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/** Livreur « responsable » du colis selon la ligne (livré / refusé). */
const LIVREUR_LIVRE_SQL = `COALESCE(NULLIF(p.parcel_delivered_by, 0), p.parcel_livreur)`;
const LIVREUR_REFUSE_SQL = `COALESCE(NULLIF(p.parcel_refused_by, 0), p.parcel_livreur)`;

/** Conditions d'éligibilité (alias p = delevery_parcel). */
const ELIGIBLE_LIVRE_SQL = `(p.parcel_status = 'DELIVERED' AND COALESCE(p.parcel_paid_livreur, 0) = 0)`;
const ELIGIBLE_REFUSE_SQL = `(p.parcel_status IN ('IN_PROGRESS', 'RETURNED')
  AND p.parcel_status_second IN ('REFUSE', 'CANCELED')
  AND COALESCE(p.parcel_refuse_livreur, 0) = 0)`;

/**
 * Expression SQL du frais livreur d'un colis (alias p) pour le livreur
 * `livExpr` : tarifs de l'application → tarifs legacy → tarif par défaut du livreur.
 * Colis de remboursement livré (parcel_is_remb = 1, seul le colis créé à
 * l'acceptation porte ce drapeau — utils/remboursement) : montant remboursé
 * seul (frais supp du colis, parcel_extra_fees).
 */
function fraisSql(kind, livExpr) {
  const [tarifCol, livFeesCol, userCol] =
    kind === 'DELIVERED'
      ? ['frais_livraison', 'liv_fees_delivered_fees', 'users_livreur_delivered_price']
      : ['frais_refuse', 'liv_fees_refused_fees', 'users_livreur_refused_price'];
  const base = `COALESCE(
    (SELECT lt.${tarifCol} FROM delevery_livreur_tarifs lt
      WHERE lt.livreur_tarif_users_id = ${livExpr} AND lt.livreur_tarif_ville_id = p.parcel_city LIMIT 1),
    (SELECT lf.${livFeesCol} FROM delevery_liv_fees lf
      WHERE lf.liv_fees_livreur_id = ${livExpr} AND lf.liv_fees_city_id = p.parcel_city LIMIT 1),
    (SELECT uf.${userCol} FROM delevery_users uf WHERE uf.users_id = ${livExpr} LIMIT 1),
    0)`;
  if (kind === 'DELIVERED') {
    return `(CASE WHEN COALESCE(p.parcel_is_remb, 0) = 1
      THEN COALESCE(p.parcel_extra_fees, 0) ELSE ${base} END)`;
  }
  return `(${base})`;
}

/** CRBT du colis : prix encaissé si livré, 0 sinon (parcel_price est un varchar). */
const CRBT_SQL = `COALESCE(CAST(p.parcel_price AS DECIMAL(12,2)), 0)`;

/** Date du statut : livraison, ou dernière ligne d'historique REFUSE / CANCELED. */
const STATUT_TIME_SQL = `CASE WHEN p.parcel_status = 'DELIVERED' THEN p.parcel_delivery_time
  ELSE (SELECT MAX(h.parcel_history_time) FROM delevery_parcel_history h
         WHERE h.parcel_history_parcel = p.parcel_id
           AND (h.parcel_history_status IN ('REFUSE', 'CANCELED')
                OR h.parcel_history_status_second IN ('REFUSE', 'CANCELED'))) END`;

/**
 * Employés type 3/4/6 : uniquement les factures des livreurs des zones de leur
 * agence (payment_note_city = zone du livreur). Renvoie null (aucune
 * restriction) ou la liste des zone_id autorisés (vide = rien de visible).
 */
async function getZonesAgence(user) {
  const agenceScope = await getAgenceScope(user);
  if (agenceScope === null) return null;
  const [rows] = await pool.query(`SELECT zone_id FROM delevery_zone WHERE zone_agence_id = ?`, [
    agenceScope
  ]);
  return rows.map((r) => Number(r.zone_id));
}

/** Zone d'un livreur : users_city si c'est une zone (legacy), sinon via sa ville. */
async function livreurZoneId(livreurId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(
        (SELECT z.zone_id FROM delevery_zone z WHERE z.zone_id = u.users_city LIMIT 1),
        (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_ville_id LIMIT 1),
        (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_city LIMIT 1)) AS zone_id
       FROM delevery_users u WHERE u.users_id = ? LIMIT 1`,
    [livreurId]
  );
  return Number(row?.zone_id) || 0;
}

/** Charge une facture livreur ; renvoie null si introuvable (type 1 uniquement). */
async function loadFacture(id) {
  const factureId = parseInt(id, 10);
  if (!Number.isInteger(factureId) || factureId <= 0) return null;
  const [[facture]] = await pool.query(
    `SELECT pn.payment_note_id        AS id,
            pn.payment_note_ref       AS ref,
            pn.payment_note_time      AS time,
            pn.payment_note_statut    AS statut,
            pn.payment_note_screen    AS screen,
            pn.payment_note_paid_time AS paid_time,
            pn.payment_note_city      AS zone_id,
            pn.payment_note_for       AS livreur_id,
            z.zone_name               AS zone,
            ul.users_name             AS livreur_name,
            uc.users_name             AS created_by,
            up.users_name             AS paid_by
       FROM delevery_payment_note pn
       LEFT JOIN delevery_zone z   ON z.zone_id = pn.payment_note_city
       LEFT JOIN delevery_users ul ON ul.users_id = pn.payment_note_for
       LEFT JOIN delevery_users uc ON uc.users_id = pn.payment_note_by
       LEFT JOIN delevery_users up ON up.users_id = pn.payment_note_paid_by
      WHERE pn.payment_note_id = ? AND pn.payment_note_type = 1 LIMIT 1`,
    [factureId]
  );
  return facture || null;
}

/** Vrai si la zone est hors du périmètre de l'employé (types 3/4/6). */
function zoneInterdite(zonesAgence, zoneId) {
  return zonesAgence !== null && !zonesAgence.includes(Number(zoneId));
}

/** Une facture n'est modifiable qu'en brouillon (statut legacy 0). */
function factureEditable(facture) {
  return Number(facture.statut) === STATUTS.draft;
}

/** La preuve : URL locale si le fichier est hébergé par l'application, sinon marqueur legacy. */
function preuveInfo(screen) {
  const name = String(screen || '').trim();
  if (!name) return null;
  const local = path.join(UPLOAD_DIR, path.basename(name));
  if (fs.existsSync(local)) return { url: `/uploads/versements/${path.basename(name)}` };
  return { legacy: true };
}

/** Sérialisation commune d'une facture (liste et détail). */
function factureJson(facture) {
  return {
    id: facture.id,
    ref: facture.ref,
    time: facture.time,
    statut: Number(facture.statut),
    zone_id: facture.zone_id,
    zone: facture.zone,
    livreur_id: facture.livreur_id,
    livreur_name: facture.livreur_name,
    created_by: facture.created_by,
    paid_time: facture.paid_time,
    paid_by: facture.paid_by,
    preuve: preuveInfo(facture.screen)
  };
}

/**
 * GET /api/factures-livreurs/filtres — référentiels des filtres : agences et
 * zones actives, livreurs actifs (type 5). Types 3/4/6 : agences / zones
 * restreintes à leur agence.
 */
async function listFiltres(req, res, next) {
  try {
    const zonesAgence = await getZonesAgence(req.user);
    const whereZone = ['z.zone_active = 1'];
    const whereAgence = ['a.agence_active = 1'];
    const paramsZone = [];
    const paramsAgence = [];
    if (zonesAgence !== null) {
      if (!zonesAgence.length) return res.json({ agences: [], zones: [], livreurs: [] });
      whereZone.push('z.zone_id IN (?)');
      paramsZone.push(zonesAgence);
      whereAgence.push('a.agence_id IN (SELECT zone_agence_id FROM delevery_zone WHERE zone_id IN (?))');
      paramsAgence.push(zonesAgence);
    }
    const [[agences], [zones], [livreurs]] = await Promise.all([
      pool.query(
        `SELECT a.agence_id AS id, a.agence_name AS label
           FROM delevery_agences a WHERE ${whereAgence.join(' AND ')} ORDER BY a.agence_name`,
        paramsAgence
      ),
      pool.query(
        `SELECT z.zone_id AS id, z.zone_name AS label, z.zone_agence_id AS agence_id
           FROM delevery_zone z WHERE ${whereZone.join(' AND ')} ORDER BY z.zone_name`,
        paramsZone
      ),
      pool.query(
        `SELECT u.users_id AS id, u.users_name AS nom
           FROM delevery_users u
          WHERE u.users_active = 1 AND u.users_type = '5'
          ORDER BY u.users_name`
      )
    ]);
    res.json({ agences, zones, livreurs });
  } catch (err) {
    next(err);
  }
}

/**
 * Livreurs ayant des colis facturables (livrés non payés, ou refusés / annulés
 * avec frais de refus > 0), avec leur nombre de colis. Types 3/4/6 : livreurs
 * des zones de leur agence uniquement.
 */
async function findLivreursPayables(user) {
  const zonesAgence = await getZonesAgence(user);
  if (zonesAgence !== null && !zonesAgence.length) return [];

  const [rows] = await pool.query(
    `SELECT x.livreur_id, COUNT(*) AS nb
       FROM (SELECT ${LIVREUR_LIVRE_SQL} AS livreur_id FROM delevery_parcel p
              WHERE ${ELIGIBLE_LIVRE_SQL}
             UNION ALL
             SELECT ${LIVREUR_REFUSE_SQL} FROM delevery_parcel p
              WHERE ${ELIGIBLE_REFUSE_SQL} AND ${fraisSql('REFUSED', LIVREUR_REFUSE_SQL)} > 0) x
      WHERE x.livreur_id > 0
      GROUP BY x.livreur_id`
  );
  if (!rows.length) return [];

  const [livreurs] = await pool.query(
    `SELECT u.users_id AS id, u.users_name AS nom,
            COALESCE(
              (SELECT z.zone_id FROM delevery_zone z WHERE z.zone_id = u.users_city LIMIT 1),
              (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_ville_id LIMIT 1),
              (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_city LIMIT 1)) AS zone_id,
            COALESCE(
              (SELECT z.zone_name FROM delevery_zone z WHERE z.zone_id = u.users_city LIMIT 1),
              (SELECT z.zone_name FROM delevery_tarifs t JOIN delevery_zone z ON z.zone_id = t.zone
                WHERE t.ville_id = u.users_ville_id LIMIT 1),
              (SELECT z.zone_name FROM delevery_tarifs t JOIN delevery_zone z ON z.zone_id = t.zone
                WHERE t.ville_id = u.users_city LIMIT 1)) AS zone
       FROM delevery_users u
      WHERE u.users_id IN (?) AND u.users_active = 1 AND u.users_type = '5'
      ORDER BY u.users_name`,
    [rows.map((r) => Number(r.livreur_id))]
  );
  const nbById = new Map(rows.map((r) => [Number(r.livreur_id), Number(r.nb)]));
  return livreurs
    .filter((l) => zonesAgence === null || zonesAgence.includes(Number(l.zone_id)))
    .map((l) => ({ id: l.id, nom: l.nom, zone: l.zone, nb: nbById.get(Number(l.id)) || 0 }));
}

/** GET /api/factures-livreurs/payables — pour la modale « Ajouter facture livreur ». */
async function listPayables(req, res, next) {
  try {
    res.json(await findLivreursPayables(req.user));
  } catch (err) {
    next(err);
  }
}

/** Requête commune des listes de factures (datatable admin et livreur). */
async function queryFactures(where, params) {
  const [rows] = await pool.query(
    `SELECT pn.payment_note_id        AS id,
            pn.payment_note_ref       AS ref,
            pn.payment_note_time      AS time,
            pn.payment_note_statut    AS statut,
            pn.payment_note_screen    AS screen,
            pn.payment_note_paid_time AS paid_time,
            pn.payment_note_city      AS zone_id,
            pn.payment_note_for       AS livreur_id,
            z.zone_name               AS zone,
            ul.users_name             AS livreur_name,
            uc.users_name             AS created_by,
            up.users_name             AS paid_by,
            (SELECT COUNT(*) FROM delevery_pay_parcels pp
              WHERE pp.pay_parcels_pay = pn.payment_note_id) AS nb_colis,
            (SELECT COALESCE(SUM(CASE WHEN pp.pay_parcels_statut = 'DELIVERED'
                      THEN ${CRBT_SQL} - pp.pay_parcels_fees
                      ELSE -pp.pay_parcels_fees END), 0)
               FROM delevery_pay_parcels pp
               JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
              WHERE pp.pay_parcels_pay = pn.payment_note_id) AS montant,
            (SELECT COALESCE(SUM(lf.frais_montant), 0)
               FROM delevery_livreur_frais lf
              WHERE lf.frais_facture_id = pn.payment_note_id) AS frais_supp
       FROM delevery_payment_note pn
       LEFT JOIN delevery_zone z   ON z.zone_id = pn.payment_note_city
       LEFT JOIN delevery_users ul ON ul.users_id = pn.payment_note_for
       LEFT JOIN delevery_users uc ON uc.users_id = pn.payment_note_by
       LEFT JOIN delevery_users up ON up.users_id = pn.payment_note_paid_by
      WHERE ${where.join(' AND ')}
      ORDER BY pn.payment_note_time DESC, pn.payment_note_id DESC
      LIMIT ${MAX_FACTURES}`,
    params
  );
  return rows.map((r) => ({
    ...factureJson(r),
    nb_colis: Number(r.nb_colis),
    frais_supp: Number(r.frais_supp),
    // Montant total = colis (CRBT - frais) - frais supplémentaires.
    montant: Number(r.montant) - Number(r.frais_supp)
  }));
}

/**
 * GET /api/factures-livreurs — liste des factures pour la datatable.
 * Query : agence, zone, livreur, statut (draft | saved | paid, '' = tous),
 * dateFrom / dateTo (AAAA-MM-JJ, date de création). 1000 factures max, de la
 * plus récente à la plus ancienne. Types 3/4/6 : zones de leur agence.
 */
async function listFactures(req, res, next) {
  try {
    const agence = parseInt(req.query.agence, 10) || 0;
    const zone = parseInt(req.query.zone, 10) || 0;
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const statut = String(req.query.statut || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['pn.payment_note_type = 1'];
    const params = [];
    const zonesAgence = await getZonesAgence(req.user);
    if (zonesAgence !== null) {
      if (!zonesAgence.length) return res.json([]);
      where.push('pn.payment_note_city IN (?)');
      params.push(zonesAgence);
    }
    if (agence) {
      where.push('pn.payment_note_city IN (SELECT zone_id FROM delevery_zone WHERE zone_agence_id = ?)');
      params.push(agence);
    }
    if (zone) {
      where.push('pn.payment_note_city = ?');
      params.push(zone);
    }
    if (livreur) {
      where.push('pn.payment_note_for = ?');
      params.push(livreur);
    }
    if (statut in STATUTS) {
      where.push('pn.payment_note_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (dateFrom !== null) {
      where.push('pn.payment_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('pn.payment_note_time <= ?');
      params.push(dateTo);
    }

    res.json(await queryFactures(where, params));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/factures-livreurs/livreur — dashboard livreur : factures du
 * livreur connecté (type 5), finalisées uniquement (les brouillons restent
 * internes à l'admin). Query : statut (saved | paid, '' = les deux),
 * dateFrom / dateTo (AAAA-MM-JJ, date de création). Même forme de réponse
 * que la liste admin.
 */
async function listFacturesLivreur(req, res, next) {
  try {
    const statut = String(req.query.statut || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [
      'pn.payment_note_type = 1',
      'pn.payment_note_for = ?',
      'pn.payment_note_statut IN (?, ?)'
    ];
    const params = [Number(req.user.id), STATUTS.saved, STATUTS.paid];
    if (statut === 'saved' || statut === 'paid') {
      where.push('pn.payment_note_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (dateFrom !== null) {
      where.push('pn.payment_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('pn.payment_note_time <= ?');
      params.push(dateTo);
    }
    res.json(await queryFactures(where, params));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/factures-livreurs/livreur/:id — dashboard livreur : détail d'une
 * facture du livreur connecté (Enregistré / Payé uniquement), mêmes
 * informations que le détail admin (lignes + frais rattachés) pour la modale
 * « Voir détail » et le PDF. Brouillon ou facture d'un autre livreur → 404.
 */
async function getFactureLivreur(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (
      !facture ||
      Number(facture.livreur_id) !== Number(req.user.id) ||
      Number(facture.statut) === STATUTS.draft
    ) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    const [parcels, frais] = await Promise.all([
      loadFactureParcels(facture.id),
      loadFactureFrais(facture.id)
    ]);
    res.json({ ...factureJson(facture), parcels, frais });
  } catch (err) {
    next(err);
  }
}

/** Référence unique au format legacy : BPL-JJMMAA-0{id}0-{2 chiffres}-{livreur}. */
function buildRef(factureId, livreurId, now) {
  const d = new Date(now * 1000);
  const jj = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const aa = String(d.getFullYear() % 100).padStart(2, '0');
  return `BPL-${jj}${mm}${aa}-0${factureId}0-${Math.floor(Math.random() * 90) + 10}-${livreurId}`;
}

/** Crée une facture brouillon pour le livreur dans la transaction ; { id, ref }. */
async function insertFacture(conn, livreurId, zoneId, userId, now) {
  const [result] = await conn.query(
    `INSERT INTO delevery_payment_note
       (payment_note_ref, payment_note_type, payment_note_for, payment_note_city,
        payment_note_time, payment_note_statut, payment_note_by)
     VALUES ('', 1, ?, ?, ?, 0, ?)`,
    [livreurId, zoneId, now, userId]
  );
  const factureId = result.insertId;
  const ref = buildRef(factureId, livreurId, now);
  await conn.query(`UPDATE delevery_payment_note SET payment_note_ref = ? WHERE payment_note_id = ?`, [
    ref,
    factureId
  ]);
  return { id: factureId, ref };
}

/**
 * Rattache à la facture (dans la transaction) les frais supplémentaires
 * « Nouveau » du livreur non rattachés et datés du jour de la facture ou
 * avant (« les jours précédents »).
 */
async function attachFrais(conn, factureId, livreurId, factureTime) {
  await conn.query(
    `UPDATE delevery_livreur_frais
        SET frais_facture_id = ?
      WHERE frais_livreur_id = ? AND frais_statut = 0
        AND frais_facture_id IS NULL AND frais_date <= ?`,
    [factureId, livreurId, finDeJour(factureTime)]
  );
}

/** Frais supplémentaires rattachés à la facture (détail, modale, PDF). */
async function loadFactureFrais(factureId) {
  const [frais] = await pool.query(
    `SELECT frais_id AS id, frais_titre AS titre, frais_date AS date_frais,
            frais_montant AS montant, frais_statut AS statut
       FROM delevery_livreur_frais
      WHERE frais_facture_id = ?
      ORDER BY frais_date, frais_id`,
    [factureId]
  );
  return frais.map((f) => ({ ...f, montant: Number(f.montant), statut: Number(f.statut) }));
}

/** Frais « Nouveau » du livreur non rattachés à une facture (ajoutables
 * manuellement à une facture brouillon depuis la section frais). */
async function loadFraisDisponibles(livreurId) {
  const [frais] = await pool.query(
    `SELECT frais_id AS id, frais_titre AS titre, frais_date AS date_frais,
            frais_montant AS montant, frais_statut AS statut
       FROM delevery_livreur_frais
      WHERE frais_livreur_id = ? AND frais_statut = 0 AND frais_facture_id IS NULL
      ORDER BY frais_date, frais_id`,
    [livreurId]
  );
  return frais.map((f) => ({ ...f, montant: Number(f.montant), statut: Number(f.statut) }));
}

/** Total des frais supplémentaires rattachés à une facture (dans conn). */
async function sumFrais(conn, factureId) {
  const [[{ total }]] = await conn.query(
    `SELECT COALESCE(SUM(frais_montant), 0) AS total
       FROM delevery_livreur_frais WHERE frais_facture_id = ?`,
    [factureId]
  );
  return Number(total);
}

/** Vérifie le livreur (actif, type 5) et sa zone (périmètre agence). */
async function checkLivreur(livreurId, user) {
  const [[livreurRow]] = await pool.query(
    `SELECT u.users_id FROM delevery_users u
      WHERE u.users_id = ? AND u.users_active = 1 AND u.users_type = '5' LIMIT 1`,
    [livreurId]
  );
  if (!livreurRow) return { error: 'Livreur introuvable ou désactivé.' };
  const zoneId = await livreurZoneId(livreurId);
  const zonesAgence = await getZonesAgence(user);
  if (zoneInterdite(zonesAgence, zoneId)) {
    return { error: 'Livreur hors de votre agence.' };
  }
  return { zoneId };
}

/**
 * POST /api/factures-livreurs — body { livreur }. Crée une facture
 * « Brouillon » pour le livreur (actif, type 5). Renvoie { id, ref }.
 */
async function createFacture(req, res, next) {
  try {
    const livreur = parseInt(req.body?.livreur, 10);
    if (!Number.isInteger(livreur) || livreur <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un livreur.' });
    }
    const check = await checkLivreur(livreur, req.user);
    if (check.error) return res.status(400).json({ message: check.error });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const facture = await insertFacture(conn, livreur, check.zoneId, Number(req.user.id), now);
      await attachFrais(conn, facture.id, livreur, now);
      await conn.commit();
      res.status(201).json(facture);
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

/** Requête des lignes d'une facture (détail, modale, PDF). */
async function loadFactureParcels(factureId) {
  const [parcels] = await pool.query(
    `SELECT p.parcel_id            AS id,
            p.parcel_code          AS code,
            p.parcel_status        AS status,
            p.parcel_status_second AS status_second,
            pp.pay_parcels_statut  AS line_statut,
            pp.pay_parcels_fees    AS frais,
            CASE WHEN pp.pay_parcels_statut = 'DELIVERED' THEN ${CRBT_SQL} ELSE 0 END AS crbt,
            ${STATUT_TIME_SQL}     AS statut_time,
            t.nom_ville            AS ville,
            c.customers_store      AS magasin
       FROM delevery_pay_parcels pp
       JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
       LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
      WHERE pp.pay_parcels_pay = ?
      ORDER BY pp.pay_parcels_id DESC`,
    [factureId]
  );
  return parcels.map((p) => ({
    ...p,
    crbt: Number(p.crbt),
    frais: Number(p.frais),
    prix: Number(p.crbt) - Number(p.frais)
  }));
}

/**
 * GET /api/factures-livreurs/:id — détail d'une facture : informations +
 * lignes (code, magasin, statut, date livraison / annulation, ville, CRBT,
 * frais, prix) + frais supplémentaires rattachés + frais « Nouveau » du
 * livreur non rattachés (fraisDisponibles, ajoutables en brouillon). Sert la
 * page de modification, la modale « Voir détail » et le PDF.
 */
async function getFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    const [parcels, frais, fraisDisponibles] = await Promise.all([
      loadFactureParcels(facture.id),
      loadFactureFrais(facture.id),
      loadFraisDisponibles(Number(facture.livreur_id))
    ]);
    res.json({ ...factureJson(facture), parcels, frais, fraisDisponibles });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/factures-livreurs/:id/frais/:fraisId — rattache manuellement un
 * frais supplémentaire « Nouveau » non rattaché du livreur à la facture
 * (brouillon uniquement). UPDATE conditionnel : ignore un frais déjà pris par
 * une autre facture (y compris en concurrence).
 */
async function attachFraisFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : ajout impossible.' });
    }
    const fraisId = parseInt(req.params.fraisId, 10) || 0;
    const [result] = await pool.query(
      `UPDATE delevery_livreur_frais
          SET frais_facture_id = ?
        WHERE frais_id = ? AND frais_livreur_id = ? AND frais_statut = 0
          AND frais_facture_id IS NULL`,
      [facture.id, fraisId, Number(facture.livreur_id)]
    );
    if (!result.affectedRows) {
      return res
        .status(400)
        .json({ message: 'Frais introuvable, d’un autre livreur, ou déjà rattaché / enregistré.' });
    }
    res.json({ id: fraisId });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-livreurs/:id/frais/:fraisId — retire un frais
 * supplémentaire de la facture (brouillon uniquement) : le frais redevient
 * « Nouveau » non rattaché (rattachable à une autre facture).
 */
async function detachFraisFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : retrait impossible.' });
    }
    const fraisId = parseInt(req.params.fraisId, 10) || 0;
    const [result] = await pool.query(
      `UPDATE delevery_livreur_frais
          SET frais_facture_id = NULL, frais_statut = 0
        WHERE frais_id = ? AND frais_facture_id = ?`,
      [fraisId, facture.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Frais absent de cette facture.' });
    }
    res.json({ id: fraisId });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/factures-livreurs/:id/available — colis facturables du livreur de
 * la facture : livrés non payés, et refusés / annulés avec frais de refus > 0.
 * Renvoie pour chaque colis le frais livreur calculé (modifiable avant ajout).
 */
async function listAvailable(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    const fraisLivre = fraisSql('DELIVERED', ':livreur');
    const fraisRefuse = fraisSql('REFUSED', ':livreur');
    const [rows] = await pool.query(
      `SELECT p.parcel_id            AS id,
              p.parcel_code          AS code,
              p.parcel_status        AS status,
              p.parcel_status_second AS status_second,
              CASE WHEN p.parcel_status = 'DELIVERED' THEN ${CRBT_SQL} ELSE 0 END AS crbt,
              CASE WHEN p.parcel_status = 'DELIVERED' THEN ${fraisLivre} ELSE ${fraisRefuse} END AS frais,
              ${STATUT_TIME_SQL}     AS statut_time,
              t.nom_ville            AS ville,
              c.customers_store      AS magasin
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE (${ELIGIBLE_LIVRE_SQL} AND ${LIVREUR_LIVRE_SQL} = :livreur)
           OR (${ELIGIBLE_REFUSE_SQL} AND ${LIVREUR_REFUSE_SQL} = :livreur AND ${fraisRefuse} > 0)
        ORDER BY statut_time DESC, p.parcel_id DESC`,
      { livreur: Number(facture.livreur_id) }
    );
    res.json(rows.map((p) => ({ ...p, crbt: Number(p.crbt), frais: Number(p.frais) })));
  } catch (err) {
    next(err);
  }
}

/** Entier ≥ 0 (frais en DH), sinon null. */
function parseFrais(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return null;
  return Math.round(n);
}

/**
 * Charge et verrouille (FOR UPDATE) un colis avec son éligibilité et ses frais
 * calculés pour le livreur. Renvoie null si introuvable.
 */
async function lockParcel(conn, parcelId, livreurId) {
  const [[parcel]] = await conn.query(
    `SELECT p.parcel_id            AS id,
            p.parcel_code          AS code,
            p.parcel_status        AS status,
            p.parcel_status_second AS status_second,
            COALESCE(p.parcel_paid_livreur, 0)   AS paid_flag,
            COALESCE(p.parcel_refuse_livreur, 0) AS refuse_flag,
            ${LIVREUR_LIVRE_SQL}   AS livre_par,
            ${LIVREUR_REFUSE_SQL}  AS refuse_par,
            ${fraisSql('DELIVERED', ':livreur')} AS frais_livre,
            ${fraisSql('REFUSED', ':livreur')}   AS frais_refuse
       FROM delevery_parcel p
      WHERE p.parcel_id = :parcelId
      LIMIT 1 FOR UPDATE`,
    { parcelId, livreur: livreurId }
  );
  return parcel || null;
}

/** Motif de refus d'ajout du colis à la facture du livreur, ou null + catégorie. */
function checkAjout(parcel, livreurId) {
  if (parcel.status === 'DELIVERED') {
    if (Number(parcel.paid_flag) !== 0) {
      return { reason: 'Colis déjà dans une facture livreur.' };
    }
    if (Number(parcel.livre_par) !== Number(livreurId)) {
      return { reason: 'Colis livré par un autre livreur.' };
    }
    return { lineStatut: 'DELIVERED', fraisDefaut: Number(parcel.frais_livre) };
  }
  const refuse =
    ['IN_PROGRESS', 'RETURNED'].includes(parcel.status) &&
    ['REFUSE', 'CANCELED'].includes(parcel.status_second);
  if (!refuse) {
    return { reason: `Statut actuel : ${parcel.status_second || parcel.status} (livré, refusé ou annulé attendu).` };
  }
  if (Number(parcel.refuse_flag) !== 0) {
    return { reason: 'Colis déjà dans une facture livreur.' };
  }
  if (Number(parcel.refuse_par) !== Number(livreurId)) {
    return { reason: 'Colis refusé chez un autre livreur.' };
  }
  // Ligne enregistrée « REFUSE » même pour un annulé : compatibilité legacy
  // (le statut affiché vient du colis lui-même).
  return { lineStatut: 'REFUSE', fraisDefaut: Number(parcel.frais_refuse) };
}

/**
 * POST /api/factures-livreurs/:id/parcels — body { entries: [{ id, frais? }] }.
 * Ajout de colis à la facture (à l'unité ou par sélection), avec frais
 * livreur éventuellement modifié avant ajout. Mêmes écritures que le legacy :
 * ligne delevery_pay_parcels + drapeau du colis à 1.
 * Renvoie { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : ajout impossible.' });
    }

    const entriesRaw = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const entries = [];
    const seen = new Set();
    for (const e of entriesRaw.slice(0, 500)) {
      const id = parseInt(e?.id, 10);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        frais: e?.frais === undefined || e?.frais === null ? null : parseFrais(e.frais)
      });
    }
    if (!entries.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });

    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const entry of entries) {
        const parcel = await lockParcel(conn, entry.id, Number(facture.livreur_id));
        if (!parcel) {
          skipped.push({ code: `#${entry.id}`, reason: 'Colis introuvable.' });
          continue;
        }
        const [[dejaLie]] = await conn.query(
          `SELECT pay_parcels_id FROM delevery_pay_parcels
            WHERE pay_parcels_pay = ? AND pay_parcels_parcel = ? LIMIT 1`,
          [facture.id, parcel.id]
        );
        if (dejaLie) {
          skipped.push({ code: parcel.code, reason: 'Déjà dans cette facture.' });
          continue;
        }
        const check = checkAjout(parcel, facture.livreur_id);
        if (check.reason) {
          skipped.push({ code: parcel.code, reason: check.reason });
          continue;
        }
        const frais = entry.frais !== null && entry.frais !== undefined ? entry.frais : Math.round(check.fraisDefaut);
        await conn.query(
          `INSERT INTO delevery_pay_parcels
             (pay_parcels_pay, pay_parcels_parcel, pay_parcels_statut, pay_parcels_fees, pay_parcels_time)
           VALUES (?, ?, ?, ?, ?)`,
          [facture.id, parcel.id, check.lineStatut, frais, now]
        );
        const flagCol = check.lineStatut === 'DELIVERED' ? 'parcel_paid_livreur' : 'parcel_refuse_livreur';
        await conn.query(`UPDATE delevery_parcel SET ${flagCol} = 1 WHERE parcel_id = ?`, [parcel.id]);
        added.push({ id: parcel.id, code: parcel.code, frais });
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
 * PATCH /api/factures-livreurs/:id/parcels/:parcelId — body { frais }.
 * Modifie le frais livreur d'une ligne de la facture (brouillon uniquement).
 */
async function updateLigne(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : modification impossible.' });
    }
    const parcelId = parseInt(req.params.parcelId, 10) || 0;
    const frais = parseFrais(req.body?.frais);
    if (frais === null) {
      return res.status(400).json({ message: 'Frais invalides (montant positif attendu).' });
    }

    const [[ligne]] = await pool.query(
      `SELECT pay_parcels_id AS id FROM delevery_pay_parcels
        WHERE pay_parcels_pay = ? AND pay_parcels_parcel = ? LIMIT 1`,
      [facture.id, parcelId]
    );
    if (!ligne) return res.status(404).json({ message: 'Colis absent de cette facture.' });

    await pool.query(`UPDATE delevery_pay_parcels SET pay_parcels_fees = ? WHERE pay_parcels_id = ?`, [
      frais,
      ligne.id
    ]);
    res.json({ id: parcelId, frais });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-livreurs/:id/parcels/:parcelId — retire un colis de la
 * facture (brouillon uniquement) : ligne supprimée, drapeau du colis remis à 0
 * (redevient facturable, y compris côté legacy).
 * Colis présent sur une facture client (delevery_invoice_parcels) : retrait
 * refusé — il doit d'abord être retiré de la facture client (l'éligibilité
 * client repose sur une facture livreur enregistrée / payée).
 */
async function removeParcel(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : retrait impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10) || 0;
    const conn = await pool.getConnection();
    let failure = null;
    try {
      await conn.beginTransaction();
      const [[ligne]] = await conn.query(
        `SELECT pay_parcels_id AS id, pay_parcels_statut AS statut
           FROM delevery_pay_parcels
          WHERE pay_parcels_pay = ? AND pay_parcels_parcel = ? LIMIT 1 FOR UPDATE`,
        [facture.id, parcelId]
      );
      if (!ligne) {
        failure = { status: 404, message: 'Colis absent de cette facture.' };
      } else {
        const [[factureClient]] = await conn.query(
          `SELECT i.invoice_id AS id, i.invoice_ref AS ref
             FROM delevery_invoice_parcels ip
             JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
            WHERE ip.invoice_parcels_parcel = ? LIMIT 1`,
          [parcelId]
        );
        if (factureClient) {
          const ref = String(factureClient.ref || '').trim() || `n° ${factureClient.id}`;
          failure = {
            status: 400,
            message: `Ce colis est sur la facture client ${ref} : retirez-le d’abord de la facture client.`
          };
        } else {
          await conn.query(`DELETE FROM delevery_pay_parcels WHERE pay_parcels_id = ?`, [ligne.id]);
          const flagCol = ligne.statut === 'DELIVERED' ? 'parcel_paid_livreur' : 'parcel_refuse_livreur';
          await conn.query(`UPDATE delevery_parcel SET ${flagCol} = 0 WHERE parcel_id = ?`, [parcelId]);
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
    res.json({ id: parcelId });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/factures-livreurs/:id/statut — body { statut: 'draft' | 'saved'
 * | 'paid' }. Mêmes écritures que le legacy : drapeaux des colis à 2 quand la
 * facture est enregistrée ou payée, à 1 quand elle repasse en brouillon.
 * Les frais supplémentaires rattachés suivent le statut de la facture
 * (enregistré / payé, retour en brouillon → « Nouveau »).
 * Payé : date + auteur du paiement enregistrés, et recette « Bon de
 * paiment » (montant net du bon) ajoutée à la caisse (delevery_spent) —
 * comptée sur la caisse de l'agence si l'utilisateur est un responsable
 * d'agence (type 3), sinon « Sans agence » (utils/caisse ; le legacy ne
 * l'écrivait que pour le type 3).
 */
async function setStatut(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    const cible = String(req.body?.statut || '').trim();
    if (!(cible in STATUTS)) return res.status(400).json({ message: 'Statut invalide.' });
    const code = STATUTS[cible];
    if (Number(facture.statut) === code) {
      return res.status(400).json({ message: 'La facture est déjà dans ce statut.' });
    }

    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_pay_parcels WHERE pay_parcels_pay = ?`,
      [facture.id]
    );
    if (code !== STATUTS.draft && !nb) {
      return res.status(400).json({ message: 'Cette facture est vide : opération impossible.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_payment_note
            SET payment_note_statut = ?, payment_note_paid_time = ?, payment_note_paid_by = ?
          WHERE payment_note_id = ?`,
        [
          code,
          code === STATUTS.paid ? now : null,
          code === STATUTS.paid ? Number(req.user.id) : null,
          facture.id
        ]
      );
      // Drapeaux des colis : 1 en brouillon, 2 dès que la facture est
      // enregistrée ou payée (mêmes valeurs que payments_note.php legacy).
      const flag = code === STATUTS.draft ? 1 : 2;
      await conn.query(
        `UPDATE delevery_parcel p
           JOIN delevery_pay_parcels pp ON pp.pay_parcels_parcel = p.parcel_id
            SET p.parcel_paid_livreur = IF(pp.pay_parcels_statut = 'DELIVERED', ?, p.parcel_paid_livreur),
                p.parcel_refuse_livreur = IF(pp.pay_parcels_statut = 'DELIVERED', p.parcel_refuse_livreur, ?)
          WHERE pp.pay_parcels_pay = ?`,
        [flag, flag, facture.id]
      );
      // Les frais supplémentaires rattachés suivent le statut de la facture.
      await conn.query(
        `UPDATE delevery_livreur_frais SET frais_statut = ? WHERE frais_facture_id = ?`,
        [FRAIS_STATUTS[cible], facture.id]
      );
      // Recette de caisse au paiement (colis livrés - frais - frais
      // supplémentaires) ; rattachement agence selon le type de l'utilisateur.
      if (code === STATUTS.paid) {
        const [[{ montant }]] = await conn.query(
          `SELECT COALESCE(SUM(CASE WHEN pp.pay_parcels_statut = 'DELIVERED'
                    THEN ${CRBT_SQL} - pp.pay_parcels_fees
                    ELSE -pp.pay_parcels_fees END), 0) AS montant
             FROM delevery_pay_parcels pp
             JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
            WHERE pp.pay_parcels_pay = ?`,
          [facture.id]
        );
        const fraisSupp = await sumFrais(conn, facture.id);
        await ajouterEntreeCaisse(conn, {
          type: TYPES_ENTREE.RECETTE,
          titre: 'Bon de paiment',
          description: facture.ref,
          montant: Number(montant) - fraisSupp,
          date: now,
          userId: req.user.id
        });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json({
      id: facture.id,
      statut: code,
      paid_time: code === STATUTS.paid ? now : null,
      paid_by: code === STATUTS.paid ? req.user.name || null : null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/factures-livreurs/generate — génération automatique : une facture
 * brouillon par livreur ayant des colis facturables (livrés non payés +
 * refusés / annulés avec frais > 0), tous ses colis ajoutés. Livreur ayant
 * déjà une facture brouillon : sa facture la plus récente est complétée
 * (colis + frais « Nouveau » du jour) au lieu d'en créer une nouvelle — même
 * logique que la facturation clients. Types 3/4/6 : livreurs des zones de
 * leur agence uniquement.
 * Renvoie { created: [{ id, ref, livreur, nb }], updated: [idem], skipped }.
 */
async function generateFactures(req, res, next) {
  try {
    const livreurs = await findLivreursPayables(req.user);
    if (!livreurs.length) {
      return res.json({ created: [], updated: [], skipped: 0, message: 'Aucun colis facturable.' });
    }

    const created = [];
    const updated = [];
    let skipped = 0;
    for (const livreur of livreurs.slice(0, 200)) {
      // Colis facturables du livreur (relus puis reverrouillés un à un).
      const fraisRefuse = fraisSql('REFUSED', ':livreur');
      const [rows] = await pool.query(
        `SELECT p.parcel_id AS id
           FROM delevery_parcel p
          WHERE (${ELIGIBLE_LIVRE_SQL} AND ${LIVREUR_LIVRE_SQL} = :livreur)
             OR (${ELIGIBLE_REFUSE_SQL} AND ${LIVREUR_REFUSE_SQL} = :livreur AND ${fraisRefuse} > 0)
          ORDER BY p.parcel_id`,
        { livreur: livreur.id }
      );
      if (!rows.length) continue;

      // Facture brouillon existante du livreur (la plus récente) : elle est
      // complétée au lieu d'en créer une nouvelle.
      const [[brouillon]] = await pool.query(
        `SELECT payment_note_id AS id, payment_note_ref AS ref
           FROM delevery_payment_note
          WHERE payment_note_type = 1 AND payment_note_for = ? AND payment_note_statut = 0
          ORDER BY payment_note_id DESC LIMIT 1`,
        [livreur.id]
      );

      const now = Math.floor(Date.now() / 1000);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const facture =
          brouillon ||
          (await insertFacture(
            conn,
            livreur.id,
            await livreurZoneId(livreur.id),
            Number(req.user.id),
            now
          ));
        await attachFrais(conn, facture.id, livreur.id, now);
        let nb = 0;
        for (const row of rows) {
          const parcel = await lockParcel(conn, row.id, livreur.id);
          if (!parcel) continue;
          const check = checkAjout(parcel, livreur.id);
          if (check.reason) {
            skipped += 1;
            continue;
          }
          await conn.query(
            `INSERT INTO delevery_pay_parcels
               (pay_parcels_pay, pay_parcels_parcel, pay_parcels_statut, pay_parcels_fees, pay_parcels_time)
             VALUES (?, ?, ?, ?, ?)`,
            [facture.id, parcel.id, check.lineStatut, Math.round(check.fraisDefaut), now]
          );
          const flagCol =
            check.lineStatut === 'DELIVERED' ? 'parcel_paid_livreur' : 'parcel_refuse_livreur';
          await conn.query(`UPDATE delevery_parcel SET ${flagCol} = 1 WHERE parcel_id = ?`, [parcel.id]);
          nb += 1;
        }
        if (nb === 0) {
          await conn.rollback();
        } else {
          await conn.commit();
          (brouillon ? updated : created).push({
            id: facture.id,
            ref: facture.ref,
            livreur: livreur.nom,
            nb
          });
        }
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }
    res.json({ created, updated, skipped });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-livreurs/:id — supprime une facture brouillon vide
 * (aucun colis) uniquement.
 */
async function deleteFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : suppression impossible.' });
    }
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_pay_parcels WHERE pay_parcels_pay = ?`,
      [facture.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Cette facture contient des colis : suppression impossible.' });
    }
    // Les frais supplémentaires rattachés sont libérés (redeviennent rattachables).
    await pool.query(
      `UPDATE delevery_livreur_frais SET frais_facture_id = NULL WHERE frais_facture_id = ?`,
      [facture.id]
    );
    await pool.query(`DELETE FROM delevery_payment_note WHERE payment_note_id = ?`, [facture.id]);
    res.json({ id: facture.id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/factures-livreurs/:id/preuve — upload de la preuve de paiement
 * (photo ou PDF, multer en amont). Fichier stocké dans uploads/versements,
 * nom enregistré dans payment_note_screen (colonne legacy) ; l'ancien fichier
 * de l'application est supprimé (jamais un fichier legacy).
 */
async function uploadPreuve(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, facture.zone_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!req.file) return res.status(400).json({ message: 'Aucun fichier reçu.' });

    const old = String(facture.screen || '').trim();
    if (old) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(old));
      if (fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
    }
    await pool.query(`UPDATE delevery_payment_note SET payment_note_screen = ? WHERE payment_note_id = ?`, [
      req.file.filename,
      facture.id
    ]);
    res.json({ id: facture.id, preuve: { url: `/uploads/versements/${req.file.filename}` } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  fraisSql,
  CRBT_SQL,
  listFiltres,
  listPayables,
  listFactures,
  listFacturesLivreur,
  getFactureLivreur,
  createFacture,
  getFacture,
  listAvailable,
  addParcels,
  updateLigne,
  removeParcel,
  attachFraisFacture,
  detachFraisFacture,
  setStatut,
  generateFactures,
  deleteFacture,
  uploadPreuve,
  ensureUploadDir
};
