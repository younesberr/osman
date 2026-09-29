const pool = require('../config/db');
const { STATUT_CODE_SQL } = require('../utils/statutEffectif');
const { LIVREUR_PHONE_SQL } = require('../utils/livreurPhone');
const { formatPhoneAffichage } = require('../utils/phone');
const { statutLabel } = require('../utils/statutLabels');
const { lireConfigs } = require('./whatsapp');

/*
 * Catalogue des événements métier déclencheurs des actions automatiques
 * WhatsApp (page /admin/api-liaison/whatsapp/actions), audiences possibles,
 * variables disponibles par contexte et résolution des données à partir du
 * payload d'un événement (ids uniquement : les contrôleurs n'envoient que des
 * identifiants après commit, ce module relit la base).
 * Ce module n'importe jamais de contrôleur (les contrôleurs importent
 * whatsappRegles) : un require paresseux est utilisé pour les rares helpers
 * de contrôleur (montant net d'une facture client).
 * Numéro du client expéditeur : téléphone personnel (customers_phone_personal)
 * en priorité, téléphone du magasin (customers_phone) seulement en repli ; la
 * variable `client_tel` affichée dans les messages reste celle du magasin.
 */

const PARAM_MAX = 300;

/*
 * Séparateur de milliers : espace insécable (U+00A0), jamais un espace ordinaire.
 * Dans un modèle en arabe (texte de droite à gauche), « 1 190 » avec un espace
 * ordinaire est réordonné par l'algorithme bidi et s'affiche « 190 1 » ; l'espace
 * insécable est un séparateur commun (classe bidi CS) qui garde le nombre d'un
 * seul tenant, en arabe comme en français. `formaterParam` le préserve.
 */
const SEP_MILLIERS = '\u00A0';

/*
 * Mod\u00E8les \u00E9crits de droite \u00E0 gauche (arabe\u2026) : l'affichage WhatsApp r\u00E9ordonne
 * les groupes de chiffres s\u00E9par\u00E9s par un blanc (\u00AB 1 190 \u00BB devient \u00AB 190 1 \u00BB,
 * \u00AB 06 12 34 56 78 \u00BB devient \u00AB 78 56 34 12 06 \u00BB). Pour ces langues, les blancs
 * entre chiffres sont retir\u00E9s des param\u00E8tres (\u00AB 1190 \u00BB, \u00AB 0612345678 \u00BB) : un
 * nombre d'un seul tenant s'affiche toujours dans le bon ordre, quel que soit
 * le traitement des espaces par Meta.
 */
const LANGUES_RTL = /^(ar|he|fa|ur)(_|$)/i;

function langueRtl(langue) {
  return LANGUES_RTL.test(String(langue || ''));
}

/** Retire les blancs entre chiffres quand le mod\u00E8le est en langue RTL ; inchang\u00E9 sinon. */
function bidiSafe(texte, langue) {
  if (!langueRtl(langue)) return texte;
  return String(texte).replace(/(\d)[ \u00A0\u202F]+(?=\d)/g, '$1');
}

/** Audiences : code → libellé. */
const AUDIENCES = {
  destinataire: 'Destinataire du colis',
  expediteur: 'Client expéditeur',
  livreur: 'Livreur',
  ramasseur: 'Ramasseur',
  admin: 'Employé(s) choisi(s)'
};

/** Contextes de résolution des variables. */
const CONTEXTES = {
  COLIS: 'Colis',
  LOT_COLIS: 'Lot de colis',
  RAMASSAGE: 'Demande de ramassage',
  BON_DISTRIBUTION: 'Bon de distribution',
  BON_RETOUR_CLIENT: 'Bon de retour client',
  RECLAMATION: 'Réclamation',
  REMBOURSEMENT: 'Remboursement',
  MODIF: 'Modification de colis',
  FACTURE_CLIENT: 'Facture client',
  FACTURE_LIVREUR: 'Facture livreur',
  MESSAGE_RECU: 'Message WhatsApp reçu'
};

/* Contextes qui portent les variables d'un colis. */
const CTX_COLIS = ['COLIS', 'RECLAMATION', 'REMBOURSEMENT', 'MODIF', 'MESSAGE_RECU'];
const CTX_CLIENT = [...CTX_COLIS, 'LOT_COLIS', 'RAMASSAGE', 'BON_RETOUR_CLIENT', 'FACTURE_CLIENT'];

/**
 * Événements : code, libellé, contexte, audiences autorisées, `statuts` = la
 * règle peut filtrer sur des codes de statut (événement STATUT), description
 * affichée dans la page.
 */
const EVENEMENTS = [
  {
    code: 'COLIS_CREE',
    label: 'Colis créé',
    contexte: 'COLIS',
    audiences: ['destinataire', 'admin'],
    description: 'Un colis vient d’être saisi (client, admin) ou importé (un événement par colis).'
  },
  {
    code: 'COLIS_IMPORTES',
    label: 'Colis importés (lot)',
    contexte: 'LOT_COLIS',
    audiences: ['expediteur', 'admin'],
    description: 'Un import Excel vient de créer plusieurs colis pour un client (un seul message par import).'
  },
  {
    code: 'STATUT',
    label: 'Changement de statut du colis',
    contexte: 'COLIS',
    audiences: ['destinataire', 'expediteur', 'livreur', 'admin'],
    statuts: true,
    description:
      'Le colis change de statut (ramassé, expédié, reçu en agence, en distribution, livré, refusé, reporté, retourné, attente confirmation après le scan « Sans adresse »…). Choisissez les statuts concernés ; aucun = tous.'
  },
  {
    code: 'BON_DISTRIBUTION_ENREGISTRE',
    label: 'Bon de distribution enregistré',
    contexte: 'BON_DISTRIBUTION',
    audiences: ['livreur', 'admin'],
    description: 'Un bon de distribution est enregistré pour un livreur (nombre de colis connu).'
  },
  {
    code: 'BON_RETOUR_CLIENT_EXPEDIE',
    label: 'Bon de retour client expédié',
    contexte: 'BON_RETOUR_CLIENT',
    audiences: ['expediteur', 'ramasseur', 'admin'],
    description: 'Les colis retournés partent vers le client.'
  },
  {
    code: 'RAMASSAGE_CREEE',
    label: 'Demande de ramassage créée',
    contexte: 'RAMASSAGE',
    audiences: ['expediteur', 'admin'],
    description: 'Nouvelle demande de ramassage (client, admin, automatique ou périodique).'
  },
  {
    code: 'RAMASSAGE_AFFECTEE',
    label: 'Ramassage affecté à un ramasseur',
    contexte: 'RAMASSAGE',
    audiences: ['expediteur', 'ramasseur', 'admin'],
    description: 'La demande est affectée à un ramasseur.'
  },
  {
    code: 'RAMASSAGE_EFFECTUEE',
    label: 'Ramassage effectué',
    contexte: 'RAMASSAGE',
    audiences: ['expediteur', 'admin'],
    description: 'Le ramasseur a marqué la demande comme ramassée.'
  },
  {
    code: 'RAMASSAGE_ANNULEE',
    label: 'Ramassage annulé',
    contexte: 'RAMASSAGE',
    audiences: ['expediteur', 'ramasseur', 'admin'],
    description: 'La demande de ramassage est annulée.'
  },
  {
    code: 'RECLAMATION_CREEE',
    label: 'Réclamation créée',
    contexte: 'RECLAMATION',
    audiences: ['expediteur', 'admin'],
    description: 'Une réclamation est ouverte sur un colis (client ou admin).'
  },
  {
    code: 'RECLAMATION_TRAITEE',
    label: 'Réclamation traitée',
    contexte: 'RECLAMATION',
    audiences: ['expediteur', 'admin'],
    description: 'La réclamation est clôturée avec une note de traitement.'
  },
  {
    code: 'REMB_DEMANDE',
    label: 'Remboursement demandé',
    contexte: 'REMBOURSEMENT',
    audiences: ['expediteur', 'admin'],
    description: 'Une demande de remboursement est déposée (client ou admin).'
  },
  {
    code: 'REMB_ACCEPTE',
    label: 'Remboursement accepté',
    contexte: 'REMBOURSEMENT',
    audiences: ['expediteur', 'destinataire', 'livreur', 'admin'],
    description: 'La demande est acceptée (colis de remboursement créé).'
  },
  {
    code: 'REMB_REFUSE',
    label: 'Remboursement refusé',
    contexte: 'REMBOURSEMENT',
    audiences: ['expediteur', 'admin'],
    description: 'La demande est refusée.'
  },
  {
    code: 'MODIF_ACCEPTEE',
    label: 'Modification de colis acceptée',
    contexte: 'MODIF',
    audiences: ['expediteur', 'admin'],
    description: 'La demande de modification du client est appliquée au colis.'
  },
  {
    code: 'MODIF_REFUSEE',
    label: 'Modification de colis refusée',
    contexte: 'MODIF',
    audiences: ['expediteur', 'admin'],
    description: 'La demande de modification est refusée.'
  },
  {
    code: 'FACTURE_CLIENT_ENREGISTREE',
    label: 'Facture client enregistrée',
    contexte: 'FACTURE_CLIENT',
    audiences: ['expediteur', 'admin'],
    description: 'Une facture client passe du brouillon à « Enregistrée » (disponible pour le client).'
  },
  {
    code: 'FACTURE_CLIENT_PAYEE',
    label: 'Facture client payée',
    contexte: 'FACTURE_CLIENT',
    audiences: ['expediteur', 'admin'],
    description: 'Une facture client est marquée payée.'
  },
  {
    code: 'FACTURE_LIVREUR_ENREGISTREE',
    label: 'Facture livreur enregistrée',
    contexte: 'FACTURE_LIVREUR',
    audiences: ['livreur', 'admin'],
    description: 'Une facture livreur passe du brouillon à « Enregistrée ».'
  },
  {
    code: 'FACTURE_LIVREUR_PAYEE',
    label: 'Facture livreur payée',
    contexte: 'FACTURE_LIVREUR',
    audiences: ['livreur', 'admin'],
    description: 'Une facture livreur est marquée payée.'
  },
  {
    code: 'MESSAGE_RECU',
    label: 'Message WhatsApp reçu (notifier un employé)',
    contexte: 'MESSAGE_RECU',
    audiences: ['admin'],
    description:
      'Un contact écrit sur le numéro WhatsApp de la société alors que sa discussion n’avait aucun message non lu. Utile pour prévenir un employé par WhatsApp.'
  }
];

const EVENEMENTS_PAR_CODE = Object.fromEntries(EVENEMENTS.map((e) => [e.code, e]));

/** Variables : code, libellé, contextes (['*'] = tous), exemple d'aperçu. */
const VARIABLES = [
  { code: 'destinataire', label: 'Nom du destinataire', contextes: CTX_COLIS, exemple: 'Ahmed Alaoui' },
  { code: 'destinataire_tel', label: 'Téléphone du destinataire', contextes: CTX_COLIS, exemple: '06 12 34 56 78' },
  { code: 'code', label: 'Code du colis', contextes: CTX_COLIS, exemple: 'DRG0726266195TO' },
  { code: 'crbt', label: 'Montant CRBT', contextes: CTX_COLIS, exemple: '250 DH' },
  { code: 'crbt_nombre', label: 'Montant CRBT (nombre seul, sans DH)', contextes: CTX_COLIS, exemple: '250' },
  { code: 'adresse', label: 'Adresse de livraison', contextes: CTX_COLIS, exemple: '12 rue Hassan II' },
  { code: 'ville', label: 'Ville de destination', contextes: CTX_COLIS, exemple: 'Casablanca' },
  { code: 'statut', label: 'Statut du colis (libellé)', contextes: CTX_COLIS, exemple: 'Livré' },
  { code: 'statut_code', label: 'Statut du colis (code)', contextes: CTX_COLIS, exemple: 'DELIVERED' },
  { code: 'commentaire', label: 'Commentaire du changement de statut', contextes: ['COLIS'], exemple: 'Client absent' },
  { code: 'date_report', label: 'Date programmée / reportée', contextes: ['COLIS'], exemple: '15/09/2026' },
  { code: 'produit', label: 'Marchandise', contextes: CTX_COLIS, exemple: 'Chaussures × 2' },
  { code: 'note', label: 'Remarque du colis', contextes: CTX_COLIS, exemple: 'Appeler avant' },
  { code: 'livreur', label: 'Nom du livreur', contextes: [...CTX_COLIS, 'BON_DISTRIBUTION', 'FACTURE_LIVREUR'], exemple: 'Youssef' },
  { code: 'livreur_tel', label: 'Téléphone du livreur', contextes: [...CTX_COLIS, 'BON_DISTRIBUTION', 'FACTURE_LIVREUR'], exemple: '06 61 00 00 00' },
  { code: 'magasin', label: 'Magasin (client expéditeur)', contextes: CTX_CLIENT, exemple: 'Boutique Nour' },
  { code: 'client', label: 'Nom du client expéditeur', contextes: CTX_CLIENT, exemple: 'Sara Benali' },
  { code: 'client_tel', label: 'Téléphone du client', contextes: CTX_CLIENT, exemple: '06 00 11 22 33' },
  { code: 'ville_ramassage', label: 'Ville de ramassage', contextes: [...CTX_COLIS, 'RAMASSAGE'], exemple: 'Rabat' },
  { code: 'nb_colis', label: 'Nombre de colis', contextes: ['LOT_COLIS', 'BON_DISTRIBUTION', 'BON_RETOUR_CLIENT', 'FACTURE_CLIENT', 'FACTURE_LIVREUR'], exemple: '12' },
  { code: 'codes_colis', label: 'Codes des colis (liste courte)', contextes: ['LOT_COLIS'], exemple: 'DRG…195TO, DRG…196TO' },
  { code: 'ref_bon', label: 'Référence du bon', contextes: ['BON_DISTRIBUTION', 'BON_RETOUR_CLIENT'], exemple: 'BD-2026-001' },
  { code: 'zone', label: 'Zone du bon', contextes: ['BON_DISTRIBUTION'], exemple: 'Casablanca centre' },
  { code: 'ramasseur', label: 'Nom du ramasseur', contextes: ['RAMASSAGE', 'BON_RETOUR_CLIENT'], exemple: 'Karim' },
  { code: 'ramasseur_tel', label: 'Téléphone du ramasseur', contextes: ['RAMASSAGE', 'BON_RETOUR_CLIENT'], exemple: '06 70 00 00 00' },
  { code: 'ramassage_adresse', label: 'Adresse de ramassage', contextes: ['RAMASSAGE'], exemple: 'Bd Zerktouni, Casablanca' },
  { code: 'ramassage_tel', label: 'Téléphone de la demande', contextes: ['RAMASSAGE'], exemple: '06 00 11 22 33' },
  { code: 'ramassage_note', label: 'Remarque de la demande', contextes: ['RAMASSAGE'], exemple: '5 colis prêts' },
  { code: 'ramassage_heure', label: 'Heure de ramassage (fiche client)', contextes: ['RAMASSAGE'], exemple: '16:00' },
  { code: 'titre_reclamation', label: 'Titre de la réclamation', contextes: ['RECLAMATION'], exemple: 'Colis endommagé' },
  { code: 'texte_reclamation', label: 'Texte de la réclamation', contextes: ['RECLAMATION'], exemple: 'Le carton est ouvert…' },
  { code: 'note_traitement', label: 'Note de traitement', contextes: ['RECLAMATION'], exemple: 'Remboursé au client' },
  { code: 'montant_remb', label: 'Montant du remboursement', contextes: ['REMBOURSEMENT'], exemple: '250 DH' },
  { code: 'montant_remb_nombre', label: 'Montant du remboursement (nombre seul, sans DH)', contextes: ['REMBOURSEMENT'], exemple: '250' },
  { code: 'code_remb', label: 'Code du colis de remboursement', contextes: ['REMBOURSEMENT'], exemple: 'DRG…195TO_REMB' },
  { code: 'nb_changements', label: 'Nombre de modifications', contextes: ['MODIF'], exemple: '2' },
  { code: 'numero_facture', label: 'Numéro de facture', contextes: ['FACTURE_CLIENT', 'FACTURE_LIVREUR'], exemple: 'FC-2026-0125' },
  { code: 'montant_facture', label: 'Montant de la facture', contextes: ['FACTURE_CLIENT', 'FACTURE_LIVREUR'], exemple: formatDh(3450) },
  { code: 'montant_facture_nombre', label: 'Montant de la facture (nombre seul, sans DH)', contextes: ['FACTURE_CLIENT', 'FACTURE_LIVREUR'], exemple: formatNombre(3450) },
  { code: 'date_facture', label: 'Date de la facture', contextes: ['FACTURE_CLIENT', 'FACTURE_LIVREUR'], exemple: '12/09/2026' },
  { code: 'expediteur_nom', label: 'Nom du contact (message reçu)', contextes: ['MESSAGE_RECU'], exemple: 'Ahmed' },
  { code: 'expediteur_tel', label: 'Téléphone du contact', contextes: ['MESSAGE_RECU'], exemple: '06 12 34 56 78' },
  { code: 'apercu', label: 'Extrait du message reçu', contextes: ['MESSAGE_RECU'], exemple: 'Bonjour, où est mon colis ?' },
  { code: 'type_contact', label: 'Type de contact', contextes: ['MESSAGE_RECU'], exemple: 'Destinataire' },
  { code: 'societe', label: 'Nom de la société', contextes: ['*'], exemple: 'ORTALOG' },
  { code: 'societe_tel', label: 'Téléphone de la société', contextes: ['*'], exemple: '05 22 00 00 00' },
  { code: 'date', label: 'Date du jour', contextes: ['*'], exemple: '13/09/2026' },
  { code: 'heure', label: 'Heure', contextes: ['*'], exemple: '14:30' }
];

const VARIABLES_PAR_CODE = Object.fromEntries(VARIABLES.map((v) => [v.code, v]));

/** Variables proposées pour un contexte (spécifiques puis communes). */
function variablesPourContexte(contexte) {
  return VARIABLES.filter((v) => v.contextes.includes('*') || v.contextes.includes(contexte));
}

/** Catalogue pour l'API (page Actions automatiques + mapping par défaut des modèles). */
function catalogue() {
  return {
    evenements: EVENEMENTS.map((e) => ({ ...e, statuts: Boolean(e.statuts), contexteLabel: CONTEXTES[e.contexte] })),
    audiences: AUDIENCES,
    contextes: CONTEXTES,
    variables: VARIABLES
  };
}

/* ------------------------------------------------------------------ */
/* Formatage                                                           */
/* ------------------------------------------------------------------ */

/** Paramètre de modèle Meta : une seule ligne, espaces simples (l'espace insécable des milliers est conservé), ≤ 300 caractères, jamais vide. */
function formaterParam(value) {
  const s = String(value ?? '').replace(/[^\S\u00A0]+/g, ' ').trim();
  if (!s) return '—';
  return s.length > PARAM_MAX ? `${s.slice(0, PARAM_MAX - 1)}…` : s;
}

/** Montant sans unité : 1250 → « 1 250 », 12.5 → « 12,50 » (pour les modèles dont le texte porte déjà « DH »). */
function formatNombre(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return '0';
  const entier = Number.isInteger(n);
  const s = entier ? String(Math.trunc(n)) : n.toFixed(2).replace('.', ',');
  const [partieEntiere, dec] = s.split(',');
  const groupes = partieEntiere.replace(/\B(?=(\d{3})+(?!\d))/g, SEP_MILLIERS);
  return `${groupes}${dec ? `,${dec}` : ''}`;
}

/** Montant en dirhams : 1250 → « 1 250 DH », 12.5 → « 12,50 DH ». */
function formatDh(value) {
  return `${formatNombre(value)} DH`;
}

const pad2 = (n) => String(n).padStart(2, '0');

function formatDateJJMMAAAA(d) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Date depuis un timestamp unix (secondes), une chaîne AAAA-MM-JJ, JJ/MM/AAAA ou Date. */
function formatDateQuelconque(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : formatDateJJMMAAAA(value);
  const s = String(value).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  if (/^\d{9,10}$/.test(s)) return formatDateJJMMAAAA(new Date(Number(s) * 1000));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : formatDateJJMMAAAA(d);
}

/* ------------------------------------------------------------------ */
/* Société (cache 5 min)                                               */
/* ------------------------------------------------------------------ */

let societeCache = null;
let societeExpire = 0;

async function infosSociete() {
  const now = Date.now();
  if (societeCache && now < societeExpire) return societeCache;
  const c = await lireConfigs(['ortalog_company_name', 'ortalog_company_tel_mobile', 'ortalog_company_tel_fixe']);
  societeCache = {
    societe: c.ortalog_company_name?.trim() || 'ORTALOG',
    societe_tel: (c.ortalog_company_tel_mobile || c.ortalog_company_tel_fixe || '').trim()
  };
  societeExpire = now + 5 * 60 * 1000;
  return societeCache;
}

/* ------------------------------------------------------------------ */
/* Résolution des contextes                                            */
/* ------------------------------------------------------------------ */

const SQL_COLIS = `
  SELECT p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone, p.parcel_address,
         p.parcel_price, COALESCE(p.parcel_crbt_zero, 0) AS parcel_crbt_zero,
         p.parcel_status, p.parcel_status_second, p.parcel_situation, p.parcel_report_time,
         p.parcel_note, p.parcel_product_name, p.parcel_product_qty, p.parcel_from_stock,
         p.parcel_customer, p.parcel_livreur,
         (${STATUT_CODE_SQL}) AS statut_code,
         t.nom_ville  AS ville,
         tr.nom_ville AS ville_ramassage,
         c.customers_id, COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin,
         c.customers_name AS client_nom, c.customers_phone AS client_tel,
         c.customers_phone_personal AS client_tel_perso,
         u.users_id AS livreur_id, u.users_name AS livreur_nom,
         ${LIVREUR_PHONE_SQL('u')} AS livreur_tel
    FROM delevery_parcel p
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
    LEFT JOIN delevery_tarifs t     ON t.ville_id = p.parcel_city
    LEFT JOIN delevery_tarifs tr    ON tr.ville_id = c.customers_pickup_city
    LEFT JOIN delevery_users u      ON u.users_id = p.parcel_livreur
   WHERE p.parcel_id = ? LIMIT 1`;

/** Données d'un colis (+ client + livreur) ; null si introuvable. */
async function chargerColis(parcelId, payload = {}) {
  const id = Number(parcelId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[p]] = await pool.query(SQL_COLIS, [id]);
  if (!p) return null;
  const codeStatut = payload.code || p.statut_code || p.parcel_status;
  const qty = Number(p.parcel_product_qty) || 0;
  return {
    destinataire: p.parcel_receiver || '',
    destinataire_tel: formatPhoneAffichage(p.parcel_phone),
    code: p.parcel_code || '',
    crbt: Number(p.parcel_crbt_zero) === 1 ? '0 DH' : formatDh(p.parcel_price),
    crbt_nombre: Number(p.parcel_crbt_zero) === 1 ? '0' : formatNombre(p.parcel_price),
    adresse: p.parcel_address || '',
    ville: p.ville || '',
    statut: await statutLabel(codeStatut),
    statut_code: codeStatut || '',
    commentaire: payload.commentaire || '',
    date_report: formatDateQuelconque(payload.dateReport || p.parcel_report_time),
    produit: p.parcel_product_name ? `${p.parcel_product_name}${qty > 1 ? ` × ${qty}` : ''}` : '',
    note: p.parcel_note || '',
    livreur: p.livreur_nom || '',
    livreur_tel: formatPhoneAffichage(p.livreur_tel),
    magasin: p.magasin || '',
    client: p.client_nom || '',
    client_tel: formatPhoneAffichage(p.client_tel),
    ville_ramassage: p.ville_ramassage || '',
    _phones: {
      destinataire: p.parcel_phone || '',
      expediteur: p.client_tel_perso || p.client_tel || '',
      livreur: payload.livreurId ? null : p.livreur_tel || ''
    },
    _ids: {
      parcelId: p.parcel_id,
      customerId: p.customers_id || null,
      livreurId: payload.livreurId || p.livreur_id || null
    },
    _noms: { destinataire: p.parcel_receiver || '', expediteur: p.magasin || '', livreur: p.livreur_nom || '' }
  };
}

/** Client (magasin, nom, téléphones, ville de ramassage, heure de ramassage). */
async function chargerClient(customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[c]] = await pool.query(
    `SELECT c.customers_id, COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name) AS magasin,
            c.customers_name, c.customers_phone, c.customers_phone_personal, c.customers_address,
            c.customers_ramassage_heure, t.nom_ville AS ville_ramassage
       FROM delevery_customers c
       LEFT JOIN delevery_tarifs t ON t.ville_id = c.customers_pickup_city
      WHERE c.customers_id = ? LIMIT 1`,
    [id]
  );
  return c || null;
}

/** Utilisateur (livreur / ramasseur / employé) avec son numéro utile. */
async function chargerUtilisateur(usersId) {
  const id = Number(usersId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[u]] = await pool.query(
    `SELECT u.users_id, u.users_name, ${LIVREUR_PHONE_SQL('u')} AS phone
       FROM delevery_users u WHERE u.users_id = ? LIMIT 1`,
    [id]
  );
  return u || null;
}

function baseClient(c) {
  if (!c) return { magasin: '', client: '', client_tel: '', ville_ramassage: '', _phones: {}, _ids: {}, _noms: {} };
  return {
    magasin: c.magasin || '',
    client: c.customers_name || '',
    client_tel: formatPhoneAffichage(c.customers_phone),
    ville_ramassage: c.ville_ramassage || '',
    _phones: { expediteur: c.customers_phone_personal || c.customers_phone || '' },
    _ids: { customerId: c.customers_id },
    _noms: { expediteur: c.magasin || '' }
  };
}

/** Fusionne des blocs de données (les sous-objets _phones/_ids/_noms sont fusionnés). */
function fusionner(...blocs) {
  const out = { _phones: {}, _ids: {}, _noms: {} };
  for (const b of blocs) {
    if (!b) continue;
    for (const [k, v] of Object.entries(b)) {
      if (k === '_phones' || k === '_ids' || k === '_noms') Object.assign(out[k], v);
      else out[k] = v;
    }
  }
  return out;
}

async function contexteRamassage(payload) {
  const id = Number(payload.demandeId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[d]] = await pool.query(
    `SELECT r.pickup_request_id, r.pickup_request_customer, r.pickup_request_affected_to,
            r.pickup_request_address, r.pickup_request_phone, r.pickup_request_note, r.pickup_request_statut
       FROM delevery_pickup_request r WHERE r.pickup_request_id = ? LIMIT 1`,
    [id]
  );
  if (!d) return null;
  const client = await chargerClient(d.pickup_request_customer);
  const ramasseurId = payload.ramasseurId || d.pickup_request_affected_to;
  const ram = ramasseurId ? await chargerUtilisateur(ramasseurId) : null;
  return fusionner(baseClient(client), {
    ramasseur: ram?.users_name || '',
    ramasseur_tel: formatPhoneAffichage(ram?.phone),
    ramassage_adresse: d.pickup_request_address || client?.customers_address || '',
    ramassage_tel: formatPhoneAffichage(d.pickup_request_phone || client?.customers_phone),
    ramassage_note: d.pickup_request_note || '',
    ramassage_heure: client?.customers_ramassage_heure || '',
    _phones: { ramasseur: ram?.phone || '' },
    _ids: { ramasseurId: ram?.users_id || null },
    _noms: { ramasseur: ram?.users_name || '' }
  });
}

async function contexteLot(payload) {
  const client = await chargerClient(payload.customerId);
  if (!client) return null;
  const ids = Array.isArray(payload.parcelIds) ? payload.parcelIds.map(Number).filter((n) => n > 0) : [];
  let codes = '';
  if (ids.length) {
    const [rows] = await pool.query('SELECT parcel_code FROM delevery_parcel WHERE parcel_id IN (?) LIMIT 5', [ids]);
    codes = rows.map((r) => r.parcel_code).join(', ') + (ids.length > 5 ? '…' : '');
  }
  return fusionner(baseClient(client), {
    nb_colis: String(Number(payload.nb) || ids.length || 0),
    codes_colis: codes
  });
}

async function contexteBonDistribution(payload) {
  const id = Number(payload.bonId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[b]] = await pool.query(
    `SELECT dn.distribution_note_id, dn.distribution_note_ref, dn.distribution_note_delivery, z.zone_name,
            (SELECT COUNT(*) FROM delevery_dis_parcels dp WHERE dp.dis_parcels_dis = dn.distribution_note_id) AS nb
       FROM delevery_distribution_note dn
       LEFT JOIN delevery_zone z ON z.zone_id = dn.distribution_note_city
      WHERE dn.distribution_note_id = ? LIMIT 1`,
    [id]
  );
  if (!b) return null;
  const liv = await chargerUtilisateur(payload.livreurId || b.distribution_note_delivery);
  return fusionner({
    ref_bon: b.distribution_note_ref || String(b.distribution_note_id),
    zone: b.zone_name || '',
    nb_colis: String(Number(payload.nb) || Number(b.nb) || 0),
    livreur: liv?.users_name || '',
    livreur_tel: formatPhoneAffichage(liv?.phone),
    _phones: { livreur: liv?.phone || '' },
    _ids: { livreurId: liv?.users_id || null },
    _noms: { livreur: liv?.users_name || '' }
  });
}

async function contexteBonRetourClient(payload) {
  const id = Number(payload.bonId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[b]] = await pool.query(
    `SELECT b.rnc_id, b.rnc_ref, b.rnc_customer, b.rnc_affected_to,
            (SELECT COUNT(*) FROM delevery_rnc_parcels rp WHERE rp.rnc_parcels_rnc = b.rnc_id) AS nb
       FROM delevery_return_note_client b WHERE b.rnc_id = ? LIMIT 1`,
    [id]
  );
  if (!b) return null;
  const client = await chargerClient(payload.clientId || b.rnc_customer);
  const ram = await chargerUtilisateur(payload.ramasseurId || b.rnc_affected_to);
  return fusionner(baseClient(client), {
    ref_bon: b.rnc_ref || String(b.rnc_id),
    nb_colis: String(Number(payload.nb) || Number(b.nb) || 0),
    ramasseur: ram?.users_name || '',
    ramasseur_tel: formatPhoneAffichage(ram?.phone),
    _phones: { ramasseur: ram?.phone || '' },
    _ids: { ramasseurId: ram?.users_id || null },
    _noms: { ramasseur: ram?.users_name || '' }
  });
}

async function contexteReclamation(payload) {
  const id = Number(payload.reclamationId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[r]] = await pool.query(
    `SELECT reclamation_id, reclamation_parcel, reclamation_titre, reclamation_text, reclamation_treated_note
       FROM delevery_reclamation_suivre WHERE reclamation_id = ? LIMIT 1`,
    [id]
  );
  if (!r) return null;
  const colis = await chargerColis(payload.parcelId || r.reclamation_parcel);
  return fusionner(colis, {
    titre_reclamation: r.reclamation_titre || '',
    texte_reclamation: String(r.reclamation_text || '').slice(0, 200),
    note_traitement: payload.note || r.reclamation_treated_note || ''
  });
}

async function contexteRemboursement(payload) {
  const id = Number(payload.rembId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[r]] = await pool.query(
    `SELECT remb_id, remb_parcel_id, remb_parcel_code, remb_montant, remb_montant_reel, remb_customer
       FROM delevery_remboursement WHERE remb_id = ? LIMIT 1`,
    [id]
  );
  if (!r) return null;
  const colis = await chargerColis(payload.parcelId || r.remb_parcel_id);
  const montant = payload.montant ?? (r.remb_montant_reel != null && r.remb_montant_reel !== '' ? r.remb_montant_reel : r.remb_montant);
  return fusionner(colis, {
    montant_remb: formatDh(montant),
    montant_remb_nombre: formatNombre(montant),
    code_remb: payload.codeRemb || (r.remb_parcel_code ? `${r.remb_parcel_code}_REMB` : '')
  });
}

async function contexteModif(payload) {
  const id = Number(payload.demandeId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[d]] = await pool.query(
    'SELECT pmd_id, pmd_parcel, pmd_changes FROM delevery_parcel_modif_demande WHERE pmd_id = ? LIMIT 1',
    [id]
  );
  if (!d) return null;
  const colis = await chargerColis(payload.parcelId || d.pmd_parcel);
  let nb = Number(payload.nbChangements) || 0;
  if (!nb && d.pmd_changes) {
    try {
      const ch = JSON.parse(d.pmd_changes);
      nb = Array.isArray(ch) ? ch.length : Object.keys(ch || {}).length;
    } catch {
      nb = 0;
    }
  }
  return fusionner(colis, { nb_changements: String(nb) });
}

async function contexteFactureClient(payload) {
  const id = Number(payload.factureId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[f]] = await pool.query(
    `SELECT i.invoice_id, i.invoice_ref, i.invoice_customer, i.invoice_time,
            (SELECT COUNT(*) FROM delevery_invoice_parcels ip WHERE ip.invoice_parcels_invoice = i.invoice_id) AS nb
       FROM delevery_invoice i WHERE i.invoice_id = ? LIMIT 1`,
    [id]
  );
  if (!f) return null;
  const client = await chargerClient(payload.clientId || f.invoice_customer);
  let montant = 0;
  try {
    // Require paresseux : même calcul que la liste des factures clients.
    montant = await require('../controllers/facturesClients.controller').montantNetFacture(pool, f.invoice_id);
  } catch {
    montant = 0;
  }
  return fusionner(baseClient(client), {
    numero_facture: f.invoice_ref || String(f.invoice_id),
    montant_facture: formatDh(montant),
    montant_facture_nombre: formatNombre(montant),
    date_facture: formatDateQuelconque(f.invoice_time),
    nb_colis: String(Number(f.nb) || 0)
  });
}

async function contexteFactureLivreur(payload) {
  const id = Number(payload.factureId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[f]] = await pool.query(
    `SELECT pn.payment_note_id, pn.payment_note_ref, pn.payment_note_for, pn.payment_note_time,
            (SELECT COUNT(*) FROM delevery_pay_parcels pp WHERE pp.pay_parcels_pay = pn.payment_note_id) AS nb,
            (SELECT COALESCE(SUM(CASE WHEN pp.pay_parcels_statut = 'DELIVERED'
                                      THEN COALESCE(CAST(p.parcel_price AS DECIMAL(12,2)), 0) ELSE 0 END
                                 - COALESCE(pp.pay_parcels_fees, 0)), 0)
               FROM delevery_pay_parcels pp
               LEFT JOIN delevery_parcel p ON p.parcel_id = pp.pay_parcels_parcel
              WHERE pp.pay_parcels_pay = pn.payment_note_id) AS montant
       FROM delevery_payment_note pn WHERE pn.payment_note_id = ? LIMIT 1`,
    [id]
  );
  if (!f) return null;
  const liv = await chargerUtilisateur(payload.livreurId || f.payment_note_for);
  return fusionner({
    numero_facture: f.payment_note_ref || String(f.payment_note_id),
    montant_facture: formatDh(f.montant),
    montant_facture_nombre: formatNombre(f.montant),
    date_facture: formatDateQuelconque(f.payment_note_time),
    nb_colis: String(Number(f.nb) || 0),
    livreur: liv?.users_name || '',
    livreur_tel: formatPhoneAffichage(liv?.phone),
    _phones: { livreur: liv?.phone || '' },
    _ids: { livreurId: liv?.users_id || null },
    _noms: { livreur: liv?.users_name || '' }
  });
}

const TYPES_CONTACT = {
  destinataire: 'Destinataire',
  client: 'Client',
  livreur: 'Livreur',
  employe: 'Employé',
  inconnu: 'Inconnu'
};

async function contexteMessageRecu(payload) {
  const id = Number(payload.conversationId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[c]] = await pool.query(
    `SELECT wac_id, wac_phone, wac_nom, wac_type_contact, wac_dernier_colis, wac_dernier_apercu
       FROM delevery_whatsapp_conversation WHERE wac_id = ? LIMIT 1`,
    [id]
  );
  if (!c) return null;
  let apercu = c.wac_dernier_apercu || '';
  if (payload.messageId) {
    const [[m]] = await pool.query('SELECT wam_contenu FROM delevery_whatsapp_message WHERE wam_id = ? LIMIT 1', [
      Number(payload.messageId)
    ]);
    if (m?.wam_contenu) apercu = m.wam_contenu;
  }
  const colis = c.wac_dernier_colis ? await chargerColis(c.wac_dernier_colis) : null;
  return fusionner(colis, {
    expediteur_nom: c.wac_nom || formatPhoneAffichage(c.wac_phone),
    expediteur_tel: formatPhoneAffichage(c.wac_phone),
    apercu: String(apercu).slice(0, 100),
    type_contact: TYPES_CONTACT[c.wac_type_contact] || 'Inconnu',
    _ids: { conversationId: c.wac_id }
  });
}

/**
 * Données complètes d'un contexte (variables + _phones/_ids/_noms + société +
 * date/heure) ; null si l'objet métier est introuvable.
 */
async function resoudreContexte(contexte, payload = {}) {
  let data;
  switch (contexte) {
    case 'COLIS':
      data = await chargerColis(payload.parcelId, payload);
      break;
    case 'LOT_COLIS':
      data = await contexteLot(payload);
      break;
    case 'RAMASSAGE':
      data = await contexteRamassage(payload);
      break;
    case 'BON_DISTRIBUTION':
      data = await contexteBonDistribution(payload);
      break;
    case 'BON_RETOUR_CLIENT':
      data = await contexteBonRetourClient(payload);
      break;
    case 'RECLAMATION':
      data = await contexteReclamation(payload);
      break;
    case 'REMBOURSEMENT':
      data = await contexteRemboursement(payload);
      break;
    case 'MODIF':
      data = await contexteModif(payload);
      break;
    case 'FACTURE_CLIENT':
      data = await contexteFactureClient(payload);
      break;
    case 'FACTURE_LIVREUR':
      data = await contexteFactureLivreur(payload);
      break;
    case 'MESSAGE_RECU':
      data = await contexteMessageRecu(payload);
      break;
    default:
      return null;
  }
  if (!data) return null;
  const now = new Date();
  const societe = await infosSociete();
  return fusionner(data, {
    societe: societe.societe,
    societe_tel: formatPhoneAffichage(societe.societe_tel) || societe.societe_tel,
    date: formatDateJJMMAAAA(now),
    heure: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  });
}

/**
 * Destinataires d'une audience : [{ phone, type, nom, customerId, userId, parcelId }].
 * `cibles` = users_id des employés pour l'audience admin.
 */
async function phonesAudience(audience, data, cibles = []) {
  const parcelId = data._ids?.parcelId || null;
  if (audience === 'destinataire') {
    return data._phones?.destinataire
      ? [{ phone: data._phones.destinataire, type: 'destinataire', nom: data._noms?.destinataire || '', parcelId }]
      : [];
  }
  if (audience === 'expediteur') {
    return data._phones?.expediteur
      ? [{ phone: data._phones.expediteur, type: 'client', nom: data._noms?.expediteur || '', customerId: data._ids?.customerId || null, parcelId }]
      : [];
  }
  if (audience === 'livreur' || audience === 'ramasseur') {
    let phone = data._phones?.[audience];
    let nom = data._noms?.[audience] || '';
    let userId = data._ids?.[`${audience}Id`] || null;
    if (phone === null && userId) {
      const u = await chargerUtilisateur(userId);
      phone = u?.phone || '';
      nom = u?.users_name || nom;
    }
    return phone ? [{ phone, type: 'livreur', nom, userId, parcelId }] : [];
  }
  if (audience === 'admin') {
    const ids = (Array.isArray(cibles) ? cibles : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    const [rows] = await pool.query(
      `SELECT u.users_id, u.users_name, ${LIVREUR_PHONE_SQL('u')} AS phone
         FROM delevery_users u WHERE u.users_id IN (?) AND u.users_active = 1`,
      [ids]
    );
    return rows.filter((r) => r.phone).map((r) => ({ phone: r.phone, type: 'employe', nom: r.users_name || '', userId: r.users_id, parcelId }));
  }
  return [];
}

/**
 * Paramètres positionnels d'un modèle à partir du mapping d'une règle :
 * [{ type: 'variable', code } | { type: 'fixe', texte } | 'code'].
 * `langue` = langue du modèle Meta (ar, fr…) : en langue RTL les blancs entre
 * chiffres sont retirés (voir `bidiSafe`).
 */
function construireParams(mapping, data, langue = 'fr') {
  return (Array.isArray(mapping) ? mapping : []).map((m) => {
    let p;
    if (typeof m === 'string') p = formaterParam(data[m]);
    else if (!m) p = '—';
    else if (m.type === 'fixe') p = formaterParam(m.texte);
    else p = formaterParam(data[m.code]);
    return bidiSafe(p, langue);
  });
}

/** Exemple d'aperçu pour un mapping (sans base) : variables → exemples du catalogue. */
function paramsExemple(mapping, langue = 'fr') {
  return (Array.isArray(mapping) ? mapping : []).map((m) => {
    let p;
    if (typeof m === 'string') p = VARIABLES_PAR_CODE[m]?.exemple || '—';
    else if (!m) p = '—';
    else if (m.type === 'fixe') p = formaterParam(m.texte);
    else p = VARIABLES_PAR_CODE[m.code]?.exemple || '—';
    return bidiSafe(p, langue);
  });
}

module.exports = {
  AUDIENCES,
  CONTEXTES,
  EVENEMENTS,
  EVENEMENTS_PAR_CODE,
  VARIABLES,
  VARIABLES_PAR_CODE,
  TYPES_CONTACT,
  variablesPourContexte,
  catalogue,
  formaterParam,
  bidiSafe,
  langueRtl,
  formatDh,
  formatNombre,
  formatDateQuelconque,
  chargerColis,
  chargerClient,
  chargerUtilisateur,
  resoudreContexte,
  phonesAudience,
  construireParams,
  paramsExemple
};
