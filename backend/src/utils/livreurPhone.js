const pool = require('../config/db');

/*
 * Numéro de téléphone « utile » d'un livreur. Un livreur salarié
 * (users_is_salarie = 1) peut avoir plusieurs comptes-fonctions reliés par
 * users_parent_id : son numéro est celui de son compte LIVREUR (type 5) quand
 * il est renseigné, sinon celui de la ligne elle-même. Même CASE que le détail
 * de suivi (parcelsAdmin.controller.js / parcels.controller.js), partagé ici
 * pour le CRM WhatsApp.
 */

/** Fragment SQL (alias de delevery_users, `u` par défaut) → numéro du livreur. */
function LIVREUR_PHONE_SQL(alias = 'u') {
  return `CASE WHEN IFNULL(${alias}.users_is_salarie, 0) = 1 THEN
            COALESCE(
              (SELECT u2.users_phone FROM delevery_users u2
                WHERE (u2.users_id = COALESCE(${alias}.users_parent_id, ${alias}.users_id)
                       OR u2.users_parent_id = COALESCE(${alias}.users_parent_id, ${alias}.users_id))
                  AND u2.users_type = 5 AND COALESCE(u2.users_phone, '') <> ''
                LIMIT 1),
              ${alias}.users_phone)
          ELSE ${alias}.users_phone END`;
}

/** { id, nom, phone } d'un utilisateur (livreur ou employé), null si inconnu. */
async function livreurContact(usersId) {
  const id = Number(usersId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT u.users_id AS id, u.users_name AS nom, ${LIVREUR_PHONE_SQL('u')} AS phone
       FROM delevery_users u
      WHERE u.users_id = ? LIMIT 1`,
    [id]
  );
  return row ? { id: row.id, nom: row.nom || '', phone: row.phone || null } : null;
}

module.exports = { LIVREUR_PHONE_SQL, livreurContact };
