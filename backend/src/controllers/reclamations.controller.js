const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const { getAgenceScope, parcelInAgence } = require('../utils/agenceScope');

/*
 * Réclamations à suivre — page admin /admin/reclamations, reprise de la page
 * legacy « reclamations-suivre » sur la table partagée
 * delevery_reclamation_suivre. Une réclamation est déclenchée depuis la page
 * Colis du dashboard admin (reclamation_user = employé connecté) et désormais
 * aussi depuis la page Colis du dashboard client (reclamation_user = 0,
 * reclamation_member = membre d'équipe auteur, 0 = propriétaire).
 *  - reclamation_statut : EN_COURS → TRAITE (note de traitement facultative) ;
 *  - compteurs et filtres identiques au legacy : livreur du colis, suivi par
 *    (employé, avec en plus « Réclamations clients »), plage de dates. Filtrer
 *    par employé montre aussi les réclamations clients pas encore lancées,
 *    visibles de tous ;
 *  - « Lancer » : affecte à l'employé connecté une réclamation client
 *    (reclamation_user 0 → employé) ; reclamation_client = 1 garde l'origine
 *    client (migration sql/2026-08-29_reclamations-lancer.sql, sinon l'action
 *    est indisponible) ;
 *  - employés type 3/4/6 : uniquement les réclamations des colis de leur
 *    agence (utils/agenceScope), comme la page Colis.
 */

const MAX_RECLAMATIONS = 1000;

const STATUTS = ['EN_COURS', 'TRAITE'];

/* Réclamation d'origine client : marquée reclamation_client = 1 (conservé
 * après « Lancer ») ; reclamation_user = 0 couvre les lignes d'avant la
 * migration 2026-08-29_reclamations-lancer.sql. */
const CLIENT_EXPR = '(r.reclamation_client = 1 OR r.reclamation_user = 0)';
// Colonne reclamation_client absente (migration pas encore exécutée) : une
// réclamation client est alors simplement une réclamation non affectée.
const CLIENT_EXPR_LEGACY = '(r.reclamation_user = 0)';

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/**
 * GET /api/reclamations/filtres — livreurs actifs (type 5) pour le filtre
 * « Livreur » et employés actifs type 1 / 2 pour le filtre « Suivi par »
 * (mêmes listes que le legacy).
 */
async function listFiltres(req, res, next) {
  try {
    const [[livreurs], [users]] = await Promise.all([
      pool.query(
        `SELECT users_id AS id, users_name AS label
           FROM delevery_users
          WHERE users_active = 1 AND users_type = 5
          ORDER BY users_name`
      ),
      pool.query(
        `SELECT users_id AS id, users_name AS label
           FROM delevery_users
          WHERE users_active = 1 AND users_type IN (1, 2)
          ORDER BY users_name`
      )
    ]);
    res.json({ livreurs, users });
  } catch (err) {
    next(err);
  }
}

/**
 * Noms des membres d'équipe client auteurs de réclamations, indexés par
 * member_id. Table delevery_customer_members absente (migration équipe client
 * pas encore exécutée en production) : map vide, l'attribution reste anonyme.
 */
async function memberNames(memberIds) {
  const ids = [...new Set(memberIds.filter((id) => id > 0))];
  if (!ids.length) return {};
  try {
    const [rows] = await pool.query(
      `SELECT member_id AS id, member_name AS name
         FROM delevery_customer_members WHERE member_id IN (?)`,
      [ids]
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return {};
    throw err;
  }
}

/**
 * GET /api/reclamations — compteurs + liste pour la datatable.
 * Query : statut (EN_COURS | TRAITE, '' = tous), livreur (users_id du livreur
 * du colis), user ('' = tous | 'client' = créées par les clients | users_id de
 * l'employé : ses réclamations + les réclamations clients pas encore lancées),
 * dateFrom / dateTo (AAAA-MM-JJ, date de la réclamation). Les compteurs
 * (total / en cours / traitées) appliquent tous les filtres sauf le statut,
 * comme le legacy. 1000 réclamations max, plus récentes d'abord.
 */
async function listReclamations(req, res, next) {
  try {
    const statut = String(req.query.statut || '').trim();
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const user = String(req.query.user || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);
    const agenceScope = await getAgenceScope(req.user);
    const scope = agenceScope !== null ? await parcelInAgence(agenceScope) : null;

    // Compteurs + liste pour une définition donnée de « réclamation client »
    // (clientExpr) : permet de retenter sans la colonne reclamation_client.
    async function run(clientExpr) {
      // Filtres communs aux compteurs et à la liste (le statut ne filtre que la liste).
      const where = ['1 = 1'];
      const params = [];
      if (livreur) {
        where.push('p.parcel_livreur = ?');
        params.push(livreur);
      }
      if (user === 'client') {
        where.push(clientExpr);
      } else if (parseInt(user, 10) > 0) {
        // Réclamations suivies par l'employé + réclamations clients pas encore
        // lancées (reclamation_user = 0), visibles de tous les utilisateurs.
        where.push('(r.reclamation_user = ? OR r.reclamation_user = 0)');
        params.push(parseInt(user, 10));
      }
      if (dateFrom !== null) {
        where.push('r.reclamation_time >= ?');
        params.push(dateFrom);
      }
      if (dateTo !== null) {
        where.push('r.reclamation_time <= ?');
        params.push(dateTo);
      }
      if (scope) {
        where.push(scope.sql);
        params.push(...scope.params);
      }

      const [[counts]] = await pool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(r.reclamation_statut = 'EN_COURS'), 0) AS enCours,
                COALESCE(SUM(r.reclamation_statut = 'TRAITE'), 0) AS traites
           FROM delevery_reclamation_suivre r
           JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
          WHERE ${where.join(' AND ')}`,
        params
      );

      const whereRows = [...where];
      const paramsRows = [...params];
      if (STATUTS.includes(statut)) {
        whereRows.push('r.reclamation_statut = ?');
        paramsRows.push(statut);
      }

      const [rows] = await pool.query(
        `SELECT r.reclamation_id           AS id,
                r.reclamation_parcel       AS parcel_id,
                p.parcel_code              AS code,
                c.customers_store          AS magasin,
                z.zone_name                AS zone,
                ul.users_name              AS livreur,
                r.reclamation_titre        AS titre,
                r.reclamation_text         AS texte,
                r.reclamation_time         AS time,
                r.reclamation_statut       AS statut,
                ${clientExpr}              AS client,
                (r.reclamation_user > 0)   AS affectee,
                us.users_name              AS suivi_par,
                r.reclamation_member       AS member_id,
                ut.users_name              AS traite_par,
                r.reclamation_treated_time AS traite_time,
                r.reclamation_treated_note AS traite_note
           FROM delevery_reclamation_suivre r
           JOIN delevery_parcel p          ON p.parcel_id = r.reclamation_parcel
           LEFT JOIN delevery_customers c  ON c.customers_id = p.parcel_customer
           LEFT JOIN delevery_tarifs t     ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_zone z       ON z.zone_id = t.zone
           LEFT JOIN delevery_users ul     ON ul.users_id = p.parcel_livreur
           LEFT JOIN delevery_users us     ON us.users_id = r.reclamation_user
           LEFT JOIN delevery_users ut     ON ut.users_id = r.reclamation_treated_by
          WHERE ${whereRows.join(' AND ')}
          ORDER BY r.reclamation_time DESC, r.reclamation_id DESC
          LIMIT ${MAX_RECLAMATIONS}`,
        paramsRows
      );
      return { counts, rows };
    }

    let counts;
    let rows;
    try {
      ({ counts, rows } = await run(CLIENT_EXPR));
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      ({ counts, rows } = await run(CLIENT_EXPR_LEGACY));
    }

    const membres = await memberNames(rows.map((r) => Number(r.member_id)));
    res.json({
      counts: {
        total: Number(counts.total) || 0,
        enCours: Number(counts.enCours) || 0,
        traites: Number(counts.traites) || 0
      },
      rows: rows.map((r) => ({
        id: r.id,
        parcel_id: r.parcel_id,
        code: r.code || '',
        magasin: r.magasin || '',
        zone: r.zone || '',
        livreur: r.livreur || '',
        titre: r.titre || '',
        texte: r.texte || '',
        time: Number(r.time) || 0,
        statut: r.statut,
        client: Number(r.client) === 1,
        affectee: Number(r.affectee) === 1,
        suivi_par: r.suivi_par || '',
        membre: membres[Number(r.member_id)] || '',
        traite_par: r.traite_par || '',
        traite_time: Number(r.traite_time) || 0,
        traite_note: r.traite_note || ''
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/reclamations/:id/lancer — affecte à l'employé connecté une
 * réclamation créée par un client et pas encore lancée (reclamation_user = 0) :
 * reclamation_user = employé, reclamation_client = 1 (l'origine client reste
 * affichée). Refusé si déjà lancée ou déjà traitée. Employés type 3/4/6 :
 * réclamations des colis de leur agence.
 */
async function lancerReclamation(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Réclamation introuvable.' });
    }

    const where = ['r.reclamation_id = ?'];
    const params = [id];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const [[rec]] = await pool.query(
      `SELECT r.reclamation_id AS id, r.reclamation_statut AS statut,
              r.reclamation_user AS user_id
         FROM delevery_reclamation_suivre r
         JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
        WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (!rec) return res.status(404).json({ message: 'Réclamation introuvable.' });
    if (rec.statut === 'TRAITE') {
      return res.status(400).json({ message: 'Réclamation déjà traitée.' });
    }
    if (Number(rec.user_id) !== 0) {
      return res.status(400).json({ message: 'Réclamation déjà lancée.' });
    }

    let result;
    try {
      [result] = await pool.query(
        `UPDATE delevery_reclamation_suivre
            SET reclamation_user = ?, reclamation_client = 1
          WHERE reclamation_id = ? AND reclamation_user = 0`,
        [Number(req.user.id), rec.id]
      );
    } catch (err) {
      // reclamation_client absent : affecter sans ce marqueur ferait perdre
      // l'origine client de la réclamation — action refusée.
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      return res.status(503).json({
        message:
          'Le lancement des réclamations n’est pas encore disponible (migration sql/2026-08-29_reclamations-lancer.sql à exécuter).'
      });
    }
    if (!result.affectedRows) {
      return res.status(409).json({ message: 'Réclamation déjà lancée par un autre utilisateur.' });
    }
    res.json({ id: rec.id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/reclamations/:id/traiter — body { note } (facultative). Marque la
 * réclamation TRAITE avec l'employé et l'heure de traitement ; refusé si déjà
 * traitée. Employés type 3/4/6 : réclamations des colis de leur agence.
 */
async function traiterReclamation(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Réclamation introuvable.' });
    }

    const where = ['r.reclamation_id = ?'];
    const params = [id];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const [[rec]] = await pool.query(
      `SELECT r.reclamation_id AS id, r.reclamation_statut AS statut
         FROM delevery_reclamation_suivre r
         JOIN delevery_parcel p ON p.parcel_id = r.reclamation_parcel
        WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (!rec) return res.status(404).json({ message: 'Réclamation introuvable.' });
    if (rec.statut === 'TRAITE') {
      return res.status(400).json({ message: 'Réclamation déjà traitée.' });
    }

    const note = String(req.body?.note || '').trim().slice(0, 2000);
    await pool.query(
      `UPDATE delevery_reclamation_suivre
          SET reclamation_statut = 'TRAITE', reclamation_treated_by = ?,
              reclamation_treated_time = ?, reclamation_treated_note = ?
        WHERE reclamation_id = ?`,
      [Number(req.user.id), Math.floor(Date.now() / 1000), note, rec.id]
    );
    emettreEvenement('RECLAMATION_TRAITEE', { reclamationId: rec.id, note, userId: Number(req.user.id) || 0 });
    res.json({ id: rec.id });
  } catch (err) {
    next(err);
  }
}

module.exports = { listFiltres, listReclamations, lancerReclamation, traiterReclamation };
