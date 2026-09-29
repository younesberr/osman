const pool = require('../config/db');
const { userAgenceSql } = require('../utils/agenceScope');

/*
 * Notifications par bannières (pages admin /admin/notifications/employes et
 * /admin/notifications/clients — service NOTIFICATIONS_EMPLOYES, fonctions 1
 * et 2 uniquement) sur les tables delevery_notif_banner / delevery_notif_cible
 * / delevery_notif_fermeture (la table legacy delevery_notification appartient
 * à l'ancien back-office — ne pas y toucher).
 *
 * Une notification cible une audience ('client' ou 'employe'), une liste de
 * pages (nb_pages, chemins CSV — le filtrage par page se fait côté frontend
 * sur le pathname) et des destinataires (nb_cible_mode + delevery_notif_cible,
 * résolus en SQL). « Fonction » = users_type (1-6) : cibler par fonction et
 * par type d'utilisateur sont le même mode. L'agence d'un employé est dérivée
 * de sa ville de fonction (userAgenceSql), types 1/2 sans agence → 0.
 *
 * La fermeture (croix) est mémorisée par utilisateur dans
 * delevery_notif_fermeture ; pour un membre d'équipe client, nf_member =
 * member_id (le JWT d'un membre porte l'id du client parent), 0 sinon.
 */

const IMPORTANCES = ['info', 'succes', 'avertissement', 'urgent'];
const MODES_CLIENT = ['TOUS', 'CLIENTS'];
const MODES_EMPLOYE = ['FONCTIONS', 'AGENCES', 'USERS'];
const MODE_DIMENSION = { CLIENTS: 'CLIENT', FONCTIONS: 'FONCTION', AGENCES: 'AGENCE', USERS: 'USER' };

/** "AAAA-MM-JJTHH:mm" (input datetime-local) → "AAAA-MM-JJ HH:mm:00" ; null si vide, false si invalide. */
function parseDateTime(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!m) return false;
  return `${m[1]} ${m[2]}:00`;
}

/** Valide le body de création/édition ; { error } ou valeurs normalisées. */
function parseBody(body) {
  const audience = body?.audience === 'client' || body?.audience === 'employe' ? body.audience : null;
  if (!audience) return { error: 'Audience invalide.' };
  const titre = String(body?.titre || '').trim();
  if (titre.length > 255) return { error: 'Titre trop long (255 caractères max).' };
  const message = String(body?.message || '').trim();
  if (!message) return { error: 'Veuillez saisir le message de la notification.' };
  if (message.length > 2000) return { error: 'Message trop long (2000 caractères max).' };
  const importance = IMPORTANCES.includes(body?.importance) ? body.importance : null;
  if (!importance) return { error: 'Importance invalide.' };
  const groupable = body?.groupable ? 1 : 0;
  const active = body?.active ? 1 : 0;

  // Pages ciblées : chemins du catalogue frontend — le backend vérifie le
  // préfixe du dashboard correspondant à l'audience.
  const prefixes = audience === 'client' ? ['/client'] : ['/admin', '/livreur'];
  const pages = Array.isArray(body?.pages)
    ? [...new Set(body.pages.map((p) => String(p || '').trim()).filter(Boolean))]
    : [];
  if (!pages.length) return { error: 'Veuillez choisir au moins une page.' };
  const pageOk = (p) =>
    /^\/[a-z0-9/-]*$/.test(p) && prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
  if (!pages.every(pageOk)) return { error: 'Pages invalides pour cette audience.' };

  const modes = audience === 'client' ? MODES_CLIENT : MODES_EMPLOYE;
  const mode = modes.includes(body?.cible_mode) ? body.cible_mode : null;
  if (!mode) return { error: 'Mode de ciblage invalide.' };
  let cibles = [];
  if (mode !== 'TOUS') {
    cibles = Array.isArray(body?.cibles) ? [...new Set(body.cibles.map(Number))] : [];
    if (!cibles.length || !cibles.every((c) => Number.isInteger(c) && c > 0)) {
      return { error: 'Veuillez choisir au moins une cible.' };
    }
    if (mode === 'FONCTIONS' && !cibles.every((c) => c >= 1 && c <= 6)) {
      return { error: 'Fonctions invalides.' };
    }
  }

  const dateDebut = parseDateTime(body?.date_debut);
  if (dateDebut === false) return { error: 'Date de début invalide.' };
  const dateFin = parseDateTime(body?.date_fin);
  if (dateFin === false) return { error: 'Date de fin invalide.' };
  if (dateDebut && dateFin && dateDebut > dateFin) {
    return { error: 'La date de début doit précéder la date de fin.' };
  }

  return {
    audience,
    titre: titre || null,
    message,
    importance,
    groupable,
    active,
    pages: pages.join(','),
    mode,
    cibles,
    dateDebut,
    dateFin
  };
}

/**
 * Conditions de visibilité d'une notification (alias n) pour l'utilisateur
 * connecté : audience, active, fenêtre de dates, ciblage. La clause d'agence
 * est correcte même multi-dimensions : une notification n'a qu'un seul mode,
 * donc seules les lignes de sa dimension existent dans delevery_notif_cible.
 */
function visibiliteSql(user, agenceId) {
  const base = `n.nb_active = 1
    AND (n.nb_date_debut IS NULL OR n.nb_date_debut <= NOW())
    AND (n.nb_date_fin IS NULL OR n.nb_date_fin >= NOW())`;
  if (user.kind === 'customer') {
    return {
      sql: `n.nb_audience = 'client' AND ${base}
        AND (n.nb_cible_mode = 'TOUS'
             OR EXISTS (SELECT 1 FROM delevery_notif_cible c
                         WHERE c.nc_notif = n.nb_id
                           AND c.nc_dimension = 'CLIENT' AND c.nc_cible_id = ?))`,
      params: [user.id]
    };
  }
  return {
    sql: `n.nb_audience = 'employe' AND ${base}
      AND EXISTS (SELECT 1 FROM delevery_notif_cible c
                   WHERE c.nc_notif = n.nb_id
                     AND ((c.nc_dimension = 'FONCTION' AND c.nc_cible_id = ?)
                       OR (c.nc_dimension = 'USER'     AND c.nc_cible_id = ?)
                       OR (c.nc_dimension = 'AGENCE'   AND c.nc_cible_id = ?)))`,
    params: [Number(user.role) || 0, user.id, agenceId]
  };
}

/** (nf_kind, nf_user, nf_member) de l'utilisateur connecté pour la table des fermetures. */
function fermetureKey(user) {
  return user.kind === 'customer'
    ? ['customer', user.id, Number(user.memberId) || 0]
    : ['employee', user.id, 0];
}

/** Agence dérivée de l'employé (0 si aucune — types 1/2 notamment). */
async function agenceDeEmploye(userId) {
  const [[row]] = await pool.query(
    `SELECT ${userAgenceSql('u')} AS agence_id
       FROM delevery_users u
      WHERE u.users_id = ? LIMIT 1`,
    [userId]
  );
  return Number(row?.agence_id) || 0;
}

/** GET /api/notifications?audience=client|employe — liste admin avec cibles et fermetures. */
async function listNotifications(req, res, next) {
  try {
    const audience = req.query.audience === 'client' || req.query.audience === 'employe'
      ? req.query.audience
      : null;
    if (!audience) return res.status(400).json({ message: 'Audience invalide.' });

    const [rows] = await pool.query(
      `SELECT n.nb_id AS id, n.nb_titre AS titre, n.nb_message AS message,
              n.nb_importance AS importance, n.nb_groupable AS groupable,
              n.nb_active AS active, n.nb_pages AS pages,
              n.nb_cible_mode AS cible_mode,
              DATE_FORMAT(n.nb_date_debut, '%Y-%m-%dT%H:%i') AS date_debut,
              DATE_FORMAT(n.nb_date_fin, '%Y-%m-%dT%H:%i')   AS date_fin,
              DATE_FORMAT(n.nb_created_at, '%d/%m/%Y %H:%i') AS created_at,
              (SELECT COUNT(*) FROM delevery_notif_fermeture f
                WHERE f.nf_notif = n.nb_id) AS fermetures
         FROM delevery_notif_banner n
        WHERE n.nb_audience = ?
        ORDER BY n.nb_created_at DESC, n.nb_id DESC`,
      [audience]
    );

    const ciblesParNotif = new Map();
    if (rows.length) {
      const [cibles] = await pool.query(
        `SELECT nc_notif, nc_dimension, nc_cible_id,
                CASE nc_dimension
                  WHEN 'CLIENT' THEN (SELECT COALESCE(NULLIF(TRIM(c.customers_store), ''), c.customers_name)
                                        FROM delevery_customers c WHERE c.customers_id = nc_cible_id)
                  WHEN 'USER'   THEN (SELECT u.users_name  FROM delevery_users u   WHERE u.users_id  = nc_cible_id)
                  WHEN 'AGENCE' THEN (SELECT a.agence_name FROM delevery_agences a WHERE a.agence_id = nc_cible_id)
                  ELSE NULL
                END AS label
           FROM delevery_notif_cible
          WHERE nc_notif IN (?)`,
        [rows.map((r) => r.id)]
      );
      for (const c of cibles) {
        if (!ciblesParNotif.has(c.nc_notif)) ciblesParNotif.set(c.nc_notif, []);
        ciblesParNotif.get(c.nc_notif).push({ id: c.nc_cible_id, label: c.label });
      }
    }

    res.json({
      notifications: rows.map((r) => ({
        ...r,
        pages: r.pages ? r.pages.split(',') : [],
        cibles: ciblesParNotif.get(r.id) || []
      }))
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/notifications/cibles — données des sélecteurs (clients, employés, agences actifs). */
async function getCibles(req, res, next) {
  try {
    const [[clients], [users], [agences]] = await Promise.all([
      pool.query(
        `SELECT customers_id AS value,
                COALESCE(NULLIF(TRIM(customers_store), ''), customers_name) AS label
           FROM delevery_customers
          WHERE customers_active = 1
          ORDER BY label`
      ),
      pool.query(
        `SELECT users_id AS value, users_name AS label, users_type AS type
           FROM delevery_users
          WHERE users_active = 1
          ORDER BY users_name`
      ),
      pool.query(
        `SELECT agence_id AS value, agence_name AS label
           FROM delevery_agences
          WHERE agence_active = 1
          ORDER BY agence_name`
      )
    ]);
    res.json({ clients, users, agences });
  } catch (err) {
    next(err);
  }
}

/** Remplace les cibles d'une notification (dans la transaction fournie). */
async function remplacerCibles(conn, notifId, mode, cibles) {
  await conn.query(`DELETE FROM delevery_notif_cible WHERE nc_notif = ?`, [notifId]);
  if (mode === 'TOUS' || !cibles.length) return;
  const dimension = MODE_DIMENSION[mode];
  await conn.query(
    `INSERT INTO delevery_notif_cible (nc_notif, nc_dimension, nc_cible_id) VALUES ?`,
    [cibles.map((c) => [notifId, dimension, c])]
  );
}

/** POST /api/notifications — création. */
async function createNotification(req, res, next) {
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ message: parsed.error });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO delevery_notif_banner
         (nb_audience, nb_titre, nb_message, nb_importance, nb_groupable,
          nb_active, nb_pages, nb_cible_mode, nb_date_debut, nb_date_fin,
          nb_created_by, nb_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        parsed.audience,
        parsed.titre,
        parsed.message,
        parsed.importance,
        parsed.groupable,
        parsed.active,
        parsed.pages,
        parsed.mode,
        parsed.dateDebut,
        parsed.dateFin,
        req.user.id
      ]
    );
    await remplacerCibles(conn, result.insertId, parsed.mode, parsed.cibles);
    await conn.commit();
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/** PUT /api/notifications/:id — édition complète (cibles remplacées). */
async function updateNotification(req, res, next) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Identifiant invalide.' });
  }
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ message: parsed.error });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `UPDATE delevery_notif_banner
          SET nb_titre = ?, nb_message = ?, nb_importance = ?, nb_groupable = ?,
              nb_active = ?, nb_pages = ?, nb_cible_mode = ?, nb_date_debut = ?,
              nb_date_fin = ?
        WHERE nb_id = ? AND nb_audience = ?`,
      [
        parsed.titre,
        parsed.message,
        parsed.importance,
        parsed.groupable,
        parsed.active,
        parsed.pages,
        parsed.mode,
        parsed.dateDebut,
        parsed.dateFin,
        id,
        parsed.audience
      ]
    );
    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ message: 'Notification introuvable.' });
    }
    await remplacerCibles(conn, id, parsed.mode, parsed.cibles);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/** PATCH /api/notifications/:id/active — activer/désactiver. */
async function setNotificationActive(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const active = req.body?.active ? 1 : 0;
    const [result] = await pool.query(
      `UPDATE delevery_notif_banner SET nb_active = ? WHERE nb_id = ?`,
      [active, id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Notification introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/notifications/:id — suppression (cibles et fermetures comprises). */
async function deleteNotification(req, res, next) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: 'Identifiant invalide.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM delevery_notif_fermeture WHERE nf_notif = ?`, [id]);
    await conn.query(`DELETE FROM delevery_notif_cible WHERE nc_notif = ?`, [id]);
    const [result] = await conn.query(`DELETE FROM delevery_notif_banner WHERE nb_id = ?`, [id]);
    await conn.commit();
    if (!result.affectedRows) return res.status(404).json({ message: 'Notification introuvable.' });
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * GET /api/notifications/me — bannières visibles par l'utilisateur connecté
 * (client, employé ou livreur) : actives, dans la fenêtre de dates, le
 * ciblant, non fermées par lui. Le filtrage par page se fait côté frontend.
 */
async function listMesNotifications(req, res, next) {
  try {
    const agenceId = req.user.kind === 'employee' ? await agenceDeEmploye(req.user.id) : 0;
    const vis = visibiliteSql(req.user, agenceId);
    const [rows] = await pool.query(
      `SELECT n.nb_id AS id, n.nb_titre AS titre, n.nb_message AS message,
              n.nb_importance AS importance, n.nb_groupable AS groupable,
              n.nb_pages AS pages
         FROM delevery_notif_banner n
        WHERE ${vis.sql}
          AND NOT EXISTS (SELECT 1 FROM delevery_notif_fermeture f
                           WHERE f.nf_notif = n.nb_id AND f.nf_kind = ?
                             AND f.nf_user = ? AND f.nf_member = ?)
        ORDER BY FIELD(n.nb_importance, 'urgent', 'avertissement', 'succes', 'info'),
                 n.nb_created_at DESC, n.nb_id DESC`,
      [...vis.params, ...fermetureKey(req.user)]
    );
    res.json({
      notifications: rows.map((r) => ({ ...r, pages: r.pages ? r.pages.split(',') : [] }))
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/notifications/:id/fermer — fermeture mémorisée (idempotente). */
async function fermerNotification(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    // La notification doit être réellement visible par cet utilisateur (évite
    // les fermetures parasites et l'énumération des ids).
    const agenceId = req.user.kind === 'employee' ? await agenceDeEmploye(req.user.id) : 0;
    const vis = visibiliteSql(req.user, agenceId);
    const [[notif]] = await pool.query(
      `SELECT n.nb_id FROM delevery_notif_banner n WHERE n.nb_id = ? AND ${vis.sql} LIMIT 1`,
      [id, ...vis.params]
    );
    if (!notif) return res.status(404).json({ message: 'Notification introuvable.' });
    await pool.query(
      `INSERT IGNORE INTO delevery_notif_fermeture (nf_notif, nf_kind, nf_user, nf_member, nf_time)
       VALUES (?, ?, ?, ?, NOW())`,
      [id, ...fermetureKey(req.user)]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listNotifications,
  getCibles,
  createNotification,
  updateNotification,
  setNotificationActive,
  deleteNotification,
  listMesNotifications,
  fermerNotification
};
