import { ADMIN_MENU } from './adminMenu';

/*
 * Règles d'accès aux menus du dashboard admin par fonction (users_type),
 * utilisées par la modale "Comptes d'accès" de la fiche utilisateur.
 * Miroir de backend/src/utils/typeServices.js (le backend fait autorité :
 * il recalcule users_services à partir de la fonction et des menus cochés).
 */

/**
 * Code de service → libellé du menu admin (pour les cases à cocher).
 * Un même code peut couvrir plusieurs menus (ex. FACTURATION pour
 * « Facturation livreurs » et « Facturation clients ») : libellés joints par « / ».
 * Un sous-menu qui porte son propre `service` donne
 * une case à part, libellée par son `serviceLabel` (sinon « Parent — Enfant »).
 */
export const SERVICE_LABELS = {};

/** Tous les codes de service (uniques), dans l'ordre du menu admin (parent puis ses sous-menus). */
export const ALL_SERVICES = [];

function declarer(code, label) {
  if (!code) return;
  if (!ALL_SERVICES.includes(code)) ALL_SERVICES.push(code);
  SERVICE_LABELS[code] = SERVICE_LABELS[code] ? `${SERVICE_LABELS[code]} / ${label}` : label;
}
for (const item of ADMIN_MENU) {
  declarer(item.service, item.serviceLabel || item.label);
  for (const child of item.children || []) {
    if (child.service && child.service !== item.service) {
      declarer(child.service, child.serviceLabel || `${item.label} — ${child.label}`);
    }
  }
}

/**
 * Par type : services acquis d'office (`defaults`) et cochables (`optional`).
 *  - 1 Super admin          : accès à tout, rien à cocher ;
 *  - 2 Responsable service  : tous les menus cochables librement ;
 *  - 3 Responsable d'agence : liste fixe, non modifiable ;
 *  - 4 Agent d'agence       : défauts + optionnels ;
 *  - 5 Livreur              : pas de dashboard admin ;
 *  - 6 Ramasseur            : défauts + optionnels.
 */
export const TYPE_RULES = {
  1: { defaults: [], optional: [] },
  2: { defaults: [], optional: ALL_SERVICES },
  3: {
    defaults: [
      'COLIS',
      'STOCK',
      'RAMASSAGE_SCAN',
      'BON_ENVOI',
      'BON_DISTRIBUTION',
      'COLIS_SANS_ADRESSE',
      'FACTURATION',
      'RETOUR',
      'RAMASSAGE',
      'COLIS_ZERO',
      'CLIENTS',
      'CLIENTS_NON_VERIFIES',
      'CAISSE_AGENCE',
      'TRANSPORT',
      'TICKETS_VIDES'
    ],
    optional: []
  },
  4: {
    defaults: [
      'COLIS',
      'RAMASSAGE_SCAN',
      'BON_ENVOI',
      'BON_DISTRIBUTION',
      'COLIS_SANS_ADRESSE',
      'RAMASSAGE',
      'TICKETS_VIDES'
    ],
    optional: ['STOCK', 'FACTURATION', 'RETOUR', 'COLIS_ZERO', 'CLIENTS', 'CLIENTS_NON_VERIFIES', 'TRANSPORT']
  },
  5: { defaults: [], optional: [] },
  6: {
    defaults: ['COLIS', 'RAMASSAGE_SCAN', 'BON_ENVOI', 'RAMASSAGE'],
    optional: ['STOCK', 'TRANSPORT', 'TICKETS_VIDES']
  }
};

/** Types dont le compte est rattaché à une agence (champ Agence de la modale). */
export const TYPES_AVEC_AGENCE = [3, 4, 5, 6];

/** Libellés des codes d'une liste, dans l'ordre du menu admin. */
export function serviceLabels(codes) {
  return ALL_SERVICES.filter((code) => codes.includes(code)).map((code) => SERVICE_LABELS[code]);
}
