const pool = require('../config/db');
const { getAgenceScope } = require('../utils/agenceScope');

/*
 * Frais supplémentaires livreurs (page
 * /admin/facturation-livreurs/frais-supplementaires) — table de l'application
 * delevery_livreur_frais (sql/2026-08-20_frais-livreurs.sql) : frais saisis
 * manuellement pour un livreur (users_type = 5, y compris les livreurs
 * salariés), destinés à être repris plus tard dans la facturation.
 *
 * Statuts (frais_statut) : 0 = Nouveau (modifiable / supprimable),
 * 1 = Enregistré, 2 = Payé. Un frais enregistré ou payé, ou rattaché à une
 * facture livreur (frais_facture_id, rattachement à la création de la
 * facture), n'est plus ni modifiable ni supprimable ; son statut suit alors
 * celui de la facture (facturesLivreurs.controller).
 *
 * Employés type 3/4/6 : uniquement les frais des livreurs des zones de leur
 * agence (même périmètre que la facturation livreurs).
 */

const MAX_FRAIS = 1000;

/* Codes API ↔ codes frais_statut. */
const STATUTS = { new: 0, saved: 1, paid: 2 };

/** Zone d'un livreur (alias u = delevery_users) : users_city si c'est une zone
 * (legacy), sinon via sa ville — mêmes règles que la facturation livreurs. */
const ZONE_ID_SQL = `COALESCE(
  (SELECT z.zone_id FROM delevery_zone z WHERE z.zone_id = u.users_city LIMIT 1),
  (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_ville_id LIMIT 1),
  (SELECT t.zone FROM delevery_tarifs t WHERE t.ville_id = u.users_city LIMIT 1))`;

const ZONE_NAME_SQL = `COALESCE(
  (SELECT z.zone_name FROM delevery_zone z WHERE z.zone_id = u.users_city LIMIT 1),
  (SELECT z.zone_name FROM delevery_tarifs t JOIN delevery_zone z ON z.zone_id = t.zone
    WHERE t.ville_id = u.users_ville_id LIMIT 1),
  (SELECT z.zone_name FROM delevery_tarifs t JOIN delevery_zone z ON z.zone_id = t.zone
    WHERE t.ville_id = u.users_city LIMIT 1))`;

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Montant > 0 (2 décimales max), sinon null. */
function parseMontant(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 99999999) return null;
  return Math.round(n * 100) / 100;
}

/** Zones autorisées : null = aucune restriction, sinon liste de zone_id. */
async function getZonesAgence(user) {
  const agenceScope = await getAgenceScope(user);
  if (agenceScope === null) return null;
  const [rows] = await pool.query(`SELECT zone_id FROM delevery_zone WHERE zone_agence_id = ?`, [
    agenceScope
  ]);
  return rows.map((r) => Number(r.zone_id));
}

/** Vérifie le livreur (actif, type 5, salarié ou non) et son périmètre agence. */
async function checkLivreur(livreurId, user) {
  const [[livreur]] = await pool.query(
    `SELECT u.users_id, ${ZONE_ID_SQL} AS zone_id
       FROM delevery_users u
      WHERE u.users_id = ? AND u.users_active = 1 AND u.users_type = '5' LIMIT 1`,
    [livreurId]
  );
  if (!livreur) return { error: 'Livreur introuvable ou désactivé.' };
  const zonesAgence = await getZonesAgence(user);
  if (zonesAgence !== null && !zonesAgence.includes(Number(livreur.zone_id))) {
    return { error: 'Livreur hors de votre agence.' };
  }
  return {};
}

/** Valide le body { livreur, titre, date, montant } ; { error } ou valeurs. */
function parseBody(body) {
  const livreur = parseInt(body?.livreur, 10);
  if (!Number.isInteger(livreur) || livreur <= 0) {
    return { error: 'Veuillez sélectionner un livreur.' };
  }
  const titre = String(body?.titre || '').trim();
  if (!titre) return { error: 'Veuillez saisir le titre du frais.' };
  if (titre.length > 255) return { error: 'Titre trop long (255 caractères max).' };
  const date = dayToUnix(body?.date);
  if (date === null) return { error: 'Veuillez saisir la date du frais.' };
  const montant = parseMontant(body?.montant);
  if (montant === null) return { error: 'Montant invalide (montant positif attendu).' };
  return { livreur, titre, date, montant };
}

/** Charge un frais avec la zone de son livreur ; null si introuvable. */
async function loadFrais(id) {
  const fraisId = parseInt(id, 10);
  if (!Number.isInteger(fraisId) || fraisId <= 0) return null;
  const [[frais]] = await pool.query(
    `SELECT f.frais_id AS id, f.frais_statut AS statut, f.frais_livreur_id AS livreur_id,
            f.frais_facture_id AS facture_id, ${ZONE_ID_SQL} AS zone_id
       FROM delevery_livreur_frais f
       LEFT JOIN delevery_users u ON u.users_id = f.frais_livreur_id
      WHERE f.frais_id = ? LIMIT 1`,
    [fraisId]
  );
  return frais || null;
}

/** Vrai si la zone est hors du périmètre de l'employé (types 3/4/6). */
function zoneInterdite(zonesAgence, zoneId) {
  return zonesAgence !== null && !zonesAgence.includes(Number(zoneId));
}

/** Motif d'interdiction de modification / suppression, ou null si permis :
 * frais enregistré / payé, ou rattaché à une facture livreur. */
function fraisVerrouille(frais) {
  if (Number(frais.statut) !== STATUTS.new) return 'Ce frais est enregistré ou payé';
  if (frais.facture_id) return 'Ce frais est rattaché à une facture livreur';
  return null;
}

/**
 * GET /api/frais-livreurs/filtres — livreurs actifs (type 5, y compris les
 * livreurs salariés) pour le filtre et la modale d'ajout.
 */
async function listFiltres(req, res, next) {
  try {
    const [livreurs] = await pool.query(
      `SELECT u.users_id AS id, u.users_name AS nom
         FROM delevery_users u
        WHERE u.users_active = 1 AND u.users_type = '5'
        ORDER BY u.users_name`
    );
    res.json({ livreurs });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/frais-livreurs — liste des frais pour la datatable.
 * Query : livreur, statut (new | saved | paid, '' = tous). 1000 frais max,
 * du plus récent au plus ancien. Types 3/4/6 : zones de leur agence.
 */
async function listFrais(req, res, next) {
  try {
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const statut = String(req.query.statut || '').trim();

    const where = ['1 = 1'];
    const params = [];
    if (livreur) {
      where.push('f.frais_livreur_id = ?');
      params.push(livreur);
    }
    if (statut in STATUTS) {
      where.push('f.frais_statut = ?');
      params.push(STATUTS[statut]);
    }

    const zonesAgence = await getZonesAgence(req.user);
    let having = '';
    if (zonesAgence !== null) {
      if (!zonesAgence.length) return res.json([]);
      having = 'HAVING zone_id IN (?)';
      params.push(zonesAgence);
    }

    const [rows] = await pool.query(
      `SELECT f.frais_id         AS id,
              f.frais_titre      AS titre,
              f.frais_date       AS date_frais,
              f.frais_montant    AS montant,
              f.frais_statut     AS statut,
              f.frais_added_time AS added_time,
              f.frais_livreur_id AS livreur_id,
              f.frais_facture_id AS facture_id,
              pn.payment_note_ref AS facture_ref,
              u.users_name       AS livreur_name,
              ${ZONE_ID_SQL}     AS zone_id,
              ${ZONE_NAME_SQL}   AS zone,
              ua.users_name      AS added_by
         FROM delevery_livreur_frais f
         LEFT JOIN delevery_users u  ON u.users_id = f.frais_livreur_id
         LEFT JOIN delevery_users ua ON ua.users_id = f.frais_added_by
         LEFT JOIN delevery_payment_note pn ON pn.payment_note_id = f.frais_facture_id
        WHERE ${where.join(' AND ')}
        ${having}
        ORDER BY f.frais_added_time DESC, f.frais_id DESC
        LIMIT ${MAX_FRAIS}`,
      params
    );
    res.json(rows.map((r) => ({ ...r, statut: Number(r.statut), montant: Number(r.montant) })));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/frais-livreurs — body { livreur, titre, date, montant }. Crée un
 * frais au statut « Nouveau » pour le livreur (actif, type 5, salarié inclus).
 */
async function createFrais(req, res, next) {
  try {
    const values = parseBody(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    const check = await checkLivreur(values.livreur, req.user);
    if (check.error) return res.status(400).json({ message: check.error });

    const now = Math.floor(Date.now() / 1000);
    const [result] = await pool.query(
      `INSERT INTO delevery_livreur_frais
         (frais_livreur_id, frais_titre, frais_date, frais_montant, frais_statut,
          frais_added_time, frais_added_by)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [values.livreur, values.titre, values.date, values.montant, now, Number(req.user.id)]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/frais-livreurs/:id — body { livreur, titre, date, montant }.
 * Modifie un frais au statut « Nouveau » uniquement.
 */
async function updateFrais(req, res, next) {
  try {
    const frais = await loadFrais(req.params.id);
    if (!frais) return res.status(404).json({ message: 'Frais introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, frais.zone_id)) {
      return res.status(404).json({ message: 'Frais introuvable.' });
    }
    const verrou = fraisVerrouille(frais);
    if (verrou) {
      return res.status(400).json({ message: `${verrou} : modification impossible.` });
    }
    const values = parseBody(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    const check = await checkLivreur(values.livreur, req.user);
    if (check.error) return res.status(400).json({ message: check.error });

    await pool.query(
      `UPDATE delevery_livreur_frais
          SET frais_livreur_id = ?, frais_titre = ?, frais_date = ?, frais_montant = ?
        WHERE frais_id = ?`,
      [values.livreur, values.titre, values.date, values.montant, frais.id]
    );
    res.json({ id: frais.id });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/frais-livreurs/:id — supprime un frais au statut « Nouveau »
 * uniquement.
 */
async function deleteFrais(req, res, next) {
  try {
    const frais = await loadFrais(req.params.id);
    if (!frais) return res.status(404).json({ message: 'Frais introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, frais.zone_id)) {
      return res.status(404).json({ message: 'Frais introuvable.' });
    }
    const verrou = fraisVerrouille(frais);
    if (verrou) {
      return res.status(400).json({ message: `${verrou} : suppression impossible.` });
    }
    await pool.query(`DELETE FROM delevery_livreur_frais WHERE frais_id = ?`, [frais.id]);
    res.json({ id: frais.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listFiltres,
  listFrais,
  createFrais,
  updateFrais,
  deleteFrais
};
