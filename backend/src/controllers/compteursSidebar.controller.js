const pool = require('../config/db');
const { hasAccess } = require('../utils/access');
const { getAgenceScope, parcelInAgence, villeInAgenceSql } = require('../utils/agenceScope');

/*
 * Compteurs des badges rouges de la sidebar admin (GET
 * /api/dashboard/admin/compteurs) — un seul appel pour tous les menus, mêmes
 * définitions d'« en attente » que les pages correspondantes :
 *  - stockColisEnAttente : colis de stock pas encore ramassés (stock.controller) ;
 *  - ramassage : demandes NEW (types 3/4 : agence ; ramasseur type 6 : ses
 *    demandes RECEIVED encore à traiter, une demande NEW n'étant jamais à lui) ;
 *  - remboursement / modificationsColis / nouveauxClients : demandes PENDING ;
 *  - reclamations : réclamations EN_COURS pas encore affectées à un employé ;
 *  - messagesClients : messages clients non lus ;
 *  - clients : clients avec demande de modification de fiche PENDING (même
 *    compteur que /api/clients/demandes/en-attente).
 * Un service inaccessible à l'employé renvoie 0 (le menu est masqué de toute
 * façon) ; une table / colonne de migration pas encore exécutée aussi.
 * Employés type 3/4/6 : mêmes périmètres d'agence que les pages.
 */

async function compteursSidebar(req, res, next) {
  try {
    const user = req.user;
    const agenceScope = await getAgenceScope(user);
    const scope = agenceScope !== null ? await parcelInAgence(agenceScope) : null;
    const scopeSql = scope ? ` AND ${scope.sql}` : '';
    const scopeParams = scope ? scope.params : [];
    // Périmètre agence via la ville de ramassage du client (tables clients).
    const villeSql = agenceScope !== null ? ` AND ${villeInAgenceSql('c.customers_pickup_city')}` : '';
    const villeParams = agenceScope !== null ? [agenceScope] : [];

    /** COUNT(*) AS n, 0 si service inaccessible ou table/colonne pas migrée. */
    async function compte(service, sql, params = []) {
      if (!hasAccess(user, service)) return 0;
      try {
        const [[row]] = await pool.query(sql, params);
        return Number(row?.n) || 0;
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR') return 0;
        throw err;
      }
    }

    const ramassage =
      Number(user.role) === 6
        ? compte(
            'RAMASSAGE',
            `SELECT COUNT(*) AS n FROM delevery_pickup_request r
              WHERE r.pickup_request_affected_to = ? AND r.pickup_request_statut = 'RECEIVED'`,
            [Number(user.id)]
          )
        : compte(
            'RAMASSAGE',
            `SELECT COUNT(*) AS n FROM delevery_pickup_request r
              LEFT JOIN delevery_customers c ON c.customers_id = r.pickup_request_customer
              WHERE r.pickup_request_statut = 'NEW'${villeSql}`,
            villeParams
          );

    const [
      stockColisEnAttente,
      ramassageN,
      remboursement,
      reclamations,
      modificationsColis,
      messagesClients,
      nouveauxClients,
      clients
    ] = await Promise.all([
      compte(
        'STOCK',
        `SELECT COUNT(*) AS n FROM delevery_parcel p
          WHERE p.parcel_from_stock = 1 AND p.parcel_status = 'WAITING_PICKUP'${scopeSql}`,
        scopeParams
      ),
      ramassage,
      compte(
        'REMBOURSEMENT',
        `SELECT COUNT(*) AS n FROM delevery_remboursement WHERE remb_statut = 'PENDING'`
      ),
      compte(
        'RECLAMATIONS',
        `SELECT COUNT(*) AS n FROM delevery_reclamation_suivre r
          JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
          WHERE r.reclamation_statut = 'EN_COURS' AND r.reclamation_user = 0${scopeSql}`,
        scopeParams
      ),
      compte(
        'MODIFICATIONS_COLIS',
        `SELECT COUNT(*) AS n FROM delevery_parcel_modif_demande WHERE pmd_statut = 'PENDING'`
      ),
      compte(
        'MESSAGES',
        `SELECT COUNT(*) AS n FROM delevery_chat_msg WHERE msg_from = 'client' AND msg_read = 0`
      ),
      compte(
        'NOUVEAUX_CLIENTS',
        `SELECT COUNT(*) AS n FROM delevery_new_customers WHERE new_customers_statut = 0`
      ),
      compte(
        'CLIENTS',
        `SELECT COUNT(DISTINCT d.cfd_customer) AS n FROM delevery_client_fiche_demande d
          JOIN delevery_customers c ON c.customers_id = d.cfd_customer
          WHERE d.cfd_statut = 'PENDING'${villeSql}`,
        villeParams
      )
    ]);

    res.json({
      stockColisEnAttente,
      ramassage: ramassageN,
      remboursement,
      reclamations,
      modificationsColis,
      messagesClients,
      nouveauxClients,
      clients
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { compteursSidebar };
