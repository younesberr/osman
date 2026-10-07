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
  'FACTURATION',
  'RETOUR',
  'RAMASSAGE',
  'REMBOURSEMENT',
  'RECLAMATIONS',
  'MODIFICATIONS_COLIS',
  'MESSAGES',
  'NOUVEAUX_CLIENTS',
  'CLIENTS',
  'CAISSE_AGENCE',
  'NOTIFICATIONS_EMPLOYES',
  'LIVREURS',
  'UTILISATEURS',
  'LOGISTIQUES',
  'MATERIEL',
  'STATISTIQUES',
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
      'FACTURATION',
      'RETOUR',
      'RAMASSAGE',
      'CLIENTS',
      'CAISSE_AGENCE'
    ],
    optional: []
  },
  4: {
    defaults: [
      'COLIS',
      'RAMASSAGE_SCAN',
      'BON_ENVOI',
      'BON_DISTRIBUTION',
      'RAMASSAGE'
    ],
    optional: ['STOCK', 'FACTURATION', 'RETOUR', 'CLIENTS']
  },
  5: { defaults: [], optional: [] }, // livreur : pas de dashboard admin
  6: {
    defaults: ['COLIS', 'RAMASSAGE_SCAN', 'BON_ENVOI', 'RAMASSAGE'],
    optional: ['STOCK']
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
