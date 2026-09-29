const pool = require('../config/db');

/*
 * Configuration > Gestion agences (delevery_agences).
 * agence_phone = téléphone mobile, agence_phone_fixe = téléphone fixe.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valide et normalise le corps d'une agence ; retourne { error } ou { data }. */
function parseAgenceBody(body) {
  const nom = String(body.nom || '').trim();
  const code = String(body.code || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const phoneFixe = String(body.phoneFixe || '').trim();
  const ville = String(body.ville || '').trim();
  const adresse = String(body.adresse || '').trim();
  const active = Number(body.active) === 0 ? 0 : 1;

  if (!nom) return { error: "Le nom de l'agence est obligatoire." };
  if (nom.length > 255) return { error: 'Nom trop long (max 255 caractères).' };
  if (!code) return { error: "Le code de l'agence est obligatoire." };
  if (code.length > 50) return { error: 'Code trop long (max 50 caractères).' };
  if (email && (email.length > 255 || !EMAIL_RE.test(email))) {
    return { error: 'Adresse email invalide.' };
  }
  if (phone.length > 20) return { error: 'Téléphone mobile trop long (max 20 caractères).' };
  if (phoneFixe.length > 20) return { error: 'Téléphone fixe trop long (max 20 caractères).' };
  if (ville.length > 255) return { error: 'Ville trop longue (max 255 caractères).' };

  return { data: { nom, code, email, phone, phoneFixe, ville, adresse, active } };
}

/** GET /api/config/agences — toutes les agences. */
async function listAgences(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT agence_id         AS id,
              agence_name       AS nom,
              agence_code       AS code,
              agence_email      AS email,
              agence_phone      AS phone,
              agence_phone_fixe AS phoneFixe,
              agence_city       AS ville,
              agence_address    AS adresse,
              agence_active     AS active
         FROM delevery_agences
        ORDER BY agence_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** POST /api/config/agences — crée une agence. */
async function createAgence(req, res, next) {
  try {
    const { error, data } = parseAgenceBody(req.body);
    if (error) return res.status(400).json({ message: error });

    const [[dup]] = await pool.query(
      `SELECT agence_id FROM delevery_agences WHERE LOWER(agence_code) = LOWER(?) LIMIT 1`,
      [data.code]
    );
    if (dup) return res.status(409).json({ message: `Le code « ${data.code} » existe déjà.` });

    const [result] = await pool.query(
      `INSERT INTO delevery_agences
         (agence_name, agence_code, agence_email, agence_phone, agence_phone_fixe,
          agence_city, agence_address, agence_active, agence_created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nom,
        data.code,
        data.email || null,
        data.phone || null,
        data.phoneFixe || null,
        data.ville || null,
        data.adresse || null,
        data.active,
        req.user?.id || null
      ]
    );
    res.status(201).json({
      id: result.insertId,
      nom: data.nom,
      code: data.code,
      email: data.email || null,
      phone: data.phone || null,
      phoneFixe: data.phoneFixe || null,
      ville: data.ville || null,
      adresse: data.adresse || null,
      active: data.active
    });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/agences/:id — modifie une agence (le statut est géré à part). */
async function updateAgence(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const { error, data } = parseAgenceBody(req.body);
    if (error) return res.status(400).json({ message: error });

    const [[dup]] = await pool.query(
      `SELECT agence_id FROM delevery_agences
        WHERE LOWER(agence_code) = LOWER(?) AND agence_id <> ? LIMIT 1`,
      [data.code, id]
    );
    if (dup) return res.status(409).json({ message: `Le code « ${data.code} » existe déjà.` });

    const [result] = await pool.query(
      `UPDATE delevery_agences
          SET agence_name = ?, agence_code = ?, agence_email = ?, agence_phone = ?,
              agence_phone_fixe = ?, agence_city = ?, agence_address = ?
        WHERE agence_id = ?`,
      [
        data.nom,
        data.code,
        data.email || null,
        data.phone || null,
        data.phoneFixe || null,
        data.ville || null,
        data.adresse || null,
        id
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Agence introuvable.' });
    }
    res.json({
      id,
      nom: data.nom,
      code: data.code,
      email: data.email || null,
      phone: data.phone || null,
      phoneFixe: data.phoneFixe || null,
      ville: data.ville || null,
      adresse: data.adresse || null
    });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/agences/:id/active — { active: 0|1 }. */
async function setAgenceActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const active = Number(req.body.active) === 1 ? 1 : 0;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_agences SET agence_active = ? WHERE agence_id = ?`,
      [active, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Agence introuvable.' });
    }
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAgences, createAgence, updateAgence, setAgenceActive };
