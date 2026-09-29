const pool = require('../config/db');

/*
 * Blocage d'expédition par le client : colonne parcel_client_block de
 * delevery_parcel (sql/2026-08-26_blocage-expedition-client.sql), posée via
 * le bouton « Bloquer l'expédition » du tableau des colis client. Un colis
 * bloqué est refusé au scan ramassage et au scan / à l'ajout d'un bon
 * d'envoi ou de sortie (« Bloqué par le client, à ne pas envoyer »).
 */

/** Message de refus affiché côté admin au scan d'un colis bloqué. */
const BLOCK_MESSAGE = 'bloqué par le client, à ne pas envoyer';

/**
 * Vrai si le colis est bloqué par son client. `db` : pool par défaut, ou une
 * connexion de transaction. Colonne absente (migration pas encore exécutée)
 * → jamais bloqué.
 */
async function isBlockedByClient(parcelId, db = pool) {
  try {
    const [[row]] = await db.query(
      `SELECT parcel_client_block AS block FROM delevery_parcel
        WHERE parcel_id = ? LIMIT 1`,
      [Number(parcelId)]
    );
    return Number(row?.block) === 1;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return false;
    throw err;
  }
}

module.exports = { BLOCK_MESSAGE, isBlockedByClient };
