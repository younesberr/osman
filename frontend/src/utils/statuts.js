import api from '../api/client';

/** Libellés français par défaut des codes statut colis (delevery_parcel_statut).
 * Secours seulement : les libellés affichés viennent de delevery_string
 * (modifiables via Configuration > Options), chargés par hydrateStatutLabels(). */
const STATUT_LABELS = {
  NEW_PARCEL: 'Nouveau colis',
  WAITING_PICKUP: 'En attente de ramassage',
  PICKED_UP: 'Ramassé',
  SENT: 'Expédié',
  RECEIVED: 'Reçu en agence',
  DISTRIBUTION: 'En distribution',
  IN_PROGRESS: 'En cours',
  DELIVERED: 'Livré',
  RETURNED: 'Retourné',
  SENT_BY_AMANA: 'Expédié via Amana',
  POSTPONED: 'Reporté',
  NOANSWER: 'Pas de réponse',
  REFUSED: 'Refusé',
  NOT_PAID: 'Non payé',
  PAID: 'Payé',
  INVOICED: 'Facturé',
  // Statuts seconds (affichés quand parcel_status = IN_PROGRESS)
  REFUSE: 'Refusé',
  CANCELED: 'Annulé',
  UNREACHABLE: 'Injoignable',
  OUT_OF_AREA: 'Hors zone',
  DEUX: '2ème appel sans réponse',
  TROIS: '3ème appel sans réponse',
  ERR: 'Numéro erroné',
  BV: 'Boîte vocale',
  PROGRAMMER: 'Programmé',
  CLIENT_INTERESE: 'Client intéressé',
  EN_VOYAGE: 'En voyage',
  RELENCE_NEW_CLIENT: 'Relance nouveau client',
  WAIT_RELANCE: 'En attente de relance',
  RETURN_BY_AMANA: 'En retour par Amana',
  CANCELED_BY_VENDEUR: 'Annulé par le vendeur',
  RETURNED_BY_LIVREUR: 'Retourné par le livreur',
  EXPEDIE_AGENCE_PRINCIPALE: 'Expédié vers agence principale',
  RECU_PAR_AGENCE: "Reçu par l'agence",
  RETURNED_TO_CITY_RAMASSAGE: 'Retourné à la ville de ramassage',
  RECU_VILLE_RAMASSAGE: 'Reçu ville de ramassage',
  RETURNED_TO_CUSTOMER: 'Retourné au client',
  RECU_BY_CUSTOMER: 'Reçu par le client',
  RETURNED_TO_STOCK: 'Retourné au stock',
  WAITING_RESHIP: 'Attente réexpédition',
  WAITING_CONFIRMATION: 'Attente confirmation'
};

/* Statut second « Attente réexpédition » (types 1-4 uniquement) : le colis
 * reste chez son livreur, statut verrouillé pour lui, jusqu'à son ajout à un
 * bon d'envoi (backend : utils/reexpedition.js). */
export const STATUT_ATTENTE_REEXPEDITION = 'WAITING_RESHIP';

/* Statut second « Attente confirmation » : posé uniquement par le scan de la
 * page Colis besoin d'attention › Sans adresse ; verrouillé pour le livreur
 * comme l'attente de réexpédition (backend : utils/sansAdresse.js). */
export const STATUT_ATTENTE_CONFIRMATION = 'WAITING_CONFIRMATION';

/* Libellés chargés depuis la base ; prioritaires sur STATUT_LABELS. */
let labelsBdd = {};
let chargement = null;

/** Charge (une seule fois) les libellés de delevery_string. Appelée par
 * SidebarLayout au montage ; relance possible après un échec réseau. */
export function hydrateStatutLabels() {
  if (!chargement) {
    chargement = api
      .get('/parcels/statuts/libelles')
      .then((res) => {
        labelsBdd = res.data || {};
      })
      .catch(() => {
        chargement = null;
      });
  }
  return chargement;
}

/** Recharge les libellés depuis la base (après ajout / renommage d'un statut
 * dans Configuration > Options) pour que les listes déroulantes déjà montées
 * affichent le nouveau nom sans recharger la page. */
export function rafraichirStatutLabels() {
  chargement = null;
  return hydrateStatutLabels();
}

export function statutLabel(code) {
  return labelsBdd[code] || STATUT_LABELS[code] || code || '—';
}
