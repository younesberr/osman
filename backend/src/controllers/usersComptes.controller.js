const pool = require('../config/db');
const { hashPassword } = require('../utils/password');
const { parseServices } = require('../utils/access');
const { TYPES_AVEC_AGENCE, computeServices } = require('../utils/typeServices');
const { agenceIdFromVille } = require('../utils/agenceScope');

/*
 * Fiche utilisateur, onglet "Comptes" : coordonnées d'accès d'une personne.
 * Chaque compte est une ligne de delevery_users (la connexion lit une ligne
 * par identifiant, rien ne change côté auth) ; les comptes d'une même personne
 * sont reliés par users_parent_id (sql/2026-08-03_delevery-users-colonne-parent-id.sql) :
 * NULL = compte principal (porte la fiche), sinon users_id du principal.
 * Un compte par fonction (users_type) et par personne ; les identifiants
 * (email / téléphone) doivent être libres sur toute la table car le login
 * matche users_email OU users_phone.
 * L'agence n'est plus saisie : elle est dérivée de la ville de fonction
 * (users_ville_id → zone → zone_agence_id) et users_agence_id (colonne
 * legacy) est resynchronisée à chaque enregistrement.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** users_id du compte principal d'une personne (id lui-même s'il est principal). */
async function principalIdOf(userId) {
  const [[row]] = await pool.query(
    `SELECT users_parent_id FROM delevery_users WHERE users_id = ? LIMIT 1`,
    [userId]
  );
  return row?.users_parent_id || Number(userId);
}

/** Ligne principale (users_parent_id NULL) ou null. */
async function fetchPrincipal(id) {
  const [[row]] = await pool.query(
    `SELECT users_id, users_name, users_personnel_id, users_is_salarie
       FROM delevery_users
      WHERE users_id = ? AND users_parent_id IS NULL
      LIMIT 1`,
    [id]
  );
  return row || null;
}

/** Comptes d'une personne : principal en tête puis secondaires. */
async function fetchComptes(principalId) {
  const [rows] = await pool.query(
    `SELECT u.users_id, u.users_type, t.user_types_code AS type_code,
            u.users_email, u.users_phone, u.users_active,
            vz.zone_name AS zone,
            a.agence_name AS agence,
            u.users_ville_id, v.nom_ville AS ville,
            u.users_services,
            (u.users_parent_id IS NULL) AS principal
       FROM delevery_users u
       LEFT JOIN delevery_user_types t ON t.user_types_id = u.users_type
       LEFT JOIN delevery_tarifs v     ON v.ville_id = u.users_ville_id
       LEFT JOIN delevery_zone vz      ON vz.zone_id = v.zone
       LEFT JOIN delevery_agences a    ON a.agence_id = COALESCE(vz.zone_agence_id, u.users_agence_id)
      WHERE u.users_id = ? OR u.users_parent_id = ?
      ORDER BY u.users_parent_id IS NULL DESC, u.users_id`,
    [principalId, principalId]
  );
  return rows.map((r) => ({
    users_id: r.users_id,
    users_type: r.users_type,
    type_code: r.type_code,
    users_email: r.users_email,
    users_phone: r.users_phone,
    users_active: r.users_active,
    zone: r.zone,
    agence: r.agence,
    users_ville_id: r.users_ville_id,
    ville: r.ville,
    services: parseServices(r.users_services),
    principal: Number(r.principal) === 1
  }));
}

/** Valide et normalise le corps d'un compte ; retourne { error } ou { data }. */
function parseCompteBody(body) {
  const type = parseInt(body.users_type, 10);
  const email = String(body.users_email || '').trim();
  const phone = String(body.users_phone || '').trim();
  const villeRaw = String(body.users_ville_id ?? '').trim();
  const villeId = villeRaw ? parseInt(villeRaw, 10) : null;

  if (!Number.isInteger(type) || type < 1 || type > 6) {
    return { error: 'Fonction invalide.' };
  }
  if (!email) {
    return { error: 'Un email est obligatoire pour se connecter.' };
  }
  if (email.length > 250 || !EMAIL_RE.test(email)) {
    return { error: 'Adresse email invalide.' };
  }
  if (phone.length > 50) return { error: 'Téléphone trop long (max 50 caractères).' };
  if (villeRaw && !Number.isInteger(villeId)) return { error: 'Ville de fonction invalide.' };

  return {
    data: {
      type,
      email,
      phone,
      villeId,
      /* Menus accessibles : défauts de la fonction + optionnels cochés (validés). */
      services: computeServices(type, body.services)
    }
  };
}

/**
 * L'email de connexion doit être libre sur toute la table (le login se fait
 * par email uniquement ; le téléphone peut être partagé entre comptes).
 * Retourne true si un AUTRE compte utilise déjà cet email.
 */
async function emailPris(email, excludeId) {
  if (!email) return false;
  const [[dup]] = await pool.query(
    `SELECT users_id FROM delevery_users
      WHERE users_id <> ? AND LOWER(users_email) = LOWER(?)
      LIMIT 1`,
    [excludeId, email]
  );
  return Boolean(dup);
}

/** Une seule coordonnée d'accès par fonction et par personne. */
async function fonctionPrise(principalId, type, excludeId) {
  const [[dup]] = await pool.query(
    `SELECT users_id FROM delevery_users
      WHERE (users_id = ? OR users_parent_id = ?) AND users_type = ? AND users_id <> ?
      LIMIT 1`,
    [principalId, principalId, type, excludeId]
  );
  return Boolean(dup);
}

/** GET /api/users/:id/comptes — comptes de la personne (principal + secondaires). */
async function listComptes(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const principal = await fetchPrincipal(id);
    if (!principal) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    res.json({ comptes: await fetchComptes(id) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/users/:id/comptes — crée un compte secondaire pour la personne. */
async function createCompte(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const principal = await fetchPrincipal(id);
    if (!principal) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const { error, data } = parseCompteBody(req.body || {});
    if (error) return res.status(400).json({ message: error });

    const password = String(req.body?.password || '');
    if (password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(data.email, 0)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }
    if (await fonctionPrise(id, data.type, 0)) {
      return res.status(409).json({ message: 'Cette personne a déjà un compte pour cette fonction.' });
    }

    const active = Number(req.body?.users_active) === 0 ? 0 : 1;
    /* Agence dérivée de la ville de fonction (users_agence_id = miroir legacy).
       Super admin et responsable service ne sont pas rattachés à une agence. */
    const agenceId = TYPES_AVEC_AGENCE.includes(data.type)
      ? await agenceIdFromVille(data.villeId)
      : null;
    const [result] = await pool.query(
      `INSERT INTO delevery_users
         (users_name, users_type, users_email, users_phone, users_password,
          users_active, users_agence_id, users_ville_id, users_services,
          users_personnel_id, users_is_salarie, users_parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        principal.users_name,
        data.type,
        data.email || null,
        data.phone || null,
        await hashPassword(password),
        active,
        agenceId,
        data.villeId,
        data.services,
        principal.users_personnel_id,
        /* Statut personnel (salarié / auto-entrepreneur) : celui de la personne. */
        principal.users_is_salarie,
        id
      ]
    );
    const comptes = await fetchComptes(id);
    res.status(201).json(comptes.find((c) => c.users_id === result.insertId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/users/:id/comptes/:compteId — modifie un compte (mot de passe optionnel). */
async function updateCompte(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const compteId = parseInt(req.params.compteId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(compteId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const principal = await fetchPrincipal(id);
    if (!principal) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const [[compte]] = await pool.query(
      `SELECT users_id, users_type, (users_parent_id IS NULL) AS principal
         FROM delevery_users
        WHERE users_id = ? AND (users_id = ? OR users_parent_id = ?)
        LIMIT 1`,
      [compteId, id, id]
    );
    if (!compte) return res.status(404).json({ message: 'Compte introuvable.' });

    const { error, data } = parseCompteBody(req.body || {});
    if (error) return res.status(400).json({ message: error });

    /* users_type est stocké en texte sur cette table legacy → comparaison numérique. */
    if (Number(compte.principal) === 1 && data.type !== Number(compte.users_type)) {
      return res
        .status(400)
        .json({ message: 'La fonction du compte principal ne se modifie pas ici.' });
    }

    const password = String(req.body?.password || '');
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(data.email, compteId)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }
    if (await fonctionPrise(id, data.type, compteId)) {
      return res.status(409).json({ message: 'Cette personne a déjà un compte pour cette fonction.' });
    }

    /* Agence dérivée de la ville de fonction (users_agence_id = miroir legacy). */
    const agenceId = TYPES_AVEC_AGENCE.includes(data.type)
      ? await agenceIdFromVille(data.villeId)
      : null;
    const sets = [
      'users_type = ?',
      'users_email = ?',
      'users_phone = ?',
      'users_agence_id = ?',
      'users_ville_id = ?',
      'users_services = ?'
    ];
    const params = [
      data.type,
      data.email || null,
      data.phone || null,
      agenceId,
      data.villeId,
      data.services
    ];
    if (password) {
      sets.push('users_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(`UPDATE delevery_users SET ${sets.join(', ')} WHERE users_id = ?`, [
      ...params,
      compteId
    ]);

    const comptes = await fetchComptes(id);
    res.json(comptes.find((c) => c.users_id === compteId));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/users/me/comptes/:compteId — un employé modifie SES identifiants de
 * connexion (email, téléphone, mot de passe) depuis la page « Ma fiche ».
 * Rien d'autre : fonction, ville, menus et activation restent gérés par le
 * service UTILISATEURS.
 */
async function updateCompteSelf(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10); // principal, forcé par selfEmployee
    const compteId = parseInt(req.params.compteId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(compteId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const [[compte]] = await pool.query(
      `SELECT users_id FROM delevery_users
        WHERE users_id = ? AND (users_id = ? OR users_parent_id = ?)
        LIMIT 1`,
      [compteId, id, id]
    );
    if (!compte) return res.status(404).json({ message: 'Compte introuvable.' });

    const email = String(req.body?.users_email || '').trim();
    const phone = String(req.body?.users_phone || '').trim();
    if (!email) {
      return res.status(400).json({ message: 'Un email est obligatoire pour se connecter.' });
    }
    if (email.length > 250 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    if (phone.length > 50) {
      return res.status(400).json({ message: 'Téléphone trop long (max 50 caractères).' });
    }
    const password = String(req.body?.password || '');
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(email, compteId)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const sets = ['users_email = ?', 'users_phone = ?'];
    const params = [email || null, phone || null];
    if (password) {
      sets.push('users_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(`UPDATE delevery_users SET ${sets.join(', ')} WHERE users_id = ?`, [
      ...params,
      compteId
    ]);

    const comptes = await fetchComptes(id);
    res.json(comptes.find((c) => c.users_id === compteId));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/users/:id/comptes/:compteId/active — { active: 0|1 }.
 * Comptes secondaires uniquement : le principal se gère depuis la datatable
 * Utilisateurs (PATCH /users/:id/active).
 */
async function setCompteActive(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const compteId = parseInt(req.params.compteId, 10);
    const active = Number(req.body?.active);
    if (!Number.isInteger(id) || !Number.isInteger(compteId) || ![0, 1].includes(active)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    if (compteId === Number(req.user.id)) {
      return res.status(400).json({ message: 'Impossible de désactiver votre propre compte.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_users SET users_active = ? WHERE users_id = ? AND users_parent_id = ?`,
      [active, compteId, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Compte introuvable.' });
    }
    res.json({ users_id: compteId, users_active: active });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listComptes,
  createCompte,
  updateCompte,
  updateCompteSelf,
  setCompteActive,
  principalIdOf
};
