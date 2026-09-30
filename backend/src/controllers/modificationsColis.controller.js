const pool = require('../config/db');
const { resolveClientFees, CLIENT_EDIT_FIELDS } = require('./parcels.controller');
const { lireOptionFraisMontant, ajusterFraisMontant } = require('../utils/fraisMontant');

/*
 * Page admin "Modifications Colis" (/admin/modifications-colis, service
 * MODIFICATIONS_COLIS) — demandes de modification de colis déjà ramassés,
 * envoyées depuis la modale "Modifier colis" du dashboard client
 * (delevery_parcel_modif_demande, sql/2026-08-24_modifications-colis.sql) :
 *  - liste filtrée par statut (En attente par défaut) + compteur en attente ;
 *  - Accepter : applique les nouvelles valeurs au colis avec les mêmes traces
 *    qu'une modification directe du client (instantané delevery_parcel_edit,
 *    delevery_parcel_modification modif_user = 0 / modif_customer = client,
 *    historique legacy EDITED) ; frais re-résolus si la ville change ;
 *  - Refuser : marque simplement la demande refusée, le colis reste intact.
 */

const STATUTS = ['PENDING', 'ACCEPTED', 'REFUSED'];

/* Statuts au-delà desquels une demande ne peut plus être appliquée. */
const LOCKED_STATUSES = ['DELIVERED', 'RETURNED'];

/*
 * Statut effectif du colis (même règle que parcels.controller) : INVOICED,
 * sinon statut second d'un colis IN_PROGRESS, sinon statut brut — affiché sur
 * chaque ligne pour aider l'admin à décider.
 */
const STATUT_CODE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 'INVOICED'
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> ''
      THEN p.parcel_status_second
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK'
      THEN 'RETURNED_TO_STOCK'
    ELSE p.parcel_status
  END`;

const STATUT_TYPE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 1
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> '' THEN 3
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK' THEN 3
    ELSE 2
  END`;

/**
 * GET /api/modifications-colis — liste des demandes (query statut : PENDING |
 * ACCEPTED | REFUSED | ALL, PENDING par défaut) + nombre de demandes en
 * attente pour le compteur de l'onglet. Chaque ligne porte le détail des
 * changements demandés (changes : [{ field, label, old, new }]) et le statut
 * effectif actuel du colis.
 */
async function listDemandes(req, res, next) {
  try {
    let statut = String(req.query.statut || 'PENDING').trim().toUpperCase();
    if (statut !== 'ALL' && !STATUTS.includes(statut)) statut = 'PENDING';
    const whereSql = statut === 'ALL' ? '' : 'WHERE d.pmd_statut = ?';
    const params = statut === 'ALL' ? [] : [statut];

    const listSql = (withMember) => `
      SELECT d.pmd_id AS id, d.pmd_parcel AS parcel_id, d.pmd_changes AS changes,
             d.pmd_statut AS statut, d.pmd_time AS time,
             d.pmd_treated_time AS treated_time,
             c.customers_store AS store,
             u.users_name AS treated_by,
             p.parcel_code, p.parcel_receiver AS receiver, p.parcel_phone AS phone,
             p.parcel_status,
             (${STATUT_CODE_SQL}) AS parcel_statut, s.parcel_statut_color AS parcel_statut_color${withMember ? `,
             mb.member_name AS member` : ''}
        FROM delevery_parcel_modif_demande d
        LEFT JOIN delevery_customers c ON c.customers_id = d.pmd_customer
        LEFT JOIN delevery_users u ON u.users_id = d.pmd_treated_by AND d.pmd_treated_by > 0
        LEFT JOIN delevery_parcel p ON p.parcel_id = d.pmd_parcel
        LEFT JOIN delevery_parcel_statut s
          ON s.parcel_statut_code = (${STATUT_CODE_SQL})
         AND s.parcel_statut_type = (${STATUT_TYPE_SQL})${withMember ? `
        LEFT JOIN delevery_customer_members mb
          ON mb.member_id = d.pmd_member AND d.pmd_member > 0` : ''}
        ${whereSql}
        ORDER BY d.pmd_time DESC, d.pmd_id DESC`;

    // Demande faite par un membre de l'équipe du client : nom du membre
    // affiché sous le magasin. Fallback si la migration
    // sql/2026-08-23_equipe-client-table-membres.sql n'est pas passée.
    let rows;
    try {
      [rows] = await pool.query(listSql(true), params);
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE' && /delevery_parcel_modif_demande/i.test(err.message || '')) {
        return res.status(503).json({
          message: 'Table des demandes absente : exécutez sql/2026-08-24_modifications-colis.sql.'
        });
      }
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
      [rows] = await pool.query(listSql(false), params);
    }

    for (const r of rows) {
      try {
        r.changes = JSON.parse(r.changes) || [];
      } catch {
        r.changes = [];
      }
    }

    const [[{ pending }]] = await pool.query(
      `SELECT COUNT(*) AS pending FROM delevery_parcel_modif_demande WHERE pmd_statut = 'PENDING'`
    );

    res.json({ pending: Number(pending) || 0, rows });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/modifications-colis/:id/accepter — applique les valeurs demandées
 * au colis. Le diff est recalculé sur les valeurs ACTUELLES du colis (il a pu
 * changer depuis la demande) ; si plus rien ne diffère, la demande est marquée
 * acceptée sans écriture sur le colis. Refusé si le colis est livré / retourné
 * / facturé (les frais et le CRBT alimentent la facturation).
 */
async function accepterDemande(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[demande]] = await conn.query(
      `SELECT * FROM delevery_parcel_modif_demande
        WHERE pmd_id = ? AND pmd_statut = 'PENDING' LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (!demande) {
      await conn.rollback();
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }

    const [[parcel]] = await conn.query(
      `SELECT p.*, t.nom_ville AS ville
         FROM delevery_parcel p
         LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
        WHERE p.parcel_id = ? LIMIT 1 FOR UPDATE`,
      [Number(demande.pmd_parcel)]
    );
    if (!parcel) {
      await conn.rollback();
      return res.status(400).json({ message: 'Colis introuvable.' });
    }
    if (LOCKED_STATUSES.includes(parcel.parcel_status) || parcel.parcel_situation === 'INVOICED') {
      await conn.rollback();
      return res.status(409).json({
        message: 'Ce colis est déjà livré, retourné ou facturé : la modification ne peut plus être appliquée. Refusez la demande.'
      });
    }
    // Colis (refusé / annulé) déjà sur une facture livreur : ses infos
    // alimentent la facturation, il doit d'abord en être retiré.
    if (Number(parcel.parcel_paid_livreur) !== 0 || Number(parcel.parcel_refuse_livreur) !== 0) {
      await conn.rollback();
      return res.status(409).json({
        message: 'Ce colis est sur une facture livreur : retirez-le d’abord de la facture pour appliquer la modification, ou refusez la demande.'
      });
    }

    // Nouvelles valeurs demandées par le client (validées à la création de la
    // demande) ; re-vérification minimale par sécurité.
    let payload;
    try {
      payload = JSON.parse(demande.pmd_payload) || {};
    } catch {
      payload = {};
    }
    const fromStock = Number(parcel.parcel_from_stock) === 1;
    const receiver = String(payload.receiver || '').trim().slice(0, 250);
    const phone = String(payload.phone || '').trim().slice(0, 50);
    const city = parseInt(payload.city, 10);
    const address = String(payload.address || '').trim().slice(0, 2000);
    const note = String(payload.note || '').trim().slice(0, 2000);
    const price = Number(payload.price);
    // Colis de stock : marchandise / quantité jamais modifiées par le client.
    const product = fromStock ? parcel.parcel_product_name || '' : String(payload.product || '').trim().slice(0, 250);
    const qty = fromStock
      ? Number(parcel.parcel_product_qty) || 1
      : Math.min(Math.max(parseInt(payload.qty, 10) || 1, 1), 9999);
    const open = Number(payload.open) === 1 ? 1 : 0;
    const essayage = open === 0 ? 0 : Number(payload.essayage) === 1 ? 1 : 0;
    const replace = Number(payload.replace) === 1 ? 1 : 0;

    if (!receiver || !phone || !address || !Number.isInteger(city) || city <= 0 ||
        !Number.isFinite(price) || price < 0 || price > 99999999) {
      await conn.rollback();
      return res.status(400).json({ message: 'Demande invalide (valeurs incomplètes).' });
    }

    const [[destVille]] = await conn.query(
      `SELECT nom_ville FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
      [city]
    );
    if (!destVille) {
      await conn.rollback();
      return res.status(400).json({ message: 'Ville de destination de la demande introuvable.' });
    }

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

    // Diff recalculé sur les valeurs actuelles du colis (il a pu être modifié
    // par un admin entre la demande et la validation) — même format que
    // updateClientParcel pour le détail de suivi.
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

    const now = Math.floor(Date.now() / 1000);
    const customerId = Number(demande.pmd_customer) || 0;
    const memberId = Number(demande.pmd_member) || 0;

    if (changes.length) {
      // Changement de ville de destination → frais re-résolus (même cascade
      // que la création côté client).
      let fees = null;
      if (ancien.city !== city) {
        const [[customer]] = await conn.query(
          `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif,
                  customers_pickup_city             AS pickup_city
             FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
          [customerId]
        );
        fees = customer
          ? await resolveClientFees(customerId, customer.custom_tarif, customer.pickup_city, city)
          : null;
        if (!fees) {
          await conn.rollback();
          return res.status(400).json({ message: 'Aucun tarif trouvé pour la nouvelle ville de destination.' });
        }
      }

      // Changement de montant → frais supp automatiques réajustés (même règle
      // que la modification directe côté client : utils/fraisMontant).
      let extraFees = null;
      if (ancien.price !== price) {
        const optionFrais = await lireOptionFraisMontant(customerId, conn);
        extraFees = ajusterFraisMontant(parcel.parcel_extra_fees, ancien.price, price, optionFrais.actif);
      }

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

      // Trace détaillée du suivi admin : la modification reste attribuée au
      // client (modif_user = 0), la validation est portée par la demande.
      await conn.query(
        `INSERT INTO delevery_parcel_modification
           (modif_parcel, modif_user, modif_customer, modif_member, modif_time, modif_changes)
         VALUES (?, 0, ?, ?, ?, ?)`,
        [parcel.parcel_id, customerId, memberId, now, JSON.stringify(changes)]
      );

      // Ligne d'historique legacy (affichée "Colis modifié" côté client).
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_data, parcel_history_time,
            parcel_history_by, parcel_history_member)
         VALUES (?, 0, ?, '', 'EDITED', ?, 0, ?)`,
        [parcel.parcel_id, parcel.parcel_situation || '', now, memberId]
      );

      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_receiver = ?, parcel_phone = ?, parcel_city = ?, parcel_address = ?,
                parcel_note = ?, parcel_price = ?, parcel_product_name = ?,
                parcel_product_qty = ?, parcel_open = ?, parcel_essayage = ?,
                parcel_replace = ?${fees ? `, parcel_delivered_fees = ?,
                parcel_returned_fees = ?, parcel_refused_fees = ?` : ''}${
                  extraFees !== null ? ', parcel_extra_fees = ?' : ''
                },
                parcel_edited = 1, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [
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
    }

    await conn.query(
      `UPDATE delevery_parcel_modif_demande
          SET pmd_statut = 'ACCEPTED', pmd_treated_by = ?, pmd_treated_time = ?
        WHERE pmd_id = ?`,
      [Number(req.user.id) || 0, now, id]
    );

    await conn.commit();
    res.json({
      id,
      statut: 'ACCEPTED',
      applied: changes.length,
      treated_by: req.user.name || '',
      treated_time: now
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/** POST /api/modifications-colis/:id/refuser — demande PENDING → REFUSED, colis intact. */
async function refuserDemande(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const now = Math.floor(Date.now() / 1000);
    const [result] = await pool.query(
      `UPDATE delevery_parcel_modif_demande
          SET pmd_statut = 'REFUSED', pmd_treated_by = ?, pmd_treated_time = ?
        WHERE pmd_id = ? AND pmd_statut = 'PENDING'`,
      [Number(req.user.id) || 0, now, id || 0]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }
    res.json({ id, statut: 'REFUSED', treated_by: req.user.name || '', treated_time: now });
  } catch (err) {
    next(err);
  }
}

module.exports = { listDemandes, accepterDemande, refuserDemande };
