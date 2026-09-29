const pool = require('../config/db');

/*
 * Messages > Form d'accueil — page admin /admin/messages/form-accueil, reprise
 * de la page legacy « contact » sur la table partagée delevery_home_msg
 * (messages envoyés depuis le formulaire de contact de la page d'accueil,
 * POST /api/public/contact).
 *  - home_msg_statut : NEW (nouveau) → LU (première ouverture) → TRAITE
 *    (employé + heure + note facultative) ; « Rouvrir » repasse TRAITE → LU ;
 *  - compteurs et filtres identiques au legacy : recherche (nom / ville /
 *    email / téléphone / message) et plage de dates, appliqués aussi aux
 *    compteurs (le statut ne filtre que la liste).
 */

const MAX_MESSAGES = 1000;

const STATUTS = ['NEW', 'LU', 'TRAITE'];

/** "AAAA-MM-JJ" valide, sinon ''. */
function cleanDay(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

/** Ligne SQL -> objet API (dates en timestamp unix, comme les autres pages). */
function toRow(r) {
  return {
    id: r.id,
    name: r.name || '',
    city: r.city || '',
    email: r.email || '',
    phone: r.phone || '',
    text: r.text || '',
    time: Number(r.time) || 0,
    statut: STATUTS.includes(r.statut) ? r.statut : 'NEW',
    traite_par: r.traite_par || '',
    traite_time: Number(r.traite_time) || 0,
    note: r.note || ''
  };
}

const SELECT_SQL = `
  SELECT m.home_msg_id    AS id,
         m.home_msg_name  AS name,
         m.home_msg_city  AS city,
         m.home_msg_email AS email,
         m.home_msg_phone AS phone,
         m.home_msg_text  AS text,
         UNIX_TIMESTAMP(m.created_at) AS time,
         m.home_msg_statut AS statut,
         ut.users_name    AS traite_par,
         m.home_msg_time  AS traite_time,
         m.home_msg_note  AS note
    FROM delevery_home_msg m
    LEFT JOIN delevery_users ut ON ut.users_id = m.home_msg_user`;

/**
 * GET /api/messages/form-accueil — compteurs + liste pour la datatable.
 * Query : statut (NEW | LU | TRAITE, '' = tous), search (nom / ville / email /
 * téléphone / message), dateFrom / dateTo (AAAA-MM-JJ, date d'envoi). Les
 * compteurs (total / nouveaux / lus / traités) appliquent tous les filtres
 * sauf le statut, comme le legacy. 1000 messages max, plus récents d'abord.
 */
async function listFormAccueil(req, res, next) {
  try {
    const statut = String(req.query.statut || '').trim();
    const search = String(req.query.search || '').trim();
    const dateFrom = cleanDay(req.query.dateFrom);
    const dateTo = cleanDay(req.query.dateTo);

    // Filtres communs aux compteurs et à la liste (le statut ne filtre que la liste).
    const where = ['1 = 1'];
    const params = [];
    if (search) {
      where.push(`(m.home_msg_name LIKE ? OR m.home_msg_city LIKE ? OR m.home_msg_email LIKE ?
                   OR m.home_msg_phone LIKE ? OR m.home_msg_text LIKE ?)`);
      params.push(...Array(5).fill(`%${search}%`));
    }
    if (dateFrom) {
      where.push('m.created_at >= ?');
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      where.push('m.created_at <= ?');
      params.push(`${dateTo} 23:59:59`);
    }

    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(m.home_msg_statut = 'NEW'), 0) AS nouveaux,
              COALESCE(SUM(m.home_msg_statut = 'LU'), 0) AS lus,
              COALESCE(SUM(m.home_msg_statut = 'TRAITE'), 0) AS traites
         FROM delevery_home_msg m
        WHERE ${where.join(' AND ')}`,
      params
    );

    const whereRows = [...where];
    const paramsRows = [...params];
    if (STATUTS.includes(statut)) {
      whereRows.push('m.home_msg_statut = ?');
      paramsRows.push(statut);
    }

    const [rows] = await pool.query(
      `${SELECT_SQL}
        WHERE ${whereRows.join(' AND ')}
        ORDER BY m.created_at DESC, m.home_msg_id DESC
        LIMIT ${MAX_MESSAGES}`,
      paramsRows
    );

    res.json({
      counts: {
        total: Number(counts.total) || 0,
        nouveaux: Number(counts.nouveaux) || 0,
        lus: Number(counts.lus) || 0,
        traites: Number(counts.traites) || 0
      },
      rows: rows.map(toRow)
    });
  } catch (err) {
    next(err);
  }
}

/** Charge un message par id, ou null. */
async function findMessage(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [rows] = await pool.query(`${SELECT_SQL} WHERE m.home_msg_id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

/**
 * GET /api/messages/form-accueil/:id — détail d'un message (modale « Ouvrir »).
 * Première ouverture : le message passe de « Nouveau » à « Lu », comme le legacy.
 */
async function getFormAccueil(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const msg = await findMessage(id);
    if (!msg) return res.status(404).json({ message: 'Message introuvable.' });

    if (msg.statut === 'NEW') {
      await pool.query(
        "UPDATE delevery_home_msg SET home_msg_statut = 'LU' WHERE home_msg_id = ?",
        [id]
      );
      msg.statut = 'LU';
    }
    res.json(toRow(msg));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/messages/form-accueil/:id/traiter — body { note } (facultative).
 * Marque le message TRAITE avec l'employé et l'heure de traitement ; refusé si
 * déjà traité.
 */
async function traiterFormAccueil(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const msg = await findMessage(id);
    if (!msg) return res.status(404).json({ message: 'Message introuvable.' });
    if (msg.statut === 'TRAITE') {
      return res.status(400).json({ message: 'Message déjà traité.' });
    }

    const note = String(req.body?.note || '').trim().slice(0, 2000);
    await pool.query(
      `UPDATE delevery_home_msg
          SET home_msg_statut = 'TRAITE', home_msg_user = ?, home_msg_time = ?, home_msg_note = ?
        WHERE home_msg_id = ?`,
      [Number(req.user.id), Math.floor(Date.now() / 1000), note, id]
    );
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/messages/form-accueil/:id/rouvrir — remet un message traité en
 * attente (TRAITE → LU, employé et heure remis à zéro, note conservée).
 */
async function rouvrirFormAccueil(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const msg = await findMessage(id);
    if (!msg) return res.status(404).json({ message: 'Message introuvable.' });
    if (msg.statut !== 'TRAITE') {
      return res.status(400).json({ message: 'Ce message n’est pas traité.' });
    }

    await pool.query(
      `UPDATE delevery_home_msg
          SET home_msg_statut = 'LU', home_msg_user = 0, home_msg_time = 0
        WHERE home_msg_id = ?`,
      [id]
    );
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/messages/form-accueil/:id — supprime définitivement un message. */
async function deleteFormAccueil(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const msg = await findMessage(id);
    if (!msg) return res.status(404).json({ message: 'Message introuvable.' });

    await pool.query('DELETE FROM delevery_home_msg WHERE home_msg_id = ?', [id]);
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listFormAccueil,
  getFormAccueil,
  traiterFormAccueil,
  rouvrirFormAccueil,
  deleteFormAccueil
};
