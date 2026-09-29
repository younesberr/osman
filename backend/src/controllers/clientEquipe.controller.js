const pool = require('../config/db');
const { hashPassword } = require('../utils/password');
const { parseServices } = require('../utils/access');
const { computeMemberServices } = require('../utils/clientServices');

/*
 * Page /client/equipe : membres du personnel d'un client
 * (delevery_customer_members, sql/2026-08-23_equipe-client-table-membres.sql).
 * Chaque membre a ses propres identifiants de connexion (email / téléphone +
 * mot de passe) et une liste de tâches attribuées (member_services) ; toutes
 * ses actions sont estampillées avec son member_id (colonnes *_member).
 * Routes réservées au propriétaire (requireClientOwner) : un membre ne peut
 * pas gérer l'équipe. Suppression = soft delete (member_deleted = 1) pour que
 * le nom reste résolvable dans l'historique ; l'identifiant est alors libéré.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapMembre(r) {
  return {
    member_id: r.member_id,
    name: r.member_name,
    fonction: r.member_fonction || '',
    email: r.member_email || '',
    phone: r.member_phone || '',
    active: Number(r.member_active),
    services: parseServices(r.member_services),
    created_at: r.member_created_at,
    last_login_at: r.member_last_login_at
  };
}

/** Membres non supprimés du client connecté. */
async function fetchMembres(customerId) {
  const [rows] = await pool.query(
    `SELECT member_id, member_name, member_fonction, member_email, member_phone,
            member_active, member_services, member_created_at, member_last_login_at
       FROM delevery_customer_members
      WHERE member_customer = ? AND member_deleted = 0
      ORDER BY member_name, member_id`,
    [customerId]
  );
  return rows.map(mapMembre);
}

/** Valide et normalise le corps d'un membre ; retourne { error } ou { data }. */
function parseMembreBody(body) {
  const name = String(body.name || '').trim();
  const fonction = String(body.fonction || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();

  if (!name) return { error: 'Le nom du membre est obligatoire.' };
  if (name.length > 191) return { error: 'Nom trop long (max 191 caractères).' };
  if (fonction.length > 100) return { error: 'Fonction trop longue (max 100 caractères).' };
  if (!email) {
    return { error: 'Un email est obligatoire pour se connecter.' };
  }
  if (email.length > 250 || !EMAIL_RE.test(email)) {
    return { error: 'Adresse email invalide.' };
  }
  if (phone.length > 50) return { error: 'Téléphone trop long (max 50 caractères).' };

  return {
    data: {
      name,
      fonction: fonction || null,
      email: email || null,
      phone: phone || null,
      /* Tâches attribuées : intersection avec le catalogue (backend autoritaire). */
      services: computeMemberServices(body.services)
    }
  };
}

/**
 * L'email de connexion doit être libre sur les DEUX tables : le login client
 * matche l'email d'abord sur delevery_customers puis sur
 * delevery_customer_members (membres non supprimés). Le téléphone peut être
 * partagé. Retourne true si un client ou un AUTRE membre utilise déjà l'email.
 */
async function emailPris(email, excludeMemberId) {
  if (!email) return false;
  const [[client]] = await pool.query(
    `SELECT customers_id FROM delevery_customers
      WHERE LOWER(customers_email) = LOWER(?)
      LIMIT 1`,
    [email]
  );
  if (client) return true;
  const [[membre]] = await pool.query(
    `SELECT member_id FROM delevery_customer_members
      WHERE member_id <> ? AND member_deleted = 0
        AND LOWER(member_email) = LOWER(?)
      LIMIT 1`,
    [excludeMemberId, email]
  );
  return Boolean(membre);
}

/** Ligne membre (non supprimée) appartenant au client connecté, ou null. */
async function fetchMembre(customerId, memberId) {
  const [[row]] = await pool.query(
    `SELECT member_id FROM delevery_customer_members
      WHERE member_id = ? AND member_customer = ? AND member_deleted = 0
      LIMIT 1`,
    [memberId, customerId]
  );
  return row || null;
}

/** Ligne du membre connecté (actif, non supprimé) + magasin parent ; null sinon. */
async function fetchMonCompteMembre(req) {
  const memberId = Number(req.user?.memberId) || 0;
  if (!memberId) return null;
  const [[row]] = await pool.query(
    `SELECT m.member_id, m.member_name, m.member_fonction, m.member_email, m.member_phone,
            c.customers_store, c.customers_name
       FROM delevery_customer_members m
       LEFT JOIN delevery_customers c ON c.customers_id = m.member_customer
      WHERE m.member_id = ? AND m.member_customer = ?
        AND m.member_deleted = 0 AND m.member_active = 1
      LIMIT 1`,
    [memberId, Number(req.user.id)]
  );
  return row || null;
}

function mapMonCompteMembre(row) {
  return {
    member_id: row.member_id,
    name: row.member_name,
    fonction: row.member_fonction || '',
    email: row.member_email || '',
    phone: row.member_phone || '',
    store: row.customers_store || row.customers_name || ''
  };
}

/**
 * GET /api/clients/me/membre-compte — « Ma fiche » d'un membre d'équipe
 * (sous-compte) : uniquement ses identifiants de connexion. Le propriétaire
 * n'a pas de membre : il passe par sa fiche complète (/clients/me/fiche).
 */
async function getMonCompteMembre(req, res, next) {
  try {
    const membre = await fetchMonCompteMembre(req);
    if (!membre) {
      return res.status(403).json({ message: 'Accès réservé aux membres d’équipe.' });
    }
    res.json(mapMonCompteMembre(membre));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/clients/me/membre-compte — le membre change son email de connexion
 * / mot de passe. Rien d'autre : nom, fonction, téléphone et tâches restent
 * gérés par le propriétaire (page /client/equipe).
 */
async function updateMonCompteMembre(req, res, next) {
  try {
    const membre = await fetchMonCompteMembre(req);
    if (!membre) {
      return res.status(403).json({ message: 'Accès réservé aux membres d’équipe.' });
    }

    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    if (email && (email.length > 250 || !EMAIL_RE.test(email))) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    // Le login matche email OU téléphone : sans téléphone, l'email est le seul identifiant.
    if (!email) {
      return res.status(400).json({ message: 'Un email est obligatoire pour se connecter.' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(email, membre.member_id)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const sets = ['member_email = ?'];
    const params = [email || null];
    if (password) {
      sets.push('member_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(
      `UPDATE delevery_customer_members SET ${sets.join(', ')} WHERE member_id = ?`,
      [...params, membre.member_id]
    );
    res.json(mapMonCompteMembre(await fetchMonCompteMembre(req)));
  } catch (err) {
    next(err);
  }
}

/** GET /api/clients/me/equipe — membres de l'équipe du client connecté. */
async function listEquipe(req, res, next) {
  try {
    res.json({ membres: await fetchMembres(Number(req.user.id)) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/clients/me/equipe — crée un membre (identifiants + tâches). */
async function createMembre(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const { error, data } = parseMembreBody(req.body || {});
    if (error) return res.status(400).json({ message: error });

    const password = String(req.body?.password || '');
    if (password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(data.email, 0)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const active = Number(req.body?.active) === 0 ? 0 : 1;
    const [result] = await pool.query(
      `INSERT INTO delevery_customer_members
         (member_customer, member_name, member_fonction, member_email, member_phone,
          member_password, member_services, member_active, member_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        customerId,
        data.name,
        data.fonction,
        data.email,
        data.phone,
        await hashPassword(password),
        data.services,
        active
      ]
    );
    const membres = await fetchMembres(customerId);
    res.status(201).json(membres.find((m) => m.member_id === result.insertId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/clients/me/equipe/:memberId — modifie un membre (mot de passe optionnel). */
async function updateMembre(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) return res.status(400).json({ message: 'Requête invalide.' });
    if (!(await fetchMembre(customerId, memberId))) {
      return res.status(404).json({ message: 'Membre introuvable.' });
    }

    const { error, data } = parseMembreBody(req.body || {});
    if (error) return res.status(400).json({ message: error });

    const password = String(req.body?.password || '');
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(data.email, memberId)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const sets = [
      'member_name = ?',
      'member_fonction = ?',
      'member_email = ?',
      'member_phone = ?',
      'member_services = ?'
    ];
    const params = [data.name, data.fonction, data.email, data.phone, data.services];
    if (password) {
      sets.push('member_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(
      `UPDATE delevery_customer_members SET ${sets.join(', ')} WHERE member_id = ? AND member_customer = ?`,
      [...params, memberId, customerId]
    );

    const membres = await fetchMembres(customerId);
    res.json(membres.find((m) => m.member_id === memberId));
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/clients/me/equipe/:memberId/active — { active: 0|1 }. */
async function setMembreActive(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const memberId = parseInt(req.params.memberId, 10);
    const active = Number(req.body?.active);
    if (!Number.isInteger(memberId) || ![0, 1].includes(active)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_customer_members SET member_active = ?
        WHERE member_id = ? AND member_customer = ? AND member_deleted = 0`,
      [active, memberId, customerId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Membre introuvable.' });
    }
    res.json({ member_id: memberId, active });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/clients/me/equipe/:memberId — soft delete : la ligne reste pour
 * l'historique (nom dans le suivi des colis / mouvements), l'identifiant est
 * libéré et le membre ne peut plus se connecter.
 */
async function deleteMembre(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const memberId = parseInt(req.params.memberId, 10);
    if (!Number.isInteger(memberId)) return res.status(400).json({ message: 'Requête invalide.' });
    const [result] = await pool.query(
      `UPDATE delevery_customer_members SET member_deleted = 1, member_active = 0
        WHERE member_id = ? AND member_customer = ? AND member_deleted = 0`,
      [memberId, customerId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Membre introuvable.' });
    }
    res.json({ member_id: memberId, deleted: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listEquipe,
  createMembre,
  updateMembre,
  setMembreActive,
  deleteMembre,
  getMonCompteMembre,
  updateMonCompteMembre
};
