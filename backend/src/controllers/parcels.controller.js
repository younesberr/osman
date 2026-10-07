const pool = require('../config/db');
const { getServicePhone } = require('./clients.controller');
const { getAgenceScope, parcelInAgence, userAgenceSql, agenceIdFromVille } = require('../utils/agenceScope');
const { getScanSonUrls } = require('../utils/scanSons');
const { attachStockProduits } = require('../utils/parcelProduits');
const { isBlockedByClient } = require('../utils/blocageClient');
const { createAutoDemandeRamassage } = require('./demandesRamassage.controller');
const { statutLabel } = require('../utils/statutLabels');
const { isValidPhone, PHONE_ERROR, phoneVariants } = require('../utils/phone');
const { isValidParcelCode, PARCEL_CODE_ERROR } = require('../utils/parcelCode');
const { historyPreuveSql } = require('../utils/preuveStatut');
const { REMB_DEMANDE_SQL, hasDemandeEnCours } = require('../utils/remboursement');
const {
  fraisMontant,
  lireOptionFraisMontant,
  fraisMontantClient,
  ajusterFraisMontant,
  infoFraisMontant
} = require('../utils/fraisMontant');

const MAX_PAGE_SIZE = 100;

/*
 * Statut affiché ("statut effectif") : CASE SQL défini dans
 * utils/statutEffectif.js (partagé avec les services), ré-exporté ici pour les
 * contrôleurs existants (livreurColis, modificationsColis…).
 */
const { STATUT_CODE_SQL, STATUT_TYPE_SQL } = require('../utils/statutEffectif');

// parcel_city référence delevery_tarifs.ville_id.
const FROM_SQL = `
    FROM delevery_parcel p
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
    LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
    LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur`;

/*
 * Champ de date filtrable/triable (timestamps unix en secondes).
 * "last_update" par défaut : la liste est triée par dernière mise à jour.
 */
const DATE_FIELDS = {
  last_update: 'p.parcel_last_update',
  created: 'p.parcel_time',
  pickup: 'p.parcel_pickup_time',
  sent: 'p.parcel_sent_time',
  delivered: 'p.parcel_delivery_time'
};

/**
 * member_id du membre d'équipe connecté (delevery_customer_members), 0 pour le
 * propriétaire ou un admin. Estampille les colonnes *_member des écritures
 * client (sql/2026-08-23_equipe-client-colonnes-attribution.sql).
 */
function memberOf(req) {
  return Number(req.user?.memberId) || 0;
}

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/**
 * GET /api/parcels — liste paginée côté serveur pour la datatable admin.
 * Query : page, pageSize, search (code, destinataire, téléphone, magasin, ville), status,
 * magasin (customers_id), pickupCity (ville_id), city (ville_id), zone (zone_id de la
 * ville de destination), agence (agence_id du livreur affecté, dérivée de sa ville de
 * fonction — parcel_agence n'est jamais renseigné en base), livreur (users_id),
 * dateField (last_update|created|pickup|sent|delivered), dateFrom / dateTo (AAAA-MM-JJ).
 * Employés type 3/4/6 : restreint aux colis de leur agence (voir utils/agenceScope).
 */
async function listParcels(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const status = String(req.query.status || '').trim().slice(0, 50);
    const magasin = parseInt(req.query.magasin, 10) || 0;
    const pickupCity = parseInt(req.query.pickupCity, 10) || 0;
    const city = parseInt(req.query.city, 10) || 0;
    const zone = parseInt(req.query.zone, 10) || 0;
    const agence = parseInt(req.query.agence, 10) || 0;
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const dateCol = DATE_FIELDS[req.query.dateField] || DATE_FIELDS.last_update;
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    // Types 3/4/6 : uniquement les colis de leur agence (ramassage dans
    // l'agence, ou destination dans l'agence à partir de RECEIVED).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    if (search) {
      where.push(`(p.parcel_code LIKE ? OR p.parcel_receiver LIKE ? OR p.parcel_phone LIKE ?
                   OR c.customers_store LIKE ? OR t.nom_ville LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (status) {
      where.push(`(${STATUT_CODE_SQL}) = ?`);
      params.push(status);
    }
    if (magasin) {
      where.push('p.parcel_customer = ?');
      params.push(magasin);
    }
    if (pickupCity) {
      where.push('p.parcel_ramassage_city = ?');
      params.push(pickupCity);
    }
    if (city) {
      where.push('p.parcel_city = ?');
      params.push(city);
    }
    if (zone) {
      // Zone de la ville de destination (delevery_tarifs.zone → delevery_zone).
      where.push('t.zone = ?');
      params.push(zone);
    }
    if (agence) {
      // Agence du livreur dérivée de sa ville de fonction (users_ville_id).
      where.push(`${userAgenceSql('l')} = ?`);
      params.push(agence);
    }
    if (livreur) {
      where.push('p.parcel_livreur = ?');
      params.push(livreur);
    }
    if (dateFrom !== null) {
      where.push(`${dateCol} >= ?`);
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push(`${dateCol} <= ?`);
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${FROM_SQL} ${whereSql}`,
      params
    );

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
              p.parcel_price, p.parcel_time, p.parcel_status, p.parcel_replace,
              p.parcel_is_remb, (${REMB_DEMANDE_SQL}) AS remb_demande,
              (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statut_color,
              p.parcel_report_time AS report_time,
              c.customers_store AS magasin,
              t.nom_ville AS ville,
              p.parcel_status_second, p.parcel_livreur, l.users_name AS livreur
         ${FROM_SQL}
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = (${STATUT_CODE_SQL})
          AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
         ${whereSql}
         ORDER BY ${dateCol} DESC, p.parcel_id DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      rows,
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
 * GET /api/parcels/statuts — statuts filtrables par la datatable :
 * INVOICED (type 1) + statuts colis (type 2) + statuts seconds (type 3),
 * actifs seulement (désactivables via Configuration > Options),
 * dédoublonnés par code (le type le plus prioritaire gagne).
 */
async function listStatuts(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT parcel_statut_code AS code, parcel_statut_color AS color
         FROM delevery_parcel_statut
        WHERE parcel_statut_active = 1
          AND (parcel_statut_type IN (2, 3)
           OR (parcel_statut_type = 1 AND parcel_statut_code = 'INVOICED'))
        ORDER BY parcel_statut_type, parcel_statut_id`
    );
    const seen = new Set();
    res.json(rows.filter((r) => !seen.has(r.code) && seen.add(r.code)));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/statuts/libelles — libellés français des statuts, lus dans
 * delevery_string (modifiables via Configuration > Options). Renvoie un objet
 * { CODE: libellé } ; les codes sans traduction sont omis (le frontend garde
 * alors son libellé par défaut). Dédoublonné par code comme /parcels/statuts.
 */
async function listStatutLabels(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT s.parcel_statut_code AS code, st.string_text AS nom
         FROM delevery_parcel_statut s
         JOIN (SELECT string_ref, MIN(string_text) AS string_text
                 FROM delevery_string
                WHERE string_lang = 'fr'
                GROUP BY string_ref) st
           ON st.string_ref COLLATE utf8mb4_unicode_ci = s.parcel_statut_name
        ORDER BY s.parcel_statut_type, s.parcel_statut_id`
    );
    const labels = {};
    for (const r of rows) {
      if (r.nom && !(r.code in labels)) labels[r.code] = r.nom;
    }
    res.json(labels);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/filters — options des listes déroulantes de la datatable :
 * magasins (clients), villes de ramassage (matrice tarifaire, sans doublons),
 * villes de destination (tarifs), zones (delevery_zone), agences,
 * livreurs (users_type = 5).
 */
async function listFilterOptions(req, res, next) {
  try {
    const [[magasins], [pickupCities], [cities], [zones], [agences], [livreurs]] = await Promise.all([
      pool.query(
        `SELECT customers_id AS id, customers_store AS label
           FROM delevery_customers
          WHERE COALESCE(customers_store, '') <> ''
          ORDER BY customers_store`
      ),
      pool.query(
        `SELECT DISTINCT m.pickup_ville_id AS id, t.nom_ville AS label
           FROM delevery_tarifs_matrix m
           JOIN delevery_tarifs t ON t.ville_id = m.pickup_ville_id
          ORDER BY t.nom_ville`
      ),
      pool.query(
        `SELECT ville_id AS id, nom_ville AS label
           FROM delevery_tarifs
          ORDER BY nom_ville`
      ),
      pool.query(
        `SELECT zone_id AS id, zone_name AS label
           FROM delevery_zone
          ORDER BY zone_name`
      ),
      pool.query(
        `SELECT agence_id AS id, agence_name AS label
           FROM delevery_agences
          ORDER BY agence_name`
      ),
      pool.query(
        `SELECT users_id AS id, users_name AS label
           FROM delevery_users
          WHERE users_type = '5'
          ORDER BY users_name`
      )
    ]);
    res.json({ magasins, pickupCities, cities, zones, agences, livreurs });
  } catch (err) {
    next(err);
  }
}

/*
 * CRBT effectif d'un colis, tel qu'imprimé sur l'étiquette (même règle que
 * crbtOf() dans frontend/src/utils/etiquettes.js) : "0" si parcel_crbt_zero,
 * sinon parcel_price numérisé.
 */
function effectiveCrbt(p) {
  if (Number(p.parcel_crbt_zero) === 1) return '0';
  return String(Number(p.parcel_price) || 0);
}

/*
 * Journalise une impression d'étiquettes dans delevery_parcel_print (une ligne
 * par colis, avec le CRBT imprimé). Sert à détecter les étiquettes obsolètes
 * (prix modifié après impression) : badge côté client + blocage du scan
 * ramassage. Tolère l'absence de la table (migration
 * sql/2026-08-20_etiquettes-impression-edit-client.sql pas encore exécutée).
 */
async function recordLabelPrints(labels, { userId = 0, customerId = 0, memberId = 0 }) {
  if (!labels.length) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = labels.map((l) => [l.parcel_id, userId, customerId, memberId, effectiveCrbt(l), now]);
  try {
    await pool.query(
      `INSERT INTO delevery_parcel_print
         (print_parcel, print_user, print_customer, print_member, print_price, print_time)
       VALUES ?`,
      [rows]
    );
  } catch (err) {
    // ER_BAD_FIELD_ERROR : print_member absent (migration équipe pas encore exécutée).
    if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err;
  }
}

/*
 * Dernier CRBT imprimé d'un colis (delevery_parcel_print), ou null si jamais
 * imprimé — dans ce cas aucune détection d'obsolescence (étiquettes d'avant la
 * migration, flux sans papier, système legacy).
 */
async function getLastPrintPrice(parcelId) {
  try {
    const [[row]] = await pool.query(
      `SELECT print_price FROM delevery_parcel_print
        WHERE print_parcel = ? ORDER BY print_id DESC LIMIT 1`,
      [parcelId]
    );
    return row ? String(row.print_price) : null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}

/**
 * GET /api/parcels/labels?ids=1,2,3 — données d'impression des étiquettes des
 * colis sélectionnés (500 max) pour la datatable admin. Les colis pouvant
 * appartenir à des clients différents, chaque étiquette porte son propre
 * expéditeur (sender_store / sender_phone). Employés type 3/4/6 : restreint aux
 * colis de leur agence (voir utils/agenceScope).
 */
async function listAdminLabels(req, res, next) {
  try {
    const ids = [...new Set(
      String(req.query.ids || '')
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) {
      return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    }

    const where = ['p.parcel_id IN (?)'];
    const params = [ids];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }

    const [labels] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
              p.parcel_address, p.parcel_note, p.parcel_price, p.parcel_time,
              p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
              p.parcel_open, p.parcel_essayage, p.parcel_replace, p.parcel_crbt_zero,
              t.nom_ville AS ville, z.zone_name AS zone,
              c.customers_store AS sender_store, c.customers_phone AS sender_phone,
              IFNULL(c.customers_phone_show, 0) AS sender_phone_show
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_zone z   ON z.zone_id = t.zone
        WHERE ${where.join(' AND ')}
        ORDER BY p.parcel_time DESC, p.parcel_id DESC`,
      params
    );
    if (!labels.length) {
      return res.status(404).json({ message: 'Colis introuvables.' });
    }

    // customers_phone_show = 0 : le client masque son numéro sur les tickets,
    // on affiche à la place le numéro de mobile de la société.
    if (labels.some((l) => Number(l.sender_phone_show) !== 1)) {
      const servicePhone = await getServicePhone();
      for (const l of labels) {
        if (Number(l.sender_phone_show) !== 1) l.sender_phone = servicePhone || l.sender_phone;
        delete l.sender_phone_show;
      }
    }

    // Colis de stock : produits (nom, quantité, position) sur le ticket.
    await attachStockProduits(labels);

    await recordLabelPrints(labels, { userId: Number(req.user.id) || 0 });

    res.json({ sender: { store: '', phone: '' }, labels });
  } catch (err) {
    next(err);
  }
}

/* Nombre maximal de colis par export Excel (bouton « Exporter Excel »). */
const EXPORT_MAX_IDS = 2000;

/**
 * POST /api/parcels/export — body { ids: [parcel_id…] } (2 000 max) : colonnes
 * du fichier Excel « Exporter Excel » de la datatable admin pour les colis
 * cochés (magasin, code, destinataire, téléphone, ville, adresse, prix,
 * commentaire, marchandise, quantité, statut effectif). Colis de stock :
 * stock_produits (nom, variante, qty) remplace la marchandise saisie. En POST
 * pour que la sélection (cumulée sur plusieurs pages) ne passe pas par l'URL.
 * Lecture seule — contrairement à /labels, aucune impression n'est
 * journalisée. Employés type 3/4/6 : restreint aux colis de leur agence.
 */
async function exportAdminParcels(req, res, next) {
  try {
    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, EXPORT_MAX_IDS);
    if (!ids.length) {
      return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    }

    const where = ['p.parcel_id IN (?)'];
    const params = [ids];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }

    const [rows] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
              p.parcel_address, p.parcel_price, p.parcel_note,
              p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
              (${STATUT_CODE_SQL}) AS statut,
              c.customers_store AS magasin,
              t.nom_ville AS ville
         ${FROM_SQL}
        WHERE ${where.join(' AND ')}
        ORDER BY p.parcel_time DESC, p.parcel_id DESC`,
      params
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Colis introuvables.' });
    }

    // Colis de stock : produits (nom, variante, quantité) à la place de la marchandise.
    await attachStockProduits(rows);

    res.json({ rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/client — liste paginée des colis du client connecté (kind = customer),
 * triée par date de création (parcel_time).
 * Query : page, pageSize, search (code, destinataire, téléphone, ville), status,
 * city (ville_id), dateFrom / dateTo (AAAA-MM-JJ, sur la dernière mise à jour).
 * Retourne aussi les champs bruts (parcel_status, parcel_replace, parcel_is_remb,
 * parcel_from_stock) et remb_demande (demande de remboursement en attente ou
 * acceptée) nécessaires aux conditions d'affichage des actions côté client,
 * les dates de ramassage / livraison (parcel_pickup_time, parcel_delivery_time)
 * et l'auteur de la création : cree_par_membre (nom du membre de l'équipe,
 * null sinon) et cree_par_admin (1 si la ligne d'historique de création porte
 * un users_id admin — le nom de l'utilisateur admin n'est jamais exposé).
 */
async function listClientParcels(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const status = String(req.query.status || '').trim().slice(0, 50);
    const city = parseInt(req.query.city, 10) || 0;
    const dateCol = DATE_FIELDS.last_update;
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['p.parcel_customer = ?'];
    const params = [Number(req.user.id)];
    if (search) {
      where.push(`(p.parcel_code LIKE ? OR p.parcel_receiver LIKE ? OR p.parcel_phone LIKE ?
                   OR t.nom_ville LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (status) {
      where.push(`(${STATUT_CODE_SQL}) = ?`);
      params.push(status);
    }
    if (city) {
      where.push('p.parcel_city = ?');
      params.push(city);
    }
    if (dateFrom !== null) {
      where.push(`${dateCol} >= ?`);
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push(`${dateCol} <= ?`);
      params.push(dateTo);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${FROM_SQL} ${whereSql}`,
      params
    );

    const offset = (page - 1) * pageSize;
    // Table dérivée : la page de colis (filtres + tri + LIMIT) est isolée
    // d'abord, puis seules ses lignes sont enrichies (statut, remboursement,
    // impression, auteur…). Sans cela, MySQL évalue les sous-requêtes et la
    // jointure statut sur TOUS les colis du client avant de trier
    // (≈ 1 s pour 19 k colis, contre quelques ms ici).
    const rowsSql = ({ withPrint, withBlock, withMember }) => `
      SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
             p.parcel_price, p.parcel_crbt_zero, p.parcel_time,
             p.parcel_pickup_time, p.parcel_delivery_time,
             p.parcel_status, p.parcel_replace, p.parcel_is_remb, p.parcel_from_stock,
             (${REMB_DEMANDE_SQL}) AS remb_demande,
             (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statut_color,
             p.parcel_report_time AS report_time,
             t.nom_ville AS ville,
             (SELECT h.parcel_history_by FROM delevery_parcel_history h
               WHERE h.parcel_history_parcel = p.parcel_id
               ORDER BY h.parcel_history_id ASC LIMIT 1) AS cree_par_admin${withMember ? `,
             (SELECT mb.member_name FROM delevery_customer_members mb
               WHERE p.parcel_member > 0 AND mb.member_id = p.parcel_member LIMIT 1) AS cree_par_membre` : ''}${withBlock ? `,
             p.parcel_client_block` : ''}${withPrint ? `,
             (SELECT pr.print_price FROM delevery_parcel_print pr
               WHERE pr.print_parcel = p.parcel_id ORDER BY pr.print_id DESC LIMIT 1) AS last_print_price` : ''}
        FROM (SELECT p.* ${FROM_SQL}
               ${whereSql}
               ORDER BY ${DATE_FIELDS.created} DESC, p.parcel_id DESC
               LIMIT ? OFFSET ?) p
        LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
        LEFT JOIN delevery_parcel_statut s
          ON s.parcel_statut_code = (${STATUT_CODE_SQL})
         AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
        ORDER BY ${DATE_FIELDS.created} DESC, p.parcel_id DESC`;
    // Replis si une migration n'est pas encore exécutée : table des impressions
    // (sql/2026-08-20_etiquettes-impression-edit-client.sql), colonne blocage
    // d'expédition (sql/2026-08-26_blocage-expedition-client.sql) ou équipe
    // client (table delevery_customer_members / colonne parcel_member,
    // sql/2026-08-23_equipe-client-*.sql : l'auteur « membre » est alors inconnu).
    // Les auteurs sont lus par sous-requêtes corrélées (pas de jointure) :
    // évaluées après le tri + LIMIT, contrairement à un LEFT JOIN qui force le
    // tri de tous les colis du client avec leurs sous-requêtes (≈ 1,4 s / 19 k colis).
    let rows;
    const opts = { withPrint: true, withBlock: true, withMember: true };
    for (;;) {
      try {
        [rows] = await pool.query(rowsSql(opts), [...params, pageSize, offset]);
        break;
      } catch (err) {
        const msg = String(err.message || '');
        const membre = msg.includes('delevery_customer_members') || msg.includes('parcel_member');
        if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(err.code) && membre && opts.withMember) {
          opts.withMember = false;
        } else if (err.code === 'ER_NO_SUCH_TABLE' && opts.withPrint) opts.withPrint = false;
        else if (err.code === 'ER_BAD_FIELD_ERROR' && opts.withBlock) opts.withBlock = false;
        else throw err;
      }
    }

    // Étiquette obsolète : dernier CRBT imprimé <> CRBT actuel → badge
    // "Étiquette à réimprimer" côté client. Jamais imprimé → jamais obsolète.
    // Auteur de la création : nom du membre d'équipe, ou admin (1, sans nom).
    for (const r of rows) {
      r.label_stale =
        r.last_print_price !== undefined && r.last_print_price !== null &&
        Number(r.last_print_price) !== Number(effectiveCrbt(r)) ? 1 : 0;
      r.parcel_client_block = Number(r.parcel_client_block) || 0;
      r.cree_par_membre = r.cree_par_membre || null;
      r.cree_par_admin = Number(r.cree_par_admin) > 0 ? 1 : 0;
      delete r.last_print_price;
      delete r.parcel_crbt_zero;
    }

    res.json({
      rows,
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
 * GET /api/parcels/client/filters — options des filtres de la liste des colis client :
 * villes de destination (tarifs) + statuts (mêmes règles que /parcels/statuts).
 */
async function listClientFilterOptions(req, res, next) {
  try {
    const [[cities], [statuts]] = await Promise.all([
      pool.query(
        `SELECT ville_id AS id, nom_ville AS label
           FROM delevery_tarifs
          ORDER BY nom_ville`
      ),
      pool.query(
        `SELECT parcel_statut_code AS code, parcel_statut_color AS color
           FROM delevery_parcel_statut
          WHERE parcel_statut_active = 1
            AND (parcel_statut_type IN (2, 3)
             OR (parcel_statut_type = 1 AND parcel_statut_code = 'INVOICED'))
          ORDER BY parcel_statut_type, parcel_statut_id`
      )
    ]);
    const seen = new Set();
    res.json({ cities, statuts: statuts.filter((r) => !seen.has(r.code) && seen.add(r.code)) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/client/labels?ids=1,2,3 — données d'impression des étiquettes
 * des colis sélectionnés (500 max), restreintes aux colis du client connecté.
 * Renvoie l'expéditeur (magasin + téléphone) et les colis triés par date de création.
 */
async function listClientLabels(req, res, next) {
  try {
    const ids = [...new Set(
      String(req.query.ids || '')
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) {
      return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    }

    // customers_phone_show = 0 : le client masque son numéro sur les tickets,
    // on affiche à la place le numéro de mobile de la société.
    const [[sender]] = await pool.query(
      `SELECT customers_store AS store, customers_phone AS phone,
              IFNULL(customers_phone_show, 0) AS phone_show
         FROM delevery_customers
        WHERE customers_id = ? LIMIT 1`,
      [Number(req.user.id)]
    );
    if (sender && Number(sender.phone_show) !== 1) {
      sender.phone = (await getServicePhone()) || sender.phone;
    }

    const [labels] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
              p.parcel_address, p.parcel_note, p.parcel_price, p.parcel_time,
              p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
              p.parcel_open, p.parcel_essayage, p.parcel_replace, p.parcel_crbt_zero,
              t.nom_ville AS ville, z.zone_name AS zone
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_zone z   ON z.zone_id = t.zone
        WHERE p.parcel_customer = ? AND p.parcel_id IN (?)
        ORDER BY p.parcel_time DESC, p.parcel_id DESC`,
      [Number(req.user.id), ids]
    );
    if (!labels.length) {
      return res.status(404).json({ message: 'Colis introuvables.' });
    }

    // Colis de stock : produits (nom, quantité, position) sur le ticket.
    await attachStockProduits(labels);

    await recordLabelPrints(labels, { customerId: Number(req.user.id) || 0, memberId: memberOf(req) });

    res.json({ sender: sender || { store: '', phone: '' }, labels });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/client/new — données du formulaire "Nouveau colis" :
 * villes de destination actives (delevery_tarifs.statut = 1) + valeurs par
 * défaut du client pour les cases « ouverture » et « essayage » +
 * `frais_montant` ({ actif, seuil, montant } : frais supp automatiques au-delà
 * de 2 500 DH de montant, utils/fraisMontant — le formulaire affiche la
 * notification « frais supp ajoutés » dès que le montant saisi dépasse le seuil).
 */
async function getClientNewParcelData(req, res, next) {
  try {
    const [[cities], [[customer]], optionFrais] = await Promise.all([
      pool.query(
        `SELECT ville_id AS id, nom_ville AS label
           FROM delevery_tarifs
          WHERE statut = 1
          ORDER BY nom_ville`
      ),
      pool.query(
        `SELECT IFNULL(customers_default_open, 0)     AS default_open,
                IFNULL(customers_default_essayage, 0) AS default_essayage
           FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
        [Number(req.user.id)]
      ),
      lireOptionFraisMontant(Number(req.user.id))
    ]);
    if (!customer) return res.status(404).json({ message: 'Compte introuvable.' });
    res.json({
      cities,
      default_open: Number(customer.default_open),
      default_essayage: Number(customer.default_essayage),
      frais_montant: infoFraisMontant(optionFrais.actif)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/new/client?customer=ID — valeurs par défaut du client choisi
 * sur la page admin "Nouveau colis" (cases « ouverture » / « essayage ») +
 * `frais_montant` (mêmes données que /parcels/client/new).
 */
async function getAdminClientDefaults(req, res, next) {
  try {
    const customerId = parseInt(req.query.customer, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ message: 'Client invalide.' });
    }
    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_default_open, 0)     AS default_open,
              IFNULL(customers_default_essayage, 0) AS default_essayage
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ message: 'Client introuvable.' });
    const optionFrais = await lireOptionFraisMontant(customerId);
    res.json({
      default_open: Number(customer.default_open),
      default_essayage: Number(customer.default_essayage),
      frais_montant: infoFraisMontant(optionFrais.actif)
    });
  } catch (err) {
    next(err);
  }
}

const CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** n lettres majuscules aléatoires (préfixes/suffixes des codes colis legacy). */
function randLetters(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  }
  return out;
}

/*
 * Frais d'un colis (livraison / retour / refusé) :
 *  1. tarif personnalisé du client (delevery_customer_tarifs) si
 *     customers_custom_tarif = 1 et que la ville de destination y figure ;
 *  2. sinon ligne « Autre » du client (customers_delivered_price /
 *     customers_returned_price / customers_refused_price, varchar legacy) si
 *     customers_custom_tarif = 1 et qu'au moins un des trois montants est > 0
 *     (ligne à 0 / 0 / 0 = non renseignée) ;
 *  3. sinon matrice ville de ramassage du client → ville de destination
 *     (delevery_tarifs_matrix) ;
 *  4. sinon tarif de la ville de destination seule (delevery_tarifs).
 * Le niveau qui répond fournit les trois frais ensemble (montant vide → 0).
 * Renvoie null si aucun tarif n'existe pour la destination.
 */
async function resolveClientFees(customerId, customTarif, pickupCity, destVilleId) {
  if (Number(customTarif) === 1) {
    const [[t]] = await pool.query(
      `SELECT delivered_price, returned_price, refused_price
         FROM delevery_customer_tarifs
        WHERE customer_id = ? AND city_id = ? LIMIT 1`,
      [customerId, destVilleId]
    );
    if (t) {
      return {
        livraison: Math.round(Number(t.delivered_price) || 0),
        retour: Math.round(Number(t.returned_price) || 0),
        refuse: Math.round(Number(t.refused_price) || 0)
      };
    }
    const [[a]] = await pool.query(
      `SELECT customers_delivered_price, customers_returned_price, customers_refused_price
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (a) {
      const autre = {
        livraison: Math.round(Number(a.customers_delivered_price) || 0),
        retour: Math.round(Number(a.customers_returned_price) || 0),
        refuse: Math.round(Number(a.customers_refused_price) || 0)
      };
      if (autre.livraison > 0 || autre.retour > 0 || autre.refuse > 0) return autre;
    }
  }
  if (Number(pickupCity) > 0) {
    const [[m]] = await pool.query(
      `SELECT frais_livraison, frais_retour, frais_refuse
         FROM delevery_tarifs_matrix
        WHERE pickup_ville_id = ? AND dest_ville_id = ? LIMIT 1`,
      [Number(pickupCity), destVilleId]
    );
    if (m) {
      return {
        livraison: Math.round(Number(m.frais_livraison) || 0),
        retour: Math.round(Number(m.frais_retour) || 0),
        refuse: Math.round(Number(m.frais_refuse) || 0)
      };
    }
  }
  const [[d]] = await pool.query(
    `SELECT frais_livraison, frais_retour, frais_refuse
       FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
    [destVilleId]
  );
  if (d) {
    return {
      livraison: Math.round(Number(d.frais_livraison) || 0),
      retour: Math.round(Number(d.frais_retour) || 0),
      refuse: Math.round(Number(d.frais_refuse) || 0)
    };
  }
  return null;
}

/**
 * GET /api/parcels/client/tarif?city=ID — tarifs affichés sous le formulaire
 * "Nouveau colis" pour la ville de destination choisie : frais de livraison /
 * retour / refusé selon la même cascade que la création (resolveClientFees),
 * plus le délai de livraison de la ville (delevery_tarifs.delai_livraison,
 * null tant que la colonne n'est pas migrée ou pas renseignée → "--" affiché).
 */
async function getClientTarif(req, res, next) {
  return doGetTarif(Number(req.user.id), req.query.city, res, next);
}

/**
 * GET /api/parcels/new/tarif?customer=ID&city=ID — mêmes tarifs, pour la page
 * admin "Nouveau colis" : le client est choisi dans la liste des magasins.
 */
async function getAdminTarif(req, res, next) {
  const customerId = parseInt(req.query.customer, 10);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ message: 'Client invalide.' });
  }
  return doGetTarif(customerId, req.query.city, res, next);
}

/**
 * GET /api/parcels/client/destinataire?phone=06XXXXXXXX — taux de livraison du
 * destinataire, affiché sous le champ téléphone de la page client « Nouveau
 * colis » : historique de tous les colis créés pour ce numéro (tous clients
 * confondus, comptes agrégés uniquement, sans détail).
 */
async function getClientDestinataireTaux(req, res, next) {
  return doGetDestinataireTaux(req.query.phone, res, next);
}

/** GET /api/parcels/new/destinataire?phone=… — même calcul pour la page admin. */
async function getAdminDestinataireTaux(req, res, next) {
  return doGetDestinataireTaux(req.query.phone, res, next);
}

/*
 * Seuils du niveau de confiance d'un destinataire (part de colis livrés) :
 *  - « Bonne personne »   : taux ≥ 80 % ;
 *  - « Personne moyenne » : 50 % ≤ taux < 80 % ;
 *  - « Mauvaise personne » : taux < 50 %.
 */
const DESTINATAIRE_TAUX_BON = 80;
const DESTINATAIRE_TAUX_MOYEN = 50;

/**
 * Cœur du calcul du taux de livraison d'un destinataire (client et admin).
 * Même convention que les compteurs des tableaux de bord : les colis encore
 * « en attente de ramassage » (NEW_PARCEL / WAITING_PICKUP) ne comptent pas ;
 * total = tous les autres colis du numéro (livrés, retournés, en cours),
 * livres = colis au statut DELIVERED, taux = livres / total (en %).
 * Réponse : { total, livres, taux (null si aucun colis), niveau ('bon' |
 * 'moyen' | 'mauvais' | null) }.
 */
async function doGetDestinataireTaux(phoneRaw, res, next) {
  try {
    const phone = String(phoneRaw || '').trim();
    if (!isValidPhone(phone)) return res.status(400).json({ message: PHONE_ERROR });

    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN p.parcel_status = 'DELIVERED' THEN 1 ELSE 0 END), 0) AS livres
         FROM delevery_parcel p
        WHERE p.parcel_phone IN (?)
          AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')`,
      [phoneVariants(phone)]
    );

    const total = Number(row.total) || 0;
    const livres = Number(row.livres) || 0;
    if (total === 0) return res.json({ total: 0, livres: 0, taux: null, niveau: null });

    const taux = Math.round((livres / total) * 100);
    const niveau = taux >= DESTINATAIRE_TAUX_BON ? 'bon' : taux >= DESTINATAIRE_TAUX_MOYEN ? 'moyen' : 'mauvais';
    res.json({ total, livres, taux, niveau });
  } catch (err) {
    next(err);
  }
}

/** Cœur du calcul des tarifs affichés sous le formulaire (client et admin). */
async function doGetTarif(customerId, cityRaw, res, next) {
  try {
    const city = parseInt(cityRaw, 10);
    if (!Number.isInteger(city) || city <= 0) {
      return res.status(400).json({ message: 'Ville invalide.' });
    }

    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
              customers_pickup_city             AS pickup_city
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ message: 'Compte introuvable.' });

    const fees = await resolveClientFees(
      customerId,
      customer.custom_tarif,
      customer.pickup_city,
      city
    );
    if (!fees) {
      return res.status(404).json({ message: 'Aucun tarif trouvé pour cette ville.' });
    }

    let delai = null;
    try {
      const [[row]] = await pool.query(
        `SELECT delai_livraison FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
        [city]
      );
      delai = row?.delai_livraison || null;
    } catch (err) {
      // Colonne pas encore migrée (voir migrations/2026-08-04_tarifs_delai_livraison.sql).
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    }

    res.json({
      livraison: fees.livraison,
      retour: fees.retour,
      refuse: fees.refuse,
      delai
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/client — création d'un colis par le client connecté.
 * Body : { code?, receiver, phone, city, address, price, product?, qty?,
 * note?, products?, fromStock: 0|1, replace: 0|1, open: 0|1, essayage: 0|1 }.
 * Insertion legacy : situation NOT_PAID, statut WAITING_PICKUP, frais résolus
 * par resolveClientFees, ville de ramassage = customers_pickup_city. Sans code
 * personnalisé, le code est généré au format legacy (LLL + MMAA + id + LL) ;
 * le code interne (L + MM-JJ-id) est toujours généré. Une ligne d'historique
 * de création est ajoutée, comme le fait le legacy.
 * Colis de stock (fromStock = 1) : products = [{ id, qty }] (au moins un produit
 * du client). Dans la même transaction que le colis : le stock
 * (delevery_product.product_qte) est déduit, un mouvement « colis envoyé » est
 * tracé dans delevery_product_mvnt (mvnt_note = code du colis créé) et le
 * contenu du colis est enregistré dans delevery_parcel_content (une ligne par
 * unité, comme le legacy — c'est ce que lit la modale "Information colis").
 * Demande de ramassage automatique (createAutoDemandeRamassage) pour un colis
 * normal uniquement : un colis de stock n'en déclenche pas (marchandise déjà
 * en agence).
 */
async function createClientParcel(req, res, next) {
  return doCreateParcel(Number(req.user.id), req.body, res, next, memberOf(req));
}

/**
 * POST /api/parcels/new — création d'un colis par l'admin au nom d'un client
 * (page /admin/colis/nouveau). Body : { customer, ...mêmes champs que la
 * création client }. Mêmes conventions legacy que createClientParcel (le colis
 * est ajouté au compte du client choisi, member = 0 comme l'import admin) ;
 * la ligne d'historique de création porte l'users_id de l'admin
 * (parcel_history_by) : le dashboard client affiche alors « Administration »
 * comme auteur, sans jamais révéler le nom de l'utilisateur admin.
 */
async function createAdminParcel(req, res, next) {
  const customerId = parseInt(req.body?.customer, 10);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ message: 'Veuillez sélectionner un client (magasin).' });
  }
  return doCreateParcel(customerId, req.body, res, next, 0, Number(req.user.id) || 0);
}

/**
 * Cœur de la création d'un colis (dashboards client et admin).
 * memberId : membre de l'équipe client (0 = propriétaire / admin) ;
 * userId : users_id de l'admin créateur (0 pour une action client).
 */
async function doCreateParcel(customerId, body, res, next, memberId = 0, userId = 0) {
  try {
    // Code colis : vide = code généré après l'INSERT ; saisi = lettres et
    // chiffres uniquement, 5 caractères minimum (utils/parcelCode).
    const code = String(body?.code || '').trim().slice(0, 100);
    if (code && !isValidParcelCode(code)) {
      return res.status(400).json({ message: PARCEL_CODE_ERROR });
    }
    const receiver = String(body?.receiver || '').trim().slice(0, 250);
    const phone = String(body?.phone || '').trim().slice(0, 50);
    const city = parseInt(body?.city, 10);
    const address = String(body?.address || '').trim().slice(0, 2000);
    const note = String(body?.note || '').trim().slice(0, 2000);
    const fromStock = Number(body?.fromStock) === 1 ? 1 : 0;
    const replace = Number(body?.replace) === 1 ? 1 : 0;
    const open = Number(body?.open) === 1 ? 1 : 0;
    // Ouverture interdite (open = 0) → essayage forcément interdit aussi.
    const essayage = open === 0 ? 0 : Number(body?.essayage) === 1 ? 1 : 0;

    if (!receiver) return res.status(400).json({ message: 'Le nom du destinataire est obligatoire.' });
    if (!phone) return res.status(400).json({ message: 'Le téléphone du destinataire est obligatoire.' });
    if (!isValidPhone(phone)) return res.status(400).json({ message: PHONE_ERROR });
    if (!Number.isInteger(city) || city <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une ville de destination.' });
    }
    if (!address) return res.status(400).json({ message: "L'adresse est obligatoire." });

    const price = Number(body?.price);
    if (!Number.isFinite(price) || price < 0 || price > 99999999) {
      return res.status(400).json({ message: 'Montant CRBT invalide (montant positif attendu).' });
    }

    // Produit / quantité : uniquement pour un colis normal (masqués côté stock).
    const product = fromStock ? '' : String(body?.product || '').trim().slice(0, 250);
    let qty = 1;
    if (!fromStock && body?.qty !== undefined && String(body.qty).trim() !== '') {
      qty = parseInt(body.qty, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 9999) {
        return res.status(400).json({ message: 'Quantité invalide.' });
      }
    }

    // Produits de stock du colis (fromStock = 1) : quantités cumulées par produit,
    // triées par id pour verrouiller les lignes dans un ordre stable (anti-deadlock).
    let stockItems = [];
    if (fromStock) {
      const raw = Array.isArray(body?.products) ? body.products.slice(0, 200) : [];
      const byId = new Map();
      for (const item of raw) {
        const productId = parseInt(item?.id, 10);
        const productQty = parseInt(item?.qty, 10);
        if (
          !Number.isInteger(productId) || productId <= 0 ||
          !Number.isInteger(productQty) || productQty <= 0 || productQty > 9999
        ) {
          return res.status(400).json({ message: 'Produits de stock invalides.' });
        }
        byId.set(productId, (byId.get(productId) || 0) + productQty);
      }
      stockItems = [...byId]
        .map(([id, quantite]) => ({ id, qty: quantite }))
        .sort((a, b) => a.id - b.id);
      if (!stockItems.length) {
        return res.status(400).json({ message: 'Veuillez ajouter au moins un produit de stock au colis.' });
      }
    }

    const [[ville]] = await pool.query(
      `SELECT ville_id FROM delevery_tarifs WHERE ville_id = ? AND statut = 1 LIMIT 1`,
      [city]
    );
    if (!ville) return res.status(400).json({ message: 'Ville de destination introuvable.' });

    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
              customers_pickup_city             AS pickup_city
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ message: 'Compte introuvable.' });

    if (code) {
      const [[dup]] = await pool.query(
        `SELECT parcel_id FROM delevery_parcel WHERE parcel_code = ? LIMIT 1`,
        [code]
      );
      if (dup) return res.status(409).json({ message: 'Ce code colis est déjà utilisé.' });
    }

    const fees = await resolveClientFees(customerId, customer.custom_tarif, customer.pickup_city, city);
    if (!fees) {
      return res.status(400).json({ message: 'Aucun tarif trouvé pour cette ville de destination.' });
    }
    // Frais supp automatiques selon le montant (20 DH par tranche de 2 500 DH
    // au-delà de 2 500 DH, sauf option désactivée sur le client) → parcel_extra_fees.
    const extraFees = await fraisMontantClient(customerId, price);

    // Agence du colis dérivée de la ville de ramassage du client (ville → zone → agence).
    const agenceId = await agenceIdFromVille(Number(customer.pickup_city) || 0);

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.query(
        `INSERT INTO delevery_parcel
           (parcel_code, parcel_receiver, parcel_phone, parcel_city, parcel_address,
            parcel_price, parcel_note, parcel_situation, parcel_status,
            parcel_delivered_fees, parcel_extra_fees, parcel_returned_fees, parcel_refused_fees,
            parcel_customer, parcel_member, parcel_replace, parcel_open, parcel_essayage,
            parcel_from_stock, parcel_product_name, parcel_product_qty,
            parcel_ramassage_city, parcel_agence, parcel_time, parcel_last_update)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'NOT_PAID', 'WAITING_PICKUP',
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code || '',
          receiver,
          phone,
          city,
          address,
          String(price),
          note,
          fees.livraison,
          extraFees,
          fees.retour,
          fees.refuse,
          customerId,
          memberId,
          replace,
          open,
          essayage,
          String(fromStock),
          product,
          qty,
          Number(customer.pickup_city) || 0,
          agenceId ? String(agenceId) : '',
          now,
          now
        ]
      );
      const parcelId = result.insertId;

      // Codes au format legacy : "OSM0926100001AB" et "X07-30-266195".
      const d = new Date(now * 1000);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = String(d.getFullYear() % 100).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const parcelCode = code || `${randLetters(3)}${mm}${yy}${parcelId}${randLetters(2)}`;
      const codeInterne = `${randLetters(1)}${mm}-${dd}-${parcelId}`;
      await conn.query(
        `UPDATE delevery_parcel SET parcel_code = ?, parcel_code_interne = ? WHERE parcel_id = ?`,
        [parcelCode, codeInterne, parcelId]
      );

      // Ligne d'historique de création (mêmes conventions que le legacy :
      // _by = 0 pour une action client, users_id de l'admin sinon ; le membre
      // est dans _member).
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_time, parcel_history_by, parcel_history_member)
         VALUES (?, 0, 'NOT_PAID', 'WAITING_PICKUP', ?, ?, ?)`,
        [parcelId, now, userId, memberId]
      );

      // Colis de stock : déduit chaque quantité du stock (ligne produit
      // verrouillée), trace le mouvement « colis envoyé » (mvnt_note = code du
      // colis) et enregistre le contenu du colis (une ligne par unité).
      for (const item of stockItems) {
        const [[produit]] = await conn.query(
          `SELECT product_name, product_ref, product_pic, product_rayonnage, product_qte
             FROM delevery_product
            WHERE product_id = ? AND product_customer = ? AND product_statut = 1
            LIMIT 1 FOR UPDATE`,
          [item.id, customerId]
        );
        if (!produit) {
          await conn.rollback();
          return res.status(400).json({ message: 'Produit de stock introuvable.' });
        }
        const stockDisponible = Number(produit.product_qte) || 0;
        if (item.qty > stockDisponible) {
          await conn.rollback();
          return res.status(400).json({
            message: `Stock insuffisant pour « ${produit.product_name} » : ${stockDisponible} disponible(s), impossible d'en envoyer ${item.qty}.`
          });
        }

        await conn.query(
          'UPDATE delevery_product SET product_qte = product_qte - ? WHERE product_id = ?',
          [item.qty, item.id]
        );
        await conn.query(
          `INSERT INTO delevery_product_mvnt
             (id_product, mvnt_qte, mvnt_type, mvnt_date, mvnt_by, mvnt_member, mvnt_commentaire, mvnt_validate_by, mvnt_note)
           VALUES (?, ?, 'colis envoyé', NOW(), ?, ?, NULL, NULL, ?)`,
          [item.id, -item.qty, customerId, memberId || null, parcelCode]
        );

        const contentRows = Array.from({ length: item.qty }, () => [
          customerId,
          parcelId,
          item.id,
          produit.product_ref || '',
          produit.product_name || '',
          '',
          produit.product_pic || '',
          String(now),
          String(produit.product_rayonnage || '').slice(0, 100)
        ]);
        await conn.query(
          `INSERT INTO delevery_parcel_content
             (parcel_content_customer_id, parcel_content_parcel_id, parcel_content_product_id,
              parcel_content_variant_ref, parcel_content_product_name, parcel_content_variant_name,
              parcel_content_product_pic, parcel_content_time, parcel_content_remarque)
           VALUES ?`,
          [contentRows]
        );
      }

      await conn.commit();
      // Demande de ramassage automatique (hors transaction : best-effort),
      // colis normal uniquement : la marchandise d'un colis de stock est déjà
      // en agence, rien à ramasser chez le client.
      if (!fromStock) await createAutoDemandeRamassage(customerId, memberId);
      // extra_fees : frais supp automatiques appliqués (0 si aucun), champ additif.
      res.status(201).json({ parcel_id: parcelId, parcel_code: parcelCode, extra_fees: extraFees });
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

/*
 * Libellés français des champs éditables par le client (trace des
 * modifications, même format que EDIT_FIELDS côté admin). Frais et ville de
 * ramassage exclus : réservés à l'admin.
 */
const CLIENT_EDIT_FIELDS = [
  { key: 'receiver', label: 'Destinataire' },
  { key: 'phone', label: 'Téléphone' },
  { key: 'city', label: 'Ville' },
  { key: 'address', label: 'Adresse' },
  { key: 'note', label: 'Commentaire' },
  { key: 'price', label: 'Prix' },
  { key: 'product', label: 'Marchandise' },
  { key: 'qty', label: 'Quantité' },
  { key: 'open', label: 'Ouverture autorisée' },
  { key: 'essayage', label: 'Essayage autorisé' },
  { key: 'replace', label: 'Colis à remplacer' }
];

/*
 * Statuts bruts pour lesquels la modale client "Modifier colis" est fermée :
 * colis livré ou retourné. Pour tous les autres :
 *  - WAITING_PICKUP : modification directe, sans validation admin ;
 *  - autres statuts (ramassé, expédié, en cours, …) : la modification devient
 *    une demande à valider sur la page admin /admin/modifications-colis
 *    (delevery_parcel_modif_demande, sql/2026-08-24_modifications-colis.sql).
 */
const CLIENT_EDIT_LOCKED_STATUSES = ['DELIVERED', 'RETURNED'];

/*
 * Statuts pour lesquels le client peut encore changer la ville de destination
 * (colis pas encore expédié). Au-delà, le colis est déjà acheminé vers
 * l'ancienne ville : le champ est verrouillé dans la modale (city_editable = 0)
 * et une ville différente est refusée (400, VILLE_NON_MODIFIABLE) ; le
 * changement passe par le service client (bouton « Réclamation » du colis).
 */
const CLIENT_CITY_EDITABLE_STATUSES = ['WAITING_PICKUP', 'PICKED_UP'];
const VILLE_NON_MODIFIABLE =
  'La ville de destination ne peut plus être modifiée après expédition : contactez le service client via le bouton « Réclamation » du colis.';

/* Message renvoyé (409) quand un code colis différent est soumis pour un colis
 * qui n'est plus en attente de ramassage (modale ouverte avant le ramassage,
 * ou requête forgée). Partagé avec la modale admin (parcelsAdmin.controller). */
const CODE_NON_MODIFIABLE =
  'Le code colis ne peut être modifié que pour un colis en attente de ramassage.';

/**
 * Nouveau code colis demandé par la modale « Modifier colis » (admin ou
 * client). Renvoie { code, modifie } — `code` = code à enregistrer (l'actuel si
 * inchangé ou non fourni), `modifie` = true si différent — ou { error, status }
 * à renvoyer tel quel. Règles : modifiable seulement en attente de ramassage
 * (WAITING_PICKUP : aucune étiquette scannée, aucun bon), non vide (le code
 * ne peut pas être supprimé), lettres et chiffres uniquement, 5 à 100
 * caractères (utils/parcelCode, comme à la création), unique dans
 * delevery_parcel (pas d'index unique en base : contrôle applicatif, comme à
 * la création / import).
 */
async function resoudreNouveauCode(parcel, rawCode) {
  const ancien = String(parcel.parcel_code || '');
  if (rawCode === undefined) return { code: ancien, modifie: false };
  const demande = String(rawCode || '').trim().slice(0, 100);
  if (demande === ancien) return { code: ancien, modifie: false };
  if (parcel.parcel_status !== 'WAITING_PICKUP') {
    return { error: CODE_NON_MODIFIABLE, status: 409 };
  }
  if (!demande) return { error: 'Le code colis est obligatoire.', status: 400 };
  if (!isValidParcelCode(demande)) return { error: PARCEL_CODE_ERROR, status: 400 };
  const [[dup]] = await pool.query(
    `SELECT parcel_id FROM delevery_parcel WHERE parcel_code = ? AND parcel_id <> ? LIMIT 1`,
    [demande, parcel.parcel_id]
  );
  if (dup) return { error: 'Ce code colis est déjà utilisé.', status: 409 };
  return { code: demande, modifie: true };
}

/**
 * Après un changement de code colis : les mouvements de stock « colis envoyé »
 * d'un colis de stock sont tracés par code du colis (mvnt_note) → suivent le
 * nouveau code. Limité aux produits du contenu du colis ; ancien code vide
 * ignoré (ne pas toucher les mouvements sans note). À appeler dans la
 * transaction de la modification.
 */
async function renommerCodeMouvementsStock(conn, parcelId, ancienCode, nouveauCode) {
  if (!ancienCode) return;
  await conn.query(
    `UPDATE delevery_product_mvnt m
       JOIN (SELECT DISTINCT parcel_content_product_id AS pid
               FROM delevery_parcel_content
              WHERE parcel_content_parcel_id = ?) c ON c.pid = m.id_product
        SET m.mvnt_note = ?
      WHERE m.mvnt_note = ?`,
    [parcelId, nouveauCode, ancienCode]
  );
}

/**
 * Demande de modification encore en attente de validation pour un colis
 * (1 seule PENDING par colis). 0 si la table n'est pas encore migrée.
 */
async function hasPendingModifDemande(parcelId) {
  try {
    const [[row]] = await pool.query(
      `SELECT pmd_id FROM delevery_parcel_modif_demande
        WHERE pmd_parcel = ? AND pmd_statut = 'PENDING' LIMIT 1`,
      [parcelId]
    );
    return row ? 1 : 0;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return 0;
    throw err;
  }
}

/**
 * GET /api/parcels/client/:id/edit — données de la modale client "Modifier
 * colis" : valeurs actuelles + villes de destination actives. Colis du client
 * connecté hors DELIVERED / RETURNED : WAITING_PICKUP = modification directe,
 * tout autre statut = demande à valider par l'admin (requires_validation = 1).
 * pending_demande = 1 si une demande est déjà en attente (la modale bloque
 * alors l'envoi). code_editable = 1 (WAITING_PICKUP seulement) : la modale
 * affiche le champ « Code colis » (voir resoudreNouveauCode). city_editable = 1
 * (WAITING_PICKUP / PICKED_UP) : ville de destination modifiable, sinon champ
 * verrouillé avec renvoi vers le service client (CLIENT_CITY_EDITABLE_STATUSES).
 */
async function getClientParcelEditData(req, res, next) {
  try {
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_receiver, p.parcel_phone,
       p.parcel_city, p.parcel_address, p.parcel_note, p.parcel_price,
       p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
       p.parcel_open, p.parcel_essayage, p.parcel_replace`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (CLIENT_EDIT_LOCKED_STATUSES.includes(parcel.parcel_status)) {
      return res.status(409).json({ message: 'Ce colis ne peut plus être modifié.' });
    }

    const [cities] = await pool.query(
      `SELECT ville_id AS id, nom_ville AS label
         FROM delevery_tarifs
        WHERE statut = 1
        ORDER BY nom_ville`
    );

    const optionFrais = await lireOptionFraisMontant(Number(req.user.id));
    res.json({
      requires_validation: parcel.parcel_status === 'WAITING_PICKUP' ? 0 : 1,
      pending_demande: await hasPendingModifDemande(parcel.parcel_id),
      code_editable: parcel.parcel_status === 'WAITING_PICKUP' ? 1 : 0,
      city_editable: CLIENT_CITY_EDITABLE_STATUSES.includes(parcel.parcel_status) ? 1 : 0,
      // Frais supp automatiques au-delà de 2 500 DH : la modale affiche la
      // notification quand le nouveau montant dépasse le seuil (option du client).
      frais_montant: infoFraisMontant(optionFrais.actif),
      parcel_code: parcel.parcel_code,
      receiver: parcel.parcel_receiver || '',
      phone: parcel.parcel_phone || '',
      city: Number(parcel.parcel_city) || 0,
      address: parcel.parcel_address || '',
      note: parcel.parcel_note || '',
      price: Number(parcel.parcel_price) || 0,
      product: parcel.parcel_product_name || '',
      qty: Number(parcel.parcel_product_qty) || 1,
      from_stock: Number(parcel.parcel_from_stock) === 1 ? 1 : 0,
      open: Number(parcel.parcel_open) === 1 ? 1 : 0,
      essayage: Number(parcel.parcel_essayage) === 1 ? 1 : 0,
      replace: Number(parcel.parcel_replace) === 1 ? 1 : 0,
      cities
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/parcels/client/:id — modale client "Modifier colis". Body :
 * { code?, receiver, phone, city, address, note, price, product?, qty?,
 * replace: 0|1, open: 0|1, essayage: 0|1 }.
 *  - WAITING_PICKUP : modification appliquée directement (sans validation) ;
 *    seul statut où le code colis (`code`) peut changer — unicité contrôlée,
 *    mouvements de stock renommés (resoudreNouveauCode /
 *    renommerCodeMouvementsStock), réponse { code_modifie: 1, parcel_code } ;
 *  - tout autre statut hors DELIVERED / RETURNED : rien n'est modifié, une
 *    demande de validation est enregistrée (delevery_parcel_modif_demande, une seule
 *    PENDING par colis) et traitée sur la page admin /admin/modifications-colis
 *    → réponse { pending_validation: 1 }.
 * Colis de stock : marchandise / quantité non modifiables (contenu géré dans
 * delevery_parcel_content). Ville de destination figée après expédition (statut
 * hors CLIENT_CITY_EDITABLE_STATUSES → 400 si elle diffère). Changement de
 * ville → frais de livraison / retour / refusé re-résolus comme à la création
 * (resolveClientFees). Mêmes traces que
 * l'édition admin : instantané delevery_parcel_edit (+ parcel_edited = 1),
 * delevery_parcel_modification (modif_user = 0, modif_customer = client) et
 * ligne d'historique legacy data = 'EDITED'. Le statut est re-vérifié dans le
 * WHERE de l'UPDATE (course avec le scan ramassage).
 */
async function updateClientParcel(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_situation,
       p.parcel_receiver, p.parcel_phone, p.parcel_city, p.parcel_address,
       p.parcel_note, p.parcel_price, p.parcel_crbt_zero, p.parcel_extra_fees,
       p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
       p.parcel_open, p.parcel_essayage, p.parcel_replace, t.nom_ville AS ville`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (CLIENT_EDIT_LOCKED_STATUSES.includes(parcel.parcel_status)) {
      return res.status(409).json({ message: 'Ce colis ne peut plus être modifié.' });
    }
    const fromStock = Number(parcel.parcel_from_stock) === 1;

    const receiver = String(req.body?.receiver || '').trim().slice(0, 250);
    const phone = String(req.body?.phone || '').trim().slice(0, 50);
    const city = parseInt(req.body?.city, 10);
    const address = String(req.body?.address || '').trim().slice(0, 2000);
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    const replace = Number(req.body?.replace) === 1 ? 1 : 0;
    const open = Number(req.body?.open) === 1 ? 1 : 0;
    // Ouverture interdite (open = 0) → essayage forcément interdit aussi.
    const essayage = open === 0 ? 0 : Number(req.body?.essayage) === 1 ? 1 : 0;

    if (!receiver) return res.status(400).json({ message: 'Le nom du destinataire est obligatoire.' });
    if (!phone) return res.status(400).json({ message: 'Le téléphone du destinataire est obligatoire.' });
    if (!isValidPhone(phone)) return res.status(400).json({ message: PHONE_ERROR });
    if (!Number.isInteger(city) || city <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une ville de destination.' });
    }
    // Ville figée une fois le colis expédié (champ verrouillé dans la modale ;
    // requête forgée ou modale ouverte avant l'expédition) : réclamation.
    if (
      city !== (Number(parcel.parcel_city) || 0) &&
      !CLIENT_CITY_EDITABLE_STATUSES.includes(parcel.parcel_status)
    ) {
      return res.status(400).json({ message: VILLE_NON_MODIFIABLE });
    }
    if (!address) return res.status(400).json({ message: "L'adresse est obligatoire." });

    const price = Number(req.body?.price);
    if (!Number.isFinite(price) || price < 0 || price > 99999999) {
      return res.status(400).json({ message: 'Montant CRBT invalide (montant positif attendu).' });
    }

    // Produit / quantité : uniquement pour un colis normal (masqués côté stock).
    const product = fromStock
      ? parcel.parcel_product_name || ''
      : String(req.body?.product || '').trim().slice(0, 250);
    let qty = fromStock ? Number(parcel.parcel_product_qty) || 1 : 1;
    if (!fromStock && req.body?.qty !== undefined && String(req.body.qty).trim() !== '') {
      qty = parseInt(req.body.qty, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 9999) {
        return res.status(400).json({ message: 'Quantité invalide.' });
      }
    }

    const [[destVille]] = await pool.query(
      `SELECT nom_ville FROM delevery_tarifs WHERE ville_id = ? AND statut = 1 LIMIT 1`,
      [city]
    );
    if (!destVille) return res.status(400).json({ message: 'Ville de destination introuvable.' });

    // Code colis : modifiable seulement en attente de ramassage (jamais via
    // une demande de validation) ; hors `nouveau` (payload des demandes).
    const codeRes = await resoudreNouveauCode(parcel, req.body?.code);
    if (codeRes.error) return res.status(codeRes.status).json({ message: codeRes.error });
    const ancienCode = String(parcel.parcel_code || '');
    const nouveauCode = codeRes.code;
    const codeModifie = codeRes.modifie;

    const nouveau = { receiver, phone, city, address, note, price, product, qty, open, essayage, replace };
    const ancien = {
      receiver: parcel.parcel_receiver || '',
      phone: parcel.parcel_phone || '',
      city: Number(parcel.parcel_city) || 0,
      address: parcel.parcel_address || '',
      note: parcel.parcel_note || '',
      price: Number(parcel.parcel_price) || 0,
      product: parcel.parcel_product_name || '',
      qty: Number(parcel.parcel_product_qty) || 1,
      open: Number(parcel.parcel_open) === 1 ? 1 : 0,
      essayage: Number(parcel.parcel_essayage) === 1 ? 1 : 0,
      replace: Number(parcel.parcel_replace) === 1 ? 1 : 0
    };

    // Champs modifiés (ville et oui/non tracés par libellé, pas par id).
    const changes = [];
    for (const f of CLIENT_EDIT_FIELDS) {
      if (fromStock && (f.key === 'product' || f.key === 'qty')) continue;
      if (String(ancien[f.key]) === String(nouveau[f.key])) continue;
      let oldVal = ancien[f.key];
      let newVal = nouveau[f.key];
      if (f.key === 'city') {
        oldVal = parcel.ville || String(oldVal || '—');
        newVal = destVille.nom_ville;
      } else if (f.key === 'open' || f.key === 'essayage' || f.key === 'replace') {
        oldVal = oldVal === 1 ? 'Oui' : 'Non';
        newVal = newVal === 1 ? 'Oui' : 'Non';
      }
      changes.push({ field: f.key, label: f.label, old: String(oldVal), new: String(newVal) });
    }
    if (codeModifie) {
      changes.unshift({ field: 'code', label: 'Code colis', old: ancienCode, new: nouveauCode });
    }
    if (!changes.length) {
      return res.status(400).json({ message: 'Aucune modification détectée.' });
    }

    // Colis hors attente de ramassage : rien n'est modifié maintenant, les
    // nouvelles valeurs + le détail des changements sont enregistrés comme
    // demande à valider par l'admin (page /admin/modifications-colis).
    if (parcel.parcel_status !== 'WAITING_PICKUP') {
      if (await hasPendingModifDemande(parcel.parcel_id)) {
        return res.status(409).json({
          message: 'Une demande de modification est déjà en attente de validation pour ce colis.'
        });
      }
      try {
        await pool.query(
          `INSERT INTO delevery_parcel_modif_demande
             (pmd_parcel, pmd_customer, pmd_member, pmd_payload, pmd_changes, pmd_statut, pmd_time)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
          [
            parcel.parcel_id,
            customerId,
            memberOf(req),
            JSON.stringify(nouveau),
            JSON.stringify(changes),
            Math.floor(Date.now() / 1000)
          ]
        );
      } catch (err) {
        // Table pas encore migrée (sql/2026-08-24_modifications-colis.sql).
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return res.status(503).json({
            message: 'Les demandes de modification ne sont pas encore disponibles. Contactez l’administration.'
          });
        }
        throw err;
      }
      return res.status(201).json({ parcel_id: parcel.parcel_id, pending_validation: 1 });
    }

    // Changement de ville de destination → frais re-résolus (même cascade que
    // la création), sinon le colis garderait le tarif de l'ancienne ville.
    let fees = null;
    if (ancien.city !== city) {
      const [[customer]] = await pool.query(
        `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
                customers_pickup_city             AS pickup_city
           FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
        [customerId]
      );
      if (!customer) return res.status(404).json({ message: 'Compte introuvable.' });
      fees = await resolveClientFees(customerId, customer.custom_tarif, customer.pickup_city, city);
      if (!fees) {
        return res.status(400).json({ message: 'Aucun tarif trouvé pour cette ville de destination.' });
      }
    }

    // Changement de montant → frais supp automatiques réajustés (part de
    // l'ancien montant retirée, part du nouveau ajoutée, frais posés à la main
    // conservés — utils/fraisMontant), selon l'option du client.
    let extraFees = null;
    if (ancien.price !== price) {
      const optionFrais = await lireOptionFraisMontant(customerId);
      extraFees = ajusterFraisMontant(parcel.parcel_extra_fees, ancien.price, price, optionFrais.actif);
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Instantané legacy des anciennes valeurs (delevery_parcel_edit).
      await conn.query(
        `INSERT INTO delevery_parcel_edit
           (parcel_edit_code, parcel_edit_receiver, parcel_edit_phone, parcel_edit_district,
            parcel_edit_price, parcel_edit_address, parcel_edit_note, parcel_edit_customer,
            parcel_edit_time)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
        [
          parcel.parcel_code || '',
          ancien.receiver,
          ancien.phone,
          Math.round(ancien.price),
          ancien.address,
          ancien.note,
          customerId,
          now
        ]
      );

      // Trace détaillée pour le suivi admin (modif_customer = client,
      // modif_member = membre d'équipe le cas échéant).
      await conn.query(
        `INSERT INTO delevery_parcel_modification
           (modif_parcel, modif_user, modif_customer, modif_member, modif_time, modif_changes)
         VALUES (?, 0, ?, ?, ?, ?)`,
        [parcel.parcel_id, customerId, memberOf(req), now, JSON.stringify(changes)]
      );

      // Ligne d'historique legacy (affichée "Colis modifié" côté client) ;
      // parcel_history_by = 0 : action du client, comme à la création.
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_data, parcel_history_time,
            parcel_history_by, parcel_history_member)
         VALUES (?, 0, ?, '', 'EDITED', ?, 0, ?)`,
        [parcel.parcel_id, parcel.parcel_situation || '', now, memberOf(req)]
      );

      const [result] = await conn.query(
        `UPDATE delevery_parcel
            SET ${codeModifie ? 'parcel_code = ?, ' : ''}parcel_receiver = ?, parcel_phone = ?,
                parcel_city = ?, parcel_address = ?,
                parcel_note = ?, parcel_price = ?, parcel_product_name = ?,
                parcel_product_qty = ?, parcel_open = ?, parcel_essayage = ?,
                parcel_replace = ?${fees ? `, parcel_delivered_fees = ?,
                parcel_returned_fees = ?, parcel_refused_fees = ?` : ''}${
                  extraFees !== null ? ', parcel_extra_fees = ?' : ''
                },
                parcel_edited = 1, parcel_last_update = ?
          WHERE parcel_id = ? AND parcel_status = 'WAITING_PICKUP'`,
        [
          ...(codeModifie ? [nouveauCode] : []),
          receiver,
          phone,
          city,
          address,
          note,
          String(price),
          product,
          qty,
          open,
          essayage,
          replace,
          ...(fees ? [fees.livraison, fees.retour, fees.refuse] : []),
          ...(extraFees !== null ? [extraFees] : []),
          now,
          parcel.parcel_id
        ]
      );
      if (!result.affectedRows) {
        // Colis ramassé entre le chargement de la modale et l'enregistrement.
        await conn.rollback();
        return res.status(409).json({ message: 'Ce colis ne peut plus être modifié (déjà ramassé).' });
      }
      if (codeModifie) {
        await renommerCodeMouvementsStock(conn, parcel.parcel_id, ancienCode, nouveauCode);
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Étiquette obsolète recalculée pour mise à jour immédiate du badge.
    const lastPrint = await getLastPrintPrice(parcel.parcel_id);
    const crbt = effectiveCrbt({ parcel_price: String(price), parcel_crbt_zero: parcel.parcel_crbt_zero });
    const labelStale = lastPrint !== null && Number(lastPrint) !== Number(crbt) ? 1 : 0;

    // Champs affichés dans la ligne de la datatable client.
    res.json({
      parcel_id: parcel.parcel_id,
      parcel_receiver: receiver,
      parcel_phone: phone,
      parcel_price: String(price),
      parcel_replace: replace,
      ville: destVille.nom_ville,
      label_stale: labelStale,
      // Code (éventuellement nouveau) + indicateur pour la modale de
      // confirmation « Vous avez modifié le code colis ».
      parcel_code: nouveauCode,
      code_modifie: codeModifie ? 1 : 0
    });
  } catch (err) {
    next(err);
  }
}

const MAX_IMPORT_ROWS = 500;

/**
 * GET /api/parcels/import/data — données de la page admin "Import Colis" :
 * magasins (clients avec un nom de boutique) + villes de destination actives
 * (delevery_tarifs.statut = 1, mêmes règles que le formulaire "Nouveau colis").
 */
async function getImportData(req, res, next) {
  try {
    // Magasins avec leur option « frais selon le montant » (frais_montant :
    // 1 = frais supp automatiques au-delà de 2 500 DH ; colonne absente tant
    // que sql/2026-09-28_frais-montant-colis.sql n'est pas passée → 1).
    let magasins;
    try {
      [magasins] = await pool.query(
        `SELECT customers_id AS id, customers_store AS label,
                IFNULL(customers_frais_montant, 1) AS frais_montant
           FROM delevery_customers
          WHERE COALESCE(customers_store, '') <> ''
          ORDER BY customers_store`
      );
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      [magasins] = await pool.query(
        `SELECT customers_id AS id, customers_store AS label, 1 AS frais_montant
           FROM delevery_customers
          WHERE COALESCE(customers_store, '') <> ''
          ORDER BY customers_store`
      );
    }
    const [cities] = await pool.query(
      `SELECT ville_id AS id, nom_ville AS label
         FROM delevery_tarifs
        WHERE statut = 1
        ORDER BY nom_ville`
    );
    // frais_montant : règle (seuil / montant par tranche) ; l'état actif est
    // celui du magasin choisi (magasins[].frais_montant).
    res.json({ magasins, cities, frais_montant: infoFraisMontant(1) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/import — création en masse de colis normaux importés depuis
 * un fichier Excel (dashboard admin, au nom d'un client).
 * Body : { customer, parcels: [{ code?, receiver, phone, city, address, price,
 * note?, product?, qty?, replace: 0|1, open: 0|1, essayage: 0|1 }] }.
 * Tout-ou-rien : chaque ligne est validée (mêmes règles que la création d'un
 * colis client) puis toutes sont insérées dans une même transaction, avec les
 * mêmes conventions legacy que createClientParcel (situation NOT_PAID, statut
 * WAITING_PICKUP, frais résolus par resolveClientFees, codes générés, ligne
 * d'historique de création).
 */
async function importParcels(req, res, next) {
  const customerId = parseInt(req.body?.customer, 10);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ message: 'Veuillez sélectionner un client (magasin).' });
  }
  return doImportParcels(customerId, req.body?.parcels, res, next, 0, Number(req.user.id) || 0);
}

/**
 * POST /api/parcels/client/import — même import de colis normaux, déclenché
 * depuis le dashboard client : les colis sont créés pour le client connecté.
 */
async function importClientParcels(req, res, next) {
  return doImportParcels(Number(req.user.id), req.body?.parcels, res, next, memberOf(req));
}

/**
 * Cœur de l'import de colis normaux (dashboards admin et client).
 * memberId : membre de l'équipe client ; userId : users_id de l'admin
 * importateur (parcel_history_by de la ligne de création, 0 côté client).
 */
async function doImportParcels(customerId, rawParcels, res, next, memberId = 0, userId = 0) {
  try {
    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
              customers_pickup_city             AS pickup_city
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ message: 'Client introuvable.' });

    const raw = Array.isArray(rawParcels) ? rawParcels : [];
    if (!raw.length) return res.status(400).json({ message: 'Aucun colis à importer.' });
    if (raw.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ message: `Import limité à ${MAX_IMPORT_ROWS} colis à la fois.` });
    }

    const [villes] = await pool.query(`SELECT ville_id FROM delevery_tarifs WHERE statut = 1`);
    const villesActives = new Set(villes.map((v) => Number(v.ville_id)));

    const rows = [];
    const codes = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const ligne = `Ligne ${i + 1}`;
      const item = raw[i] || {};
      const code = String(item.code || '').trim().slice(0, 100);
      const receiver = String(item.receiver || '').trim().slice(0, 250);
      const phone = String(item.phone || '').trim().slice(0, 50);
      const city = parseInt(item.city, 10);
      const address = String(item.address || '').trim().slice(0, 2000);
      const note = String(item.note || '').trim().slice(0, 2000);
      const product = String(item.product || '').trim().slice(0, 250);
      const replace = Number(item.replace) === 1 ? 1 : 0;
      const open = Number(item.open) === 1 ? 1 : 0;
      // Ouverture interdite (open = 0) → essayage forcément interdit aussi.
      const essayage = open === 0 ? 0 : Number(item.essayage) === 1 ? 1 : 0;

      if (!receiver) {
        return res.status(400).json({ message: `${ligne} : le nom du destinataire est obligatoire.` });
      }
      if (!phone) {
        return res.status(400).json({ message: `${ligne} : le téléphone du destinataire est obligatoire.` });
      }
      if (!isValidPhone(phone)) {
        return res.status(400).json({ message: `${ligne} : numéro de téléphone invalide (10 chiffres commençant par 0).` });
      }
      if (!Number.isInteger(city) || !villesActives.has(city)) {
        return res.status(400).json({ message: `${ligne} : ville de destination introuvable.` });
      }
      if (!address) {
        return res.status(400).json({ message: `${ligne} : l'adresse est obligatoire.` });
      }
      const price = Number(item.price);
      if (!Number.isFinite(price) || price < 0 || price > 99999999) {
        return res.status(400).json({ message: `${ligne} : montant CRBT invalide.` });
      }
      let qty = 1;
      if (item.qty !== undefined && String(item.qty).trim() !== '') {
        qty = parseInt(item.qty, 10);
        if (!Number.isInteger(qty) || qty <= 0 || qty > 9999) {
          return res.status(400).json({ message: `${ligne} : quantité invalide.` });
        }
      }
      if (code) {
        if (codes.has(code)) {
          return res.status(400).json({ message: `${ligne} : code colis « ${code} » en double dans le fichier.` });
        }
        codes.add(code);
      }
      rows.push({ code, receiver, phone, city, address, note, product, qty, price, replace, open, essayage });
    }

    if (codes.size) {
      const [dups] = await pool.query(
        `SELECT parcel_code FROM delevery_parcel WHERE parcel_code IN (?)`,
        [[...codes]]
      );
      if (dups.length) {
        return res.status(409).json({
          message: `Code(s) colis déjà utilisé(s) : ${dups.map((d) => d.parcel_code).join(', ')}.`
        });
      }
    }

    // Frais résolus une seule fois par ville de destination (même cascade que le legacy).
    const feesByCity = new Map();
    for (let i = 0; i < rows.length; i += 1) {
      const { city } = rows[i];
      if (!feesByCity.has(city)) {
        feesByCity.set(
          city,
          await resolveClientFees(customerId, customer.custom_tarif, customer.pickup_city, city)
        );
      }
      if (!feesByCity.get(city)) {
        return res.status(400).json({
          message: `Ligne ${i + 1} : aucun tarif trouvé pour cette ville de destination.`
        });
      }
    }

    // Agence du colis dérivée de la ville de ramassage du client (ville → zone → agence).
    const agenceId = await agenceIdFromVille(Number(customer.pickup_city) || 0);
    // Frais supp automatiques selon le montant (option du client, lue une fois).
    const optionFrais = await lireOptionFraisMontant(customerId);
    let nbFraisMontant = 0;

    const now = Math.floor(Date.now() / 1000);
    const d = new Date(now * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const created = [];
      for (const row of rows) {
        const fees = feesByCity.get(row.city);
        const extraFees = optionFrais.actif ? fraisMontant(row.price) : 0;
        if (extraFees > 0) nbFraisMontant += 1;
        const [result] = await conn.query(
          `INSERT INTO delevery_parcel
             (parcel_code, parcel_receiver, parcel_phone, parcel_city, parcel_address,
              parcel_price, parcel_note, parcel_situation, parcel_status,
              parcel_delivered_fees, parcel_extra_fees, parcel_returned_fees, parcel_refused_fees,
              parcel_customer, parcel_member, parcel_replace, parcel_open, parcel_essayage,
              parcel_from_stock, parcel_product_name, parcel_product_qty,
              parcel_ramassage_city, parcel_agence, parcel_time, parcel_last_update)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'NOT_PAID', 'WAITING_PICKUP',
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?)`,
          [
            row.code || '',
            row.receiver,
            row.phone,
            row.city,
            row.address,
            String(row.price),
            row.note,
            fees.livraison,
            extraFees,
            fees.retour,
            fees.refuse,
            customerId,
            memberId,
            row.replace,
            row.open,
            row.essayage,
            row.product,
            row.qty,
            Number(customer.pickup_city) || 0,
            agenceId ? String(agenceId) : '',
            now,
            now
          ]
        );
        const parcelId = result.insertId;

        // Codes au format legacy : "OSM0926100001AB" et "X07-30-266195".
        const parcelCode = row.code || `${randLetters(3)}${mm}${yy}${parcelId}${randLetters(2)}`;
        const codeInterne = `${randLetters(1)}${mm}-${dd}-${parcelId}`;
        await conn.query(
          `UPDATE delevery_parcel SET parcel_code = ?, parcel_code_interne = ? WHERE parcel_id = ?`,
          [parcelCode, codeInterne, parcelId]
        );

        await conn.query(
          `INSERT INTO delevery_parcel_history
             (parcel_history_parcel, parcel_history_city, parcel_history_situation,
              parcel_history_status, parcel_history_time, parcel_history_by, parcel_history_member)
           VALUES (?, 0, 'NOT_PAID', 'WAITING_PICKUP', ?, ?, ?)`,
          [parcelId, now, userId, memberId]
        );

        created.push({ parcel_id: parcelId, parcel_code: parcelCode });
      }
      await conn.commit();
      // Demande de ramassage automatique : une seule par lot (hors transaction).
      if (created.length) await createAutoDemandeRamassage(customerId, memberId);
      // extra_fees_count : colis ayant reçu des frais supp automatiques (champ additif).
      res.status(201).json({ count: created.length, parcels: created, extra_fees_count: nbFraisMontant });
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
 * GET /api/parcels/import/stock/products?customer=ID — produits actifs du client
 * choisi sur la page admin "Import Colis de stock" : id, réf, nom et stock
 * disponible, pour valider côté navigateur les réfs saisies dans le fichier.
 */
async function getImportStockProducts(req, res, next) {
  try {
    const customerId = parseInt(req.query.customer, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ message: 'Client invalide.' });
    }
    const [rows] = await pool.query(
      `SELECT product_id AS id, product_ref AS ref, product_name AS nom,
              IFNULL(product_qte, 0) AS stock
         FROM delevery_product
        WHERE product_customer = ? AND product_statut = 1
        ORDER BY product_name`,
      [customerId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/import/stock — création en masse de colis de stock importés
 * depuis un fichier Excel (dashboard admin, au nom d'un client).
 * Body : { customer, parcels: [{ code?, receiver, phone, city, address, price,
 * note?, productId, qty?, replace: 0|1, open: 0|1, essayage: 0|1 }] } —
 * `productId` est un produit actif du client (choisi par sa réf dans la liste
 * déroulante de la page, vérifié ici) ; `qty` la quantité de ce produit dans
 * le colis (défaut 1).
 * Tout-ou-rien : mêmes validations et conventions legacy que importParcels
 * (parcel_from_stock = 1), et pour chaque colis — comme createClientParcel —
 * le stock est vérifié puis déduit (ligne produit verrouillée FOR UPDATE, donc
 * cumul des quantités du fichier contrôlé), un mouvement « colis envoyé » est
 * tracé (mvnt_note = code du colis) et le contenu du colis est enregistré dans
 * delevery_parcel_content (une ligne par unité).
 * Contrairement à importParcels, aucune demande de ramassage automatique : la
 * marchandise d'un colis de stock est déjà en agence.
 */
async function importStockParcels(req, res, next) {
  const customerId = parseInt(req.body?.customer, 10);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ message: 'Veuillez sélectionner un client (magasin).' });
  }
  return doImportStockParcels(customerId, req.body?.parcels, res, next, 0, Number(req.user.id) || 0);
}

/**
 * POST /api/parcels/client/import/stock — même import de colis de stock,
 * déclenché depuis le dashboard client : les colis sont créés pour le client
 * connecté et les produits référencés doivent lui appartenir.
 */
async function importClientStockParcels(req, res, next) {
  return doImportStockParcels(Number(req.user.id), req.body?.parcels, res, next, memberOf(req));
}

/**
 * Cœur de l'import de colis de stock (dashboards admin et client).
 * memberId : membre de l'équipe client ; userId : users_id de l'admin
 * importateur (parcel_history_by de la ligne de création, 0 côté client).
 */
async function doImportStockParcels(customerId, rawParcels, res, next, memberId = 0, userId = 0) {
  try {
    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
              customers_pickup_city             AS pickup_city
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    if (!customer) return res.status(404).json({ message: 'Client introuvable.' });

    const raw = Array.isArray(rawParcels) ? rawParcels : [];
    if (!raw.length) return res.status(400).json({ message: 'Aucun colis à importer.' });
    if (raw.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ message: `Import limité à ${MAX_IMPORT_ROWS} colis à la fois.` });
    }

    const [villes] = await pool.query(`SELECT ville_id FROM delevery_tarifs WHERE statut = 1`);
    const villesActives = new Set(villes.map((v) => Number(v.ville_id)));

    // Produits actifs du client : chaque colis doit référencer l'un d'eux.
    const [prods] = await pool.query(
      `SELECT product_id FROM delevery_product
        WHERE product_customer = ? AND product_statut = 1`,
      [customerId]
    );
    const produitsActifs = new Set(prods.map((p) => Number(p.product_id)));

    const rows = [];
    const codes = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      const ligne = `Ligne ${i + 1}`;
      const item = raw[i] || {};
      const code = String(item.code || '').trim().slice(0, 100);
      const receiver = String(item.receiver || '').trim().slice(0, 250);
      const phone = String(item.phone || '').trim().slice(0, 50);
      const city = parseInt(item.city, 10);
      const address = String(item.address || '').trim().slice(0, 2000);
      const note = String(item.note || '').trim().slice(0, 2000);
      const productId = parseInt(item.productId, 10);
      const replace = Number(item.replace) === 1 ? 1 : 0;
      const open = Number(item.open) === 1 ? 1 : 0;
      // Ouverture interdite (open = 0) → essayage forcément interdit aussi.
      const essayage = open === 0 ? 0 : Number(item.essayage) === 1 ? 1 : 0;

      if (!receiver) {
        return res.status(400).json({ message: `${ligne} : le nom du destinataire est obligatoire.` });
      }
      if (!phone) {
        return res.status(400).json({ message: `${ligne} : le téléphone du destinataire est obligatoire.` });
      }
      if (!isValidPhone(phone)) {
        return res.status(400).json({ message: `${ligne} : numéro de téléphone invalide (10 chiffres commençant par 0).` });
      }
      if (!Number.isInteger(city) || !villesActives.has(city)) {
        return res.status(400).json({ message: `${ligne} : ville de destination introuvable.` });
      }
      if (!address) {
        return res.status(400).json({ message: `${ligne} : l'adresse est obligatoire.` });
      }
      const price = Number(item.price);
      if (!Number.isFinite(price) || price < 0 || price > 99999999) {
        return res.status(400).json({ message: `${ligne} : montant CRBT invalide.` });
      }
      let qty = 1;
      if (item.qty !== undefined && String(item.qty).trim() !== '') {
        qty = parseInt(item.qty, 10);
        if (!Number.isInteger(qty) || qty <= 0 || qty > 9999) {
          return res.status(400).json({ message: `${ligne} : quantité invalide.` });
        }
      }
      if (!Number.isInteger(productId) || !produitsActifs.has(productId)) {
        return res.status(400).json({
          message: `${ligne} : réf produit introuvable chez ce client.`
        });
      }
      if (code) {
        if (codes.has(code)) {
          return res.status(400).json({ message: `${ligne} : code colis « ${code} » en double dans le fichier.` });
        }
        codes.add(code);
      }
      rows.push({ code, receiver, phone, city, address, note, productId, qty, price, replace, open, essayage });
    }

    if (codes.size) {
      const [dups] = await pool.query(
        `SELECT parcel_code FROM delevery_parcel WHERE parcel_code IN (?)`,
        [[...codes]]
      );
      if (dups.length) {
        return res.status(409).json({
          message: `Code(s) colis déjà utilisé(s) : ${dups.map((d) => d.parcel_code).join(', ')}.`
        });
      }
    }

    // Frais résolus une seule fois par ville de destination (même cascade que le legacy).
    const feesByCity = new Map();
    for (let i = 0; i < rows.length; i += 1) {
      const { city } = rows[i];
      if (!feesByCity.has(city)) {
        feesByCity.set(
          city,
          await resolveClientFees(customerId, customer.custom_tarif, customer.pickup_city, city)
        );
      }
      if (!feesByCity.get(city)) {
        return res.status(400).json({
          message: `Ligne ${i + 1} : aucun tarif trouvé pour cette ville de destination.`
        });
      }
    }

    // Agence du colis dérivée de la ville de ramassage du client (ville → zone → agence).
    const agenceId = await agenceIdFromVille(Number(customer.pickup_city) || 0);
    // Frais supp automatiques selon le montant (option du client, lue une fois).
    const optionFrais = await lireOptionFraisMontant(customerId);
    let nbFraisMontant = 0;

    const now = Math.floor(Date.now() / 1000);
    const d = new Date(now * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const created = [];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const fees = feesByCity.get(row.city);
        const extraFees = optionFrais.actif ? fraisMontant(row.price) : 0;
        if (extraFees > 0) nbFraisMontant += 1;
        const [result] = await conn.query(
          `INSERT INTO delevery_parcel
             (parcel_code, parcel_receiver, parcel_phone, parcel_city, parcel_address,
              parcel_price, parcel_note, parcel_situation, parcel_status,
              parcel_delivered_fees, parcel_extra_fees, parcel_returned_fees, parcel_refused_fees,
              parcel_customer, parcel_member, parcel_replace, parcel_open, parcel_essayage,
              parcel_from_stock, parcel_product_name, parcel_product_qty,
              parcel_ramassage_city, parcel_agence, parcel_time, parcel_last_update)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'NOT_PAID', 'WAITING_PICKUP',
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', '', 1, ?, ?, ?, ?)`,
          [
            row.code || '',
            row.receiver,
            row.phone,
            row.city,
            row.address,
            String(row.price),
            row.note,
            fees.livraison,
            extraFees,
            fees.retour,
            fees.refuse,
            customerId,
            memberId,
            row.replace,
            row.open,
            row.essayage,
            Number(customer.pickup_city) || 0,
            agenceId ? String(agenceId) : '',
            now,
            now
          ]
        );
        const parcelId = result.insertId;

        // Codes au format legacy : "OSM0926100001AB" et "X07-30-266195".
        const parcelCode = row.code || `${randLetters(3)}${mm}${yy}${parcelId}${randLetters(2)}`;
        const codeInterne = `${randLetters(1)}${mm}-${dd}-${parcelId}`;
        await conn.query(
          `UPDATE delevery_parcel SET parcel_code = ?, parcel_code_interne = ? WHERE parcel_id = ?`,
          [parcelCode, codeInterne, parcelId]
        );

        await conn.query(
          `INSERT INTO delevery_parcel_history
             (parcel_history_parcel, parcel_history_city, parcel_history_situation,
              parcel_history_status, parcel_history_time, parcel_history_by, parcel_history_member)
           VALUES (?, 0, 'NOT_PAID', 'WAITING_PICKUP', ?, ?, ?)`,
          [parcelId, now, userId, memberId]
        );

        // Ligne produit verrouillée : les déductions des lignes précédentes de la
        // transaction sont visibles, le contrôle du stock cumule donc tout le fichier.
        const [[produit]] = await conn.query(
          `SELECT product_name, product_ref, product_pic, product_rayonnage, product_qte
             FROM delevery_product
            WHERE product_id = ? AND product_customer = ? AND product_statut = 1
            LIMIT 1 FOR UPDATE`,
          [row.productId, customerId]
        );
        if (!produit) {
          await conn.rollback();
          return res.status(400).json({ message: `Ligne ${i + 1} : produit de stock introuvable.` });
        }
        const stockDisponible = Number(produit.product_qte) || 0;
        if (row.qty > stockDisponible) {
          await conn.rollback();
          return res.status(400).json({
            message: `Ligne ${i + 1} : stock insuffisant pour « ${produit.product_name} » : ${stockDisponible} disponible(s), impossible d'en envoyer ${row.qty}.`
          });
        }

        await conn.query(
          'UPDATE delevery_product SET product_qte = product_qte - ? WHERE product_id = ?',
          [row.qty, row.productId]
        );
        await conn.query(
          `INSERT INTO delevery_product_mvnt
             (id_product, mvnt_qte, mvnt_type, mvnt_date, mvnt_by, mvnt_member, mvnt_commentaire, mvnt_validate_by, mvnt_note)
           VALUES (?, ?, 'colis envoyé', NOW(), ?, ?, NULL, NULL, ?)`,
          [row.productId, -row.qty, customerId, memberId || null, parcelCode]
        );

        const contentRows = Array.from({ length: row.qty }, () => [
          customerId,
          parcelId,
          row.productId,
          produit.product_ref || '',
          produit.product_name || '',
          '',
          produit.product_pic || '',
          String(now),
          String(produit.product_rayonnage || '').slice(0, 100)
        ]);
        await conn.query(
          `INSERT INTO delevery_parcel_content
             (parcel_content_customer_id, parcel_content_parcel_id, parcel_content_product_id,
              parcel_content_variant_ref, parcel_content_product_name, parcel_content_variant_name,
              parcel_content_product_pic, parcel_content_time, parcel_content_remarque)
           VALUES ?`,
          [contentRows]
        );

        created.push({ parcel_id: parcelId, parcel_code: parcelCode });
      }
      await conn.commit();
      // Pas de demande de ramassage automatique : colis de stock (marchandise
      // déjà en agence), contrairement à doImportParcels.
      // extra_fees_count : colis ayant reçu des frais supp automatiques (champ additif).
      res.status(201).json({ count: created.length, parcels: created, extra_fees_count: nbFraisMontant });
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

/** Charge un colis appartenant au client connecté ; renvoie null s'il n'existe pas. */
async function loadClientParcel(req, columns) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[parcel]] = await pool.query(
    `SELECT ${columns} FROM delevery_parcel p
      LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
     WHERE p.parcel_id = ? AND p.parcel_customer = ? LIMIT 1`,
    [id, Number(req.user.id)]
  );
  return parcel || null;
}

/**
 * Code statut affiché d'une étape d'historique : la ligne de facturation
 * client (situation INVOICED avec statut DELIVERED / REFUSE répété, sans
 * statut second) s'affiche « Facturé », comme le statut effectif du tableau
 * colis ; sinon statut second si renseigné, sinon statut.
 */
const HISTORY_STATUT_SQL = `CASE
    WHEN h.parcel_history_situation = 'INVOICED'
         AND h.parcel_history_status IN ('DELIVERED', 'REFUSE')
         AND COALESCE(h.parcel_history_status_second, '') = ''
      THEN 'INVOICED'
    WHEN COALESCE(h.parcel_history_status_second, '') <> '' THEN h.parcel_history_status_second
    ELSE COALESCE(h.parcel_history_status, '') END`;

/**
 * GET /api/parcels/client/:id/suivi — historique des changements de statut du colis
 * (delevery_parcel_history, du plus ancien au plus récent) pour la modale "Détail de suivi".
 * Le livreur affecté (parcel_livreur) est renvoyé en pied de modale avec son
 * users_phone ; pour un livreur salarié (delevery_users.users_is_salarie = 1), le
 * téléphone est celui de son compte de fonction LIVREUR (users_type = 5, comptes
 * reliés par users_parent_id), à défaut celui du compte référencé.
 */
async function getClientParcelSuivi(req, res, next) {
  try {
    const parcel = await loadClientParcel(req, `p.parcel_id, p.parcel_code, p.parcel_livreur`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    let livreur = null;
    if (Number(parcel.parcel_livreur) > 0) {
      const [[row]] = await pool.query(
        `SELECT u.users_name AS name,
                CASE WHEN IFNULL(u.users_is_salarie, 0) = 1 THEN
                  COALESCE(
                    (SELECT u2.users_phone FROM delevery_users u2
                      WHERE (u2.users_id = COALESCE(u.users_parent_id, u.users_id)
                             OR u2.users_parent_id = COALESCE(u.users_parent_id, u.users_id))
                        AND u2.users_type = 5 AND COALESCE(u2.users_phone, '') <> ''
                      LIMIT 1),
                    u.users_phone)
                ELSE u.users_phone END AS phone
           FROM delevery_users u
          WHERE u.users_id = ? LIMIT 1`,
        [Number(parcel.parcel_livreur)]
      );
      if (row?.name) livreur = { name: row.name, phone: row.phone || null };
    }

    // preuve : photo jointe par le livreur / l'admin au changement de statut
    // (NULL sans la migration sql/2026-09-02_preuve-statut.sql), lien
    // « Voir la preuve » en face du statut.
    const preuveSql = await historyPreuveSql();

    // parcel_history_member > 0 : action faite par un membre de l'équipe du
    // client (son nom est affiché sur l'étape). Fallback si la migration
    // sql/2026-08-23_equipe-client-colonnes-attribution.sql n'est pas passée.
    let entries;
    try {
      [entries] = await pool.query(
        `SELECT h.parcel_history_id AS id,
              ${HISTORY_STATUT_SQL} AS status,
              h.parcel_history_situation AS situation,
              h.parcel_history_data AS data,
              h.parcel_history_comment AS comment,
              h.parcel_history_time AS time,
              ${preuveSql} AS preuve,
              sc.color AS status_color,
              mb.member_name AS member
         FROM delevery_parcel_history h
         LEFT JOIN delevery_customer_members mb
           ON mb.member_id = h.parcel_history_member AND h.parcel_history_member > 0
         LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                      FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
           ON sc.parcel_statut_code = ${HISTORY_STATUT_SQL}
        WHERE h.parcel_history_parcel = ?
        ORDER BY h.parcel_history_time ASC, h.parcel_history_id ASC`,
        [parcel.parcel_id]
      );
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
      [entries] = await pool.query(
        `SELECT h.parcel_history_id AS id,
              ${HISTORY_STATUT_SQL} AS status,
              h.parcel_history_situation AS situation,
              h.parcel_history_data AS data,
              h.parcel_history_comment AS comment,
              h.parcel_history_time AS time,
              ${preuveSql} AS preuve,
              sc.color AS status_color
         FROM delevery_parcel_history h
         LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                      FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
           ON sc.parcel_statut_code = ${HISTORY_STATUT_SQL}
        WHERE h.parcel_history_parcel = ?
        ORDER BY h.parcel_history_time ASC, h.parcel_history_id ASC`,
        [parcel.parcel_id]
      );
    }

    // Les lignes "colis modifié" (sans statut, data EDITED…) ne sont pas
    // affichées dans le suivi client — seuls les changements de statut le sont.
    const EDIT_DATA_MARKERS = ['EDITED', 'PARCEL_EDITED', 'UPDATED', 'MODIFIED'];
    const visibles = entries.filter(
      (e) => e.status || !EDIT_DATA_MARKERS.includes(String(e.data || '').trim())
    );

    res.json({ code: parcel.parcel_code, livreur, entries: visibles });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/client/:id/details — modale "Information colis" :
 * destinataire, téléphone, ville, adresse, prix, commentaire, marchandise.
 * Pour un colis de stock (parcel_from_stock = 1), la marchandise est la liste
 * des produits de delevery_parcel_content (une ligne par unité → quantités groupées).
 */
async function getClientParcelDetails(req, res, next) {
  try {
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone, p.parcel_address,
       p.parcel_price, p.parcel_note, p.parcel_product_name, p.parcel_product_qty,
       p.parcel_from_stock, p.parcel_crbt_zero, t.nom_ville AS ville`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    let produits = [];
    if (Number(parcel.parcel_from_stock) === 1) {
      const [rows] = await pool.query(
        `SELECT parcel_content_product_name AS produit,
                COALESCE(NULLIF(parcel_content_variant_name, ''), '') AS variante,
                COUNT(*) AS qty
           FROM delevery_parcel_content
          WHERE parcel_content_parcel_id = ?
          GROUP BY parcel_content_product_name, COALESCE(NULLIF(parcel_content_variant_name, ''), '')
          ORDER BY parcel_content_product_name`,
        [parcel.parcel_id]
      );
      produits = rows;
    }

    res.json({
      parcel_code: parcel.parcel_code,
      parcel_receiver: parcel.parcel_receiver,
      parcel_phone: parcel.parcel_phone,
      ville: parcel.ville,
      parcel_address: parcel.parcel_address,
      parcel_price: parcel.parcel_price,
      crbt: Number(parcel.parcel_crbt_zero) === 1 ? 0 : Number(parcel.parcel_price) || 0,
      parcel_note: parcel.parcel_note,
      parcel_from_stock: Number(parcel.parcel_from_stock) === 1 ? 1 : 0,
      parcel_product_name: parcel.parcel_product_name,
      parcel_product_qty: parcel.parcel_product_qty,
      produits
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/client/:id/remboursement — body { montant, recuperer: 0|1, commentaire? }.
 * Conditions : colis livré (DELIVERED), qui n'est pas lui-même un colis de
 * remboursement (parcel_is_remb = 0) et sans demande en attente ou acceptée
 * (utils/remboursement : un refus permet une nouvelle demande). Enregistre la
 * demande dans delevery_remboursement (statut PENDING, traitée sur la page
 * Remboursements admin) ; le colis original n'est pas marqué.
 */
async function createClientRemboursement(req, res, next) {
  try {
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_is_remb,
       p.parcel_price, p.parcel_crbt_zero`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status !== 'DELIVERED' || Number(parcel.parcel_is_remb) === 1) {
      return res.status(400).json({ message: 'Ce colis ne peut pas faire l’objet d’un remboursement.' });
    }
    if (await hasDemandeEnCours(parcel.parcel_id)) {
      return res.status(400).json({ message: 'Une demande de remboursement est déjà en cours pour ce colis.' });
    }

    const montantReel = Number(parcel.parcel_crbt_zero) === 1 ? 0 : Number(parcel.parcel_price) || 0;
    const montant = Number(req.body?.montant);
    const recuperer = Number(req.body?.recuperer) === 1 ? 1 : 0;
    const commentaire = String(req.body?.commentaire || '').trim().slice(0, 2000);
    if (!Number.isFinite(montant) || montant <= 0 || montant > montantReel) {
      return res.status(400).json({
        message: `Montant à rembourser invalide (entre 0 et ${montantReel} DH).`
      });
    }

    const [remb] = await pool.query(
      `INSERT INTO delevery_remboursement
         (remb_parcel_id, remb_parcel_code, remb_customer, remb_member, remb_montant_reel,
          remb_montant, remb_recuperer_colis, remb_commentaire, remb_statut, remb_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        parcel.parcel_id,
        parcel.parcel_code || '',
        Number(req.user.id),
        memberOf(req),
        montantReel,
        montant,
        recuperer,
        commentaire,
        Math.floor(Date.now() / 1000)
      ]
    );

    res.status(201).json({ parcel_id: parcel.parcel_id, remb_demande: 1 });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/client/:id/reclamation — body { titre, texte }.
 * Enregistre la réclamation dans delevery_reclamation_suivre (statut EN_COURS,
 * affichée sur la page Réclamations du dashboard admin).
 * reclamation_user = 0 : marqueur « créée par le client » — cette colonne ne
 * contient que des ids d'employés (legacy et page Réclamations) ; le client se
 * retrouve via le colis (parcel_customer) et le membre via reclamation_member.
 */
async function createClientReclamation(req, res, next) {
  try {
    const parcel = await loadClientParcel(req, `p.parcel_id, p.parcel_status`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status === 'WAITING_PICKUP') {
      return res.status(400).json({ message: 'Ce colis ne peut pas faire l’objet d’une réclamation.' });
    }

    const titre = String(req.body?.titre || '').trim().slice(0, 255);
    const texte = String(req.body?.texte || '').trim().slice(0, 5000);
    if (!titre || !texte) {
      return res.status(400).json({ message: 'Titre et texte de la réclamation sont obligatoires.' });
    }

    const [recl] = await pool.query(
      `INSERT INTO delevery_reclamation_suivre
         (reclamation_parcel, reclamation_titre, reclamation_text, reclamation_statut,
          reclamation_user, reclamation_member, reclamation_time)
       VALUES (?, ?, ?, 'EN_COURS', 0, ?, ?)`,
      [parcel.parcel_id, titre, texte, memberOf(req), Math.floor(Date.now() / 1000)]
    );

    res.status(201).json({ parcel_id: parcel.parcel_id });
  } catch (err) {
    next(err);
  }
}

/*
 * Blocage d'expédition : statuts pour lesquels le client peut bloquer (ou
 * débloquer) le ramassage et l'expédition de son colis. Au-delà (expédié,
 * reçu…), le colis est déjà dans le circuit : trop tard.
 */
const BLOCKABLE_STATUSES = ['WAITING_PICKUP', 'PICKED_UP'];

/**
 * POST /api/parcels/client/:id/blocage — body { bloquer: 1 | 0 }.
 * Bouton « Bloquer l'expédition » du tableau des colis client : tant que le
 * colis est bloqué (parcel_client_block = 1), il est refusé au scan ramassage
 * admin et au scan / à l'ajout d'un bon d'envoi ou de sortie avec le message
 * « Bloqué par le client, à ne pas envoyer ». Ligne d'historique CLIENT_BLOCK /
 * CLIENT_UNBLOCK visible dans le détail de suivi (client et admin).
 */
async function setClientParcelBlock(req, res, next) {
  try {
    const bloquer = Number(req.body?.bloquer) === 0 ? 0 : 1;
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_situation`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (!BLOCKABLE_STATUSES.includes(parcel.parcel_status)) {
      return res.status(409).json({
        message: bloquer
          ? 'Ce colis ne peut plus être bloqué (déjà expédié ou traité).'
          : 'Ce colis ne peut plus être débloqué (déjà expédié ou traité).'
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let result;
      try {
        // Statut re-vérifié dans l'UPDATE : colis ramassé/expédié entre le
        // chargement de la page et la confirmation → aucun blocage posé.
        [result] = await conn.query(
          `UPDATE delevery_parcel
              SET parcel_client_block = ?, parcel_last_update = ?
            WHERE parcel_id = ? AND parcel_status IN (?)`,
          [bloquer, now, parcel.parcel_id, BLOCKABLE_STATUSES]
        );
      } catch (err) {
        // Colonne absente : migration sql/2026-08-26_blocage-expedition-client.sql.
        if (err.code === 'ER_BAD_FIELD_ERROR') {
          await conn.rollback();
          return res.status(503).json({
            message: 'Fonction indisponible pour le moment. Veuillez réessayer plus tard.'
          });
        }
        throw err;
      }
      if (!result.affectedRows) {
        await conn.rollback();
        return res.status(409).json({
          message: 'Le statut du colis a changé entre-temps : action impossible.'
        });
      }
      // Trace dans le suivi ; parcel_history_by = 0 : action du client,
      // parcel_history_member : membre de l'équipe le cas échéant.
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_data, parcel_history_time,
            parcel_history_by, parcel_history_member)
         VALUES (?, 0, ?, '', ?, ?, 0, ?)`,
        [
          parcel.parcel_id,
          parcel.parcel_situation || '',
          bloquer ? 'CLIENT_BLOCK' : 'CLIENT_UNBLOCK',
          now,
          memberOf(req)
        ]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ parcel_id: parcel.parcel_id, parcel_client_block: bloquer });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/parcels/client/:id — suppression par le client d'un colis encore
 * en attente de ramassage (WAITING_PICKUP), après confirmation dans le
 * tableau des colis client. Même traitement que la suppression admin
 * (DELETE /api/parcels/:id) : pour un colis de stock, le stock des produits
 * est restauré (mouvement « colis supprimé » tracé au nom du client / membre)
 * et le contenu supprimé ; historique et traces de modification partent avec
 * le colis. Le statut est re-vérifié sous verrou dans la transaction : colis
 * ramassé entre le chargement de la page et la confirmation → rien n'est
 * supprimé.
 */
async function deleteClientParcel(req, res, next) {
  try {
    const parcel = await loadClientParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_from_stock`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status !== 'WAITING_PICKUP') {
      return res.status(409).json({
        message: 'Seul un colis en attente de ramassage peut être supprimé.'
      });
    }

    const customerId = Number(req.user.id);
    const memberId = memberOf(req);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Verrou + re-vérification du statut : un colis ramassé entre-temps
      // n'est pas supprimé (et son stock n'est pas restauré).
      const [[current]] = await conn.query(
        `SELECT parcel_status FROM delevery_parcel WHERE parcel_id = ? FOR UPDATE`,
        [parcel.parcel_id]
      );
      if (!current || current.parcel_status !== 'WAITING_PICKUP') {
        await conn.rollback();
        return res.status(409).json({
          message: 'Le statut du colis a changé entre-temps : suppression impossible.'
        });
      }

      // Colis de stock : restaure les quantités déduites à la création
      // (une ligne de contenu par unité) et trace le mouvement.
      if (Number(parcel.parcel_from_stock) === 1) {
        const [contenus] = await conn.query(
          `SELECT parcel_content_product_id AS product_id, COUNT(*) AS qty
             FROM delevery_parcel_content
            WHERE parcel_content_parcel_id = ?
            GROUP BY parcel_content_product_id
            ORDER BY parcel_content_product_id`,
          [parcel.parcel_id]
        );
        for (const c of contenus) {
          if (!Number(c.product_id)) continue;
          await conn.query(
            `UPDATE delevery_product SET product_qte = product_qte + ? WHERE product_id = ?`,
            [Number(c.qty), Number(c.product_id)]
          );
          await conn.query(
            `INSERT INTO delevery_product_mvnt
               (id_product, mvnt_qte, mvnt_type, mvnt_date, mvnt_by, mvnt_member, mvnt_commentaire, mvnt_validate_by, mvnt_note)
             VALUES (?, ?, 'colis supprimé', NOW(), ?, ?, NULL, NULL, ?)`,
            [Number(c.product_id), Number(c.qty), customerId, memberId || null, parcel.parcel_code || '']
          );
        }
        await conn.query(
          `DELETE FROM delevery_parcel_content WHERE parcel_content_parcel_id = ?`,
          [parcel.parcel_id]
        );
      }

      await conn.query(`DELETE FROM delevery_parcel_history WHERE parcel_history_parcel = ?`, [
        parcel.parcel_id
      ]);
      await conn.query(`DELETE FROM delevery_parcel_modification WHERE modif_parcel = ?`, [
        parcel.parcel_id
      ]);
      await conn.query(`DELETE FROM delevery_parcel WHERE parcel_id = ?`, [parcel.parcel_id]);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ parcel_id: parcel.parcel_id, deleted: true });
  } catch (err) {
    next(err);
  }
}

/*
 * Page admin "Ramassage par scan" : chaque code scanné (douchette ou caméra)
 * passe le colis en PICKED_UP avec une ligne d'historique, comme le legacy.
 * Seuls les colis pas encore ramassés sont acceptés : tout autre cas
 * (introuvable, déjà ramassé, statut avancé) est refusé — son de refus.
 * Les colis de stock (parcel_from_stock = 1) sont toujours refusés : ils
 * passent en PICKED_UP via le bouton « Traiter » de leur bon de sortie.
 */
const SCANNABLE_STATUSES = ['NEW_PARCEL', 'WAITING_PICKUP'];

/** GET /api/parcels/ramassage/sons — sons de l'étape ramassage configurés (Options). */
async function getRamassageSons(req, res, next) {
  try {
    const urls = await getScanSonUrls();
    res.json({ success: urls.ramassage_success, error: urls.ramassage_error });
  } catch (err) {
    next(err);
  }
}

/** POST /api/parcels/ramassage/scan — body { code } (parcel_code ou code interne). */
async function scanRamassage(req, res, next) {
  try {
    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const [[parcel]] = await pool.query(
      `SELECT p.parcel_id        AS id,
              p.parcel_code      AS code,
              p.parcel_status    AS status,
              p.parcel_situation AS situation,
              p.parcel_receiver  AS receiver,
              p.parcel_price, p.parcel_crbt_zero, p.parcel_from_stock,
              t.nom_ville        AS ville,
              c.customers_store  AS magasin
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
        WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
        LIMIT 1`,
      [code, code]
    );
    if (!parcel) {
      return res.status(404).json({ message: `Colis « ${code} » introuvable.` });
    }

    // Types 3/4/6 : uniquement les colis de leur agence (mêmes règles que la liste).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      const [[visible]] = await pool.query(
        `SELECT 1 AS ok FROM delevery_parcel p WHERE p.parcel_id = ? AND ${scope.sql} LIMIT 1`,
        [parcel.id, ...scope.params]
      );
      if (!visible) {
        return res.status(403).json({ message: `Colis « ${parcel.code} » hors de votre agence.` });
      }
    }

    const info = {
      code: parcel.code,
      receiver: parcel.receiver,
      ville: parcel.ville,
      magasin: parcel.magasin,
      status: parcel.status
    };
    // Colis de stock : jamais ramassé par scan — il passe en PICKED_UP via le
    // bouton « Traiter » de son bon de sortie (bonsSortie.controller).
    if (Number(parcel.parcel_from_stock) === 1) {
      return res.status(409).json({
        message: `Colis « ${parcel.code} » de stock : à traiter depuis son bon de sortie (bouton « Traiter »).`,
        parcel: info
      });
    }
    if (parcel.status === 'PICKED_UP') {
      return res.status(409).json({ message: `Colis « ${parcel.code} » déjà ramassé.`, parcel: info });
    }
    if (!SCANNABLE_STATUSES.includes(parcel.status)) {
      return res.status(409).json({
        message: `Colis « ${parcel.code} » non ramassable (statut actuel : ${await statutLabel(parcel.status)}).`,
        parcel: info
      });
    }

    // Blocage posé par le client (bouton « Bloquer l'expédition » de son
    // tableau de colis) → refus, son d'erreur.
    if (await isBlockedByClient(parcel.id)) {
      return res.status(409).json({
        message: `Colis « ${parcel.code} » bloqué par le client, à ne pas envoyer.`,
        parcel: info
      });
    }

    // Étiquette obsolète : le CRBT a changé depuis la dernière impression du
    // ticket → refus (son d'erreur), l'agent réimprime l'étiquette (nouvelle
    // ligne delevery_parcel_print au prix courant) puis re-scanne.
    const lastPrint = await getLastPrintPrice(parcel.id);
    if (lastPrint !== null && Number(lastPrint) !== Number(effectiveCrbt(parcel))) {
      const printed = Number(lastPrint);
      const current = Number(effectiveCrbt(parcel));
      return res.status(409).json({
        message: `Étiquette obsolète pour « ${parcel.code} » : imprimée à ${printed} DH, ` +
                 `prix actuel ${current} DH. Réimprimez l'étiquette puis re-scannez.`,
        parcel: info,
        stale: { printed, current }
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_status = 'PICKED_UP', parcel_pickup_time = ?, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [now, now, parcel.id]
      );
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_time, parcel_history_by)
         VALUES (?, 0, ?, 'PICKED_UP', ?, ?)`,
        [parcel.id, parcel.situation, now, Number(req.user.id)]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({
      message: `Colis « ${parcel.code} » ramassé.`,
      parcel: { ...info, status: 'PICKED_UP' }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listParcels,
  listStatuts,
  listStatutLabels,
  listFilterOptions,
  listAdminLabels,
  exportAdminParcels,
  getClientNewParcelData,
  getClientTarif,
  getAdminTarif,
  getAdminClientDefaults,
  getClientDestinataireTaux,
  getAdminDestinataireTaux,
  createClientParcel,
  createAdminParcel,
  getClientParcelEditData,
  updateClientParcel,
  getImportData,
  importParcels,
  getImportStockProducts,
  importStockParcels,
  importClientParcels,
  importClientStockParcels,
  listClientParcels,
  listClientFilterOptions,
  listClientLabels,
  getClientParcelSuivi,
  getClientParcelDetails,
  createClientRemboursement,
  createClientReclamation,
  setClientParcelBlock,
  deleteClientParcel,
  getRamassageSons,
  scanRamassage,
  resolveClientFees,
  CODE_NON_MODIFIABLE,
  resoudreNouveauCode,
  renommerCodeMouvementsStock,
  CLIENT_EDIT_FIELDS,
  STATUT_CODE_SQL,
  STATUT_TYPE_SQL
};
