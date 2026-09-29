/*
 * Statut « Attente réexpédition » (WAITING_RESHIP, statut second type 3 —
 * sql/2026-09-10_statut-attente-reexpedition.sql), partagé entre la modale
 * « Changer statut » (parcelsAdmin.controller), les bons d'envoi
 * (bonsEnvoi.controller), les bons de distribution et les bons de retour
 * livreur.
 *
 * Règles :
 *  - posé uniquement par un employé de type 1, 2, 3 ou 4 (TYPES_REEXPEDITION) ;
 *    un livreur (5) ou un ramasseur (6) ne le voit pas dans la liste des
 *    statuts et ne peut pas le poser ;
 *  - un colis qui le porte (parcel_status = IN_PROGRESS + parcel_status_second
 *    = WAITING_RESHIP) reste affecté à son livreur et visible sur son
 *    dashboard, mais son statut est verrouillé pour les types 5 et 6 ; seuls
 *    les types 1-4 peuvent encore le changer ;
 *  - il est ajoutable à un bon d'envoi comme un colis « Ramassé » : il repart
 *    SENT → RECEIVED → distribution, comme un colis nouvellement ramassé. Il
 *    n'est ni distribuable directement ni retournable tant qu'il attend.
 */

const STATUT_ATTENTE_REEXPEDITION = 'WAITING_RESHIP';

/* Types d'employé autorisés à poser le statut / à modifier un colis qui le porte. */
const TYPES_REEXPEDITION = [1, 2, 3, 4];

/** Vrai si l'utilisateur connecté (req.user) peut poser / lever le statut. */
function peutReexpedier(user) {
  return Boolean(user) && user.kind === 'employee' && TYPES_REEXPEDITION.includes(Number(user.role));
}

/** Vrai si le couple (parcel_status, parcel_status_second) = attente de réexpédition. */
function enAttenteReexpedition(status, second) {
  return status === 'IN_PROGRESS' && String(second || '').trim() === STATUT_ATTENTE_REEXPEDITION;
}

/**
 * Condition SQL « colis ajoutable à un bon d'envoi » (alias de delevery_parcel) :
 * ramassé, ou en attente de réexpédition. Aucun paramètre.
 */
function aExpedierSql(alias = 'p') {
  return `(${alias}.parcel_status = 'PICKED_UP'
      OR (${alias}.parcel_status = 'IN_PROGRESS'
          AND ${alias}.parcel_status_second = '${STATUT_ATTENTE_REEXPEDITION}'))`;
}

/** Condition SQL « colis PAS en attente de réexpédition » (alias de delevery_parcel). */
function pasEnAttenteReexpeditionSql(alias = 'p') {
  return `NOT (${alias}.parcel_status = 'IN_PROGRESS'
      AND ${alias}.parcel_status_second = '${STATUT_ATTENTE_REEXPEDITION}')`;
}

module.exports = {
  STATUT_ATTENTE_REEXPEDITION,
  TYPES_REEXPEDITION,
  peutReexpedier,
  enAttenteReexpedition,
  aExpedierSql,
  pasEnAttenteReexpeditionSql
};
