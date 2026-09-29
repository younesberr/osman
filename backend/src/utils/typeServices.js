/*
 * Règles d'accès aux menus du dashboard admin par fonction (users_type).
 * Les codes sont ceux de delevery_users.users_services (liste séparée par des
 * virgules) et correspondent aux `service` du menu admin
 * (frontend/src/config/adminMenu.js — miroir : frontend/src/config/typeServices.js).
 *
 *  - type 1 (Super admin)          : accès à tout (users_services ignoré) ;
 *  - type 2 (Responsable service)  : menus choisis librement à la création du compte ;
 *  - type 3 (Responsable d'agence) : liste fixe, non modifiable ;
 *  - type 4 (Agent d'agence)       : menus par défaut + menus optionnels cochés ;
 *  - type 5 (Livreur)              : pas d'accès au dashboard admin ;
 *  - type 6 (Ramasseur)            : menus par défaut + menus optionnels cochés.
 */

/** Tous les codes de service du menu admin (ordre du menu). */
const ALL_SERVICES = [
  'COLIS',
  'IMPORT', // Import Colis — code legacy, déjà utilisé par l'ancien système dans users_services

  'STOCK',
  'RAMASSAGE_SCAN',
  'BON_ENVOI',
  'BON_DISTRIBUTION',
  'COLIS_SANS_ADRESSE', // Sans adresse (menu à part sous Bons de distribution) — types 1-2 (case « Colis sans adresse »), 3-4 d'office (agence)
  'FACTURATION',
  'RETOUR',
  'SUIVI_RETOUR',
  'RAMASSAGE',
  'REMBOURSEMENT',
  'RECLAMATIONS',
  'MODIFICATIONS_COLIS',
  'COLIS_ZERO',
  'COLIS_ATTENTION',
  'MESSAGES',
  'NOUVEAUX_CLIENTS',
  'CLIENTS',
  'CLIENTS_NON_VERIFIES',
  'CAISSE_AGENCE',
  'NOTIFICATIONS_EMPLOYES',
  'TRANSPORT',
  'TICKETS_VIDES',
  'LIVREURS',
  'UTILISATEURS',
  'LOGISTIQUES',
  'MATERIEL',
  'COMPTABILITES',
  'STATISTIQUES',
  'API_LIAISON', // API liaison (hors Discussions) — types 1 et 2 uniquement (ni défaut ni optionnel pour 3, 4, 6)
  'WHATSAPP_DISCUSSIONS', // API liaison › Discussions WhatsApp seules — types 1 et 2, indépendant d'API_LIAISON
  'CONFIGURATION'
];

/** Par type : services acquis d'office (`defaults`) et cochables (`optional`). */
const TYPE_RULES = {
  1: { defaults: [], optional: [] }, // superAdmin : accès total via users_type
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
  5: { defaults: [], optional: [] }, // livreur : pas de dashboard admin
  6: {
    defaults: ['COLIS', 'RAMASSAGE_SCAN', 'BON_ENVOI', 'RAMASSAGE'],
    optional: ['STOCK', 'TRANSPORT', 'TICKETS_VIDES']
  }
};

/** Types dont le compte est rattaché à une agence (champ Agence de la modale). */
const TYPES_AVEC_AGENCE = [3, 4, 5, 6];

/**
 * users_services d'un compte à partir de sa fonction et des menus cochés :
 * défauts du type + intersection des cochés avec les optionnels autorisés.
 * Retourne la chaîne à stocker (codes séparés par des virgules).
 */
function computeServices(type, requested) {
  const rules = TYPE_RULES[type];
  if (!rules) return '';
  const asked = Array.isArray(requested)
    ? requested.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  const extra = rules.optional.filter((code) => asked.includes(code));
  return [...new Set([...rules.defaults, ...extra])].join(',');
}

module.exports = { ALL_SERVICES, TYPE_RULES, TYPES_AVEC_AGENCE, computeServices };
