const pool = require('../config/db');

/*
 * Configuration > Gestion tarifs — tarifs par couple de villes
 * (delevery_tarifs_matrix) : ville de ramassage + ville de destination
 * (ville_id de delevery_tarifs), frais de livraison / retour / refusé.
 * Couple (pickup, dest) unique ; table partagée avec le système legacy.
 */

const LIST_SQL = `
  SELECT m.matrix_id       AS id,
         m.pickup_ville_id AS pickupVilleId,
         vp.nom_ville      AS pickupVille,
         m.dest_ville_id   AS destVilleId,
         vd.nom_ville      AS destVille,
         m.frais_livraison AS fraisLivraison,
         m.frais_retour    AS fraisRetour,
         m.frais_refuse    AS fraisRefuse
    FROM delevery_tarifs_matrix m
    LEFT JOIN delevery_tarifs vp ON vp.ville_id = m.pickup_ville_id
    LEFT JOIN delevery_tarifs vd ON vd.ville_id = m.dest_ville_id`;

/** GET /api/config/tarifs — tous les tarifs avec les noms de villes. */
async function listTarifs(req, res, next) {
  try {
    const [rows] = await pool.query(`${LIST_SQL} ORDER BY vp.nom_ville, vd.nom_ville`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** Parse un montant de frais ; renvoie null et répond en cas d'erreur (0 est valide). */
function parseFrais(value, label, res) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) {
    res.status(400).json({ message: `${label} invalide (montant positif attendu).` });
    return null;
  }
  return Math.round(n * 100) / 100;
}

/** Valide le corps d'un tarif ; renvoie null et répond en cas d'erreur. */
async function tarifPayload(req, res, excludeId = null) {
  const pickupVilleId = Number(req.body.pickupVilleId);
  const destVilleId = Number(req.body.destVilleId);

  if (!Number.isInteger(pickupVilleId) || pickupVilleId <= 0) {
    res.status(400).json({ message: 'Veuillez sélectionner une ville de ramassage.' });
    return null;
  }
  if (!Number.isInteger(destVilleId) || destVilleId <= 0) {
    res.status(400).json({ message: 'Veuillez sélectionner une ville de destination.' });
    return null;
  }

  const fraisLivraison = parseFrais(req.body.fraisLivraison, 'Frais de livraison', res);
  if (fraisLivraison === null) return null;
  const fraisRetour = parseFrais(req.body.fraisRetour, 'Frais de retour', res);
  if (fraisRetour === null) return null;
  const fraisRefuse = parseFrais(req.body.fraisRefuse, 'Frais de refusé', res);
  if (fraisRefuse === null) return null;

  const [villes] = await pool.query(
    `SELECT ville_id FROM delevery_tarifs WHERE ville_id IN (?, ?)`,
    [pickupVilleId, destVilleId]
  );
  const ids = villes.map((v) => v.ville_id);
  if (!ids.includes(pickupVilleId)) {
    res.status(400).json({ message: 'Ville de ramassage introuvable.' });
    return null;
  }
  if (!ids.includes(destVilleId)) {
    res.status(400).json({ message: 'Ville de destination introuvable.' });
    return null;
  }

  const exclude = excludeId ? 'AND matrix_id <> ?' : '';
  const excludeParams = excludeId ? [excludeId] : [];
  const [[dup]] = await pool.query(
    `SELECT matrix_id FROM delevery_tarifs_matrix
      WHERE pickup_ville_id = ? AND dest_ville_id = ? ${exclude} LIMIT 1`,
    [pickupVilleId, destVilleId, ...excludeParams]
  );
  if (dup) {
    res.status(409).json({ message: 'Un tarif existe déjà pour ce couple de villes.' });
    return null;
  }

  return { pickupVilleId, destVilleId, fraisLivraison, fraisRetour, fraisRefuse };
}

/** Renvoie le tarif (format liste) par matrix_id. */
async function findTarif(id) {
  const [[row]] = await pool.query(`${LIST_SQL} WHERE m.matrix_id = ?`, [id]);
  return row || null;
}

/** POST /api/config/tarifs — nouveau tarif pour un couple de villes. */
async function createTarif(req, res, next) {
  try {
    const payload = await tarifPayload(req, res);
    if (!payload) return;

    const [result] = await pool.query(
      `INSERT INTO delevery_tarifs_matrix
         (pickup_ville_id, dest_ville_id, frais_livraison, frais_retour, frais_refuse, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [payload.pickupVilleId, payload.destVilleId, payload.fraisLivraison, payload.fraisRetour, payload.fraisRefuse]
    );
    res.status(201).json(await findTarif(result.insertId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/tarifs/:id — modifier le tarif (villes + frais). */
async function updateTarif(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const payload = await tarifPayload(req, res, id);
    if (!payload) return;

    const [result] = await pool.query(
      `UPDATE delevery_tarifs_matrix
          SET pickup_ville_id = ?, dest_ville_id = ?,
              frais_livraison = ?, frais_retour = ?, frais_refuse = ?
        WHERE matrix_id = ?`,
      [payload.pickupVilleId, payload.destVilleId, payload.fraisLivraison, payload.fraisRetour, payload.fraisRefuse, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    res.json(await findTarif(id));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/config/tarifs/:id — supprimer le tarif. */
async function deleteTarif(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const [result] = await pool.query(`DELETE FROM delevery_tarifs_matrix WHERE matrix_id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

module.exports = { listTarifs, createTarif, updateTarif, deleteTarif };
