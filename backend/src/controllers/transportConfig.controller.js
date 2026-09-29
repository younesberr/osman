const pool = require('../config/db');
const { estMigrationManquante } = require('../utils/transportBons');

/*
 * Module Transport — configuration (page /admin/transport/configuration,
 * service TRANSPORT, types 1/2 dans les routes). Tables legacy
 * delevery_transport_societes, delevery_transport_tarifs,
 * delevery_transport_config (sql/2026-08-24_transport-tickets.sql).
 *
 * Référentiel du module : sociétés partenaires (jamais supprimées, seulement
 * désactivées — les colis y font référence), tarif standard global (ligne
 * unique config_id = 1) et grille de tarifs personnalisés société × ville de
 * destination (delevery_tarifs = référentiel des villes).
 *
 * Corrections du legacy : le code société (2-3 lettres, préfixe/suffixe des
 * tickets) doit être UNIQUE parmi les sociétés — sinon le scan ne peut pas
 * résoudre la société de façon fiable ; unicité société × ville de la grille
 * conservée.
 *
 * Section « Trajets » (ORTALOG, sql/2026-09-18_transport-bons.sql) : un
 * trajet = un nom + des zones (delevery_zone) ; une zone n'appartient qu'à un
 * seul trajet. Les colis dont la ville de destination est dans une zone du
 * trajet rejoignent le bon de transport du jour de ce trajet.
 */

/** Trajets avec leurs zones : [{ id, nom, created_time, zones: [{ id, nom }] }]. */
async function listerTrajets() {
  const [trajets] = await pool.query(
    `SELECT t.trajet_id AS id, t.trajet_nom AS nom, t.created_time,
            (SELECT COUNT(*) FROM delevery_transport_bons b WHERE b.trajet_id = t.trajet_id) AS nb_bons
       FROM delevery_transport_trajets t
      ORDER BY t.trajet_nom`
  );
  const [liaisons] = await pool.query(
    `SELECT tz.trajet_id, z.zone_id AS id, z.zone_name AS nom
       FROM delevery_transport_trajet_zones tz
       JOIN delevery_zone z ON z.zone_id = tz.zone_id
      ORDER BY z.zone_name`
  );
  const parTrajet = new Map();
  for (const l of liaisons) {
    if (!parTrajet.has(l.trajet_id)) parTrajet.set(l.trajet_id, []);
    parTrajet.get(l.trajet_id).push({ id: Number(l.id), nom: l.nom });
  }
  return trajets.map((t) => ({
    id: Number(t.id),
    nom: t.nom,
    created_time: Number(t.created_time),
    nb_bons: Number(t.nb_bons),
    zones: parTrajet.get(t.id) || []
  }));
}

/** Zones actives avec le trajet qui les utilise déjà (null si libre). */
async function listerZones() {
  const [rows] = await pool.query(
    `SELECT z.zone_id AS id, z.zone_name AS nom, a.agence_name AS agence,
            tz.trajet_id, t.trajet_nom AS trajet
       FROM delevery_zone z
       LEFT JOIN delevery_agences a ON a.agence_id = z.zone_agence_id
       LEFT JOIN delevery_transport_trajet_zones tz ON tz.zone_id = z.zone_id
       LEFT JOIN delevery_transport_trajets t ON t.trajet_id = tz.trajet_id
      WHERE z.zone_active = 1
      ORDER BY z.zone_name`
  );
  return rows.map((z) => ({
    id: Number(z.id),
    nom: z.nom,
    agence: z.agence || '',
    trajet_id: z.trajet_id ? Number(z.trajet_id) : null,
    trajet: z.trajet || ''
  }));
}

/**
 * Corps trajet validé → { nom, zones: [ids] }, ou { error }. Au moins une
 * zone : un trajet sans zone ne recevrait jamais de colis.
 */
async function parseTrajet(body, saufId) {
  const nom = String(body?.nom || '').trim();
  if (!nom) return { error: 'Veuillez saisir le nom du trajet.' };
  if (nom.length > 100) return { error: 'Nom trop long (100 caractères max).' };
  const brut = Array.isArray(body?.zones) ? body.zones : [];
  const zones = [...new Set(brut.map((z) => parseInt(z, 10)).filter((z) => Number.isInteger(z) && z > 0))];
  if (!zones.length) return { error: 'Veuillez sélectionner au moins une zone.' };

  const [[dup]] = await pool.query(
    `SELECT trajet_id FROM delevery_transport_trajets
      WHERE LOWER(TRIM(trajet_nom)) = LOWER(?) AND trajet_id <> ? LIMIT 1`,
    [nom, saufId]
  );
  if (dup) return { error: `Le trajet « ${nom} » existe déjà.` };

  const [existantes] = await pool.query(
    `SELECT z.zone_id AS id, z.zone_name AS nom, tz.trajet_id, t.trajet_nom AS trajet
       FROM delevery_zone z
       LEFT JOIN delevery_transport_trajet_zones tz ON tz.zone_id = z.zone_id
       LEFT JOIN delevery_transport_trajets t ON t.trajet_id = tz.trajet_id
      WHERE z.zone_id IN (?) AND z.zone_active = 1`,
    [zones]
  );
  const parId = new Map(existantes.map((z) => [Number(z.id), z]));
  for (const id of zones) {
    const z = parId.get(id);
    if (!z) return { error: `Zone #${id} introuvable ou désactivée.` };
    if (z.trajet_id && Number(z.trajet_id) !== saufId) {
      return { error: `La zone « ${z.nom} » appartient déjà au trajet « ${z.trajet || z.trajet_id} ».` };
    }
  }
  return { nom, zones };
}

/** Remplace les zones d'un trajet (dans la transaction donnée). */
async function remplacerZones(conn, trajetId, zones) {
  await conn.query(`DELETE FROM delevery_transport_trajet_zones WHERE trajet_id = ?`, [trajetId]);
  await conn.query(`INSERT INTO delevery_transport_trajet_zones (zone_id, trajet_id) VALUES ?`, [
    zones.map((z) => [z, trajetId])
  ]);
}

/** Erreurs d'unicité (nom de trajet, zone déjà prise) → 400, sinon propage. */
function repondreErreurTrajet(err, res, next) {
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(400).json({ message: 'Nom de trajet ou zone déjà utilisé(e) par un autre trajet.' });
  }
  if (estMigrationManquante(err)) {
    return res.status(503).json({ message: 'Trajets indisponibles : exécuter sql/2026-09-18_transport-bons.sql.' });
  }
  return next(err);
}

/** Corps société validé → valeurs, ou { error }. */
function parseSociete(body) {
  const nom = String(body?.nom || '').trim();
  if (!nom) return { error: 'Veuillez saisir le nom de la société.' };
  if (nom.length > 255) return { error: 'Nom trop long (255 caractères max).' };
  const code = String(body?.code || '').trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(code)) {
    return { error: 'Code société invalide (2 à 3 lettres attendues).' };
  }
  const ville = parseInt(body?.ville, 10);
  if (!Number.isInteger(ville) || ville <= 0) {
    return { error: 'Veuillez sélectionner la ville de la société.' };
  }
  const telephone = String(body?.telephone || '').trim();
  if (telephone.length > 50) return { error: 'Téléphone trop long (50 caractères max).' };
  const ice = String(body?.ice || '').trim();
  if (ice.length > 50) return { error: 'ICE trop long (50 caractères max).' };
  const adresse = String(body?.adresse || '').trim();
  if (adresse.length > 1000) return { error: 'Adresse trop longue (1000 caractères max).' };
  const tarifPersonnalise = body?.tarif_personnalise ? 1 : 0;
  return { nom, code, ville, telephone, ice, adresse, tarifPersonnalise };
}

/** Vrai si une AUTRE société (active ou non) porte déjà ce code. */
async function codeDejaPris(code, saufId) {
  const [[row]] = await pool.query(
    `SELECT societe_id FROM delevery_transport_societes
      WHERE code_societe = ? AND societe_id <> ? LIMIT 1`,
    [code, saufId]
  );
  return Boolean(row);
}

/** Montant >= 0 (2 décimales max), sinon null. */
function parseMontant(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return null;
  return Math.round(n * 100) / 100;
}

/**
 * GET /api/transport/configuration — tout le référentiel de la page :
 * sociétés (avec ville), tarif standard, villes actives pour les selects.
 */
async function getConfiguration(req, res, next) {
  try {
    const [societes] = await pool.query(
      `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
              s.ville_id, s.telephone, s.ice, s.adresse,
              s.tarif_personnalise, s.statut,
              v.reference_ville AS ville_ref, v.nom_ville AS ville
         FROM delevery_transport_societes s
         LEFT JOIN delevery_tarifs v ON v.ville_id = s.ville_id
        ORDER BY s.nom_societe`
    );
    const [[config]] = await pool.query(
      `SELECT tarif_standard FROM delevery_transport_config WHERE config_id = 1 LIMIT 1`
    );
    const [villes] = await pool.query(
      `SELECT ville_id AS id, reference_ville AS ref, nom_ville AS nom
         FROM delevery_tarifs WHERE statut = '1'
        ORDER BY nom_ville`
    );
    // Trajets + zones : section indisponible (trajets_disponibles = false) tant
    // que la migration des bons de transport n'est pas passée.
    let trajets = [];
    let zones = [];
    let trajetsDisponibles = true;
    try {
      trajets = await listerTrajets();
      zones = await listerZones();
    } catch (err) {
      if (!estMigrationManquante(err)) throw err;
      trajetsDisponibles = false;
    }
    res.json({
      societes: societes.map((s) => ({
        ...s,
        tarif_personnalise: Number(s.tarif_personnalise),
        statut: Number(s.statut)
      })),
      tarif_standard: config ? Number(config.tarif_standard) : 0,
      villes,
      trajets,
      zones,
      trajets_disponibles: trajetsDisponibles
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transport/configuration/trajets — body { nom, zones: [ids] }.
 * Crée un trajet avec ses zones (chaque zone doit être libre).
 */
async function createTrajet(req, res, next) {
  try {
    const values = await parseTrajet(req.body, 0);
    if (values.error) return res.status(400).json({ message: values.error });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_transport_trajets (trajet_nom, user_id, created_time) VALUES (?, ?, ?)`,
        [values.nom, Number(req.user.id), Math.floor(Date.now() / 1000)]
      );
      await remplacerZones(conn, result.insertId, values.zones);
      await conn.commit();
      res.status(201).json({ id: result.insertId });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    repondreErreurTrajet(err, res, next);
  }
}

/**
 * PATCH /api/transport/configuration/trajets/:id — body { nom, zones }.
 * Renomme le trajet et remplace ses zones. Les bons existants du trajet ne
 * changent pas ; seuls les prochains scans suivent les nouvelles zones.
 */
async function updateTrajet(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Trajet introuvable.' });
    const [[trajet]] = await pool.query(`SELECT trajet_id FROM delevery_transport_trajets WHERE trajet_id = ?`, [id]);
    if (!trajet) return res.status(404).json({ message: 'Trajet introuvable.' });
    const values = await parseTrajet(req.body, id);
    if (values.error) return res.status(400).json({ message: values.error });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE delevery_transport_trajets SET trajet_nom = ? WHERE trajet_id = ?`, [values.nom, id]);
      await remplacerZones(conn, id, values.zones);
      await conn.commit();
      res.json({ id });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    repondreErreurTrajet(err, res, next);
  }
}

/**
 * DELETE /api/transport/configuration/trajets/:id — supprime un trajet sans
 * bon (ses zones redeviennent libres). Un trajet ayant des bons est conservé
 * pour garder l'historique : modifiez plutôt ses zones.
 */
async function deleteTrajet(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Trajet introuvable.' });
    const [[{ nb }]] = await pool.query(`SELECT COUNT(*) AS nb FROM delevery_transport_bons WHERE trajet_id = ?`, [
      id
    ]);
    if (Number(nb) > 0) {
      return res.status(400).json({
        message: `Ce trajet a ${nb} bon(s) de transport : suppression impossible, modifiez plutôt ses zones.`
      });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM delevery_transport_trajet_zones WHERE trajet_id = ?`, [id]);
      const [result] = await conn.query(`DELETE FROM delevery_transport_trajets WHERE trajet_id = ?`, [id]);
      await conn.commit();
      if (!result.affectedRows) return res.status(404).json({ message: 'Trajet introuvable.' });
      res.json({ id });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    repondreErreurTrajet(err, res, next);
  }
}

/**
 * POST /api/transport/configuration/societes — body { nom, code, ville,
 * telephone, ice, adresse, tarif_personnalise }. Crée une société active.
 */
async function createSociete(req, res, next) {
  try {
    const values = parseSociete(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await codeDejaPris(values.code, 0)) {
      return res.status(400).json({ message: `Le code ${values.code} est déjà utilisé par une autre société.` });
    }
    const [result] = await pool.query(
      `INSERT INTO delevery_transport_societes
         (nom_societe, code_societe, ville_id, telephone, ice, adresse,
          tarif_personnalise, statut, created_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        values.nom,
        values.code,
        values.ville,
        values.telephone,
        values.ice,
        values.adresse,
        values.tarifPersonnalise,
        Math.floor(Date.now() / 1000)
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/transport/configuration/societes/:id — body idem création +
 * statut (0 | 1). Modifie une société (seul endroit où le statut est
 * éditable, comme le legacy).
 */
async function updateSociete(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Société introuvable.' });
    const [[societe]] = await pool.query(
      `SELECT societe_id FROM delevery_transport_societes WHERE societe_id = ? LIMIT 1`,
      [id]
    );
    if (!societe) return res.status(404).json({ message: 'Société introuvable.' });
    const values = parseSociete(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await codeDejaPris(values.code, id)) {
      return res.status(400).json({ message: `Le code ${values.code} est déjà utilisé par une autre société.` });
    }
    const statut = Number(req.body?.statut) === 0 ? 0 : 1;
    await pool.query(
      `UPDATE delevery_transport_societes
          SET nom_societe = ?, code_societe = ?, ville_id = ?, telephone = ?,
              ice = ?, adresse = ?, tarif_personnalise = ?, statut = ?
        WHERE societe_id = ?`,
      [
        values.nom,
        values.code,
        values.ville,
        values.telephone,
        values.ice,
        values.adresse,
        values.tarifPersonnalise,
        statut,
        id
      ]
    );
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/transport/configuration/societes/:id/statut — bascule
 * activer / désactiver (une société désactivée n'est plus scannable et sort
 * des selects, mais ses colis restent).
 */
async function toggleSociete(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Société introuvable.' });
    const [result] = await pool.query(
      `UPDATE delevery_transport_societes SET statut = IF(statut = 1, 0, 1) WHERE societe_id = ?`,
      [id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Société introuvable.' });
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/transport/configuration/tarif-standard — body { tarif }.
 * Tarif appliqué à toutes les sociétés sans grille personnalisée.
 */
async function setTarifStandard(req, res, next) {
  try {
    const tarif = parseMontant(req.body?.tarif);
    if (tarif === null) return res.status(400).json({ message: 'Tarif invalide.' });
    await pool.query(
      `INSERT INTO delevery_transport_config (config_id, tarif_standard, updated_time)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE tarif_standard = VALUES(tarif_standard),
                               updated_time = VALUES(updated_time)`,
      [tarif, Math.floor(Date.now() / 1000)]
    );
    res.json({ tarif });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transport/configuration/tarifs?societe=N — grille personnalisée
 * d'une société (ville de destination + tarif).
 */
async function listTarifs(req, res, next) {
  try {
    const societe = parseInt(req.query.societe, 10) || 0;
    if (!societe) return res.json([]);
    const [rows] = await pool.query(
      `SELECT t.transport_tarif_id AS id, t.ville_id, t.tarif,
              v.reference_ville AS ville_ref, v.nom_ville AS ville
         FROM delevery_transport_tarifs t
         LEFT JOIN delevery_tarifs v ON v.ville_id = t.ville_id
        WHERE t.societe_id = ?
        ORDER BY v.nom_ville`,
      [societe]
    );
    res.json(rows.map((r) => ({ ...r, tarif: Number(r.tarif) })));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transport/configuration/tarifs — body { societe, ville, tarif }.
 * Ajoute une ligne à la grille (couple société × ville unique).
 */
async function createTarif(req, res, next) {
  try {
    const societe = parseInt(req.body?.societe, 10);
    const ville = parseInt(req.body?.ville, 10);
    const tarif = parseMontant(req.body?.tarif);
    if (!Number.isInteger(societe) || societe <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une société.' });
    }
    if (!Number.isInteger(ville) || ville <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner la ville de destination.' });
    }
    if (tarif === null) return res.status(400).json({ message: 'Tarif invalide.' });
    const [[existe]] = await pool.query(
      `SELECT transport_tarif_id FROM delevery_transport_tarifs
        WHERE societe_id = ? AND ville_id = ? LIMIT 1`,
      [societe, ville]
    );
    if (existe) {
      return res.status(400).json({ message: 'Un tarif existe déjà pour cette ville : modifiez-le.' });
    }
    const [result] = await pool.query(
      `INSERT INTO delevery_transport_tarifs (societe_id, ville_id, tarif, created_time)
       VALUES (?, ?, ?, ?)`,
      [societe, ville, tarif, Math.floor(Date.now() / 1000)]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/transport/configuration/tarifs/:id — body { tarif }. Modifie le
 * tarif d'une ligne de la grille.
 */
async function updateTarif(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Tarif introuvable.' });
    const tarif = parseMontant(req.body?.tarif);
    if (tarif === null) return res.status(400).json({ message: 'Tarif invalide.' });
    const [result] = await pool.query(
      `UPDATE delevery_transport_tarifs SET tarif = ? WHERE transport_tarif_id = ?`,
      [tarif, id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Tarif introuvable.' });
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/transport/configuration/tarifs/:id — supprime une ligne de la
 * grille (la société repasse au tarif standard pour cette ville).
 */
async function deleteTarif(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Tarif introuvable.' });
    const [result] = await pool.query(
      `DELETE FROM delevery_transport_tarifs WHERE transport_tarif_id = ?`,
      [id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Tarif introuvable.' });
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getConfiguration,
  createSociete,
  updateSociete,
  toggleSociete,
  setTarifStandard,
  listTarifs,
  createTarif,
  updateTarif,
  deleteTarif,
  createTrajet,
  updateTrajet,
  deleteTrajet
};
