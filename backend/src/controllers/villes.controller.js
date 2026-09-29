const pool = require('../config/db');

/*
 * Configuration > Gestion villes — villes desservies (delevery_tarifs) :
 * une ligne par ville (ville_id unique) avec référence, nom, zone de
 * rattachement (colonne zone = delevery_zone.zone_id), frais de livraison /
 * retour / refusé et statut. Table partagée avec le système legacy : à la
 * création, ville_id = MAX(ville_id) + 1, comme le fait le legacy.
 */

const LIST_SQL = `
  SELECT t.tarif_id        AS id,
         t.ville_id        AS villeId,
         t.reference_ville AS ref,
         t.nom_ville       AS nom,
         t.zone            AS zoneId,
         z.zone_name       AS zone,
         t.frais_livraison AS fraisLivraison,
         t.frais_retour    AS fraisRetour,
         t.frais_refuse    AS fraisRefuse,
         t.statut          AS active
    FROM delevery_tarifs t
    LEFT JOIN delevery_zone z ON z.zone_id = t.zone`;

/** GET /api/config/villes — toutes les villes avec leur zone. */
async function listVilles(req, res, next) {
  try {
    const [rows] = await pool.query(`${LIST_SQL} ORDER BY t.nom_ville`);
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

/** Valide le corps d'une ville ; renvoie null et répond en cas d'erreur. */
async function villePayload(req, res, excludeId = null) {
  const ref = String(req.body.ref || '').trim().toUpperCase();
  const nom = String(req.body.nom || '').trim();
  const zoneId = Number(req.body.zoneId);

  if (!ref) {
    res.status(400).json({ message: 'La référence de la ville est obligatoire.' });
    return null;
  }
  if (ref.length > 50) {
    res.status(400).json({ message: 'Référence trop longue (max 50 caractères).' });
    return null;
  }
  if (!nom) {
    res.status(400).json({ message: 'Le nom de la ville est obligatoire.' });
    return null;
  }
  if (nom.length > 255) {
    res.status(400).json({ message: 'Nom trop long (max 255 caractères).' });
    return null;
  }
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    res.status(400).json({ message: 'Veuillez sélectionner une zone.' });
    return null;
  }

  const fraisLivraison = parseFrais(req.body.fraisLivraison, 'Frais de livraison', res);
  if (fraisLivraison === null) return null;
  const fraisRetour = parseFrais(req.body.fraisRetour, 'Frais de retour', res);
  if (fraisRetour === null) return null;
  const fraisRefuse = parseFrais(req.body.fraisRefuse, 'Frais de refusé', res);
  if (fraisRefuse === null) return null;

  const [[zone]] = await pool.query(`SELECT zone_id FROM delevery_zone WHERE zone_id = ? LIMIT 1`, [zoneId]);
  if (!zone) {
    res.status(400).json({ message: 'Zone introuvable.' });
    return null;
  }

  const exclude = excludeId ? 'AND tarif_id <> ?' : '';
  const excludeParams = excludeId ? [excludeId] : [];
  const [[dupRef]] = await pool.query(
    `SELECT tarif_id FROM delevery_tarifs
      WHERE LOWER(TRIM(reference_ville)) = LOWER(?) ${exclude} LIMIT 1`,
    [ref, ...excludeParams]
  );
  if (dupRef) {
    res.status(409).json({ message: `La référence « ${ref} » existe déjà.` });
    return null;
  }
  const [[dupNom]] = await pool.query(
    `SELECT tarif_id FROM delevery_tarifs
      WHERE LOWER(TRIM(nom_ville)) = LOWER(?) ${exclude} LIMIT 1`,
    [nom, ...excludeParams]
  );
  if (dupNom) {
    res.status(409).json({ message: `La ville « ${nom} » existe déjà.` });
    return null;
  }

  return { ref, nom, zoneId, fraisLivraison, fraisRetour, fraisRefuse };
}

/** Renvoie la ville (format liste) par tarif_id. */
async function findVille(id) {
  const [[row]] = await pool.query(`${LIST_SQL} WHERE t.tarif_id = ?`, [id]);
  return row || null;
}

/** POST /api/config/villes — nouvelle ville active (ville_id = max + 1). */
async function createVille(req, res, next) {
  try {
    const payload = await villePayload(req, res);
    if (!payload) return;

    const [result] = await pool.query(
      `INSERT INTO delevery_tarifs
         (ville_id, reference_ville, nom_ville, zone, statut,
          frais_livraison, frais_retour, frais_refuse, created_at, updated_at)
       SELECT COALESCE(MAX(ville_id), 0) + 1, ?, ?, ?, 1, ?, ?, ?, NOW(), NOW()
         FROM delevery_tarifs`,
      [payload.ref, payload.nom, payload.zoneId, payload.fraisLivraison, payload.fraisRetour, payload.fraisRefuse]
    );
    res.status(201).json(await findVille(result.insertId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/villes/:id — modifier la ville (ref, nom, zone, frais). */
async function updateVille(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const payload = await villePayload(req, res, id);
    if (!payload) return;

    const [result] = await pool.query(
      `UPDATE delevery_tarifs
          SET reference_ville = ?, nom_ville = ?, zone = ?,
              frais_livraison = ?, frais_retour = ?, frais_refuse = ?, updated_at = NOW()
        WHERE tarif_id = ?`,
      [payload.ref, payload.nom, payload.zoneId, payload.fraisLivraison, payload.fraisRetour, payload.fraisRefuse, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Ville introuvable.' });
    }
    res.json(await findVille(id));
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/villes/:id/active — { active: 0|1 } (statut). */
async function setVilleActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const active = Number(req.body.active) === 1 ? 1 : 0;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_tarifs SET statut = ?, updated_at = NOW() WHERE tarif_id = ?`,
      [active, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Ville introuvable.' });
    }
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

module.exports = { listVilles, createVille, updateVille, setVilleActive };
