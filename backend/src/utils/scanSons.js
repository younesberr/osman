const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { cfgKey } = require('../config/brand');

/*
 * Sons du scanner, gérés depuis Configuration > Options : un son par étape
 * (ramassage / envoi / distribution / retour, en succès ou échec). Une ligne
 * par son dans delevery_configs : configs_var = app_scan_son,
 * configs_val = JSON { type, file }. Les fichiers audio sont stockés dans
 * backend/uploads/sons.
 */

const CONFIG_VAR = cfgKey('scan_son');
const SON_TYPES = [
  'ramassage_success',
  'ramassage_error',
  'envoi_success',
  'envoi_error',
  'distribution_success',
  'distribution_error',
  'retour_success',
  'retour_error'
];
// Anciennes valeurs (validation / refus du scan de ramassage) encore en base.
const LEGACY_TYPES = { success: 'ramassage_success', error: 'ramassage_error' };
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.aac'];
const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'sons');

function ensureSonUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

function toPublicUrl(filename) {
  return filename ? `/uploads/sons/${filename}` : null;
}

/** Ligne delevery_configs → { id, type, file, url } (null si JSON invalide). */
function parseSonRow(row) {
  try {
    const val = JSON.parse(row.configs_val);
    if (!val) return null;
    const type = LEGACY_TYPES[val.type] || val.type;
    if (!SON_TYPES.includes(type)) return null;
    return {
      id: row.configs_id,
      type,
      file: String(val.file || ''),
      url: toPublicUrl(val.file)
    };
  } catch {
    return null;
  }
}

/** Tous les sons chargés, du plus récent au plus ancien. */
async function listSons() {
  const [rows] = await pool.query(
    `SELECT configs_id, configs_val FROM delevery_configs
      WHERE configs_var = ? ORDER BY configs_id DESC`,
    [CONFIG_VAR]
  );
  return rows.map(parseSonRow).filter(Boolean);
}

/** URLs des sons joués par étape : le plus récent de chaque type. */
async function getScanSonUrls() {
  const sons = await listSons();
  const urls = {};
  for (const type of SON_TYPES) urls[type] = null;
  for (const son of sons) {
    if (urls[son.type] === null) urls[son.type] = son.url;
  }
  return urls;
}

/** Supprime un fichier audio du dossier uploads/sons (silencieux si absent). */
function deleteSonFile(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch(() => {});
}

module.exports = {
  CONFIG_VAR,
  SON_TYPES,
  AUDIO_EXT,
  UPLOAD_DIR,
  ensureSonUploadDir,
  toPublicUrl,
  parseSonRow,
  listSons,
  getScanSonUrls,
  deleteSonFile
};
