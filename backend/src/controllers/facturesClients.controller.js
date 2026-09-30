const pool = require('../config/db');
const { TYPES_ENTREE, ajouterEntreeCaisse } = require('../utils/caisse');
const { getAgenceScope, villeInAgenceSql, clientDansAgence } = require('../utils/agenceScope');

/*
 * Factures clients (page /admin/facturation-clients/factures) — réutilise les
 * tables legacy des factures clients, partagées avec le système de
 * production : delevery_invoice (invoice_customer = client) +
 * delevery_invoice_parcels (lignes : statut DELIVERED / REFUSE, COD et frais
 * client stockés sur la ligne) + delevery_invoice_extra (frais legacy,
 * lecture seule).
 *
 * Statuts d'une facture (invoice_statut, mêmes codes que le legacy —
 * différents de ceux des factures livreurs) :
 *  - 0 → « Brouillon » (modifiable) ;
 *  - 1 → « Enregistré » ;
 *  - 2 → « Payé » (invoice_paid_time / invoice_paid_by, colonnes legacy).
 *
 * Drapeaux de facturation du colis (colonnes legacy) : parcel_invoiced
 * (colis livré) / parcel_refuse_invoiced (colis refusé ou annulé) — 0 =
 * facturable, 1 = dans une facture brouillon, 2 = facture enregistrée ou
 * payée. Ils évitent qu'un colis soit facturé deux fois, y compris depuis
 * l'ancien système.
 *
 * Situation du colis (parcel_situation, convention legacy) : quand la facture
 * quitte le brouillon (enregistrée ou payée), tous ses colis passent à
 * INVOICED — statut effectif « Facturé » affiché partout, prioritaire sur
 * parcel_status — avec une ligne d'historique (situation INVOICED, statut
 * DELIVERED / REFUSE, masquée du suivi public comme dans le legacy). Retour
 * en brouillon : situation d'avant facturation restaurée (PAID livré /
 * NOT_PAID refusé ou annulé, valeurs legacy).
 *
 * Colis facturables d'un client (parcel_customer) :
 *  - livrés : parcel_status = DELIVERED, drapeau parcel_invoiced = 0 ;
 *  - refusés / annulés : parcel_status IN_PROGRESS ou RETURNED avec
 *    parcel_status_second REFUSE / CANCELED, drapeau parcel_refuse_invoiced
 *    = 0, et frais de refus > 0 uniquement (frais nuls : rien à facturer,
 *    colis non listé) — mêmes règles que la facturation livreurs ;
 *  - et, règle de l'application absente du legacy : le colis doit être dans une
 *    facture livreur « Enregistré » ou « Payé » — drapeaux livreur
 *    parcel_paid_livreur (livré) / parcel_refuse_livreur (refusé / annulé)
 *    = 2, écrits par la facturation livreurs (0 = aucune facture livreur,
 *    1 = facture livreur brouillon : colis pas encore facturable client).
 *
 * Frais client d'un colis : montants stockés sur le colis à sa création
 * (parcel_delivered_fees / parcel_refused_fees, cascade tarifs client →
 * matrice → ville), modifiables ligne par ligne avant / après ajout tant que
 * la facture est en brouillon.
 *
 * Frais supp de livraison d'un colis (parcel_extra_fees, ex : colis
 * volumineux) : mêmes frais que le champ « Frais supplémentaires » de la
 * modale de modification du colis — portés par le colis lui-même (pas de
 * colonne sur la ligne de facture : la table legacy delevery_invoice_parcels
 * n'est pas modifiée), lus en jointure et modifiables depuis la facture tant
 * qu'elle est en brouillon (écriture sur delevery_parcel).
 *
 * Prix d'une ligne : livré → COD (parcel_price) - frais - frais supp de
 * livraison ; refusé / annulé → -frais - frais supp de livraison. Montant net
 * = somme des prix - frais supplémentaires de l'application (delevery_client_frais) -
 * frais legacy (delevery_invoice_extra) - remise (invoice_discount, legacy —
 * jamais écrite par l'application).
 *
 * Génération automatique : la périodicité de facturation de la fiche client
 * (customers_facturation_periode / customers_facturation_jours) est
 * respectée — une facture n'est générée pour un client que si le jour de la
 * génération est un jour de facturation pour lui (annuelle → 1er janvier ;
 * trimestrielle → 1er jour du trimestre ; mensuelle → 1er du mois ;
 * hebdomadaire / par jours → jours de semaine choisis sur la fiche). Client
 * sans périodicité configurée : aucune restriction. La création manuelle
 * n'est jamais restreinte. Client ayant déjà une facture brouillon : elle est
 * complétée (colis + frais du jour) au lieu d'en créer une nouvelle.
 *
 * Frais supplémentaires (delevery_client_frais, table de l'application) : à la
 * création d'une facture, les frais « Nouveau » du client non rattachés et
 * datés du jour de la facture ou avant y sont rattachés (frais_facture_id).
 * Tant que la facture est en brouillon, les frais « Nouveau » non rattachés
 * du client peuvent aussi être ajoutés / retirés manuellement (boutons de la
 * section frais — les frais legacy invoice_extra restent en lecture seule).
 * Leur statut suit ensuite celui de la facture (enregistré / payé, retour en
 * brouillon → « Nouveau ») ; la suppression d'une facture les libère.
 *
 * Employés type 3/4/6 : uniquement les factures des clients dont la ville de
 * ramassage est rattachée à leur agence (même périmètre que la page Clients).
 */

const MAX_FACTURES = 1000;

/* Codes API ↔ codes legacy invoice_statut (≠ codes factures livreurs). */
const STATUTS = { draft: 0, saved: 1, paid: 2 };

/* Codes API ↔ codes frais_statut (delevery_client_frais : 0 = Nouveau,
 * 1 = Enregistré, 2 = Payé). */
const FRAIS_STATUTS = { draft: 0, saved: 1, paid: 2 };

/* Jours de la semaine dans l'ordre de Date.getDay() (codes de
 * customers_facturation_jours : lundi … vendredi). */
const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * Vrai si `date` (heure locale serveur) est un jour de facturation pour la
 * périodicité de la fiche client (voir les libellés de la fiche) :
 *  - annuelle → 1er janvier ;
 *  - trimestrielle → 1er janvier / avril / juillet / octobre ;
 *  - mensuelle → 1er jour du mois ;
 *  - hebdomadaire / jours → le jour de semaine figure dans facturation_jours ;
 *  - pas de périodicité configurée → toujours vrai (aucune restriction).
 */
function jourDeFacturation(periode, jours, date) {
  switch (String(periode || '').trim()) {
    case 'annuelle':
      return date.getDate() === 1 && date.getMonth() === 0;
    case 'trimestrielle':
      return date.getDate() === 1 && date.getMonth() % 3 === 0;
    case 'mensuelle':
      return date.getDate() === 1;
    case 'hebdomadaire':
    case 'jours': {
      const list = String(jours || '')
        .split(',')
        .map((j) => j.trim().toLowerCase())
        .filter(Boolean);
      return list.includes(JOURS_SEMAINE[date.getDay()]);
    }
    default:
      return true;
  }
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

/** Conditions d'éligibilité (alias p = delevery_parcel). Le drapeau livreur
 * = 2 exige que le colis soit dans une facture livreur enregistrée ou payée
 * (1 = facture livreur brouillon : pas encore facturable client). */
const ELIGIBLE_LIVRE_SQL = `(p.parcel_status = 'DELIVERED' AND COALESCE(p.parcel_invoiced, 0) = 0
  AND COALESCE(p.parcel_paid_livreur, 0) = 2)`;
const ELIGIBLE_REFUSE_SQL = `(p.parcel_status IN ('IN_PROGRESS', 'RETURNED')
  AND p.parcel_status_second IN ('REFUSE', 'CANCELED')
  AND COALESCE(p.parcel_refuse_invoiced, 0) = 0
  AND COALESCE(p.parcel_refused_fees, 0) > 0
  AND COALESCE(p.parcel_refuse_livreur, 0) = 2)`;

/** COD du colis : prix encaissé si livré, 0 sinon (parcel_price est un varchar). */
const CRBT_SQL = `COALESCE(CAST(p.parcel_price AS DECIMAL(12,2)), 0)`;

/** Date du statut : livraison, ou dernière ligne d'historique REFUSE / CANCELED. */
const STATUT_TIME_SQL = `CASE WHEN p.parcel_status = 'DELIVERED' THEN p.parcel_delivery_time
  ELSE (SELECT MAX(h.parcel_history_time) FROM delevery_parcel_history h
         WHERE h.parcel_history_parcel = p.parcel_id
           AND (h.parcel_history_status IN ('REFUSE', 'CANCELED')
                OR h.parcel_history_status_second IN ('REFUSE', 'CANCELED'))) END`;

/* Composantes du montant net d'une facture (alias i = delevery_invoice) :
 * colis (COD - frais - frais supp de livraison), frais supplémentaires
 * de l'application et frais legacy. Net = colis - frais supp - frais legacy - remise.
 * FRAIS_COLIS_SQL : total des frais client des lignes (colonne « Frais » du
 * détail, hors frais supp de livraison et frais supplémentaires) — colonne
 * « Frais TTC » de l'export Excel de la liste admin. */
const FRAIS_COLIS_SQL = `(SELECT COALESCE(SUM(ip.invoice_parcels_parcel_fees), 0)
               FROM delevery_invoice_parcels ip
              WHERE ip.invoice_parcels_invoice = i.invoice_id)`;
const MONTANT_COLIS_SQL = `(SELECT COALESCE(SUM((CASE WHEN ip.invoice_parcels_statut = 'DELIVERED'
                      THEN ip.invoice_parcels_parcel_cod - ip.invoice_parcels_parcel_fees
                      ELSE -ip.invoice_parcels_parcel_fees END)
                      - COALESCE(pp.parcel_extra_fees, 0)), 0)
               FROM delevery_invoice_parcels ip
               LEFT JOIN delevery_parcel pp ON pp.parcel_id = ip.invoice_parcels_parcel
              WHERE ip.invoice_parcels_invoice = i.invoice_id)`;
const FRAIS_SUPP_SQL = `(SELECT COALESCE(SUM(cf.frais_montant), 0)
               FROM delevery_client_frais cf
              WHERE cf.frais_facture_id = i.invoice_id)`;
const FRAIS_LEGACY_SQL = `(SELECT COALESCE(SUM(ie.invoice_extra_total), 0)
               FROM delevery_invoice_extra ie
              WHERE ie.invoice_extra_invoice = i.invoice_id)`;

/** Montant net d'une facture (même calcul que la liste) ; `conn` : transaction ou pool. */
async function montantNetFacture(conn, factureId) {
  const [[r]] = await conn.query(
    `SELECT i.invoice_discount   AS remise,
            ${MONTANT_COLIS_SQL} AS montant_colis,
            ${FRAIS_SUPP_SQL}    AS frais_supp,
            ${FRAIS_LEGACY_SQL}  AS frais_legacy
       FROM delevery_invoice i
      WHERE i.invoice_id = ? LIMIT 1`,
    [factureId]
  );
  if (!r) return 0;
  return (
    Number(r.montant_colis) - Number(r.frais_supp) - Number(r.frais_legacy) - (Number(r.remise) || 0)
  );
}

/** Charge une facture client ; renvoie null si introuvable. */
async function loadFacture(id) {
  const factureId = parseInt(id, 10);
  if (!Number.isInteger(factureId) || factureId <= 0) return null;
  const [[facture]] = await pool.query(
    `SELECT i.invoice_id        AS id,
            i.invoice_ref       AS ref,
            i.invoice_time      AS time,
            i.invoice_statut    AS statut,
            i.invoice_paid_time AS paid_time,
            i.invoice_discount  AS remise,
            i.invoice_customer  AS client_id,
            c.customers_store   AS store,
            c.customers_name    AS client_name,
            uc.users_name       AS created_by,
            up.users_name       AS paid_by
       FROM delevery_invoice i
       LEFT JOIN delevery_customers c ON c.customers_id = i.invoice_customer
       LEFT JOIN delevery_users uc ON uc.users_id = i.invoice_create_by
       LEFT JOIN delevery_users up ON up.users_id = i.invoice_paid_by
      WHERE i.invoice_id = ? LIMIT 1`,
    [factureId]
  );
  return facture || null;
}

/** Vrai si le client de la facture est hors du périmètre de l'employé (types 3/4/6). */
async function clientInterdit(user, clientId) {
  const agenceScope = await getAgenceScope(user);
  return agenceScope !== null && !(await clientDansAgence(clientId, agenceScope));
}

/** Une facture n'est modifiable qu'en brouillon (statut legacy 0). */
function factureEditable(facture) {
  return Number(facture.statut) === STATUTS.draft;
}

/** Sérialisation commune d'une facture (liste et détail). */
function factureJson(facture) {
  return {
    id: facture.id,
    ref: facture.ref,
    time: facture.time,
    statut: Number(facture.statut),
    client_id: facture.client_id,
    store: facture.store,
    client_name: facture.client_name,
    created_by: facture.created_by,
    // Legacy stocke 0 (pas NULL) tant que la facture n'est pas payée.
    paid_time: Number(facture.paid_time) || null,
    paid_by: facture.paid_by,
    remise: Number(facture.remise) || 0
  };
}

/**
 * GET /api/factures-clients/filtres — clients actifs (magasin + nom) pour le
 * filtre magasin. Types 3/4/6 : clients de leur agence uniquement.
 */
async function listFiltres(req, res, next) {
  try {
    const where = ['IFNULL(c.customers_active, 0) = 1'];
    const params = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push(villeInAgenceSql('c.customers_pickup_city'));
      params.push(agenceScope);
    }
    const [clients] = await pool.query(
      `SELECT c.customers_id AS id, c.customers_store AS store, c.customers_name AS nom
         FROM delevery_customers c
        WHERE ${where.join(' AND ')}
        ORDER BY c.customers_store, c.customers_name`,
      params
    );
    res.json({ clients });
  } catch (err) {
    next(err);
  }
}

/**
 * Clients ayant des colis facturables (livrés non facturés, ou refusés /
 * annulés avec frais de refus > 0), avec leur nombre de colis. Types 3/4/6 :
 * clients de leur agence uniquement.
 */
async function findClientsPayables(user) {
  const [rows] = await pool.query(
    `SELECT p.parcel_customer AS client_id, COUNT(*) AS nb
       FROM delevery_parcel p
      WHERE p.parcel_customer > 0 AND (${ELIGIBLE_LIVRE_SQL} OR ${ELIGIBLE_REFUSE_SQL})
      GROUP BY p.parcel_customer`
  );
  if (!rows.length) return [];

  const where = [
    'c.customers_id IN (?)',
    'IFNULL(c.customers_active, 0) = 1'
  ];
  const params = [rows.map((r) => Number(r.client_id))];
  const agenceScope = await getAgenceScope(user);
  if (agenceScope !== null) {
    where.push(villeInAgenceSql('c.customers_pickup_city'));
    params.push(agenceScope);
  }
  const [clients] = await pool.query(
    `SELECT c.customers_id AS id, c.customers_store AS store, c.customers_name AS nom,
            c.customers_facturation_periode AS periode,
            c.customers_facturation_jours AS jours
       FROM delevery_customers c
      WHERE ${where.join(' AND ')}
      ORDER BY c.customers_store, c.customers_name`,
    params
  );
  const nbById = new Map(rows.map((r) => [Number(r.client_id), Number(r.nb)]));
  return clients.map((c) => ({ ...c, nb: nbById.get(Number(c.id)) || 0 }));
}

/** GET /api/factures-clients/payables — pour la modale « Créer facture client ». */
async function listPayables(req, res, next) {
  try {
    res.json(await findClientsPayables(req.user));
  } catch (err) {
    next(err);
  }
}

/* Colonnes de date filtrables sur la liste admin (query dateField). */
const DATE_FIELDS = {
  created: 'i.invoice_time',
  paid: 'i.invoice_paid_time'
};

/** Requête et sérialisation communes de la liste des factures (datatable
 * admin et dashboard client) : nombre de colis, frais (total des frais
 * client des lignes et frais supplémentaires) et montant net, 1000
 * factures max, de la plus récente à la plus ancienne (selon la colonne de
 * date orderCol, création par défaut). */
async function queryFactures(where, params, orderCol = DATE_FIELDS.created) {
  const [rows] = await pool.query(
    `SELECT i.invoice_id        AS id,
            i.invoice_ref       AS ref,
            i.invoice_time      AS time,
            i.invoice_statut    AS statut,
            i.invoice_paid_time AS paid_time,
            i.invoice_discount  AS remise,
            i.invoice_customer  AS client_id,
            c.customers_store   AS store,
            c.customers_name    AS client_name,
            cb.configs_val      AS banque,
            c.customers_rib     AS rib,
            uc.users_name       AS created_by,
            up.users_name       AS paid_by,
            (SELECT COUNT(*) FROM delevery_invoice_parcels ip
              WHERE ip.invoice_parcels_invoice = i.invoice_id) AS nb_colis,
            ${FRAIS_COLIS_SQL}   AS frais,
            ${MONTANT_COLIS_SQL} AS montant_colis,
            ${FRAIS_SUPP_SQL}    AS frais_supp,
            ${FRAIS_LEGACY_SQL}  AS frais_legacy
       FROM delevery_invoice i
       LEFT JOIN delevery_customers c ON c.customers_id = i.invoice_customer
       LEFT JOIN delevery_configs cb ON cb.configs_var = 'ws_config_banks_name'
                                    AND cb.configs_id = CAST(NULLIF(c.customers_bank, '') AS UNSIGNED)
       LEFT JOIN delevery_users uc ON uc.users_id = i.invoice_create_by
       LEFT JOIN delevery_users up ON up.users_id = i.invoice_paid_by
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderCol} DESC, i.invoice_id DESC
      LIMIT ${MAX_FACTURES}`,
    params
  );
  return rows.map((r) => ({
    ...factureJson(r),
    // Coordonnées bancaires du magasin (export Excel de la liste admin).
    banque: r.banque || '',
    rib: r.rib || '',
    nb_colis: Number(r.nb_colis),
    // Total des frais client des lignes (hors frais supp) : « Frais TTC » de
    // l'export Excel.
    frais: Number(r.frais),
    frais_supp: Number(r.frais_supp) + Number(r.frais_legacy),
    // Montant net = colis (COD - frais - frais supp de livraison) - frais
    // supp - frais legacy - remise.
    montant:
      Number(r.montant_colis) -
      Number(r.frais_supp) -
      Number(r.frais_legacy) -
      (Number(r.remise) || 0)
  }));
}

/**
 * GET /api/factures-clients — liste des factures pour la datatable.
 * Query : magasin (customers_id), statut (draft | saved | paid, '' = tous),
 * dateField (created | paid : date de création ou de paiement, création par
 * défaut), dateFrom / dateTo (AAAA-MM-JJ). Par date de paiement, seules les
 * factures payées sont retenues (invoice_paid_time = 0 sinon, convention
 * legacy) dès qu'une borne est donnée. 1000 factures max, de la plus récente
 * à la plus ancienne selon la date choisie. Types 3/4/6 : clients de leur
 * agence.
 */
async function listFactures(req, res, next) {
  try {
    const magasin = parseInt(req.query.magasin, 10) || 0;
    const statut = String(req.query.statut || '').trim();
    const dateCol = DATE_FIELDS[req.query.dateField] || DATE_FIELDS.created;
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['1 = 1'];
    const params = [];
    if (magasin) {
      where.push('i.invoice_customer = ?');
      params.push(magasin);
    }
    if (statut in STATUTS) {
      where.push('i.invoice_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (dateFrom !== null) {
      where.push(`${dateCol} >= ?`);
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push(`${dateCol} <= ?`);
      params.push(dateTo);
    }
    if (dateCol === DATE_FIELDS.paid && (dateFrom !== null || dateTo !== null)) {
      where.push(`${dateCol} > 0`);
    }
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push(villeInAgenceSql('c.customers_pickup_city'));
      params.push(agenceScope);
    }

    res.json(await queryFactures(where, params, dateCol));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/factures-clients/client — dashboard client : factures du client
 * connecté (kind customer), finalisées uniquement (les brouillons restent
 * internes à l'admin). Query : statut (saved | paid, '' = les deux),
 * dateFrom / dateTo (AAAA-MM-JJ, date de création). Même forme de réponse
 * que la liste admin.
 */
async function listFacturesClient(req, res, next) {
  try {
    const statut = String(req.query.statut || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['i.invoice_customer = ?', 'i.invoice_statut IN (?, ?)'];
    const params = [Number(req.user.id), STATUTS.saved, STATUTS.paid];
    if (statut === 'saved' || statut === 'paid') {
      where.push('i.invoice_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (dateFrom !== null) {
      where.push('i.invoice_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('i.invoice_time <= ?');
      params.push(dateTo);
    }
    res.json(await queryFactures(where, params));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/factures-clients/client/:id — dashboard client : détail d'une
 * facture du client connecté (Enregistré / Payé uniquement), mêmes
 * informations que le détail admin (lignes + frais rattachés) pour la modale
 * « Détail » et le PDF. Brouillon ou facture d'un autre client → 404.
 */
async function getFactureClient(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (
      !facture ||
      Number(facture.client_id) !== Number(req.user.id) ||
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

/** Référence unique au format legacy : FCT-JJMMAA-0{id}0-{2 chiffres}-{client}. */
function buildRef(factureId, clientId, now) {
  const d = new Date(now * 1000);
  const jj = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const aa = String(d.getFullYear() % 100).padStart(2, '0');
  return `FCT-${jj}${mm}${aa}-0${factureId}0-${Math.floor(Math.random() * 90) + 10}-${clientId}`;
}

/** Crée une facture brouillon pour le client dans la transaction ; { id, ref }.
 * Colonnes de paiement à 0 (pas NULL) : convention du legacy. */
async function insertFacture(conn, clientId, userId, now) {
  const [result] = await conn.query(
    `INSERT INTO delevery_invoice
       (invoice_customer, invoice_ref, invoice_time, invoice_statut, invoice_paid,
        invoice_paid_time, invoice_discount, invoice_create_by, invoice_paid_by)
     VALUES (?, '', ?, 0, 0, 0, 0, ?, 0)`,
    [clientId, now, userId]
  );
  const factureId = result.insertId;
  const ref = buildRef(factureId, clientId, now);
  await conn.query(`UPDATE delevery_invoice SET invoice_ref = ? WHERE invoice_id = ?`, [
    ref,
    factureId
  ]);
  return { id: factureId, ref };
}

/**
 * Rattache à la facture (dans la transaction) les frais supplémentaires
 * « Nouveau » du client non rattachés et datés du jour de la facture ou
 * avant (« les jours précédents »).
 */
async function attachFrais(conn, factureId, clientId, factureTime) {
  await conn.query(
    `UPDATE delevery_client_frais
        SET frais_facture_id = ?
      WHERE frais_client_id = ? AND frais_statut = 0
        AND frais_facture_id IS NULL AND frais_date <= ?`,
    [factureId, clientId, finDeJour(factureTime)]
  );
}

/**
 * Frais rattachés à la facture (détail, modale, PDF) : frais supplémentaires
 * de l'application (delevery_client_frais) + frais legacy (delevery_invoice_extra,
 * lecture seule, id préfixé « x »), même forme pour l'affichage.
 */
async function loadFactureFrais(factureId) {
  const [[frais], [extras]] = await Promise.all([
    pool.query(
      `SELECT frais_id AS id, frais_titre AS titre, frais_date AS date_frais,
              frais_montant AS montant, frais_statut AS statut
         FROM delevery_client_frais
        WHERE frais_facture_id = ?
        ORDER BY frais_date, frais_id`,
      [factureId]
    ),
    pool.query(
      `SELECT invoice_extra_id AS id, invoice_extra_designation AS titre,
              invoice_extra_time AS date_frais, invoice_extra_total AS montant
         FROM delevery_invoice_extra
        WHERE invoice_extra_invoice = ?
        ORDER BY invoice_extra_time, invoice_extra_id`,
      [factureId]
    )
  ]);
  return [
    ...frais.map((f) => ({ ...f, montant: Number(f.montant), statut: Number(f.statut) })),
    ...extras.map((e) => ({ ...e, id: `x${e.id}`, montant: Number(e.montant), legacy: true }))
  ];
}

/** Frais « Nouveau » du client non rattachés à une facture (ajoutables
 * manuellement à une facture brouillon depuis la section frais). */
async function loadFraisDisponibles(clientId) {
  const [frais] = await pool.query(
    `SELECT frais_id AS id, frais_titre AS titre, frais_date AS date_frais,
            frais_montant AS montant, frais_statut AS statut
       FROM delevery_client_frais
      WHERE frais_client_id = ? AND frais_statut = 0 AND frais_facture_id IS NULL
      ORDER BY frais_date, frais_id`,
    [clientId]
  );
  return frais.map((f) => ({ ...f, montant: Number(f.montant), statut: Number(f.statut) }));
}

/** Vérifie le client (actif) et son périmètre agence. */
async function checkClient(clientId, user) {
  const [[client]] = await pool.query(
    `SELECT customers_id FROM delevery_customers
      WHERE customers_id = ? AND IFNULL(customers_active, 0) = 1 LIMIT 1`,
    [clientId]
  );
  if (!client) return { error: 'Client introuvable ou désactivé.' };
  if (await clientInterdit(user, clientId)) {
    return { error: 'Client hors de votre agence.' };
  }
  return {};
}

/**
 * POST /api/factures-clients — body { client }. Crée une facture
 * « Brouillon » pour le client (actif). Renvoie { id, ref }.
 */
async function createFacture(req, res, next) {
  try {
    const client = parseInt(req.body?.client, 10);
    if (!Number.isInteger(client) || client <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un magasin.' });
    }
    const check = await checkClient(client, req.user);
    if (check.error) return res.status(400).json({ message: check.error });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const facture = await insertFacture(conn, client, Number(req.user.id), now);
      await attachFrais(conn, facture.id, client, now);
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
            p.parcel_receiver      AS destinataire,
            p.parcel_status        AS status,
            p.parcel_status_second AS status_second,
            ip.invoice_parcels_statut      AS line_statut,
            ip.invoice_parcels_parcel_cod  AS crbt,
            ip.invoice_parcels_parcel_fees AS frais,
            COALESCE(p.parcel_extra_fees, 0) AS frais_supp,
            ${STATUT_TIME_SQL}     AS statut_time,
            t.nom_ville            AS ville
       FROM delevery_invoice_parcels ip
       JOIN delevery_parcel p ON p.parcel_id = ip.invoice_parcels_parcel
       LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
      WHERE ip.invoice_parcels_invoice = ?
      ORDER BY ip.invoice_parcels_id DESC`,
    [factureId]
  );
  return parcels.map((p) => ({
    ...p,
    crbt: Number(p.crbt),
    frais: Number(p.frais),
    frais_supp: Number(p.frais_supp),
    prix:
      (p.line_statut === 'DELIVERED' ? Number(p.crbt) - Number(p.frais) : -Number(p.frais)) -
      Number(p.frais_supp)
  }));
}

/**
 * GET /api/factures-clients/:id — détail d'une facture : informations +
 * lignes (code, destinataire, statut, date livraison / annulation, ville,
 * COD, frais, frais supp de livraison, prix) + frais rattachés (application +
 * legacy) + frais « Nouveau »
 * du client non rattachés (fraisDisponibles, ajoutables en brouillon). Sert
 * la page de modification, la modale « Voir détail » et le PDF.
 */
async function getFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    const [parcels, frais, fraisDisponibles] = await Promise.all([
      loadFactureParcels(facture.id),
      loadFactureFrais(facture.id),
      loadFraisDisponibles(Number(facture.client_id))
    ]);
    res.json({ ...factureJson(facture), parcels, frais, fraisDisponibles });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/factures-clients/:id/frais/:fraisId — rattache manuellement un
 * frais supplémentaire « Nouveau » non rattaché du client à la facture
 * (brouillon uniquement). UPDATE conditionnel : ignore un frais déjà pris par
 * une autre facture (y compris en concurrence). Les frais legacy
 * (invoice_extra) ne sont pas concernés.
 */
async function attachFraisFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : ajout impossible.' });
    }
    const fraisId = parseInt(req.params.fraisId, 10) || 0;
    const [result] = await pool.query(
      `UPDATE delevery_client_frais
          SET frais_facture_id = ?
        WHERE frais_id = ? AND frais_client_id = ? AND frais_statut = 0
          AND frais_facture_id IS NULL`,
      [facture.id, fraisId, Number(facture.client_id)]
    );
    if (!result.affectedRows) {
      return res
        .status(400)
        .json({ message: 'Frais introuvable, d’un autre client, ou déjà rattaché / enregistré.' });
    }
    res.json({ id: fraisId });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-clients/:id/frais/:fraisId — retire un frais
 * supplémentaire de l'application de la facture (brouillon uniquement) : le frais
 * redevient « Nouveau » non rattaché (rattachable à une autre facture).
 * Les frais legacy (invoice_extra) ne sont pas détachables.
 */
async function detachFraisFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : retrait impossible.' });
    }
    const fraisId = parseInt(req.params.fraisId, 10) || 0;
    const [result] = await pool.query(
      `UPDATE delevery_client_frais
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
 * GET /api/factures-clients/:id/available — colis facturables du client de
 * la facture : livrés non facturés, et refusés / annulés avec frais de refus
 * > 0. Renvoie pour chaque colis le frais client stocké (modifiable avant
 * ajout).
 */
async function listAvailable(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }

    const [rows] = await pool.query(
      `SELECT p.parcel_id            AS id,
              p.parcel_code          AS code,
              p.parcel_receiver      AS destinataire,
              p.parcel_status        AS status,
              p.parcel_status_second AS status_second,
              CASE WHEN p.parcel_status = 'DELIVERED' THEN ${CRBT_SQL} ELSE 0 END AS crbt,
              CASE WHEN p.parcel_status = 'DELIVERED'
                   THEN COALESCE(p.parcel_delivered_fees, 0)
                   ELSE COALESCE(p.parcel_refused_fees, 0) END AS frais,
              COALESCE(p.parcel_extra_fees, 0) AS frais_supp,
              ${STATUT_TIME_SQL}     AS statut_time,
              t.nom_ville            AS ville
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
        WHERE p.parcel_customer = :client AND (${ELIGIBLE_LIVRE_SQL} OR ${ELIGIBLE_REFUSE_SQL})
        ORDER BY statut_time DESC, p.parcel_id DESC`,
      { client: Number(facture.client_id) }
    );
    res.json(
      rows.map((p) => ({
        ...p,
        crbt: Number(p.crbt),
        frais: Number(p.frais),
        frais_supp: Number(p.frais_supp)
      }))
    );
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
 * Charge et verrouille (FOR UPDATE) un colis avec son éligibilité et ses
 * frais client stockés. Renvoie null si introuvable.
 */
async function lockParcel(conn, parcelId) {
  const [[parcel]] = await conn.query(
    `SELECT p.parcel_id            AS id,
            p.parcel_code          AS code,
            p.parcel_customer      AS client_id,
            p.parcel_status        AS status,
            p.parcel_status_second AS status_second,
            COALESCE(p.parcel_invoiced, 0)        AS invoiced_flag,
            COALESCE(p.parcel_refuse_invoiced, 0) AS refuse_flag,
            COALESCE(p.parcel_paid_livreur, 0)    AS paid_livreur_flag,
            COALESCE(p.parcel_refuse_livreur, 0)  AS refuse_livreur_flag,
            ${CRBT_SQL}                           AS crbt,
            COALESCE(p.parcel_delivered_fees, 0)  AS frais_livre,
            COALESCE(p.parcel_refused_fees, 0)    AS frais_refuse
       FROM delevery_parcel p
      WHERE p.parcel_id = ?
      LIMIT 1 FOR UPDATE`,
    [parcelId]
  );
  return parcel || null;
}

/** Motif de refus d'ajout du colis à la facture du client, ou null + catégorie. */
function checkAjout(parcel, clientId) {
  if (Number(parcel.client_id) !== Number(clientId)) {
    return { reason: "Colis d'un autre client." };
  }
  if (parcel.status === 'DELIVERED') {
    if (Number(parcel.invoiced_flag) !== 0) {
      return { reason: 'Colis déjà dans une facture client.' };
    }
    if (Number(parcel.paid_livreur_flag) !== 2) {
      return { reason: 'Colis pas encore dans une facture livreur enregistrée ou payée.' };
    }
    return { lineStatut: 'DELIVERED', cod: Number(parcel.crbt), fraisDefaut: Number(parcel.frais_livre) };
  }
  const refuse =
    ['IN_PROGRESS', 'RETURNED'].includes(parcel.status) &&
    ['REFUSE', 'CANCELED'].includes(parcel.status_second);
  if (!refuse) {
    return { reason: `Statut actuel : ${parcel.status_second || parcel.status} (livré, refusé ou annulé attendu).` };
  }
  if (Number(parcel.refuse_flag) !== 0) {
    return { reason: 'Colis déjà dans une facture client.' };
  }
  if (Number(parcel.refuse_livreur_flag) !== 2) {
    return { reason: 'Colis pas encore dans une facture livreur enregistrée ou payée.' };
  }
  // Ligne enregistrée « REFUSE » même pour un annulé : compatibilité legacy
  // (le statut affiché vient du colis lui-même).
  return { lineStatut: 'REFUSE', cod: 0, fraisDefaut: Number(parcel.frais_refuse) };
}

/**
 * POST /api/factures-clients/:id/parcels — body { entries: [{ id, frais? }] }.
 * Ajout de colis à la facture (à l'unité ou par sélection), avec frais client
 * éventuellement modifié avant ajout. Mêmes écritures que le legacy : ligne
 * delevery_invoice_parcels (COD + frais stockés) + drapeau du colis à 1.
 * Renvoie { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
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
        const parcel = await lockParcel(conn, entry.id);
        if (!parcel) {
          skipped.push({ code: `#${entry.id}`, reason: 'Colis introuvable.' });
          continue;
        }
        const [[dejaLie]] = await conn.query(
          `SELECT invoice_parcels_id FROM delevery_invoice_parcels
            WHERE invoice_parcels_invoice = ? AND invoice_parcels_parcel = ? LIMIT 1`,
          [facture.id, parcel.id]
        );
        if (dejaLie) {
          skipped.push({ code: parcel.code, reason: 'Déjà dans cette facture.' });
          continue;
        }
        const check = checkAjout(parcel, facture.client_id);
        if (check.reason) {
          skipped.push({ code: parcel.code, reason: check.reason });
          continue;
        }
        const frais = entry.frais !== null && entry.frais !== undefined ? entry.frais : Math.round(check.fraisDefaut);
        await conn.query(
          `INSERT INTO delevery_invoice_parcels
             (invoice_parcels_invoice, invoice_parcels_parcel, invoice_parcels_parcel_cod,
              invoice_parcels_parcel_fees, invoice_parcels_statut, invoice_parcels_time)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [facture.id, parcel.id, Math.round(check.cod), frais, check.lineStatut, now]
        );
        const flagCol = check.lineStatut === 'DELIVERED' ? 'parcel_invoiced' : 'parcel_refuse_invoiced';
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
 * PATCH /api/factures-clients/:id/parcels/:parcelId — body { frais }.
 * Modifie le frais client d'une ligne de la facture (brouillon uniquement).
 */
async function updateLigne(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
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
      `SELECT invoice_parcels_id AS id FROM delevery_invoice_parcels
        WHERE invoice_parcels_invoice = ? AND invoice_parcels_parcel = ? LIMIT 1`,
      [facture.id, parcelId]
    );
    if (!ligne) return res.status(404).json({ message: 'Colis absent de cette facture.' });

    await pool.query(
      `UPDATE delevery_invoice_parcels SET invoice_parcels_parcel_fees = ? WHERE invoice_parcels_id = ?`,
      [frais, ligne.id]
    );
    res.json({ id: parcelId, frais });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/factures-clients/:id/parcels/:parcelId/frais-supp — body
 * { frais_supp }. Modifie les frais supp de livraison du colis
 * (parcel_extra_fees, portés par le colis : mêmes frais que le champ « Frais
 * supplémentaires » de la modale de modification du colis). Facture brouillon
 * uniquement ; colis du client de la facture, qu'il soit déjà dans la facture
 * ou encore dans la liste des facturables.
 */
async function updateFraisSupp(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : modification impossible.' });
    }
    const parcelId = parseInt(req.params.parcelId, 10) || 0;
    const fraisSupp = parseFrais(req.body?.frais_supp);
    if (fraisSupp === null) {
      return res.status(400).json({ message: 'Frais invalides (montant positif attendu).' });
    }

    const [[parcel]] = await pool.query(
      `SELECT parcel_id AS id FROM delevery_parcel
        WHERE parcel_id = ? AND parcel_customer = ? LIMIT 1`,
      [parcelId, Number(facture.client_id)]
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable ou d’un autre client.' });

    await pool.query(`UPDATE delevery_parcel SET parcel_extra_fees = ? WHERE parcel_id = ?`, [
      fraisSupp,
      parcelId
    ]);
    res.json({ id: parcelId, frais_supp: fraisSupp });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-clients/:id/parcels/:parcelId — retire un colis de la
 * facture (brouillon uniquement) : ligne supprimée, drapeau du colis remis à 0
 * (redevient facturable, y compris côté legacy).
 */
async function removeParcel(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
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
        `SELECT invoice_parcels_id AS id, invoice_parcels_statut AS statut
           FROM delevery_invoice_parcels
          WHERE invoice_parcels_invoice = ? AND invoice_parcels_parcel = ? LIMIT 1 FOR UPDATE`,
        [facture.id, parcelId]
      );
      if (!ligne) {
        failure = { status: 404, message: 'Colis absent de cette facture.' };
      } else {
        await conn.query(`DELETE FROM delevery_invoice_parcels WHERE invoice_parcels_id = ?`, [ligne.id]);
        const flagCol = ligne.statut === 'DELIVERED' ? 'parcel_invoiced' : 'parcel_refuse_invoiced';
        await conn.query(`UPDATE delevery_parcel SET ${flagCol} = 0 WHERE parcel_id = ?`, [parcelId]);
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
 * PATCH /api/factures-clients/:id/statut — body { statut: 'draft' | 'saved'
 * | 'paid' }. Mêmes écritures que le legacy : drapeaux des colis à 2 quand la
 * facture est enregistrée ou payée, à 1 quand elle repasse en brouillon ;
 * colis en statut « Facturé » (parcel_situation INVOICED + historique) dès
 * que la facture quitte le brouillon, situation restaurée au retour.
 * Les frais supplémentaires de l'application rattachés suivent le statut de la facture
 * (enregistré / payé, retour en brouillon → « Nouveau ») ; les frais legacy
 * (invoice_extra) ne sont pas touchés.
 * Payé : date + auteur du paiement enregistrés (invoice_paid_time /
 * invoice_paid_by, remis à 0 sinon — convention legacy), et dépense
 * « Facture payée » (montant net de la facture) ajoutée à la caisse
 * (delevery_spent) — comptée sur la caisse de l'agence si l'utilisateur est
 * un responsable d'agence (type 3), sinon « Sans agence » (utils/caisse ;
 * le legacy ne l'écrivait que pour le type 3).
 */
async function setStatut(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    const cible = String(req.body?.statut || '').trim();
    if (!(cible in STATUTS)) return res.status(400).json({ message: 'Statut invalide.' });
    const code = STATUTS[cible];
    if (Number(facture.statut) === code) {
      return res.status(400).json({ message: 'La facture est déjà dans ce statut.' });
    }

    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_invoice_parcels WHERE invoice_parcels_invoice = ?`,
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
        `UPDATE delevery_invoice
            SET invoice_statut = ?, invoice_paid_time = ?, invoice_paid_by = ?
          WHERE invoice_id = ?`,
        [
          code,
          code === STATUTS.paid ? now : 0,
          code === STATUTS.paid ? Number(req.user.id) : 0,
          facture.id
        ]
      );
      // Drapeaux des colis : 1 en brouillon, 2 dès que la facture est
      // enregistrée ou payée (mêmes valeurs que la facturation livreurs).
      const flag = code === STATUTS.draft ? 1 : 2;
      await conn.query(
        `UPDATE delevery_parcel p
           JOIN delevery_invoice_parcels ip ON ip.invoice_parcels_parcel = p.parcel_id
            SET p.parcel_invoiced = IF(ip.invoice_parcels_statut = 'DELIVERED', ?, p.parcel_invoiced),
                p.parcel_refuse_invoiced = IF(ip.invoice_parcels_statut = 'DELIVERED', p.parcel_refuse_invoiced, ?)
          WHERE ip.invoice_parcels_invoice = ?`,
        [flag, flag, facture.id]
      );
      // Statut « Facturé » du colis (parcel_situation, prioritaire sur
      // parcel_status dans tout l'affichage — convention legacy).
      if (code === STATUTS.draft) {
        // Retour en brouillon : situation d'avant facturation restaurée
        // (PAID livré / NOT_PAID refusé ou annulé, valeurs legacy).
        await conn.query(
          `UPDATE delevery_parcel p
             JOIN delevery_invoice_parcels ip ON ip.invoice_parcels_parcel = p.parcel_id
              SET p.parcel_situation = IF(ip.invoice_parcels_statut = 'DELIVERED', 'PAID', 'NOT_PAID'),
                  p.parcel_last_update = ?
            WHERE ip.invoice_parcels_invoice = ? AND p.parcel_situation = 'INVOICED'`,
          [now, facture.id]
        );
      } else if (Number(facture.statut) === STATUTS.draft) {
        // Brouillon → enregistrée / payée : colis marqués « Facturé », avec la
        // même ligne d'historique que le legacy (situation INVOICED + statut de
        // la ligne, masquée du suivi public). Rien entre enregistrée et payée.
        await conn.query(
          `UPDATE delevery_parcel p
             JOIN delevery_invoice_parcels ip ON ip.invoice_parcels_parcel = p.parcel_id
              SET p.parcel_situation = 'INVOICED', p.parcel_last_update = ?
            WHERE ip.invoice_parcels_invoice = ?`,
          [now, facture.id]
        );
        await conn.query(
          `INSERT INTO delevery_parcel_history
             (parcel_history_parcel, parcel_history_city, parcel_history_situation,
              parcel_history_status, parcel_history_time, parcel_history_by)
           SELECT ip.invoice_parcels_parcel, 0, 'INVOICED', ip.invoice_parcels_statut, ?, ?
             FROM delevery_invoice_parcels ip
            WHERE ip.invoice_parcels_invoice = ?`,
          [now, Number(req.user.id) || 0, facture.id]
        );
      }
      // Les frais supplémentaires de l'application rattachés suivent le statut de la facture.
      await conn.query(
        `UPDATE delevery_client_frais SET frais_statut = ? WHERE frais_facture_id = ?`,
        [FRAIS_STATUTS[cible], facture.id]
      );
      // Dépense de caisse au paiement (montant net versé au client) ;
      // rattachement agence selon le type de l'utilisateur.
      if (code === STATUTS.paid) {
        await ajouterEntreeCaisse(conn, {
          type: TYPES_ENTREE.DEPENSE,
          titre: 'Facture payée',
          description: facture.ref,
          montant: await montantNetFacture(conn, facture.id),
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
 * POST /api/factures-clients/generate — génération automatique : une facture
 * brouillon par client ayant des colis facturables (livrés non facturés +
 * refusés / annulés avec frais > 0) ET dont la périodicité de facturation de
 * la fiche (jourDeFacturation) autorise la facturation aujourd'hui, tous ses
 * colis ajoutés. Client ayant déjà une facture brouillon : sa facture la plus
 * récente est complétée (colis + frais « Nouveau » du jour) au lieu d'en
 * créer une nouvelle. Types 3/4/6 : clients de leur agence uniquement.
 * Renvoie { created: [{ id, ref, client, nb }], updated: [idem], skipped,
 * horsPeriode }.
 */
async function generateFactures(req, res, next) {
  try {
    const payables = await findClientsPayables(req.user);
    if (!payables.length) {
      return res.json({ created: [], updated: [], skipped: 0, horsPeriode: 0, message: 'Aucun colis facturable.' });
    }

    // Périodicité de la fiche client : seuls les clients dont c'est un jour
    // de facturation sont générés (la création manuelle reste libre).
    const aujourdhui = new Date();
    const clients = payables.filter((c) => jourDeFacturation(c.periode, c.jours, aujourdhui));
    const horsPeriode = payables.length - clients.length;
    if (!clients.length) {
      return res.json({
        created: [],
        updated: [],
        skipped: 0,
        horsPeriode,
        message:
          "Aucune facture à générer : aucun client facturable n'est dans sa période de facturation aujourd'hui."
      });
    }

    const created = [];
    const updated = [];
    let skipped = 0;
    for (const client of clients.slice(0, 200)) {
      // Colis facturables du client (relus puis reverrouillés un à un).
      const [rows] = await pool.query(
        `SELECT p.parcel_id AS id
           FROM delevery_parcel p
          WHERE p.parcel_customer = :client AND (${ELIGIBLE_LIVRE_SQL} OR ${ELIGIBLE_REFUSE_SQL})
          ORDER BY p.parcel_id`,
        { client: client.id }
      );
      if (!rows.length) continue;

      // Facture brouillon existante du client (la plus récente) : elle est
      // complétée au lieu d'en créer une nouvelle.
      const [[brouillon]] = await pool.query(
        `SELECT invoice_id AS id, invoice_ref AS ref
           FROM delevery_invoice
          WHERE invoice_customer = ? AND invoice_statut = 0
          ORDER BY invoice_id DESC LIMIT 1`,
        [client.id]
      );

      const now = Math.floor(Date.now() / 1000);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const facture =
          brouillon || (await insertFacture(conn, client.id, Number(req.user.id), now));
        await attachFrais(conn, facture.id, client.id, now);
        let nb = 0;
        for (const row of rows) {
          const parcel = await lockParcel(conn, row.id);
          if (!parcel) continue;
          const check = checkAjout(parcel, client.id);
          if (check.reason) {
            skipped += 1;
            continue;
          }
          await conn.query(
            `INSERT INTO delevery_invoice_parcels
               (invoice_parcels_invoice, invoice_parcels_parcel, invoice_parcels_parcel_cod,
                invoice_parcels_parcel_fees, invoice_parcels_statut, invoice_parcels_time)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [facture.id, parcel.id, Math.round(check.cod), Math.round(check.fraisDefaut), check.lineStatut, now]
          );
          const flagCol =
            check.lineStatut === 'DELIVERED' ? 'parcel_invoiced' : 'parcel_refuse_invoiced';
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
            client: client.store || client.nom,
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
    res.json({ created, updated, skipped, horsPeriode });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/factures-clients/:id — supprime une facture brouillon vide
 * (aucun colis) uniquement.
 */
async function deleteFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (await clientInterdit(req.user, facture.client_id)) {
      return res.status(404).json({ message: 'Facture introuvable.' });
    }
    if (!factureEditable(facture)) {
      return res.status(400).json({ message: 'Cette facture n’est plus en brouillon : suppression impossible.' });
    }
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_invoice_parcels WHERE invoice_parcels_invoice = ?`,
      [facture.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Cette facture contient des colis : suppression impossible.' });
    }
    // Les frais supplémentaires rattachés sont libérés (redeviennent rattachables).
    await pool.query(
      `UPDATE delevery_client_frais SET frais_facture_id = NULL WHERE frais_facture_id = ?`,
      [facture.id]
    );
    await pool.query(`DELETE FROM delevery_invoice WHERE invoice_id = ?`, [facture.id]);
    res.json({ id: facture.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  montantNetFacture,
  listFiltres,
  listPayables,
  listFactures,
  listFacturesClient,
  getFactureClient,
  createFacture,
  getFacture,
  listAvailable,
  addParcels,
  updateLigne,
  updateFraisSupp,
  removeParcel,
  attachFraisFacture,
  detachFraisFacture,
  setStatut,
  generateFactures,
  deleteFacture
};
