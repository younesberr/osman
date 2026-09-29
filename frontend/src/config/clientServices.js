/*
 * Tâches attribuables aux membres de l'équipe d'un client (page /client/equipe).
 * Miroir de backend/src/utils/clientServices.js (le backend fait autorité : il
 * recalcule member_services à partir des tâches cochées). Les codes
 * correspondent aux `service` du menu client (config/clientMenu.js).
 * EQUIPE est volontairement absent : la gestion d'équipe est réservée au
 * propriétaire (un membre ne doit pas pouvoir s'attribuer des tâches).
 */

/** Tâches cochables dans la modale membre (ordre du menu client). */
export const CLIENT_SERVICES = [
  { code: 'COLIS_CONSULTATION', label: 'Liste des colis (suivi, étiquettes)' },
  { code: 'COLIS_SAISIE', label: 'Nouveau colis + importation' },
  { code: 'COLIS_MODIFICATION', label: 'Modifier / supprimer un colis en attente' },
  { code: 'RAMASSAGE', label: 'Demande ramassage' },
  { code: 'STOCK_PRODUITS', label: 'Stock — liste des produits' },
  { code: 'STOCK_MOUVEMENTS', label: 'Stock — mouvements' },
  { code: 'REMBOURSEMENT_RECLAMATION', label: 'Remboursements / réclamations' },
  { code: 'FACTURES', label: 'Factures' },
  { code: 'BON_RETOUR', label: 'Bon de retour' },
  { code: 'MESSAGES', label: 'Messages' },
  { code: 'STATISTIQUES', label: 'Statistiques' },
  { code: 'CONFIGURATION', label: 'Configuration' }
];

/** Code → libellé (badges de la liste des membres). */
export const SERVICE_LABELS = Object.fromEntries(CLIENT_SERVICES.map((s) => [s.code, s.label]));

/**
 * Accès d'un compte client à une page / entrée du menu client :
 * le propriétaire (pas de memberId) voit tout ; un membre d'équipe doit avoir
 * la tâche dans ses services (relus par /auth/me à chaque chargement).
 * EQUIPE n'étant jamais attribuable, un membre n'y accède jamais.
 */
export function hasClientAccess(user, service) {
  if (!user || user.kind !== 'customer') return false;
  if (!user.memberId) return true;
  if (!service) return true;
  const granted = Array.isArray(user.services) ? user.services : [];
  return granted.includes(service);
}

/** Libellés des codes d'une liste, dans l'ordre du catalogue. */
export function serviceLabels(codes) {
  return CLIENT_SERVICES.filter((s) => codes.includes(s.code)).map((s) => s.label);
}
