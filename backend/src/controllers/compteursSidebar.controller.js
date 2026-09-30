const pool = require('../config/db');
const { hasAccess } = require('../utils/access');
const { getAgenceScope, parcelInAgence, villeInAgenceSql } = require('../utils/agenceScope');
const { ATTENTION_ALERTE, REPORT_DATE_SQL, SANS_ADRESSE_WHERE } = require('./parcelsAdmin.controller');
const { CLIENT_SANS_ADRESSE_WHERE } = require('./parcels.controller');

/*
 * Compteurs des badges rouges de la sidebar admin (GET
 * /api/dashboard/admin/compteurs) — un seul appel pour tous les menus, mêmes
 * définitions d'« en attente » que les pages correspondantes :
 *  - stockColisEnAttente : colis de stock pas encore ramassés (stock.controller) ;
 *  - ramassage : demandes NEW (types 3/4 : agence ; ramasseur type 6 : ses
 *    demandes RECEIVED encore à traiter, une demande NEW n'étant jamais à lui) ;
 *  - remboursement / modificationsColis / nouveauxClients : demandes PENDING ;
 *  - reclamations : réclamations EN_COURS pas encore affectées à un employé ;
 *  - colisZero : colis montant zéro en attente d'encaissement (CRBT ni payé ni avisé) ;
 *  - colisAttention : page « Colis alerte 00H00 » (parcelsAdmin.controller) ;
 *  - sansAdresse : colis « Attente confirmation » de la page « Sans adresse »
 *    (scannés faute d'adresse, utils/sansAdresse ; service COLIS_SANS_ADRESSE) ;
 *  - messagesClients : messages clients non lus ; messagesAccueil : messages NEW
 *    du formulaire de contact ;
 *  - clients : clients avec demande de modification de fiche PENDING (même
 *    compteur que /api/clients/demandes/en-attente) ;
 *  - clientsNonVerifies : clients non vérifiés ayant saisi au moins un colis ;
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

    // Minuit du jour courant : convention des « Colis alerte 00H00 ».
    const minuit = new Date();
    minuit.setHours(0, 0, 0, 0);
    const midnight = Math.floor(minuit.getTime() / 1000);

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
      colisZero,
      colisAttention,
      sansAdresse,
      messagesClients,
      messagesAccueil,
      nouveauxClients,
      clients,
      clientsNonVerifies
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
        'COLIS_ZERO',
        `SELECT COUNT(*) AS n FROM delevery_parcel p
          LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
          WHERE p.parcel_price = '0'
            AND p.parcel_status NOT IN ('NEW_PARCEL', 'WAITING_PICKUP')
            AND COALESCE(c.customers_colis_zero, 0) <> 1
            AND COALESCE(p.parcel_crbt_zero, 0) NOT IN (1, 2)`
      ),
      compte(
        'COLIS_ATTENTION',
        `SELECT COUNT(*) AS n FROM delevery_parcel p
          WHERE (
                 (p.parcel_status = 'IN_PROGRESS' AND p.parcel_status_second IN (?)
                    AND p.parcel_last_update > 0 AND p.parcel_last_update < ?)
              OR (p.parcel_status = 'DISTRIBUTION'
                    AND p.parcel_last_update > 0 AND p.parcel_last_update < ?)
              OR (p.parcel_status = 'IN_PROGRESS' AND p.parcel_status_second IN (?)
                    AND COALESCE(${REPORT_DATE_SQL} < CURDATE(),
                                 (p.parcel_last_update > 0 AND p.parcel_last_update < ?)))
                )${scopeSql}`,
        [
          ATTENTION_ALERTE.relance,
          midnight,
          midnight,
          ATTENTION_ALERTE.programme,
          midnight,
          ...scopeParams
        ]
      ),
      compte(
        'COLIS_SANS_ADRESSE',
        `SELECT COUNT(*) AS n FROM delevery_parcel p WHERE ${SANS_ADRESSE_WHERE}${scopeSql}`,
        scopeParams
      ),
      compte(
        'MESSAGES',
        `SELECT COUNT(*) AS n FROM delevery_chat_msg WHERE msg_from = 'client' AND msg_read = 0`
      ),
      compte(
        'MESSAGES',
        `SELECT COUNT(*) AS n FROM delevery_home_msg WHERE home_msg_statut = 'NEW'`
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
      ),
      compte(
        'CLIENTS_NON_VERIFIES',
        `SELECT COUNT(*) AS n FROM delevery_customers c
          WHERE IFNULL(c.customers_verified, 0) = 0
            AND EXISTS (SELECT 1 FROM delevery_parcel dp WHERE dp.parcel_customer = c.customers_id)${villeSql}`,
        villeParams
      )
    ]);

    res.json({
      stockColisEnAttente,
      ramassage: ramassageN,
      remboursement,
      reclamations,
      modificationsColis,
      colisZero,
      colisAttention,
      sansAdresse,
      messagesClients,
      messagesAccueil,
      nouveauxClients,
      clients,
      clientsNonVerifies
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/dashboard/client/compteurs — badges rouges de la sidebar client
 * (ClientLayout, un seul appel rafraîchi à chaque navigation) :
 *  - sansAdresse : colis du client en « Attente confirmation » (page
 *    /client/sans-adresse), même définition que la page
 *    (CLIENT_SANS_ADRESSE_WHERE de parcels.controller) — le badge et le
 *    compteur de la page affichent donc toujours le même nombre.
 * Le propriétaire voit tout ; un membre d'équipe sans la tâche
 * COLIS_CONSULTATION reçoit 0 (son menu est masqué de toute façon ; ses tâches
 * sont relues en base par requireClientPermission() sur la route).
 */
async function compteursClient(req, res, next) {
  try {
    const user = req.user;
    const services = Array.isArray(user.services) ? user.services : [];
    const peut = (code) => !user.memberId || services.includes(code);

    let sansAdresse = 0;
    if (peut('COLIS_CONSULTATION')) {
      const [[row]] = await pool.query(
        `SELECT COUNT(*) AS n FROM delevery_parcel p WHERE ${CLIENT_SANS_ADRESSE_WHERE}`,
        [Number(user.id)]
      );
      sansAdresse = Number(row?.n) || 0;
    }

    res.json({ sansAdresse });
  } catch (err) {
    next(err);
  }
}

module.exports = { compteursSidebar, compteursClient };
