const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');

/*
 * Preuve photo d'un changement de statut (modale « Changer statut » admin,
 * dashboard livreur et API livreur) : image stockée dans uploads/preuves, URL
 * conservée dans delevery_parcel_history.parcel_history_preuve
 * (sql/2026-09-02_preuve-statut.sql) et affichée en face du statut dans le
 * détail de suivi, côté admin comme côté client.
 */

const PREUVE_DIR = path.join(UPLOADS_ROOT, 'preuves');
const PREUVE_URL_PREFIX = '/uploads/preuves/';
const PREUVE_MIGRATION = 'sql/2026-09-02_preuve-statut.sql';

function ensurePreuveDir() {
  fs.mkdirSync(PREUVE_DIR, { recursive: true });
  return PREUVE_DIR;
}

/** Nom de fichier multer → URL publique servie par /uploads. */
function preuveUrl(filename) {
  return `${PREUVE_URL_PREFIX}${path.basename(filename)}`;
}

/** Supprime du disque une preuve (URL '/uploads/preuves/…') ; ignore le reste. */
function supprimerPreuve(value) {
  if (typeof value !== 'string' || !value.startsWith(PREUVE_URL_PREFIX)) return;
  fs.unlink(path.join(PREUVE_DIR, path.basename(value)), () => {});
}

/*
 * La colonne parcel_history_preuve existe-t-elle ? Vérifiée via
 * information_schema : résultat positif gardé en cache pour de bon, résultat
 * négatif re-testé toutes les 60 s (le temps que la migration passe en prod,
 * sans redémarrer). Sans la colonne : le suivi marche (NULL AS preuve) et
 * l'envoi d'une preuve est refusé avec un message explicite.
 */
let colonneOk = false;
let prochainTest = 0;
async function historyPreuveDisponible() {
  if (colonneOk) return true;
  const now = Date.now();
  if (now < prochainTest) return false;
  prochainTest = now + 60 * 1000;
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'delevery_parcel_history'
        AND COLUMN_NAME = 'parcel_history_preuve'`
  );
  colonneOk = Number(row?.n) > 0;
  return colonneOk;
}

/** Fragment SELECT de la preuve d'une ligne d'historique (alias h), NULL sans migration. */
async function historyPreuveSql() {
  return (await historyPreuveDisponible()) ? 'h.parcel_history_preuve' : 'NULL';
}

module.exports = {
  PREUVE_MIGRATION,
  ensurePreuveDir,
  preuveUrl,
  supprimerPreuve,
  historyPreuveDisponible,
  historyPreuveSql
};
