const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const { getServicePhone } = require('./clients.controller');
const { getAgenceScope, parcelInAgence } = require('../utils/agenceScope');
const { getProduitsByParcel, attachStockProduits } = require('../utils/parcelProduits');
const { isBlockedByClient } = require('../utils/blocageClient');
const { statutLabel } = require('../utils/statutLabels');

/*
 * Bons de sortie de stock (delevery_delivery_note_stock + delevery_dns_parcels,
 * tables partagées avec le legacy) : un bon regroupe des colis de stock
 * (parcel_from_stock = 1) en attente de ramassage (WAITING_PICKUP) à sortir
 * de l'entrepôt.
 *
 * Statut d'un bon :
 *  - delivery_note_stock_delivered = 1 → « Traité » (ancien libellé legacy
 *    « Reçu » : simple changement d'affichage, aucune migration de données) ;
 *  - sinon delivery_note_stock_affecter renseigné → « Affecté » ;
 *  - sinon → « Nouveau ».
 *
 * delivery_note_stock_affecter (colonne ORTALOG, migration SQL manuelle) :
 * utilisateur auquel le bon est affecté. Le traitement, le PDF et les tickets
 * ne sont possibles qu'après affectation.
 *
 * Ajout d'un colis au bon : simple ligne delevery_dns_parcels, le colis reste
 * WAITING_PICKUP (dans le legacy le colis passait NEW_PARCEL → WAITING_PICKUP,
 * statut que les colis de stock ORTALOG ont déjà à leur création). Traitement :
 * les colis du bon encore WAITING_PICKUP passent en PICKED_UP + ligne
 * d'historique, comme le ramassage par scan.
 */

const MAX_PAGE_SIZE = 100;

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/** Minuscules sans accents, pour comparer la recherche aux libellés de statut. */
function sansAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/* Conditions SQL des statuts affichés (Traité > Affecté > Nouveau). */
const SQL_TRAITE = 'IFNULL(dns.delivery_note_stock_delivered, 0) = 1';
const SQL_NON_TRAITE = 'IFNULL(dns.delivery_note_stock_delivered, 0) <> 1';
const SQL_AFFECTE = 'IFNULL(dns.delivery_note_stock_affecter, 0) <> 0';
const SQL_NON_AFFECTE = 'IFNULL(dns.delivery_note_stock_affecter, 0) = 0';
const STATUT_LIBELLES = [
  { libelle: 'traité', sql: SQL_TRAITE },
  { libelle: 'affecté', sql: `(${SQL_NON_TRAITE} AND ${SQL_AFFECTE})` },
  { libelle: 'nouveau', sql: `(${SQL_NON_TRAITE} AND ${SQL_NON_AFFECTE})` }
];

/** Charge un bon ; renvoie null si l'id est invalide ou le bon introuvable. */
async function loadBon(id) {
  const bonId = parseInt(id, 10);
  if (!Number.isInteger(bonId) || bonId <= 0) return null;
  const [[bon]] = await pool.query(
    `SELECT dns.delivery_note_stock_id        AS id,
            dns.delivery_note_stock_ref       AS ref,
            dns.delivery_note_stock_time      AS time,
            dns.delivery_note_stock_delivered AS delivered,
            dns.delivery_note_stock_by        AS by_id,
            ub.users_name                     AS by_name,
            dns.delivery_note_stock_affecter  AS affecter_id,
            ua.users_name                     AS affecter_name
       FROM delevery_delivery_note_stock dns
       LEFT JOIN delevery_users ub ON ub.users_id = dns.delivery_note_stock_by
       LEFT JOIN delevery_users ua ON ua.users_id = dns.delivery_note_stock_affecter
      WHERE dns.delivery_note_stock_id = ? LIMIT 1`,
    [bonId]
  );
  return bon || null;
}

/** Un bon est modifiable (colis, affectation) tant qu'il n'est pas traité. */
function bonEditable(bon) {
  return Number(bon.delivered) !== 1;
}

/**
 * GET /api/bons-sortie — liste paginée pour la datatable, du plus récent au
 * plus ancien : référence, date, créateur, utilisateur affecté, nombre de
 * colis, statut. Query : page, pageSize, search (référence, créateur, affecté
 * à, libellé de statut), statut (traite | non-traite), affecte (affecte |
 * non-affecte), dateFrom / dateTo ("AAAA-MM-JJ").
 * Renvoie { rows, total, page, pageSize, totalPages }.
 */
async function listBons(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 10, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const statut = String(req.query.statut || '').trim();
    const affecte = String(req.query.affecte || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    if (statut === 'traite') where.push(SQL_TRAITE);
    else if (statut === 'non-traite') where.push(SQL_NON_TRAITE);
    if (affecte === 'affecte') where.push(SQL_AFFECTE);
    else if (affecte === 'non-affecte') where.push(SQL_NON_AFFECTE);
    if (dateFrom !== null) {
      where.push('dns.delivery_note_stock_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('dns.delivery_note_stock_time <= ?');
      params.push(dateTo);
    }
    if (search) {
      const or = ['dns.delivery_note_stock_ref LIKE ?', 'ub.users_name LIKE ?', 'ua.users_name LIKE ?'];
      const like = `%${search}%`;
      params.push(like, like, like);
      // Recherche par libellé de statut (« trait », « affecte », « nouveau »…),
      // comme l'ancien filtre navigateur, accents ignorés.
      const q = sansAccents(search);
      for (const s of STATUT_LIBELLES) {
        if (sansAccents(s.libelle).includes(q)) or.push(s.sql);
      }
      where.push(`(${or.join(' OR ')})`);
    }
    const fromSql = `FROM delevery_delivery_note_stock dns
         LEFT JOIN delevery_users ub ON ub.users_id = dns.delivery_note_stock_by
         LEFT JOIN delevery_users ua ON ua.users_id = dns.delivery_note_stock_affecter`;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql} ${whereSql}`, params);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT dns.delivery_note_stock_id        AS id,
              dns.delivery_note_stock_ref       AS ref,
              dns.delivery_note_stock_time      AS time,
              dns.delivery_note_stock_delivered AS delivered,
              ub.users_name                     AS by_name,
              dns.delivery_note_stock_affecter  AS affecter_id,
              ua.users_name                     AS affecter_name
         ${fromSql}
         ${whereSql}
         ORDER BY dns.delivery_note_stock_time DESC, dns.delivery_note_stock_id DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // Nombre de colis des seuls bons de la page : une requête groupée sur leurs
    // ids (delevery_dns_parcels, ~50 k lignes) — rapide même sans l'index
    // idx_dns_parcels_dns (sql/2026-09-03_bons-sortie-index.sql), instantané avec.
    const nbColis = new Map();
    if (rows.length) {
      const [cnt] = await pool.query(
        `SELECT dns_parcels_dns AS id, COUNT(*) AS nb
           FROM delevery_dns_parcels
          WHERE dns_parcels_dns IN (?)
          GROUP BY dns_parcels_dns`,
        [rows.map((r) => r.id)]
      );
      cnt.forEach((c) => nbColis.set(Number(c.id), Number(c.nb)));
    }

    res.json({
      rows: rows.map((r) => ({ ...r, nb_colis: nbColis.get(Number(r.id)) || 0 })),
      total,
      page,
      pageSize,
      totalPages
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-sortie — crée un bon « Nouveau » et génère sa référence
 * unique au format legacy : BL-S-JJMMAA-0{id}0-{2 chiffres} (l'id du bon la
 * rend unique). Renvoie { id, ref }.
 */
async function createBon(req, res, next) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_delivery_note_stock
           (delivery_note_stock_ref, delivery_note_stock_time,
            delivery_note_stock_delivered, delivery_note_stock_by)
         VALUES ('', ?, 0, ?)`,
        [now, Number(req.user.id)]
      );
      const bonId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `BL-S-${jj}${mm}${aa}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(
        `UPDATE delevery_delivery_note_stock SET delivery_note_stock_ref = ?
          WHERE delivery_note_stock_id = ?`,
        [ref, bonId]
      );
      await conn.commit();
      res.status(201).json({ id: bonId, ref });
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
 * GET /api/bons-sortie/users — utilisateurs actifs (comptes principaux) pour
 * la liste déroulante d'affectation d'un bon. Les livreurs (users_type = 5)
 * sont exclus.
 */
async function listUsers(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT users_id AS id, users_name AS nom
         FROM delevery_users
        WHERE users_active = 1 AND users_parent_id IS NULL AND users_type <> '5'
        ORDER BY users_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-sortie/:id — détail d'un bon : informations (référence, date,
 * créateur, utilisateur affecté, statut) + colis du bon (code, magasin, ville
 * de destination, adresse, commentaire, date de création, produits avec
 * quantités et positions de stock), du plus récemment ajouté au plus ancien.
 * Sert la page de modification, la modale « Détail du bon » et le PDF.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const [parcels] = await pool.query(
      `SELECT p.parcel_id       AS id,
              p.parcel_code     AS code,
              p.parcel_status   AS status,
              p.parcel_time     AS time,
              p.parcel_note     AS commentaire,
              p.parcel_address  AS adresse,
              t.nom_ville       AS ville,
              c.customers_store AS magasin,
              c.customers_name  AS clientNom
         FROM delevery_dns_parcels sp
         JOIN delevery_parcel p ON p.parcel_id = sp.dns_parcels_parcel
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE sp.dns_parcels_dns = ?
        ORDER BY sp.dns_parcels_id DESC`,
      [bon.id]
    );
    const produits = await getProduitsByParcel(parcels.map((p) => p.id));
    res.json({
      ...bon,
      parcels: parcels.map((p) => ({ ...p, produits: produits.get(p.id) || [] }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-sortie/:id/available — colis ajoutables au bon : colis de
 * stock (parcel_from_stock = 1) en attente de ramassage (WAITING_PICKUP) et
 * pas déjà dans un bon de sortie (recherche et pagination côté client).
 * Employés type 3/4/6 : uniquement les colis de leur agence.
 */
async function listAvailable(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const where = [
      'p.parcel_from_stock = 1',
      "p.parcel_status = 'WAITING_PICKUP'",
      `NOT EXISTS (SELECT 1 FROM delevery_dns_parcels sp
                    WHERE sp.dns_parcels_parcel = p.parcel_id)`
    ];
    const params = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }

    const [rows] = await pool.query(
      `SELECT p.parcel_id       AS id,
              p.parcel_code     AS code,
              p.parcel_time     AS time,
              p.parcel_address  AS adresse,
              t.nom_ville       AS ville,
              c.customers_store AS magasin,
              c.customers_name  AS clientNom
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
        WHERE ${where.join(' AND ')}
        ORDER BY p.parcel_time DESC, p.parcel_id DESC`,
      params
    );
    const produits = await getProduitsByParcel(rows.map((p) => p.id));
    res.json(rows.map((p) => ({ ...p, produits: produits.get(p.id) || [] })));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-sortie/:id/parcels — body { ids: [parcel_id] }.
 * Ajout de colis au bon (à l'unité ou par sélection) : chaque colis doit être
 * un colis de stock WAITING_PICKUP pas déjà dans un bon, les autres sont
 * ignorés avec un motif. Le colis reste WAITING_PICKUP (il ne passera en
 * PICKED_UP qu'au traitement du bon). Renvoie { added, skipped }.
 */
async function addParcels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est traité : ajout impossible.' });
    }

    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });

    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const parcelId of ids) {
        const [[parcel]] = await conn.query(
          `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
                  p.parcel_from_stock AS from_stock,
                  (SELECT sp.dns_parcels_id FROM delevery_dns_parcels sp
                    WHERE sp.dns_parcels_parcel = p.parcel_id LIMIT 1) AS link_id
             FROM delevery_parcel p
            WHERE p.parcel_id = ? LIMIT 1 FOR UPDATE`,
          [parcelId]
        );
        if (!parcel) {
          skipped.push({ code: `#${parcelId}`, reason: 'Colis introuvable.' });
          continue;
        }
        if (Number(parcel.from_stock) !== 1) {
          skipped.push({ code: parcel.code, reason: 'Pas un colis de stock.' });
          continue;
        }
        if (parcel.status !== 'WAITING_PICKUP') {
          skipped.push({ code: parcel.code, reason: `Statut actuel : ${await statutLabel(parcel.status)} (en attente de ramassage attendu).` });
          continue;
        }
        if (parcel.link_id) {
          skipped.push({ code: parcel.code, reason: 'Déjà dans un bon de sortie.' });
          continue;
        }
        if (await isBlockedByClient(parcel.id, conn)) {
          skipped.push({ code: parcel.code, reason: 'Bloqué par le client, à ne pas envoyer.' });
          continue;
        }
        await conn.query(
          `INSERT INTO delevery_dns_parcels (dns_parcels_dns, dns_parcels_parcel, dns_parcels_time)
           VALUES (?, ?, ?)`,
          [bon.id, parcel.id, now]
        );
        added.push({ id: parcel.id, code: parcel.code });
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
 * DELETE /api/bons-sortie/:id/parcels/:parcelId — retire un colis du bon
 * (suppression de la ligne delevery_dns_parcels, le colis reste WAITING_PICKUP
 * et redevient ajoutable). Impossible sur un bon traité.
 */
async function removeParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est traité : suppression impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10);
    const [[row]] = await pool.query(
      `SELECT sp.dns_parcels_id AS link_id, p.parcel_id AS id, p.parcel_code AS code
         FROM delevery_dns_parcels sp
         JOIN delevery_parcel p ON p.parcel_id = sp.dns_parcels_parcel
        WHERE sp.dns_parcels_dns = ? AND sp.dns_parcels_parcel = ? LIMIT 1`,
      [bon.id, parcelId || 0]
    );
    if (!row) return res.status(404).json({ message: 'Colis introuvable dans ce bon.' });

    await pool.query(`DELETE FROM delevery_dns_parcels WHERE dns_parcels_id = ?`, [row.link_id]);
    res.json({ id: row.id, code: row.code });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-sortie/:id/affecter — body { userId }. Affecte le bon à un
 * utilisateur actif (statut « Affecté ») ; réaffectation possible tant que le
 * bon n'est pas traité. Renvoie { id, affecter_id, affecter_name }.
 */
async function affecterBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est traité : affectation impossible.' });
    }

    const userId = parseInt(req.body?.userId, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un utilisateur.' });
    }
    // Mêmes règles que la liste déroulante : utilisateur actif, hors livreurs (type 5).
    const [[user]] = await pool.query(
      `SELECT users_id AS id, users_name AS nom FROM delevery_users
        WHERE users_id = ? AND users_active = 1 AND users_type <> '5' LIMIT 1`,
      [userId]
    );
    if (!user) return res.status(400).json({ message: 'Utilisateur introuvable ou désactivé.' });

    await pool.query(
      `UPDATE delevery_delivery_note_stock SET delivery_note_stock_affecter = ?
        WHERE delivery_note_stock_id = ?`,
      [user.id, bon.id]
    );
    res.json({ id: bon.id, affecter_id: user.id, affecter_name: user.nom });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-sortie/:id/traiter — marque le bon « Traité » (uniquement
 * s'il est affecté à un utilisateur) : ses colis encore WAITING_PICKUP passent
 * en PICKED_UP (ligne d'historique chacun, comme le ramassage par scan).
 */
async function traiterBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    if (Number(bon.delivered) === 1) {
      return res.status(400).json({ message: 'Ce bon est déjà traité.' });
    }
    if (!bon.affecter_id) {
      return res.status(400).json({ message: 'Affectez d’abord ce bon à un utilisateur.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_delivery_note_stock SET delivery_note_stock_delivered = 1
          WHERE delivery_note_stock_id = ?`,
        [bon.id]
      );
      // Colis du bon encore en attente (verrouillés) → PICKED_UP + historique.
      const [parcels] = await conn.query(
        `SELECT p.parcel_id AS id, p.parcel_situation AS situation
           FROM delevery_dns_parcels sp
           JOIN delevery_parcel p ON p.parcel_id = sp.dns_parcels_parcel
          WHERE sp.dns_parcels_dns = ? AND p.parcel_status = 'WAITING_PICKUP'
          ORDER BY p.parcel_id FOR UPDATE`,
        [bon.id]
      );
      for (const parcel of parcels) {
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
      }
      await conn.commit();
      for (const p of parcels) emettreEvenement('STATUT', { parcelId: p.id, code: 'PICKED_UP', bonId: bon.id, userId: Number(req.user.id) || 0 });
      res.json({ id: bon.id, delivered: 1, pickedCount: parcels.length });
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
 * DELETE /api/bons-sortie/:id — supprime un bon vide (aucun colis) uniquement.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_dns_parcels WHERE dns_parcels_dns = ?`,
      [bon.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Ce bon contient des colis : suppression impossible.' });
    }
    await pool.query(`DELETE FROM delevery_delivery_note_stock WHERE delivery_note_stock_id = ?`, [
      bon.id
    ]);
    res.json({ id: bon.id });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-sortie/:id/labels — données d'impression des tickets des colis
 * du bon (mêmes champs que GET /parcels/labels, réutilisés par
 * utils/etiquettes côté front), avec les produits de stock de chaque colis
 * (stock_produits : nom, quantité, position — affichés sur le ticket à la
 * place de la ligne « Marchandise »). customers_phone_show = 0 : le numéro du
 * client est remplacé par le numéro de mobile de la société.
 */
async function listLabels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });

    const [labels] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone,
              p.parcel_address, p.parcel_note, p.parcel_price, p.parcel_time,
              p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
              p.parcel_open, p.parcel_essayage, p.parcel_replace, p.parcel_crbt_zero,
              t.nom_ville AS ville, z.zone_name AS zone,
              c.customers_store AS sender_store, c.customers_phone AS sender_phone,
              IFNULL(c.customers_phone_show, 0) AS sender_phone_show
         FROM delevery_dns_parcels sp
         JOIN delevery_parcel p ON p.parcel_id = sp.dns_parcels_parcel
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_zone z   ON z.zone_id = t.zone
        WHERE sp.dns_parcels_dns = ?
        ORDER BY sp.dns_parcels_id ASC`,
      [bon.id]
    );
    if (!labels.length) {
      return res.status(404).json({ message: 'Aucun colis dans ce bon.' });
    }
    await attachStockProduits(labels);

    // customers_phone_show = 0 : le client masque son numéro sur les tickets,
    // on affiche à la place le numéro de mobile de la société.
    if (labels.some((l) => Number(l.sender_phone_show) !== 1)) {
      const servicePhone = await getServicePhone();
      for (const l of labels) {
        if (Number(l.sender_phone_show) !== 1) l.sender_phone = servicePhone || l.sender_phone;
        delete l.sender_phone_show;
      }
    }

    res.json({ sender: { store: '', phone: '' }, labels });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listBons,
  createBon,
  listUsers,
  getBon,
  listAvailable,
  addParcels,
  removeParcel,
  affecterBon,
  traiterBon,
  deleteBon,
  listLabels
};
