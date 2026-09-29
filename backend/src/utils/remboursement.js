const pool = require('../config/db');

/*
 * Demandes de remboursement (delevery_remboursement).
 *
 * Un colis « fait l'objet d'une demande » tant qu'il a une demande en attente
 * ou acceptée ; une demande refusée permet d'en faire une nouvelle. Le colis
 * original n'est PAS marqué parcel_is_remb : ce drapeau n'identifie que le
 * colis de remboursement « CODE_REMB » créé à l'acceptation
 * (remboursements.controller), qui n'est jamais remboursable lui-même.
 * Migration sql/2026-09-04_remboursement-is-remb.sql : remet à 0 les colis
 * originaux flagués par l'ancienne logique.
 */

/** Expression SQL (alias p = delevery_parcel) : 1 si demande en attente ou acceptée. */
const REMB_DEMANDE_SQL = `EXISTS (SELECT 1 FROM delevery_remboursement r
  WHERE r.remb_parcel_id = p.parcel_id AND r.remb_statut IN ('PENDING', 'ACCEPTED'))`;

/** Vrai si le colis a déjà une demande en attente ou acceptée. */
async function hasDemandeEnCours(parcelId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS x FROM delevery_remboursement
      WHERE remb_parcel_id = ? AND remb_statut IN ('PENDING', 'ACCEPTED') LIMIT 1`,
    [Number(parcelId) || 0]
  );
  return Boolean(row);
}

module.exports = { REMB_DEMANDE_SQL, hasDemandeEnCours };
