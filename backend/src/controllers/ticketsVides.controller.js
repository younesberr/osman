const pool = require('../config/db');

/*
 * Tickets vides (pages /admin/tickets-vides/transport et
 * /admin/tickets-vides/clients, service TICKETS_VIDES).
 *
 * Un ticket vide est une étiquette 100 × 100 mm imprimée à l'avance ; comme
 * dans le legacy, les codes générés ne sont PAS enregistrés en base — ils
 * n'existent que sur le papier jusqu'au scan (tickets transport →
 * delevery_transport_envois / retours) ou à la saisie du colis (tickets
 * clients → delevery_parcel.parcel_code).
 *
 * Ce contrôleur ne fait que de la lecture : les sociétés actives pour le
 * générateur transport, et la vérification d'un lot de codes avant
 * impression (collisions avec les codes déjà en circulation — le legacy ne
 * vérifiait l'unicité que dans le navigateur).
 */

const MAX_CODES = 200;

/**
 * GET /api/tickets-vides/societes — sociétés actives (avec code et ville)
 * pour les selects expéditeur / destinataire du générateur transport.
 */
async function listSocietes(req, res, next) {
  try {
    const [societes] = await pool.query(
      `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
              s.telephone, v.reference_ville AS ville_ref, v.nom_ville AS ville
         FROM delevery_transport_societes s
         LEFT JOIN delevery_tarifs v ON v.ville_id = s.ville_id
        WHERE s.statut = 1
        ORDER BY s.nom_societe`
    );
    res.json({ societes });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/tickets-vides/verifier — body { codes: [] }. Vérifie qu'aucun
 * code du lot généré n'est déjà en circulation : colis clients
 * (delevery_parcel.parcel_code) et scans transport (envois / retours).
 * Renvoie { doublons: [] } — le front regénère les codes en conflit avant
 * d'imprimer.
 */
async function verifierCodes(req, res, next) {
  try {
    const codes = (Array.isArray(req.body?.codes) ? req.body.codes : [])
      .map((c) => String(c || '').trim().toUpperCase())
      .filter((c) => /^[A-Z0-9-]{5,40}$/.test(c));
    if (!codes.length) return res.status(400).json({ message: 'Aucun code à vérifier.' });
    if (codes.length > MAX_CODES) {
      return res.status(400).json({ message: `${MAX_CODES} codes maximum par vérification.` });
    }

    const doublons = new Set();
    const [parcels] = await pool.query(
      `SELECT parcel_code AS code FROM delevery_parcel WHERE parcel_code IN (?)`,
      [codes]
    );
    parcels.forEach((r) => doublons.add(String(r.code).toUpperCase()));
    const [envois] = await pool.query(
      `SELECT code FROM delevery_transport_envois WHERE code IN (?)`,
      [codes]
    );
    envois.forEach((r) => doublons.add(String(r.code).toUpperCase()));
    const [retours] = await pool.query(
      `SELECT code FROM delevery_transport_retours WHERE code IN (?)`,
      [codes]
    );
    retours.forEach((r) => doublons.add(String(r.code).toUpperCase()));

    res.json({ doublons: [...doublons] });
  } catch (err) {
    next(err);
  }
}

module.exports = { listSocietes, verifierCodes };
