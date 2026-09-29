const pool = require('../config/db');

/*
 * Migration du CRM WhatsApp (sql/2026-09-13_whatsapp-crm.sql) : 4 tables
 * delevery_whatsapp_{modele,regle,conversation,reponse_rapide} + colonnes CRM
 * de delevery_whatsapp_message. Vérifiée via information_schema, même mécanique
 * que utils/preuveStatut.js : résultat positif gardé en cache pour de bon,
 * négatif re-testé toutes les 60 s (la migration passe en prod sans redémarrer).
 * Sans la migration : configuration / journal / webhook de la phase 1
 * fonctionnent, les routes CRM répondent 503 avec MESSAGE_CRM_ABSENT, l'émetteur
 * d'événements et la file d'envoi ne font rien.
 */

const CRM_MIGRATION = 'sql/2026-09-13_whatsapp-crm.sql';
const MESSAGE_CRM_ABSENT = `CRM WhatsApp indisponible : exécutez ${CRM_MIGRATION} dans phpMyAdmin.`;

let crmOk = false;
let prochainTest = 0;

async function crmDisponible() {
  if (crmOk) return true;
  const now = Date.now();
  if (now < prochainTest) return false;
  prochainTest = now + 60 * 1000;
  try {
    const [[row]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delevery_whatsapp_conversation')
            + (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delevery_whatsapp_message'
                  AND COLUMN_NAME = 'wam_conversation') AS n`
    );
    crmOk = Number(row?.n) >= 2;
  } catch {
    crmOk = false;
  }
  return crmOk;
}

/** Erreur MySQL typique d'une migration absente (table ou colonne manquante). */
function estErreurMigration(err) {
  return err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');
}

module.exports = { CRM_MIGRATION, MESSAGE_CRM_ABSENT, crmDisponible, estErreurMigration };
