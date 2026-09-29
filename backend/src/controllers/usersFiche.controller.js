const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');

/**
 * Fiche utilisateur (page /admin/utilisateurs/:id, onglet "Infos personnelles").
 * Les informations sont lues et écrites directement sur delevery_users :
 *  - colonnes réutilisées : users_name, users_cin, users_cin_recto_image,
 *    users_cin_verso_image, users_city, users_address, users_phone, users_bank,
 *    users_rib, users_rib_image ;
 *  - colonnes ajoutées (sql/2026-08-03_delevery-users-colonnes-fiche-infos-personnelles.sql) :
 *    users_cin_expiration, users_date_naissance, users_permis_numero,
 *    users_permis_expiration, users_permis_fichier, users_visite_medicale,
 *    users_visite_medicale_expiration, users_fiche_updated_at.
 * Périmètre = page Utilisateurs : les livreurs auto-entrepreneurs sont exclus
 * (même règle que users.controller SCOPE_SQL.utilisateurs).
 */

const SCOPE_UTILISATEURS_SQL = 'NOT (u.users_type = 5 AND IFNULL(u.users_is_salarie, 1) = 0)';

const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'users');

/* Fichiers de la fiche : champ multipart → colonne delevery_users. */
const FILE_FIELDS = {
  cin_recto: 'users_cin_recto_image',
  cin_verso: 'users_cin_verso_image',
  rib: 'users_rib_image',
  permis: 'users_permis_fichier',
  visite_medicale: 'users_visite_medicale'
};

/* Champs texte : nom multipart → [colonne, longueur max]. */
const TEXT_FIELDS = {
  users_name: ['users_name', 250],
  users_cin: ['users_cin', 25],
  users_address: ['users_address', 250],
  users_phone: ['users_phone', 50],
  users_rib: ['users_rib', 25],
  users_permis_numero: ['users_permis_numero', 100]
};

const DATE_FIELDS = ['users_cin_expiration', 'users_date_naissance', 'users_permis_expiration', 'users_visite_medicale_expiration'];
const INT_FIELDS = ['users_city', 'users_bank'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/** Date (objet Date mysql2) → 'AAAA-MM-JJ' en heure locale. */
function toDateStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Datetime → 'AAAA-MM-JJ HH:MM:SS' en heure locale. */
function toDateTimeStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Chemin public d'un fichier uploadé par la fiche, null sinon (fichiers legacy non servis). */
function isServedFile(value) {
  return typeof value === 'string' && value.startsWith('/uploads/users/');
}

async function fetchFiche(id) {
  const [rows] = await pool.query(
    `SELECT u.users_id, u.users_name, u.users_email, u.users_pic, u.users_active,
            u.users_cin, u.users_cin_expiration, u.users_date_naissance,
            u.users_cin_recto_image, u.users_cin_verso_image,
            u.users_city, u.users_address, u.users_phone,
            u.users_bank, u.users_rib, u.users_rib_image,
            u.users_permis_numero, u.users_permis_expiration, u.users_permis_fichier,
            u.users_visite_medicale, u.users_visite_medicale_expiration,
            u.users_fiche_updated_at, u.users_type, u.users_ville_id,
            t.user_types_code AS type_code,
            vf.nom_ville AS ville_fonction,
            vz.zone_name AS zone,
            a.agence_name AS agence
       FROM delevery_users u
       LEFT JOIN delevery_user_types t ON t.user_types_id = u.users_type
       LEFT JOIN delevery_tarifs vf    ON vf.ville_id = u.users_ville_id
       LEFT JOIN delevery_zone vz      ON vz.zone_id = vf.zone
       LEFT JOIN delevery_agences a    ON a.agence_id = COALESCE(vz.zone_agence_id, u.users_agence_id)
      WHERE u.users_id = ? AND ${SCOPE_UTILISATEURS_SQL}`,
    [id]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    users_id: r.users_id,
    users_name: r.users_name,
    users_email: r.users_email,
    users_pic: r.users_pic,
    users_active: r.users_active,
    users_type: r.users_type,
    type_code: r.type_code,
    users_ville_id: r.users_ville_id,
    ville_fonction: r.ville_fonction,
    zone: r.zone,
    agence: r.agence,
    users_cin: r.users_cin,
    users_cin_expiration: toDateStr(r.users_cin_expiration),
    users_date_naissance: toDateStr(r.users_date_naissance),
    users_cin_recto_image: r.users_cin_recto_image,
    users_cin_verso_image: r.users_cin_verso_image,
    users_city: r.users_city,
    users_address: r.users_address,
    users_phone: r.users_phone,
    users_bank: r.users_bank,
    users_rib: r.users_rib,
    users_rib_image: r.users_rib_image,
    users_permis_numero: r.users_permis_numero,
    users_permis_expiration: toDateStr(r.users_permis_expiration),
    users_permis_fichier: r.users_permis_fichier,
    users_visite_medicale: r.users_visite_medicale,
    users_visite_medicale_expiration: toDateStr(r.users_visite_medicale_expiration),
    users_fiche_updated_at: toDateTimeStr(r.users_fiche_updated_at)
  };
}

/** GET /api/users/:id — fiche complète d'un utilisateur du périmètre Utilisateurs. */
async function getFiche(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    res.json(fiche);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/fiche/options — listes du formulaire :
 *  - banques : delevery_configs (configs_var = 'ws_config_banks_name', actives) ;
 *  - villes  : delevery_tarifs (référentiel des villes, comme parcel_city).
 */
async function getFicheOptions(req, res, next) {
  try {
    const [banques] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs
        WHERE configs_var = 'ws_config_banks_name' AND configs_active = 1
        ORDER BY configs_val`
    );
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    res.json({
      banques: banques.map((b) => ({ id: b.configs_id, nom: b.configs_val })),
      villes: villes.map((v) => ({ id: v.ville_id, nom: v.nom_ville }))
    });
  } catch (err) {
    next(err);
  }
}

/** Supprime un fichier précédemment uploadé par la fiche (jamais les fichiers legacy). */
function removeOldUpload(value) {
  if (!isServedFile(value)) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(value));
  fs.unlink(filePath, () => {});
}

/**
 * PUT /api/users/:id/fiche — enregistre l'onglet "Infos personnelles"
 * (multipart/form-data : champs texte + fichiers, voir FILE_FIELDS).
 * Un fichier envoyé remplace l'ancien ; les champs texte absents du corps
 * ne sont pas modifiés, une chaîne vide efface la valeur (NULL).
 */
async function updateFiche(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });

    const current = await fetchFiche(id);
    if (!current) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const body = req.body || {};
    const sets = [];
    const params = [];

    for (const [field, [column, maxLen]] of Object.entries(TEXT_FIELDS)) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim().slice(0, maxLen);
      if ((field === 'users_name' || field === 'users_cin') && !value) {
        return res.status(400).json({ message: 'Le nom complet et le CIN sont obligatoires.' });
      }
      sets.push(`${column} = ?`);
      params.push(value || null);
    }

    for (const field of DATE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim();
      if (value && !DATE_RE.test(value)) {
        return res.status(400).json({ message: 'Format de date invalide (AAAA-MM-JJ attendu).' });
      }
      sets.push(`${field} = ?`);
      params.push(value || null);
    }

    for (const field of INT_FIELDS) {
      if (body[field] === undefined) continue;
      const raw = String(body[field]).trim();
      const value = parseInt(raw, 10);
      if (raw && !Number.isInteger(value)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      sets.push(`${field} = ?`);
      params.push(raw ? value : null);
    }

    for (const [field, column] of Object.entries(FILE_FIELDS)) {
      const file = req.files?.[field]?.[0];
      if (!file) continue;
      removeOldUpload(current[column]);
      sets.push(`${column} = ?`);
      params.push(`/uploads/users/${file.filename}`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: 'Aucune modification envoyée.' });
    }
    sets.push('users_fiche_updated_at = NOW()');

    await pool.query(`UPDATE delevery_users SET ${sets.join(', ')} WHERE users_id = ?`, [...params, id]);
    if (body.users_name !== undefined) {
      // Nom repris par les comptes secondaires (onglet "Comptes") pour rester
      // cohérent partout, y compris côté système legacy.
      await pool.query(`UPDATE delevery_users SET users_name = ? WHERE users_parent_id = ?`, [
        String(body.users_name).trim().slice(0, 250) || null,
        id
      ]);
    }
    res.json(await fetchFiche(id));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getFiche,
  getFicheOptions,
  updateFiche,
  ensureUploadDir,
  FILE_FIELDS,
  SCOPE_UTILISATEURS_SQL,
  UPLOAD_DIR
};
