const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { SCOPE_UTILISATEURS_SQL, UPLOAD_DIR } = require('./usersFiche.controller');

/*
 * Fiche utilisateur — onglets « Parcours professionnel » et « Congés & absences »
 * (page /admin/utilisateurs/:id), calqués sur la page RH de l'ancienne
 * plateforme SUIVI :
 *  - CNSS + date de recrutement : colonnes users_cnss / users_date_recrutement
 *    de delevery_users ;
 *  - historique des contrats : delevery_contrats (sql/2026-08-19_suppression-
 *    liaisons-suivi.sql) — le dernier contrat alimente aussi users_type_contrat
 *    (colonne du filtre « Type de contrat » de la page Utilisateurs) ;
 *  - historique des salaires : delevery_salaires (même migration) ;
 *  - indisponibilités : delevery_indisponibilites (sql/2026-08-25_parcours-
 *    conges.sql), fichiers joints en tableau JSON (indispo_fichiers).
 * Fichiers stockés dans /uploads/users comme ceux de l'onglet Infos personnelles.
 */

const TYPES_CONTRAT = ['CDI', 'CDD', 'Stage', 'Interim', 'Anapec'];

/* Clé stockée en base → libellé (mêmes types que l'ancien SUIVI). */
const INDISPO_TYPES = {
  conge: 'Congé',
  absence_autorisee: 'Absence autorisée',
  absence_non_autorisee: 'Absence non autorisée',
  retard: 'Retard',
  autre: 'Autre'
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INDISPO_FICHIERS = 10;

/** Date (objet Date mysql2) → 'AAAA-MM-JJ' en heure locale. */
function toDateStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Champ date du corps : '' → null, sinon 'AAAA-MM-JJ' validé (undefined si absent). */
function dateOrNull(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim();
  if (!v) return null;
  if (!DATE_RE.test(v)) throw Object.assign(new Error('Format de date invalide (AAAA-MM-JJ attendu).'), { status: 400 });
  return v;
}

/** Montant du corps : '' → null, sinon nombre >= 0 arrondi à 2 décimales. */
function montantOrNull(value, label) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`Montant invalide pour « ${label} ».`), { status: 400 });
  }
  return n.toFixed(2);
}

/** Supprime du disque un fichier uploadé par la plateforme (jamais les chemins legacy). */
function removeUpload(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/users/')) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(value)), () => {});
}

/** L'utilisateur existe et appartient au périmètre de la page Utilisateurs, sinon null. */
async function requireUser(id) {
  if (!Number.isInteger(id)) return null;
  const [rows] = await pool.query(
    `SELECT u.users_id FROM delevery_users u WHERE u.users_id = ? AND ${SCOPE_UTILISATEURS_SQL}`,
    [id]
  );
  return rows[0] || null;
}

/* ------------------------------------------------------------------ */
/* Parcours professionnel                                              */
/* ------------------------------------------------------------------ */

/** Charge CNSS/date de recrutement + historiques contrats et salaires (plus récents en premier). */
async function fetchParcours(id) {
  const [[user]] = await pool.query(
    `SELECT users_cnss, users_date_recrutement FROM delevery_users WHERE users_id = ?`,
    [id]
  );
  const [contrats] = await pool.query(
    `SELECT contrat_id, contrat_type, contrat_date_debut, contrat_date_fin,
            contrat_fichier, contrat_observation
       FROM delevery_contrats WHERE contrat_users_id = ?
      ORDER BY contrat_date_debut DESC, contrat_id DESC`,
    [id]
  );
  const [salaires] = await pool.query(
    `SELECT salaire_id, salaire_declare, salaire_net, salaire_date_application, salaire_observation
       FROM delevery_salaires WHERE salaire_users_id = ?
      ORDER BY salaire_date_application DESC, salaire_id DESC`,
    [id]
  );
  return {
    users_cnss: user?.users_cnss ?? null,
    users_date_recrutement: toDateStr(user?.users_date_recrutement),
    contrats: contrats.map((c) => ({
      contrat_id: c.contrat_id,
      type: c.contrat_type,
      date_debut: toDateStr(c.contrat_date_debut),
      date_fin: toDateStr(c.contrat_date_fin),
      fichier: c.contrat_fichier,
      observation: c.contrat_observation
    })),
    salaires: salaires.map((s) => ({
      salaire_id: s.salaire_id,
      declare: s.salaire_declare,
      net: s.salaire_net,
      date_application: toDateStr(s.salaire_date_application),
      observation: s.salaire_observation
    }))
  };
}

/* Colonne users_type_contrat (filtre de la page Utilisateurs) alignée sur le
 * dernier contrat ; sans contrat elle garde sa valeur (statut saisi à la création). */
async function syncTypeContrat(id) {
  const [[last]] = await pool.query(
    `SELECT contrat_type FROM delevery_contrats WHERE contrat_users_id = ?
      ORDER BY contrat_date_debut DESC, contrat_id DESC LIMIT 1`,
    [id]
  );
  if (last) {
    await pool.query(`UPDATE delevery_users SET users_type_contrat = ? WHERE users_id = ?`, [
      last.contrat_type,
      id
    ]);
  }
}

/** GET /api/users/:id/parcours — onglet complet. */
async function getParcours(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    res.json(await fetchParcours(id));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/users/:id/parcours — N° CNSS + date de recrutement. */
async function updateParcours(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const cnss = String(req.body?.users_cnss ?? '').trim().slice(0, 50) || null;
    const recrutement = dateOrNull(req.body?.users_date_recrutement) ?? null;
    await pool.query(
      `UPDATE delevery_users SET users_cnss = ?, users_date_recrutement = ? WHERE users_id = ?`,
      [cnss, recrutement, id]
    );
    res.json(await fetchParcours(id));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** Valide le corps d'un contrat (multipart) : type + dates cohérentes. */
function parseContratBody(body) {
  const type = String(body?.type ?? '').trim();
  if (!TYPES_CONTRAT.includes(type)) {
    throw Object.assign(new Error('Type de contrat invalide.'), { status: 400 });
  }
  const debut = dateOrNull(body?.date_debut) ?? null;
  const fin = dateOrNull(body?.date_fin) ?? null;
  if (debut && fin && fin < debut) {
    throw Object.assign(new Error('La date de fin ne peut pas précéder la date de début.'), { status: 400 });
  }
  const observation = String(body?.observation ?? '').trim().slice(0, 1000) || null;
  return { type, debut, fin, observation };
}

/** POST /api/users/:id/contrats — ajout (fichier PDF facultatif, champ "fichier"). */
async function createContrat(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const { type, debut, fin, observation } = parseContratBody(req.body);
    const fichier = req.file ? `/uploads/users/${req.file.filename}` : null;
    await pool.query(
      `INSERT INTO delevery_contrats
         (contrat_users_id, contrat_type, contrat_date_debut, contrat_date_fin,
          contrat_fichier, contrat_observation, contrat_created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, type, debut, fin, fichier, observation, Number(req.user.id)]
    );
    await syncTypeContrat(id);
    res.status(201).json(await fetchParcours(id));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** PUT /api/users/:id/contrats/:contratId — un nouveau fichier remplace l'ancien. */
async function updateContrat(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const contratId = parseInt(req.params.contratId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [[row]] = await pool.query(
      `SELECT contrat_fichier FROM delevery_contrats WHERE contrat_id = ? AND contrat_users_id = ?`,
      [contratId, id]
    );
    if (!row) return res.status(404).json({ message: 'Contrat introuvable.' });
    const { type, debut, fin, observation } = parseContratBody(req.body);
    let fichier = row.contrat_fichier;
    if (req.file) {
      removeUpload(row.contrat_fichier);
      fichier = `/uploads/users/${req.file.filename}`;
    }
    await pool.query(
      `UPDATE delevery_contrats
          SET contrat_type = ?, contrat_date_debut = ?, contrat_date_fin = ?,
              contrat_fichier = ?, contrat_observation = ?
        WHERE contrat_id = ? AND contrat_users_id = ?`,
      [type, debut, fin, fichier, observation, contratId, id]
    );
    await syncTypeContrat(id);
    res.json(await fetchParcours(id));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** DELETE /api/users/:id/contrats/:contratId — le PDF associé est aussi supprimé. */
async function deleteContrat(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const contratId = parseInt(req.params.contratId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [[row]] = await pool.query(
      `SELECT contrat_fichier FROM delevery_contrats WHERE contrat_id = ? AND contrat_users_id = ?`,
      [contratId, id]
    );
    if (!row) return res.status(404).json({ message: 'Contrat introuvable.' });
    await pool.query(`DELETE FROM delevery_contrats WHERE contrat_id = ? AND contrat_users_id = ?`, [
      contratId,
      id
    ]);
    removeUpload(row.contrat_fichier);
    await syncTypeContrat(id);
    res.json(await fetchParcours(id));
  } catch (err) {
    next(err);
  }
}

/** Valide le corps d'un salaire (JSON). */
function parseSalaireBody(body) {
  const declare = montantOrNull(body?.declare, 'Salaire déclaré');
  const net = montantOrNull(body?.net, 'Salaire net');
  const dateApplication = dateOrNull(body?.date_application) ?? null;
  const observation = String(body?.observation ?? '').trim().slice(0, 1000) || null;
  return { declare, net, dateApplication, observation };
}

/** POST /api/users/:id/salaires — ajout. */
async function createSalaire(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const { declare, net, dateApplication, observation } = parseSalaireBody(req.body);
    await pool.query(
      `INSERT INTO delevery_salaires
         (salaire_users_id, salaire_declare, salaire_net, salaire_date_application,
          salaire_observation, salaire_created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, declare, net, dateApplication, observation, Number(req.user.id)]
    );
    res.status(201).json(await fetchParcours(id));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** PUT /api/users/:id/salaires/:salaireId — modification. */
async function updateSalaire(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const salaireId = parseInt(req.params.salaireId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [[row]] = await pool.query(
      `SELECT salaire_id FROM delevery_salaires WHERE salaire_id = ? AND salaire_users_id = ?`,
      [salaireId, id]
    );
    if (!row) return res.status(404).json({ message: 'Salaire introuvable.' });
    const { declare, net, dateApplication, observation } = parseSalaireBody(req.body);
    await pool.query(
      `UPDATE delevery_salaires
          SET salaire_declare = ?, salaire_net = ?, salaire_date_application = ?, salaire_observation = ?
        WHERE salaire_id = ? AND salaire_users_id = ?`,
      [declare, net, dateApplication, observation, salaireId, id]
    );
    res.json(await fetchParcours(id));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** DELETE /api/users/:id/salaires/:salaireId — suppression. */
async function deleteSalaire(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const salaireId = parseInt(req.params.salaireId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [result] = await pool.query(
      `DELETE FROM delevery_salaires WHERE salaire_id = ? AND salaire_users_id = ?`,
      [salaireId, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Salaire introuvable.' });
    res.json(await fetchParcours(id));
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Congés & absences (indisponibilités)                                */
/* ------------------------------------------------------------------ */

/** Colonne indispo_fichiers (JSON) → tableau de chemins, tolérant aux valeurs invalides. */
function parseFichiers(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

async function fetchIndispos(id) {
  const [rows] = await pool.query(
    `SELECT indispo_id, indispo_type, indispo_date_debut, indispo_date_fin,
            indispo_remarque, indispo_fichiers
       FROM delevery_indisponibilites WHERE indispo_users_id = ?
      ORDER BY indispo_date_debut DESC, indispo_id DESC`,
    [id]
  );
  return rows.map((r) => ({
    indispo_id: r.indispo_id,
    type: r.indispo_type,
    date_debut: toDateStr(r.indispo_date_debut),
    date_fin: toDateStr(r.indispo_date_fin),
    remarque: r.indispo_remarque,
    fichiers: parseFichiers(r.indispo_fichiers)
  }));
}

/** Valide le corps d'une indisponibilité (multipart) : type + dates obligatoires. */
function parseIndispoBody(body) {
  const type = String(body?.type ?? '').trim();
  if (!INDISPO_TYPES[type]) {
    throw Object.assign(new Error("Type d'indisponibilité invalide."), { status: 400 });
  }
  const debut = dateOrNull(body?.date_debut) ?? null;
  const fin = dateOrNull(body?.date_fin) ?? null;
  if (!debut || !fin) {
    throw Object.assign(new Error('Les dates de début et de fin sont obligatoires.'), { status: 400 });
  }
  if (fin < debut) {
    throw Object.assign(new Error('La date de fin ne peut pas précéder la date de début.'), { status: 400 });
  }
  const remarque = String(body?.remarque ?? '').trim().slice(0, 1000) || null;
  return { type, debut, fin, remarque };
}

/** GET /api/users/:id/indisponibilites — historique complet. */
async function listIndispos(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    res.json({ rows: await fetchIndispos(id) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/users/:id/indisponibilites — ajout (fichiers joints facultatifs, champ "fichiers"). */
async function createIndispo(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const { type, debut, fin, remarque } = parseIndispoBody(req.body);
    const fichiers = (req.files || []).map((f) => `/uploads/users/${f.filename}`);
    await pool.query(
      `INSERT INTO delevery_indisponibilites
         (indispo_users_id, indispo_type, indispo_date_debut, indispo_date_fin,
          indispo_remarque, indispo_fichiers, indispo_created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, type, debut, fin, remarque, fichiers.length ? JSON.stringify(fichiers) : null, Number(req.user.id)]
    );
    res.status(201).json({ rows: await fetchIndispos(id) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/**
 * PUT /api/users/:id/indisponibilites/:indispoId — fichiers conservés = existants
 * moins ceux listés dans "fichiers_remove" (supprimés du disque), plus les nouveaux.
 */
async function updateIndispo(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const indispoId = parseInt(req.params.indispoId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [[row]] = await pool.query(
      `SELECT indispo_fichiers FROM delevery_indisponibilites WHERE indispo_id = ? AND indispo_users_id = ?`,
      [indispoId, id]
    );
    if (!row) return res.status(404).json({ message: 'Indisponibilité introuvable.' });
    const { type, debut, fin, remarque } = parseIndispoBody(req.body);

    const existants = parseFichiers(row.indispo_fichiers);
    const remove = req.body?.fichiers_remove;
    const aRetirer = new Set(Array.isArray(remove) ? remove : remove ? [remove] : []);
    const conserves = existants.filter((f) => !aRetirer.has(f));
    const ajoutes = (req.files || []).map((f) => `/uploads/users/${f.filename}`);
    const fichiers = [...conserves, ...ajoutes].slice(0, MAX_INDISPO_FICHIERS);

    await pool.query(
      `UPDATE delevery_indisponibilites
          SET indispo_type = ?, indispo_date_debut = ?, indispo_date_fin = ?,
              indispo_remarque = ?, indispo_fichiers = ?
        WHERE indispo_id = ? AND indispo_users_id = ?`,
      [type, debut, fin, remarque, fichiers.length ? JSON.stringify(fichiers) : null, indispoId, id]
    );
    for (const f of existants) if (aRetirer.has(f)) removeUpload(f);
    res.json({ rows: await fetchIndispos(id) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  }
}

/** DELETE /api/users/:id/indisponibilites/:indispoId — les fichiers joints sont aussi supprimés. */
async function deleteIndispo(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const indispoId = parseInt(req.params.indispoId, 10);
    if (!(await requireUser(id))) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const [[row]] = await pool.query(
      `SELECT indispo_fichiers FROM delevery_indisponibilites WHERE indispo_id = ? AND indispo_users_id = ?`,
      [indispoId, id]
    );
    if (!row) return res.status(404).json({ message: 'Indisponibilité introuvable.' });
    await pool.query(`DELETE FROM delevery_indisponibilites WHERE indispo_id = ? AND indispo_users_id = ?`, [
      indispoId,
      id
    ]);
    for (const f of parseFichiers(row.indispo_fichiers)) removeUpload(f);
    res.json({ rows: await fetchIndispos(id) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getParcours,
  updateParcours,
  createContrat,
  updateContrat,
  deleteContrat,
  createSalaire,
  updateSalaire,
  deleteSalaire,
  listIndispos,
  createIndispo,
  updateIndispo,
  deleteIndispo,
  MAX_INDISPO_FICHIERS
};
