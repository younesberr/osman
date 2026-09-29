const pool = require('../config/db');
const { estErreurMigration } = require('../utils/whatsappSchema');

/*
 * Préférences de notification WhatsApp du client expéditeur
 * (table delevery_whatsapp_pref_client, sql/2026-09-18_whatsapp-preferences-client.sql).
 * - Catalogue OPTIONS : une option = un ou deux événements du catalogue des
 *   actions automatiques (services/whatsappEvenements.js) ; libellés partagés
 *   par /client/configuration (section « Notifications WhatsApp ») et par la
 *   modale « Options » de /admin/clients.
 * - Absence de ligne = activé : un client qui n'a jamais enregistré ses choix
 *   reçoit tout ce que les règles « Client expéditeur » prévoient.
 * - notificationClientAutorisee() est consulté par whatsappRegles.appliquerRegle
 *   pour chaque destinataire de type client ; les autres audiences (destinataire,
 *   livreur, employés) ne sont jamais filtrées ici.
 * - Table absente (migration non exécutée) : lirePreferences renvoie
 *   disponible = false (les pages affichent « indisponible »), l'enregistrement
 *   lève une erreur de migration (503 côté contrôleur) et l'émetteur envoie
 *   comme avant (tout activé). Détection sous 60 s sans redémarrage.
 */

const MIGRATION = 'sql/2026-09-18_whatsapp-preferences-client.sql';
const MESSAGE_PREF_ABSENT = `Préférences WhatsApp indisponibles : exécutez ${MIGRATION} dans phpMyAdmin.`;

const OPTIONS = [
  {
    code: 'BON_RETOUR_EXPEDIE',
    label: 'Bon de retour expédié',
    description: 'Quand un bon de retour contenant vos colis retournés est expédié vers vous.',
    evenements: ['BON_RETOUR_CLIENT_EXPEDIE']
  },
  {
    code: 'RECLAMATION_TRAITEE',
    label: 'Réclamation traitée',
    description: "Quand l'une de vos réclamations est traitée par le service client.",
    evenements: ['RECLAMATION_TRAITEE']
  },
  {
    code: 'REMBOURSEMENT',
    label: 'Remboursement accepté / refusé',
    description: "Quand une demande de remboursement est acceptée ou refusée.",
    evenements: ['REMB_ACCEPTE', 'REMB_REFUSE']
  },
  {
    code: 'MODIFICATION_COLIS',
    label: 'Modification de colis acceptée / refusée',
    description: 'Quand une demande de modification de colis est acceptée ou refusée.',
    evenements: ['MODIF_ACCEPTEE', 'MODIF_REFUSEE']
  },
  {
    code: 'FACTURE_ENREGISTREE',
    label: 'Facture enregistrée',
    description: "Quand une nouvelle facture est enregistrée sur votre compte.",
    evenements: ['FACTURE_CLIENT_ENREGISTREE']
  },
  {
    code: 'FACTURE_PAYEE',
    label: 'Facture payée',
    description: "Quand l'une de vos factures est marquée payée.",
    evenements: ['FACTURE_CLIENT_PAYEE']
  }
];

const OPTION_PAR_CODE = Object.fromEntries(OPTIONS.map((o) => [o.code, o]));

/** Code d'événement (catalogue des règles) → code d'option client. */
const OPTION_PAR_EVENEMENT = Object.fromEntries(
  OPTIONS.flatMap((o) => o.evenements.map((e) => [e, o.code]))
);

/** Catalogue pour les pages (sans les codes d'événements internes). */
function catalogue() {
  return OPTIONS.map(({ code, label, description }) => ({ code, label, description }));
}

/** Toutes les options activées (valeur par défaut, aussi utilisée sans migration). */
function preferencesParDefaut() {
  return Object.fromEntries(OPTIONS.map((o) => [o.code, 1]));
}

let tableOk = false;
let prochainTest = 0;

async function tableDisponible() {
  if (tableOk) return true;
  const now = Date.now();
  if (now < prochainTest) return false;
  prochainTest = now + 60 * 1000;
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delevery_whatsapp_pref_client'`
    );
    tableOk = Number(row?.n) >= 1;
  } catch {
    tableOk = false;
  }
  return tableOk;
}

/**
 * Préférences d'un client : { disponible, options, prefs } où prefs =
 * { code: 0|1 } pour chaque option du catalogue (1 si jamais enregistrée).
 */
async function lirePreferences(customerId) {
  const prefs = preferencesParDefaut();
  const disponible = await tableDisponible();
  if (disponible) {
    const [rows] = await pool.query(
      'SELECT wpc_option, wpc_actif FROM delevery_whatsapp_pref_client WHERE wpc_customer = ?',
      [Number(customerId)]
    );
    for (const r of rows) {
      if (OPTION_PAR_CODE[r.wpc_option]) prefs[r.wpc_option] = Number(r.wpc_actif) === 1 ? 1 : 0;
    }
  }
  return { disponible, options: catalogue(), prefs };
}

/**
 * Normalise le corps { CODE: 0|1, … } envoyé par les pages.
 * Renvoie { prefs } (codes connus seulement) ou { erreur } si une valeur est
 * invalide ; prefs = null quand rien n'est envoyé.
 */
function normaliserPreferences(body) {
  if (body === undefined || body === null) return { prefs: null };
  if (typeof body !== 'object' || Array.isArray(body)) return { erreur: 'Préférences WhatsApp invalides.' };
  const prefs = {};
  for (const [code, valeur] of Object.entries(body)) {
    if (!OPTION_PAR_CODE[code]) continue;
    const v = Number(valeur);
    if (![0, 1].includes(v)) return { erreur: `Préférence WhatsApp « ${code} » invalide.` };
    prefs[code] = v;
  }
  return { prefs: Object.keys(prefs).length ? prefs : null };
}

/**
 * Enregistre (INSERT … ON DUPLICATE KEY UPDATE) les options fournies.
 * origine : 'client' (dashboard client) ou 'admin' (page Clients, userId = employé).
 * Lève l'erreur MySQL de migration absente (ER_NO_SUCH_TABLE) : à traiter en 503.
 */
async function enregistrerPreferences(customerId, prefs, { origine = 'client', userId = 0 } = {}) {
  const entries = Object.entries(prefs || {}).filter(([code]) => OPTION_PAR_CODE[code]);
  if (!entries.length) return;
  const values = entries.map(([code, actif]) => [
    Number(customerId),
    code,
    actif ? 1 : 0,
    origine === 'admin' ? 'admin' : 'client',
    Number(userId) || 0
  ]);
  await pool.query(
    `INSERT INTO delevery_whatsapp_pref_client
       (wpc_customer, wpc_option, wpc_actif, wpc_origine, wpc_updated_by, wpc_updated_at)
     VALUES ${values.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ')}
     ON DUPLICATE KEY UPDATE
       wpc_actif = VALUES(wpc_actif),
       wpc_origine = VALUES(wpc_origine),
       wpc_updated_by = VALUES(wpc_updated_by),
       wpc_updated_at = NOW()`,
    values.flat()
  );
  tableOk = true;
}

/**
 * Le client `customerId` accepte-t-il l'événement `evenementCode` ?
 * true si l'événement n'est pas configurable, si la migration est absente,
 * ou si aucune ligne « désactivé » n'existe.
 */
async function notificationClientAutorisee(customerId, evenementCode) {
  const option = OPTION_PAR_EVENEMENT[evenementCode];
  if (!option || !customerId) return true;
  if (!(await tableDisponible())) return true;
  try {
    const [[row]] = await pool.query(
      'SELECT wpc_actif FROM delevery_whatsapp_pref_client WHERE wpc_customer = ? AND wpc_option = ? LIMIT 1',
      [Number(customerId), option]
    );
    return !row || Number(row.wpc_actif) === 1;
  } catch (err) {
    if (estErreurMigration(err)) {
      tableOk = false;
      return true;
    }
    throw err;
  }
}

module.exports = {
  MIGRATION,
  MESSAGE_PREF_ABSENT,
  OPTIONS,
  OPTION_PAR_EVENEMENT,
  catalogue,
  lirePreferences,
  normaliserPreferences,
  enregistrerPreferences,
  notificationClientAutorisee
};
