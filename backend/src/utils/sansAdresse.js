/*
 * Statut « Attente confirmation » (WAITING_CONFIRMATION, statut second type 3 —
 * sql/2026-09-19_statut-attente-confirmation.sql), page « Sans adresse »
 * (/admin/sans-adresse, menu à part sous Bons de distribution — service
 * COLIS_SANS_ADRESSE, types 1-4 ; 3-4 restreints à leur agence).
 *
 * Règles :
 *  - posé UNIQUEMENT par le scan de la page « Sans adresse » (douchette ou
 *    caméra) : jamais proposé par la modale « Changer statut » (admin comme
 *    livreur) et refusé si forcé dans le corps de la requête ;
 *  - colis admis au scan : reçu en agence (RECEIVED) ou en distribution
 *    (DISTRIBUTION / IN_PROGRESS, statuts seconds compris) ; un colis livré,
 *    retourné, facturé ou déjà en attente de confirmation est refusé ;
 *  - un colis qui le porte (parcel_status = IN_PROGRESS + parcel_status_second
 *    = WAITING_CONFIRMATION) reste affecté à son livreur mais son statut est
 *    verrouillé pour les types 5 (livreur) et 6 (ramasseur) : seuls les
 *    employés de type 1-4 peuvent le faire évoluer (« Changer statut » de la
 *    page Sans adresse ou de la page Colis, ajout à un bon de distribution).
 */

const STATUT_ATTENTE_CONFIRMATION = 'WAITING_CONFIRMATION';

/* Types d'employé autorisés à changer le statut d'un colis en attente de confirmation. */
const TYPES_CONFIRMATION = [1, 2, 3, 4];

/* Statuts principaux d'un colis scannable « sans adresse ». */
const STATUTS_SCAN_SANS_ADRESSE = ['RECEIVED', 'DISTRIBUTION', 'IN_PROGRESS'];

/** Vrai si l'utilisateur connecté (req.user) peut lever le statut. */
function peutConfirmer(user) {
  return Boolean(user) && user.kind === 'employee' && TYPES_CONFIRMATION.includes(Number(user.role));
}

/** Vrai si le couple (parcel_status, parcel_status_second) = attente de confirmation. */
function enAttenteConfirmation(status, second) {
  return status === 'IN_PROGRESS' && String(second || '').trim() === STATUT_ATTENTE_CONFIRMATION;
}

module.exports = {
  STATUT_ATTENTE_CONFIRMATION,
  TYPES_CONFIRMATION,
  STATUTS_SCAN_SANS_ADRESSE,
  peutConfirmer,
  enAttenteConfirmation
};
