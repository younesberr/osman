const pool = require('../config/db');
const { parseServices } = require('../utils/access');
const { COOKIE_NAME } = require('./auth');

/*
 * Contrôle d'accès des membres d'équipe client (delevery_customer_members).
 * Le JWT d'un membre garde id = customers_id PARENT (tout le scoping existant
 * reste valable) et ajoute memberId ; le propriétaire n'a pas de memberId.
 * requireClientPermission relit le membre en base à CHAQUE requête gardée :
 * une désactivation / suppression / retrait de tâche prend effet immédiatement
 * malgré le JWT de 8 h (même esprit que la relecture users_services de /auth/me).
 */

/** Réservé au propriétaire du compte client (pas un membre d'équipe). */
function requireClientOwner(req, res, next) {
  if (req.user?.memberId) {
    return res.status(403).json({ message: 'Accès réservé au propriétaire du compte.' });
  }
  next();
}

/**
 * Exige une tâche attribuée (member_services) pour un membre d'équipe ;
 * le propriétaire passe toujours. À placer après requireKind('customer').
 */
function requireClientPermission(code) {
  return async (req, res, next) => {
    try {
      const memberId = Number(req.user?.memberId) || 0;
      if (!memberId) return next();

      const [[member]] = await pool.query(
        `SELECT member_name, member_services, member_active, member_deleted
           FROM delevery_customer_members
          WHERE member_id = ? AND member_customer = ?
          LIMIT 1`,
        [memberId, Number(req.user.id)]
      );
      if (!member || Number(member.member_deleted) === 1 || Number(member.member_active) !== 1) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return res.status(401).json({ message: 'Compte désactivé. Contactez le propriétaire du compte.' });
      }

      // Tâches à jour pour la suite de la requête (et le front via /auth/me).
      req.user.services = parseServices(member.member_services);
      req.user.name = member.member_name;
      if (code && !req.user.services.includes(code)) {
        return res.status(403).json({ message: 'Accès non autorisé.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireClientOwner, requireClientPermission };
