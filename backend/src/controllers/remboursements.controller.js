const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const { agenceIdFromVille } = require('../utils/agenceScope');

/*
 * Page admin "Remboursement" (/admin/remboursement) — demandes de remboursement
 * (delevery_remboursement, table partagée avec le système de production PHP),
 * même fonctionnement que la page legacy admin/files/remboursements.php :
 *  - liste filtrée par statut (En attente par défaut) + compteur en attente ;
 *  - Accepter : crée un colis "CODE_REMB" (prix 0) en DISTRIBUTION chez le
 *    livreur du colis original et l'ajoute à son dernier bon de distribution
 *    encore ouvert. Contrairement au legacy (frais de livraison = 25 DH +
 *    montant remboursé), les deux montants sont séparés : frais de livraison
 *    = 25 DH, montant remboursé en frais supp de livraison
 *    (parcel_extra_fees) ; sa ville de ramassage (et son agence, ville → zone
 *    → agence) est celle du client du colis original, comme une création de
 *    colis normale ;
 *  - Refuser : marque simplement la demande refusée.
 * Les demandes viennent du dashboard client (montant plafonné au CRBT) ou de
 * la datatable admin Colis (montant libre, parcelsAdmin.controller).
 */

const STATUTS = ['PENDING', 'ACCEPTED', 'REFUSED'];

/* Frais de livraison du colis de remboursement (valeur du legacy). */
const REMB_BASE_FEES = 25;

/**
 * GET /api/remboursements — liste des demandes (query statut : PENDING |
 * ACCEPTED | REFUSED | ALL, PENDING par défaut) + nombre de demandes en
 * attente pour le compteur de l'onglet.
 */
async function listRemboursements(req, res, next) {
  try {
    let statut = String(req.query.statut || 'PENDING').trim().toUpperCase();
    if (statut !== 'ALL' && !STATUTS.includes(statut)) statut = 'PENDING';
    const whereSql = statut === 'ALL' ? '' : 'WHERE r.remb_statut = ?';
    const params = statut === 'ALL' ? [] : [statut];

    const listSql = (withMember) => `
      SELECT r.remb_id AS id, r.remb_parcel_id AS parcel_id,
             r.remb_parcel_code AS parcel_code,
             r.remb_montant_reel AS montant_reel, r.remb_montant AS montant,
             r.remb_recuperer_colis AS recuperer,
             r.remb_commentaire AS commentaire, r.remb_statut AS statut,
             r.remb_time AS time, r.remb_treated_time AS treated_time,
             c.customers_store AS store,
             u.users_name AS treated_by,
             p.parcel_receiver AS receiver, p.parcel_phone AS phone${withMember ? `,
             mb.member_name AS member` : ''}
        FROM delevery_remboursement r
        LEFT JOIN delevery_customers c ON c.customers_id = r.remb_customer
        LEFT JOIN delevery_users u ON u.users_id = r.remb_treated_by AND r.remb_treated_by > 0
        LEFT JOIN delevery_parcel p ON p.parcel_id = r.remb_parcel_id${withMember ? `
        LEFT JOIN delevery_customer_members mb
          ON mb.member_id = r.remb_member AND r.remb_member > 0` : ''}
        ${whereSql}
        ORDER BY r.remb_time DESC, r.remb_id DESC`;

    // Demande faite par un membre de l'équipe du client : nom du membre
    // affiché sous le magasin. Fallback si la migration
    // sql/2026-08-23_equipe-client-table-membres.sql n'est pas passée.
    let rows;
    try {
      [rows] = await pool.query(listSql(true), params);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
      [rows] = await pool.query(listSql(false), params);
    }

    const [[{ pending }]] = await pool.query(
      `SELECT COUNT(*) AS pending FROM delevery_remboursement WHERE remb_statut = 'PENDING'`
    );

    res.json({ pending: Number(pending) || 0, rows });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/remboursements/:id/accepter — mêmes écritures que le legacy :
 * création du colis de remboursement "CODE_REMB" (suffixe horodaté si le code
 * est déjà pris) copié du colis original : prix 0, note "Remboursement colis
 * CODE", NOT_PAID / DISTRIBUTION, frais de livraison 25 DH, montant remboursé
 * en frais supp de livraison (parcel_extra_fees), ville de ramassage / agence
 * du client du colis original, même livreur, parcel_replace = récupérer
 * colis, parcel_is_remb = 1 ; ligne d'historique DISTRIBUTION ; ajout au
 * dernier bon de distribution ouvert du livreur s'il y en a un ; demande →
 * ACCEPTED.
 */
async function accepterRemboursement(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[demande]] = await conn.query(
      `SELECT * FROM delevery_remboursement
        WHERE remb_id = ? AND remb_statut = 'PENDING' LIMIT 1 FOR UPDATE`,
      [id]
    );
    if (!demande) {
      await conn.rollback();
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }

    const [[orig]] = await conn.query(
      `SELECT * FROM delevery_parcel WHERE parcel_id = ? LIMIT 1`,
      [Number(demande.remb_parcel_id)]
    );
    if (!orig) {
      await conn.rollback();
      return res.status(400).json({ message: 'Colis original introuvable.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const montant = Number(demande.remb_montant) || 0;
    const livreurId = Number(orig.parcel_livreur) || 0;
    const clientId = Number(orig.parcel_customer) || Number(demande.remb_customer) || 0;

    // Ville de ramassage (et agence, ville → zone → agence) du colis créé :
    // celles du client du colis original, comme une création de colis normale.
    const [[client]] = await conn.query(
      `SELECT customers_pickup_city AS pickup_city
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [clientId]
    );
    const pickupCity = Number(client?.pickup_city) || 0;
    const agenceId = await agenceIdFromVille(pickupCity);

    let newCode = `${demande.remb_parcel_code}_REMB`;
    const [[codeTaken]] = await conn.query(
      `SELECT parcel_id FROM delevery_parcel WHERE parcel_code = ? LIMIT 1`,
      [newCode]
    );
    if (codeTaken) newCode = `${demande.remb_parcel_code}_REMB_${now}`;

    const [inserted] = await conn.query(
      `INSERT INTO delevery_parcel
         (parcel_code, parcel_receiver, parcel_phone, parcel_city, parcel_address,
          parcel_price, parcel_note, parcel_situation, parcel_status,
          parcel_paid_livreur, parcel_paid_city, parcel_delivered_fees,
          parcel_extra_fees, parcel_returned_fees, parcel_refused_fees,
          parcel_customer, parcel_livreur, parcel_replace, parcel_is_remb,
          parcel_ramassage_city, parcel_agence,
          parcel_time, parcel_pickup_time, parcel_last_update)
       VALUES (?, ?, ?, ?, ?, '0', ?, 'NOT_PAID', 'DISTRIBUTION',
               0, 0, ?, ?, 0, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        newCode,
        orig.parcel_receiver,
        orig.parcel_phone,
        Number(orig.parcel_city) || 0,
        orig.parcel_address,
        `Remboursement colis ${demande.remb_parcel_code}`,
        REMB_BASE_FEES,
        Math.round(montant),
        Number(demande.remb_customer) || 0,
        livreurId,
        Number(demande.remb_recuperer_colis) === 1 ? 1 : 0,
        pickupCity,
        agenceId ? String(agenceId) : '',
        now,
        now,
        now
      ]
    );
    const newParcelId = inserted.insertId;

    const [hist] = await conn.query(
      `INSERT INTO delevery_parcel_history
         (parcel_history_parcel, parcel_history_city, parcel_history_situation,
          parcel_history_status, parcel_history_time, parcel_history_by)
       VALUES (?, ?, 'NOT_PAID', 'DISTRIBUTION', ?, ?)`,
      [newParcelId, Number(orig.parcel_city) || 0, now, Number(req.user.id) || 0]
    );

    // Dernier bon de distribution encore ouvert du même livreur : le colis y
    // est ajouté directement (comme le legacy), sinon il reste en DISTRIBUTION
    // hors bon.
    let addedToBon = false;
    if (livreurId > 0) {
      const [[bon]] = await conn.query(
        `SELECT distribution_note_id AS id FROM delevery_distribution_note
          WHERE distribution_note_delivery = ? AND distribution_note_save = 0
          ORDER BY distribution_note_id DESC LIMIT 1`,
        [livreurId]
      );
      if (bon) {
        await conn.query(
          `INSERT INTO delevery_dis_parcels
             (dis_parcels_livreur_before, dis_parcels_was_en_agence,
              dis_parcels_dis, dis_parcels_parcel, dis_parcels_time)
           VALUES (NULL, 0, ?, ?, ?)`,
          [bon.id, newParcelId, now]
        );
        await conn.query(
          `UPDATE delevery_parcel_history SET parcel_history_livreur = ?
            WHERE parcel_history_id = ?`,
          [livreurId, hist.insertId]
        );
        addedToBon = true;
      }
    }

    await conn.query(
      `UPDATE delevery_remboursement
          SET remb_statut = 'ACCEPTED', remb_treated_by = ?, remb_treated_time = ?
        WHERE remb_id = ?`,
      [Number(req.user.id) || 0, now, id]
    );

    await conn.commit();
    emettreEvenement('REMB_ACCEPTE', { rembId: id, codeRemb: newCode, userId: Number(req.user.id) || 0 });
    res.json({
      id,
      statut: 'ACCEPTED',
      new_parcel_code: newCode,
      added_to_bon: addedToBon,
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

/** POST /api/remboursements/:id/refuser — demande PENDING → REFUSED. */
async function refuserRemboursement(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const now = Math.floor(Date.now() / 1000);
    const [result] = await pool.query(
      `UPDATE delevery_remboursement
          SET remb_statut = 'REFUSED', remb_treated_by = ?, remb_treated_time = ?
        WHERE remb_id = ? AND remb_statut = 'PENDING'`,
      [Number(req.user.id) || 0, now, id || 0]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }
    emettreEvenement('REMB_REFUSE', { rembId: id, userId: Number(req.user.id) || 0 });
    res.json({ id, statut: 'REFUSED', treated_by: req.user.name || '', treated_time: now });
  } catch (err) {
    next(err);
  }
}

module.exports = { listRemboursements, accepterRemboursement, refuserRemboursement };
