const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { hasAccess, parseServices, SUPER_ADMIN_TYPE } = require('../utils/access');

const COOKIE_NAME = 'ortalog_token';
const DEACTIVATED = { message: 'Compte désactivé. Contactez votre responsable.' };

function getToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Exige un JWT valide. Attache req.user = { id, kind, role, name }. */
function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'ortalog',
      audience: 'ortalog-app'
    });
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Session invalide ou expirée.' });
  }
}

/** Exige kind = 'customer' | 'employee'. */
function requireKind(kind) {
  return (req, res, next) => {
    if (!req.user || req.user.kind !== kind) {
      return res.status(403).json({ message: 'Accès non autorisé.' });
    }
    next();
  };
}

/** Exige un users_type parmi la liste (employés uniquement). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || req.user.kind !== 'employee' || !roles.includes(Number(req.user.role))) {
      return res.status(403).json({ message: 'Accès non autorisé.' });
    }
    next();
  };
}

/**
 * Relit en base les accès d'un employé (hors superAdmin) pour que req.user
 * reflète delevery_users et non le JWT signé au login (valable 8 h) : un menu
 * ajouté ou retiré depuis Utilisateurs > Comptes prend effet immédiatement,
 * comme le fait déjà /auth/me pour l'affichage du menu — sans cette relecture
 * le menu s'affichait mais l'API répondait 403 jusqu'au re-login. Même esprit
 * que requireClientPermission pour les membres d'équipe client.
 * Renvoie false si le compte est introuvable ou désactivé.
 */
async function reloadEmployeeAccess(req) {
  const user = req.user;
  if (!user || user.kind !== 'employee' || Number(user.role) === SUPER_ADMIN_TYPE) return true;
  const [[row]] = await pool.query(
    'SELECT users_name, users_services, users_active FROM delevery_users WHERE users_id = ? LIMIT 1',
    [Number(user.id)]
  );
  if (!row || Number(row.users_active) !== 1) return false;
  user.services = parseServices(row.users_services);
  user.name = row.users_name;
  return true;
}

/** Middleware : accès employé à jour pour la suite de la requête (ex. compteurs sidebar). */
async function refreshEmployeeAccess(req, res, next) {
  try {
    if (!(await reloadEmployeeAccess(req))) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json(DEACTIVATED);
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Exige l'accès à un service (has_access) : superAdmin (type 1) passe toujours,
 * sinon le code doit figurer dans users_services (relu en base à chaque requête,
 * voir reloadEmployeeAccess).
 */
function requireService(service) {
  return async (req, res, next) => {
    try {
      if (!(await reloadEmployeeAccess(req))) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json(DEACTIVATED);
      }
      if (!hasAccess(req.user, service)) {
        return res.status(403).json({ message: 'Accès non autorisé.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requireAuth,
  requireKind,
  requireRole,
  requireService,
  refreshEmployeeAccess,
  COOKIE_NAME
};
