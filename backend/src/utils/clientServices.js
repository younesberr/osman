/*
 * Tâches attribuables aux membres de l'équipe d'un client (page /client/equipe).
 * Les codes sont ceux de delevery_customer_members.member_services (liste
 * séparée par des virgules) et correspondent aux `service` du menu client
 * (frontend/src/config/clientMenu.js — miroir : frontend/src/config/clientServices.js).
 *
 * Le propriétaire (connexion via delevery_customers, pas de memberId dans le
 * JWT) a toujours accès à tout ; un membre n'accède qu'aux tâches cochées.
 * EQUIPE n'existe pas comme code : la gestion d'équipe est réservée au
 * propriétaire (un membre ne doit pas pouvoir s'attribuer des tâches).
 */

/** Tous les codes de tâche du menu client (ordre du menu). */
const CLIENT_SERVICES = [
  'COLIS_CONSULTATION', // liste des colis, suivi, détails, étiquettes
  'COLIS_SAISIE', // nouveau colis + imports Excel (normal & stock)
  'COLIS_MODIFICATION', // modifier / supprimer / bloquer un colis en attente de ramassage
  'RAMASSAGE', // demande de ramassage
  'STOCK_PRODUITS', // produits : liste, création, fiche, statut
  'STOCK_MOUVEMENTS', // mouvements : liste + entrée/sortie
  'REMBOURSEMENT_RECLAMATION', // demandes de remboursement / réclamations
  'FACTURES', // consultation des factures
  'BON_RETOUR', // bons de retour
  'MESSAGES', // messagerie
  'STATISTIQUES', // statistiques
  'CONFIGURATION' // préférences du compte
];

/**
 * member_services à partir des tâches cochées : intersection avec le
 * catalogue (le backend reste l'autorité, comme computeServices pour les
 * employés). Retourne la chaîne à stocker (codes séparés par des virgules).
 */
function computeMemberServices(requested) {
  const asked = Array.isArray(requested)
    ? requested.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  return CLIENT_SERVICES.filter((code) => asked.includes(code)).join(',');
}

module.exports = { CLIENT_SERVICES, computeMemberServices };
