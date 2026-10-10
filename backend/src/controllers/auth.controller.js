const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { verifyPassword, hashPassword, isLegacyHash } = require('../utils/password');
const { COOKIE_NAME } = require('../middleware/auth');
const { BRAND } = require('../config/brand');

const { parseServices } = require('../utils/access');

const ADMIN_TYPES = [1, 2, 3, 4, 6];
const LIVREUR_TYPE = 5;
const TOKEN_TTL = '8h';
const COOKIE_TTL_MS = 8 * 60 * 60 * 1000;

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: TOKEN_TTL,
    issuer: BRAND.jwtIssuer,
    audience: BRAND.jwtAudience
  });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_TTL_MS,
    path: '/'
  });
}

function dashboardFor(user) {
  if (user.kind === 'customer') return 'client';
  return Number(user.role) === LIVREUR_TYPE ? 'livreur' : 'admin';
}

const GENERIC_FAIL = { message: 'Identifiants incorrects.' };

/*
 * Option « Stock » du compte client (customers_stock, varchar '0'/'1', modale
 * Options de /admin/clients) : 0 → pas de menu « Gestion stock » (front :
 * hasClientAccess). Hors JWT, relue par /auth/me pour suivre les changements.
 */
function stockFlag(value) {
  return Number(value) === 1 ? 1 : 0;
}

/**
 * POST /api/auth/login/client — table delevery_customers, sinon membre d'équipe
 * (delevery_customer_members). Le propriétaire gagne toujours : la table des
 * membres n'est interrogée que si aucun client ne matche l'identifiant
 * (l'unicité croisée est vérifiée à la création des membres). Le JWT d'un
 * membre garde id = customers_id PARENT (tout le scoping existant est intact)
 * et ajoute memberId + les tâches attribuées.
 */
async function loginClient(req, res, next) {
  try {
    const { identifiant, password } = req.body;
    const [rows] = await pool.execute(
      `SELECT customers_id, customers_name, customers_email, customers_password,
              customers_store, customers_active, customers_stock
         FROM delevery_customers
        WHERE customers_email = ?
        LIMIT 1`,
      [identifiant]
    );

    const customer = rows[0];
    if (customer) {
      const ok = await verifyPassword(password, customer.customers_password);
      if (!ok) return res.status(401).json(GENERIC_FAIL);
      if (Number(customer.customers_active) !== 1) {
        return res.status(403).json({ message: BRAND.messages.compteDesactive });
      }

      if (process.env.UPGRADE_LEGACY_HASHES === 'true' && isLegacyHash(customer.customers_password)) {
        const newHash = await hashPassword(password);
        await pool.execute('UPDATE delevery_customers SET customers_password = ? WHERE customers_id = ?', [
          newHash,
          customer.customers_id
        ]);
      }

      const user = {
        id: customer.customers_id,
        kind: 'customer',
        role: 'client',
        name: customer.customers_name
      };
      // Le token est aussi renvoyé dans le corps pour les intégrations API des
      // clients (documentation /client/api/documentation : header
      // Authorization: Bearer <token>) ; le dashboard web s'appuie sur le cookie.
      const token = signToken(user);
      setAuthCookie(res, token);
      return res.json({
        user: { ...user, store: customer.customers_store, stock: stockFlag(customer.customers_stock), dashboard: 'client' },
        token
      });
    }

    // Membre d'équipe (tolère l'absence de la table tant que la migration
    // 2026-08-23_equipe-client-table-membres.sql n'a pas été exécutée).
    let member;
    try {
      const [mRows] = await pool.execute(
        `SELECT m.member_id, m.member_customer, m.member_name, m.member_fonction,
                m.member_password, m.member_services, m.member_active,
                c.customers_store, c.customers_active, c.customers_stock
           FROM delevery_customer_members m
           JOIN delevery_customers c ON c.customers_id = m.member_customer
          WHERE m.member_email = ? AND m.member_deleted = 0
          LIMIT 1`,
        [identifiant]
      );
      member = mRows[0];
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    const ok = member && (await verifyPassword(password, member.member_password));
    if (!ok) return res.status(401).json(GENERIC_FAIL);
    if (Number(member.member_active) !== 1) {
      return res.status(403).json({ message: 'Compte désactivé. Contactez le propriétaire du compte.' });
    }
    if (Number(member.customers_active) !== 1) {
      return res.status(403).json({ message: BRAND.messages.compteDesactive });
    }

    await pool.execute('UPDATE delevery_customer_members SET member_last_login_at = NOW() WHERE member_id = ?', [
      member.member_id
    ]);

    const user = {
      id: member.member_customer,
      kind: 'customer',
      role: 'client',
      name: member.member_name,
      memberId: member.member_id,
      services: parseServices(member.member_services)
    };
    const token = signToken(user);
    setAuthCookie(res, token);
    return res.json({
      user: {
        ...user,
        store: member.customers_store,
        fonction: member.member_fonction,
        stock: stockFlag(member.customers_stock),
        dashboard: 'client'
      },
      token
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/login/employee — table delevery_users */
async function loginEmployee(req, res, next) {
  try {
    const { identifiant, password } = req.body;
    const [rows] = await pool.execute(
      `SELECT users_id, users_name, users_email, users_password, users_type, users_active,
              users_services, users_pic
         FROM delevery_users
        WHERE users_email = ?
        LIMIT 1`,
      [identifiant]
    );

    const employee = rows[0];
    const ok = employee && (await verifyPassword(password, employee.users_password));
    if (!ok) return res.status(401).json(GENERIC_FAIL);
    if (Number(employee.users_active) !== 1) {
      return res.status(403).json({ message: 'Compte désactivé. Contactez votre responsable.' });
    }

    const type = Number(employee.users_type);
    if (!ADMIN_TYPES.includes(type) && type !== LIVREUR_TYPE) {
      return res.status(403).json({ message: 'Type de compte non autorisé.' });
    }

    if (process.env.UPGRADE_LEGACY_HASHES === 'true' && isLegacyHash(employee.users_password)) {
      const newHash = await hashPassword(password);
      await pool.execute('UPDATE delevery_users SET users_password = ? WHERE users_id = ?', [
        newHash,
        employee.users_id
      ]);
    }

    const user = {
      id: employee.users_id,
      kind: 'employee',
      role: type,
      name: employee.users_name,
      services: parseServices(employee.users_services)
    };
    const token = signToken(user);
    setAuthCookie(res, token);
    // La photo n'est pas signée dans le token (taille) : renvoyée à part, comme dans /me.
    // Le token est aussi renvoyé dans le corps pour les intégrations API
    // (plateformes des livreurs : header Authorization: Bearer <token>) ;
    // le dashboard web, lui, s'appuie sur le cookie httpOnly.
    return res.json({
      user: { ...user, pic: employee.users_pic || null, dashboard: dashboardFor(user) },
      token
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me — recharge les accès pour refléter les changements sans
 * re-login : users_services pour un employé (désactivé → déconnexion), la ligne
 * membre pour un membre d'équipe client (désactivé / supprimé → déconnexion),
 * l'option « Stock » (customers_stock) pour tout compte client.
 */
async function me(req, res, next) {
  try {
    const user = { ...req.user };
    if (user.kind === 'employee') {
      const [rows] = await pool.execute(
        'SELECT users_services, users_name, users_pic, users_active FROM delevery_users WHERE users_id = ? LIMIT 1',
        [user.id]
      );
      // Désactivé après le login → déconnexion immédiate (même règle que
      // requireService, qui relit aussi le compte à chaque requête gardée).
      if (!rows[0] || Number(rows[0].users_active) !== 1) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ message: 'Compte désactivé. Contactez votre responsable.' });
      }
      user.services = parseServices(rows[0].users_services);
      user.name = rows[0].users_name;
      user.pic = rows[0].users_pic || null;
    } else if (user.kind === 'customer' && user.memberId) {
      const [rows] = await pool.execute(
        `SELECT member_name, member_fonction, member_services, member_active, member_deleted
           FROM delevery_customer_members
          WHERE member_id = ? AND member_customer = ?
          LIMIT 1`,
        [user.memberId, user.id]
      );
      const member = rows[0];
      if (!member || Number(member.member_deleted) === 1 || Number(member.member_active) !== 1) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ message: 'Compte désactivé. Contactez le propriétaire du compte.' });
      }
      user.name = member.member_name;
      user.fonction = member.member_fonction;
      user.services = parseServices(member.member_services);
    }
    if (user.kind === 'customer') {
      // Option « Stock » du compte (un membre d'équipe hérite de celle du propriétaire).
      const [rows] = await pool.execute(
        'SELECT customers_stock FROM delevery_customers WHERE customers_id = ? LIMIT 1',
        [user.id]
      );
      user.stock = stockFlag(rows[0]?.customers_stock);
    }
    return res.json({ user: { ...user, dashboard: dashboardFor(user) } });
  } catch (err) {
    next(err);
  }
}

/** POST /api/auth/logout */
async function logout(req, res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ message: 'Déconnecté.' });
}

module.exports = { loginClient, loginEmployee, me, logout, ADMIN_TYPES, LIVREUR_TYPE };
