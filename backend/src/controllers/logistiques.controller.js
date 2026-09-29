const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { listMarqueRows, maintenanceIntervalles, MOYEN_TYPES } = require('./config.controller');

/*
 * Logistiques (page /admin/logistiques — service LOGISTIQUES) : parc des
 * moyens logistiques de la société (motos, VL, PL).
 *
 * Tables neuves delevery_logistique_* (sql/2026-08-25_logistiques.sql +
 * sql/2026-08-25_logistiques-onglets.sql). Les types (moto / vl / pl), le
 * catalogue des marques et les intervalles de maintenance viennent de
 * Configuration > Options (delevery_configs) ; lm_marque_id = configs_id.
 *
 * Un moyen s'identifie par son n° de châssis (unique). La fiche a 5 onglets :
 *  - Informations : identification + caractéristiques (updateMoyen) ;
 *  - Maintenance  : vidanges (prochaine estimée = dernière + intervalle
 *    « vidange » du type), entretiens, consommation carburant ;
 *  - Documents    : 4 documents réglementaires (une ligne par type, carte
 *    grise avec recto + verso) + autres documents (une ligne par fichier) ;
 *  - Financement  : prix / méthode d'achat, détail du crédit, documents ;
 *  - Matériels    : dépend du module Matériels, à venir.
 * Les colonnes « Doc. manquants » (5 fichiers requis : carte grise recto et
 * verso, visite technique, assurance, vignette), « Doc. expirés »,
 * « Financement » et « Fin crédit » de la liste sortent de ces onglets.
 */

const TYPE_LABELS = { moto: 'Moto', vl: 'VL (permis B)', pl: 'PL (permis C)' };

const ENERGIES = [
  { code: 'diesel', label: 'Diesel' },
  { code: 'essence', label: 'Essence' },
  { code: 'electrique', label: 'Électrique' },
  { code: 'hybride', label: 'Hybride' },
  { code: 'gpl', label: 'GPL' }
];

const STATUTS = [
  { code: 'actif', label: 'Actif' },
  { code: 'en_maintenance', label: 'En maintenance' },
  { code: 'immobilise', label: 'Immobilisé' },
  { code: 'vendu', label: 'Vendu' },
  { code: 'hors_service', label: 'Hors service' }
];

/** Documents réglementaires (onglet Documents) : une ligne par type. */
const REGLEMENTAIRES = [
  { code: 'carte_grise', label: 'Carte grise' },
  { code: 'visite_technique', label: 'Visite technique' },
  { code: 'assurance', label: 'Assurance' },
  { code: 'vignette', label: 'Vignette' }
];
/* Fichiers requis par moyen : carte grise recto + verso, puis un fichier
 * pour chacun des 3 autres types (colonne « Doc. manquants » de la liste). */
const NB_FICHIERS_REQUIS = 5;
const REGL_TYPES_SQL = REGLEMENTAIRES.map((d) => `'${d.code}'`).join(', ');

/** Types d'entretien (onglet Maintenance) : pièces suivies hors vidange. */
const ENTRETIEN_TYPES = [
  { code: 'vidange_boite', label: 'Vidange boîte' },
  { code: 'chaine_tendeur', label: 'Chaîne et tendeur' },
  { code: 'pneus_avant', label: 'Pneus avant' },
  { code: 'pneus_arriere', label: 'Pneus arrière' },
  { code: 'autre', label: 'Autre' }
];

const METHODES_FINANCEMENT = [
  { code: 'comptant', label: 'Comptant' },
  { code: 'credit', label: 'Crédit' },
  { code: 'leasing', label: 'Leasing' }
];

/* Fichiers uploadés (documents, financement) : backend/uploads/logistiques. */
const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'logistiques');

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/** Supprime un fichier du dossier logistiques (chemin '/uploads/logistiques/…'). */
function deleteUploadedFile(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/logistiques/')) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(value)), () => {});
}

/** "AAAA-MM-JJ" valide → la chaîne, '' → null, sinon undefined (invalide). */
function parseDay(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return undefined;
  return v;
}

/** Kilométrage : entier 0..9 999 999, sinon null. */
function parseKm(value) {
  const km = Number(value);
  if (!Number.isInteger(km) || km < 0 || km > 9999999) return null;
  return km;
}

/** Montant DH (2 décimales max) : '' → null, invalide → undefined. */
function parseMontant(value, max = 99999999.99) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

/** Marques (delevery_configs) indexées par id : { id → { id, marque, type, active } }. */
async function marquesById() {
  const map = new Map();
  for (const m of await listMarqueRows()) map.set(m.id, m);
  return map;
}

/**
 * GET /api/logistiques/filtres — listes de valeurs des filtres et
 * formulaires : types, énergies, statuts, marques ACTIVES par type, types
 * d'entretien et méthodes de financement.
 */
async function listFiltres(req, res, next) {
  try {
    const marques = (await listMarqueRows())
      .filter((m) => m.active === 1)
      .sort(
        (a, b) =>
          MOYEN_TYPES.indexOf(a.type) - MOYEN_TYPES.indexOf(b.type) ||
          a.marque.localeCompare(b.marque, 'fr', { sensitivity: 'base' })
      )
      .map((m) => ({ id: m.id, type: m.type, nom: m.marque }));
    res.json({
      types: MOYEN_TYPES.map((code) => ({ code, label: TYPE_LABELS[code] })),
      energies: ENERGIES,
      statuts: STATUTS,
      entretienTypes: ENTRETIEN_TYPES,
      methodes: METHODES_FINANCEMENT,
      marques
    });
  } catch (err) {
    next(err);
  }
}

/** Ligne SQL d'un moyen → objet API (marque résolue via le catalogue). */
function toMoyen(row, marques) {
  const marque = marques.get(Number(row.lm_marque_id));
  return {
    id: row.lm_id,
    type: row.lm_type,
    marque_id: row.lm_marque_id,
    marque: marque ? marque.marque : `Marque n°${row.lm_marque_id}`,
    chassis: row.lm_chassis,
    immat_ww: row.lm_immat_ww,
    immat: row.lm_immat,
    mise_circulation: row.mise_circulation || '',
    energie: row.lm_energie,
    statut: row.lm_statut,
    observation: row.lm_observation || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || ''
  };
}

/** Libellé court d'un moyen pour le sélecteur de la fiche : "VL · trafic — 123…". */
function moyenLabel(moyen) {
  return `${moyen.type.toUpperCase()} · ${moyen.marque} — ${moyen.chassis}`;
}

const MOYEN_FIELDS = `
  m.lm_id, m.lm_type, m.lm_marque_id, m.lm_chassis, m.lm_immat_ww,
  m.lm_immat, m.lm_energie, m.lm_statut, m.lm_observation,
  DATE_FORMAT(m.lm_mise_circulation, '%Y-%m-%d')  AS mise_circulation,
  DATE_FORMAT(m.lm_created_at, '%d/%m/%Y %H:%i')  AS created_at,
  DATE_FORMAT(m.lm_updated_at, '%d/%m/%Y %H:%i')  AS updated_at`;

const MOYEN_SELECT = `SELECT ${MOYEN_FIELDS} FROM delevery_logistique_moyen m`;

/**
 * GET /api/logistiques — tout le parc, avec compteurs de documents (fichiers
 * requis présents / documents expirés) et financement (méthode, fin crédit).
 * Le filtrage se fait côté frontend.
 */
async function listMoyens(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT ${MOYEN_FIELDS},
         f.lf_methode AS financement_methode,
         DATE_FORMAT(DATE_ADD(f.lf_premiere_mensualite,
                              INTERVAL f.lf_nb_mensualites - 1 MONTH),
                     '%d/%m/%Y') AS fin_credit,
         (SELECT COALESCE(SUM(CASE WHEN d.ld_type = 'carte_grise'
                  THEN (d.ld_fichier <> '') + (d.ld_fichier2 <> '')
                  ELSE (d.ld_fichier <> '') END), 0)
            FROM delevery_logistique_document d
           WHERE d.ld_moyen = m.lm_id AND d.ld_type IN (${REGL_TYPES_SQL})) AS docs_presents,
         (SELECT COUNT(*) FROM delevery_logistique_document d
           WHERE d.ld_moyen = m.lm_id AND d.ld_type IN (${REGL_TYPES_SQL})
             AND d.ld_date_expiration IS NOT NULL
             AND d.ld_date_expiration < CURDATE()) AS docs_expires
         FROM delevery_logistique_moyen m
         LEFT JOIN delevery_logistique_financement f ON f.lf_moyen = m.lm_id
        ORDER BY m.lm_id DESC`
    );
    const marques = await marquesById();
    res.json({
      rows: rows.map((r) => ({
        ...toMoyen(r, marques),
        financement: r.financement_methode || '',
        fin_credit: r.fin_credit || '',
        docs_manquants: NB_FICHIERS_REQUIS - Number(r.docs_presents || 0),
        docs_expires: Number(r.docs_expires || 0)
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Valide l'identification { type, marqueId, chassis } d'un moyen.
 * `current` (fiche existante) : autorise de conserver une marque désactivée.
 * Retourne { error } ou { type, marqueId, chassis }.
 */
async function parseIdentification(body, current = null) {
  const type = String(body?.type || '').trim();
  if (!MOYEN_TYPES.includes(type)) {
    return { error: 'Veuillez choisir le type de moyen (Moto, VL ou PL).' };
  }
  const marqueId = Number(body?.marqueId);
  const marque = (await marquesById()).get(marqueId);
  if (!marque || marque.type !== type) {
    return { error: 'Veuillez choisir une marque du type sélectionné.' };
  }
  if (marque.active !== 1 && (!current || marqueId !== Number(current.marque_id))) {
    return { error: 'Cette marque est désactivée (Configuration > Options).' };
  }
  const chassis = String(body?.chassis || '').trim();
  if (!chassis) return { error: 'Veuillez saisir le n° de châssis.' };
  if (chassis.length > 100) return { error: 'N° de châssis trop long (100 caractères max).' };
  return { type, marqueId, chassis };
}

/** Le châssis est-il déjà pris par un autre moyen ? */
async function chassisExiste(chassis, excludeId = 0) {
  const [[row]] = await pool.query(
    `SELECT lm_id FROM delevery_logistique_moyen
      WHERE lm_chassis = ? AND lm_id <> ? LIMIT 1`,
    [chassis, excludeId]
  );
  return Boolean(row);
}

/**
 * POST /api/logistiques — body { type, marqueId, chassis } (modale
 * « Nouveau moyen logistique »). Statut « actif » par défaut, les
 * caractéristiques se complètent ensuite sur la fiche.
 */
async function createMoyen(req, res, next) {
  try {
    const values = await parseIdentification(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await chassisExiste(values.chassis)) {
      return res.status(409).json({ message: 'Un moyen avec ce n° de châssis existe déjà.' });
    }
    const [result] = await pool.query(
      `INSERT INTO delevery_logistique_moyen
         (lm_type, lm_marque_id, lm_chassis, lm_statut, lm_created_by, lm_created_at)
       VALUES (?, ?, ?, 'actif', ?, NOW())`,
      [values.type, values.marqueId, values.chassis, Number(req.user.id)]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/** Charge une fiche par id (marque résolue) ; null si introuvable. */
async function loadMoyen(id) {
  const moyenId = parseInt(id, 10);
  if (!Number.isInteger(moyenId) || moyenId <= 0) return null;
  const [[row]] = await pool.query(`${MOYEN_SELECT} WHERE m.lm_id = ? LIMIT 1`, [moyenId]);
  if (!row) return null;
  return toMoyen(row, await marquesById());
}

/** Liste { id, label } de tout le parc pour le sélecteur « Moyen : » de la fiche. */
async function listSwitcher() {
  const [rows] = await pool.query(`${MOYEN_SELECT} ORDER BY m.lm_id DESC`);
  const marques = await marquesById();
  return rows.map((r) => {
    const moyen = toMoyen(r, marques);
    return { id: moyen.id, label: moyenLabel(moyen) };
  });
}

/** GET /api/logistiques/:id — fiche + liste du parc (sélecteur de moyen). */
async function getMoyen(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    res.json({ fiche, moyens: await listSwitcher() });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/logistiques/:id — onglet Informations : identification (type,
 * marque, châssis) + caractéristiques (immatriculations, mise en circulation,
 * énergie, statut, observation). Renvoie la même forme que le GET.
 */
async function updateMoyen(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });

    const values = await parseIdentification(req.body, fiche);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await chassisExiste(values.chassis, fiche.id)) {
      return res.status(409).json({ message: 'Un moyen avec ce n° de châssis existe déjà.' });
    }

    const immatWw = String(req.body?.immatWw || '').trim();
    const immat = String(req.body?.immat || '').trim();
    if (immatWw.length > 50 || immat.length > 50) {
      return res.status(400).json({ message: 'Immatriculation trop longue (50 caractères max).' });
    }
    const miseCirculation = parseDay(req.body?.miseCirculation);
    if (miseCirculation === undefined) {
      return res.status(400).json({ message: 'Date de mise en circulation invalide.' });
    }
    const energie = String(req.body?.energie || '').trim();
    if (energie && !ENERGIES.some((e) => e.code === energie)) {
      return res.status(400).json({ message: 'Énergie invalide.' });
    }
    const statut = String(req.body?.statut || '').trim();
    if (!STATUTS.some((s) => s.code === statut)) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    const observation = String(req.body?.observation || '').trim();
    if (observation.length > 2000) {
      return res.status(400).json({ message: 'Observation trop longue (2000 caractères max).' });
    }

    await pool.query(
      `UPDATE delevery_logistique_moyen
          SET lm_type = ?, lm_marque_id = ?, lm_chassis = ?, lm_immat_ww = ?,
              lm_immat = ?, lm_mise_circulation = ?, lm_energie = ?,
              lm_statut = ?, lm_observation = ?, lm_updated_at = NOW()
        WHERE lm_id = ?`,
      [
        values.type,
        values.marqueId,
        values.chassis,
        immatWw,
        immat,
        miseCirculation,
        energie,
        statut,
        observation,
        fiche.id
      ]
    );
    res.json({ fiche: await loadMoyen(fiche.id), moyens: await listSwitcher() });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/logistiques/:id — supprime le moyen, ses enregistrements
 * (maintenance, financement) et ses documents (fichiers inclus). */
async function deleteMoyen(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    const [docs] = await pool.query(
      `SELECT ld_fichier, ld_fichier2 FROM delevery_logistique_document WHERE ld_moyen = ?`,
      [fiche.id]
    );
    for (const doc of docs) {
      deleteUploadedFile(doc.ld_fichier);
      deleteUploadedFile(doc.ld_fichier2);
    }
    await pool.query(`DELETE FROM delevery_logistique_document WHERE ld_moyen = ?`, [fiche.id]);
    await pool.query(`DELETE FROM delevery_logistique_vidange WHERE lv_moyen = ?`, [fiche.id]);
    await pool.query(`DELETE FROM delevery_logistique_entretien WHERE le_moyen = ?`, [fiche.id]);
    await pool.query(`DELETE FROM delevery_logistique_conso WHERE lc_moyen = ?`, [fiche.id]);
    await pool.query(`DELETE FROM delevery_logistique_financement WHERE lf_moyen = ?`, [fiche.id]);
    await pool.query(`DELETE FROM delevery_logistique_moyen WHERE lm_id = ?`, [fiche.id]);
    res.json({ id: fiche.id });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Onglet Maintenance : vidanges, entretiens, consommation carburant. */
/* ------------------------------------------------------------------ */

/**
 * Données de l'onglet Maintenance : listes + prochaine vidange estimée
 * (dernière vidange = km le plus élevé + intervalle « vidange » du type) et
 * alertes (dernier kilométrage relevé toutes saisies confondues).
 */
async function buildMaintenance(fiche) {
  const [vidanges] = await pool.query(
    `SELECT lv_id AS id, lv_km AS km, lv_filtre_huile AS filtre_huile,
            lv_filtre_carburant AS filtre_carburant, lv_filtre_air AS filtre_air,
            lv_adblue AS adblue, lv_anti_cristallisant AS anti_cristallisant,
            DATE_FORMAT(lv_created_at, '%d/%m/%Y %H:%i') AS created_at
       FROM delevery_logistique_vidange
      WHERE lv_moyen = ?
      ORDER BY lv_km DESC, lv_id DESC`,
    [fiche.id]
  );
  const [entretiens] = await pool.query(
    `SELECT le_id AS id, le_type AS type, le_km AS km, le_observation AS observation,
            DATE_FORMAT(le_created_at, '%d/%m/%Y %H:%i') AS created_at
       FROM delevery_logistique_entretien
      WHERE le_moyen = ?
      ORDER BY le_id DESC`,
    [fiche.id]
  );
  const [consommations] = await pool.query(
    `SELECT lc_id AS id, lc_montant AS montant, lc_km AS km,
            DATE_FORMAT(lc_recharge_at, '%d/%m/%Y %H:%i') AS recharge_at,
            DATE_FORMAT(lc_created_at, '%d/%m/%Y %H:%i') AS created_at
       FROM delevery_logistique_conso
      WHERE lc_moyen = ?
      ORDER BY lc_recharge_at DESC, lc_id DESC`,
    [fiche.id]
  );

  const intervalles = (await maintenanceIntervalles())[fiche.type] || {};
  const intervalleVidange = Number(intervalles.vidange) || 10000;

  const derniereVidange = vidanges.length
    ? { km: Number(vidanges[0].km), date: vidanges[0].created_at }
    : null;
  const kms = [
    ...vidanges.map((v) => Number(v.km)),
    ...entretiens.map((e) => Number(e.km)),
    ...consommations.map((c) => Number(c.km))
  ];
  const dernierKm = kms.length ? Math.max(...kms) : null;
  const prochaineVidange = derniereVidange ? derniereVidange.km + intervalleVidange : null;

  const alertes = [];
  if (!derniereVidange) {
    alertes.push({
      niveau: 'info',
      texte:
        'Aucune vidange enregistrée pour ce moyen. Enregistrez la première vidange pour activer le suivi.'
    });
  } else if (dernierKm !== null && dernierKm >= prochaineVidange) {
    alertes.push({
      niveau: 'urgent',
      texte: `Vidange dépassée : prévue vers ${prochaineVidange.toLocaleString('fr-FR')} km, dernier kilométrage relevé ${dernierKm.toLocaleString('fr-FR')} km.`
    });
  } else if (dernierKm !== null && prochaineVidange - dernierKm <= 1000) {
    alertes.push({
      niveau: 'warn',
      texte: `Vidange à prévoir dans environ ${(prochaineVidange - dernierKm).toLocaleString('fr-FR')} km.`
    });
  } else {
    alertes.push({ niveau: 'success', texte: 'Aucune alerte pour ce moyen.' });
  }

  return {
    vidanges: vidanges.map((v) => ({ ...v, km: Number(v.km) })),
    entretiens: entretiens.map((e) => ({ ...e, km: Number(e.km) })),
    consommations: consommations.map((c) => ({
      ...c,
      km: Number(c.km),
      montant: Number(c.montant) || 0
    })),
    intervalleVidange,
    derniereVidange,
    prochaineVidange,
    dernierKm,
    alertes
  };
}

/** GET /api/logistiques/:id/maintenance — données de l'onglet Maintenance. */
async function getMaintenanceMoyen(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    res.json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** POST /api/logistiques/:id/vidanges — { km, filtreHuile, filtreCarburant,
 * filtreAir, adblue, antiCristallisant } (booléens : remplacés en même temps). */
async function createVidange(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    const km = parseKm(req.body?.km);
    if (km === null) {
      return res.status(400).json({ message: 'Kilométrage invalide (entier positif attendu).' });
    }
    const flag = (v) => (v ? 1 : 0);
    await pool.query(
      `INSERT INTO delevery_logistique_vidange
         (lv_moyen, lv_km, lv_filtre_huile, lv_filtre_carburant, lv_filtre_air,
          lv_adblue, lv_anti_cristallisant, lv_created_by, lv_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        fiche.id,
        km,
        flag(req.body?.filtreHuile),
        flag(req.body?.filtreCarburant),
        flag(req.body?.filtreAir),
        flag(req.body?.adblue),
        flag(req.body?.antiCristallisant),
        Number(req.user.id)
      ]
    );
    res.status(201).json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/logistiques/:id/vidanges/:itemId */
async function deleteVidange(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    await pool.query(
      `DELETE FROM delevery_logistique_vidange WHERE lv_id = ? AND lv_moyen = ?`,
      [Number(req.params.itemId) || 0, fiche.id]
    );
    res.json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** POST /api/logistiques/:id/entretiens — { type, km, observation }. */
async function createEntretien(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    const type = String(req.body?.type || '').trim();
    if (!ENTRETIEN_TYPES.some((t) => t.code === type)) {
      return res.status(400).json({ message: "Veuillez choisir le type d'entretien." });
    }
    const km = parseKm(req.body?.km);
    if (km === null) {
      return res.status(400).json({ message: 'Kilométrage invalide (entier positif attendu).' });
    }
    const observation = String(req.body?.observation || '').trim();
    if (observation.length > 500) {
      return res.status(400).json({ message: 'Observation trop longue (500 caractères max).' });
    }
    await pool.query(
      `INSERT INTO delevery_logistique_entretien
         (le_moyen, le_type, le_km, le_observation, le_created_by, le_created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [fiche.id, type, km, observation, Number(req.user.id)]
    );
    res.status(201).json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/logistiques/:id/entretiens/:itemId */
async function deleteEntretien(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    await pool.query(
      `DELETE FROM delevery_logistique_entretien WHERE le_id = ? AND le_moyen = ?`,
      [Number(req.params.itemId) || 0, fiche.id]
    );
    res.json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** POST /api/logistiques/:id/consommations — { montant, km, rechargeAt
 * ("AAAA-MM-JJTHH:MM", input datetime-local) }. */
async function createConsommation(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    const montant = parseMontant(req.body?.montant, 99999.99);
    if (montant === undefined || montant === null || montant <= 0) {
      return res.status(400).json({ message: 'Montant invalide (DH, 2 décimales max).' });
    }
    const km = parseKm(req.body?.km);
    if (km === null) {
      return res.status(400).json({ message: 'Kilométrage invalide (entier positif attendu).' });
    }
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(req.body?.rechargeAt || '').trim());
    if (!m || parseDay(m[1]) === undefined) {
      return res.status(400).json({ message: 'Veuillez saisir la date et l’heure de la recharge.' });
    }
    await pool.query(
      `INSERT INTO delevery_logistique_conso
         (lc_moyen, lc_montant, lc_km, lc_recharge_at, lc_created_by, lc_created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [fiche.id, montant, km, `${m[1]} ${m[2]}:00`, Number(req.user.id)]
    );
    res.status(201).json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/logistiques/:id/consommations/:itemId */
async function deleteConsommation(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    await pool.query(
      `DELETE FROM delevery_logistique_conso WHERE lc_id = ? AND lc_moyen = ?`,
      [Number(req.params.itemId) || 0, fiche.id]
    );
    res.json(await buildMaintenance(fiche));
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Onglet Documents : réglementaires (upsert) + autres documents.     */
/* ------------------------------------------------------------------ */

/** Lignes documents d'un moyen pour un ensemble de types. */
async function listDocRows(moyenId, types) {
  const [rows] = await pool.query(
    `SELECT ld_id AS id, ld_type AS type, ld_numero AS numero,
            DATE_FORMAT(ld_date_expiration, '%Y-%m-%d') AS expiration,
            ld_fichier AS fichier, ld_fichier2 AS fichier2,
            DATE_FORMAT(ld_created_at, '%d/%m/%Y %H:%i') AS created_at
       FROM delevery_logistique_document
      WHERE ld_moyen = ? AND ld_type IN (${types.map(() => '?').join(', ')})
      ORDER BY ld_id DESC`,
    [moyenId, ...types]
  );
  return rows;
}

/** Données de l'onglet Documents : réglementaires (par type) + autres. */
async function buildDocuments(moyenId) {
  const rows = await listDocRows(moyenId, [...REGLEMENTAIRES.map((d) => d.code), 'autre']);
  const reglementaires = {};
  for (const d of REGLEMENTAIRES) {
    const row = rows.find((r) => r.type === d.code);
    reglementaires[d.code] = row
      ? { expiration: row.expiration || '', fichier: row.fichier, fichier2: row.fichier2 }
      : { expiration: '', fichier: '', fichier2: '' };
  }
  return {
    reglementaires,
    autres: rows.filter((r) => r.type === 'autre')
  };
}

/** GET /api/logistiques/:id/documents */
async function getDocuments(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    res.json(await buildDocuments(fiche.id));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/logistiques/:id/documents — multipart : champs texte
 * <type>_expiration, fichiers carte_grise_recto, carte_grise_verso,
 * visite_technique, assurance, vignette. Une ligne par type (upsert) ;
 * un nouveau fichier remplace (et supprime) l'ancien. ld_numero reste vide
 * pour les réglementaires (il ne sert qu'à la description des documents
 * libres).
 */
async function updateDocuments(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });

    const files = req.files || {};
    const expirations = {};
    for (const d of REGLEMENTAIRES) {
      const parsed = parseDay(req.body?.[`${d.code}_expiration`]);
      if (parsed === undefined) {
        return res.status(400).json({ message: `Date « valable jusqu'à » invalide (${d.label}).` });
      }
      expirations[d.code] = parsed;
    }

    const existants = await listDocRows(fiche.id, REGLEMENTAIRES.map((d) => d.code));
    for (const d of REGLEMENTAIRES) {
      const row = existants.find((r) => r.type === d.code);
      const upload1 = files[d.code === 'carte_grise' ? 'carte_grise_recto' : d.code]?.[0];
      const upload2 = d.code === 'carte_grise' ? files.carte_grise_verso?.[0] : null;

      let fichier = row?.fichier || '';
      if (upload1) {
        deleteUploadedFile(fichier);
        fichier = `/uploads/logistiques/${upload1.filename}`;
      }
      let fichier2 = row?.fichier2 || '';
      if (upload2) {
        deleteUploadedFile(fichier2);
        fichier2 = `/uploads/logistiques/${upload2.filename}`;
      }

      if (row) {
        await pool.query(
          `UPDATE delevery_logistique_document
              SET ld_numero = '', ld_date_expiration = ?, ld_fichier = ?, ld_fichier2 = ?
            WHERE ld_id = ?`,
          [expirations[d.code], fichier, fichier2, row.id]
        );
      } else if (expirations[d.code] || fichier || fichier2) {
        await pool.query(
          `INSERT INTO delevery_logistique_document
             (ld_moyen, ld_type, ld_numero, ld_date_expiration, ld_fichier, ld_fichier2, ld_created_at)
           VALUES (?, ?, '', ?, ?, ?, NOW())`,
          [fiche.id, d.code, expirations[d.code], fichier, fichier2]
        );
      }
    }
    res.json(await buildDocuments(fiche.id));
  } catch (err) {
    next(err);
  }
}

/** Ajout de documents libres (une ligne par fichier) : kind = 'autre'
 * (onglet Documents) ou 'financement' (onglet Financement). */
function addDocsLibres(kind, buildResponse) {
  return async (req, res, next) => {
    try {
      const fiche = await loadMoyen(req.params.id);
      if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
      const description = String(req.body?.description || '').trim();
      if (description.length > 100) {
        return res.status(400).json({ message: 'Description trop longue (100 caractères max).' });
      }
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ message: 'Veuillez sélectionner au moins un fichier.' });
      }
      for (const file of files) {
        await pool.query(
          `INSERT INTO delevery_logistique_document
             (ld_moyen, ld_type, ld_numero, ld_fichier, ld_created_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [fiche.id, kind, description, `/uploads/logistiques/${file.filename}`]
        );
      }
      res.status(201).json(await buildResponse(fiche.id));
    } catch (err) {
      next(err);
    }
  };
}

/** Suppression d'un document libre (ligne + fichier). */
function deleteDocLibre(kind, buildResponse) {
  return async (req, res, next) => {
    try {
      const fiche = await loadMoyen(req.params.id);
      if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
      const [[row]] = await pool.query(
        `SELECT ld_id AS id, ld_fichier AS fichier, ld_fichier2 AS fichier2
           FROM delevery_logistique_document
          WHERE ld_id = ? AND ld_moyen = ? AND ld_type = ? LIMIT 1`,
        [Number(req.params.docId) || 0, fiche.id, kind]
      );
      if (!row) return res.status(404).json({ message: 'Document introuvable.' });
      deleteUploadedFile(row.fichier);
      deleteUploadedFile(row.fichier2);
      await pool.query(`DELETE FROM delevery_logistique_document WHERE ld_id = ?`, [row.id]);
      res.json(await buildResponse(fiche.id));
    } catch (err) {
      next(err);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Onglet Financement : achat / crédit + documents.                   */
/* ------------------------------------------------------------------ */

/** Données de l'onglet Financement : ligne financement + documents. */
async function buildFinancement(moyenId) {
  const [[row]] = await pool.query(
    `SELECT lf_prix_achat, lf_methode, lf_apport, lf_mensualite, lf_nb_mensualites,
            DATE_FORMAT(lf_premiere_mensualite, '%Y-%m-%d') AS premiere_mensualite
       FROM delevery_logistique_financement
      WHERE lf_moyen = ? LIMIT 1`,
    [moyenId]
  );
  const toNum = (v) => (v == null ? null : Number(v));
  return {
    financement: row
      ? {
          prix_achat: toNum(row.lf_prix_achat),
          methode: row.lf_methode || '',
          apport: toNum(row.lf_apport),
          mensualite: toNum(row.lf_mensualite),
          nb_mensualites: toNum(row.lf_nb_mensualites),
          premiere_mensualite: row.premiere_mensualite || ''
        }
      : null,
    documents: await listDocRows(moyenId, ['financement'])
  };
}

/** GET /api/logistiques/:id/financement */
async function getFinancement(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    res.json(await buildFinancement(fiche.id));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/logistiques/:id/financement — { prixAchat, methode, apport,
 * mensualite, nbMensualites, premiereMensualite }. Détail du crédit conservé
 * seulement pour les méthodes crédit / leasing (les totaux et la fin de
 * crédit se calculent à l'affichage).
 */
async function updateFinancement(req, res, next) {
  try {
    const fiche = await loadMoyen(req.params.id);
    if (!fiche) return res.status(404).json({ message: 'Moyen logistique introuvable.' });

    const methode = String(req.body?.methode || '').trim();
    if (methode && !METHODES_FINANCEMENT.some((m) => m.code === methode)) {
      return res.status(400).json({ message: "Méthode d'achat invalide." });
    }
    const prixAchat = parseMontant(req.body?.prixAchat);
    if (prixAchat === undefined) {
      return res.status(400).json({ message: "Prix d'achat invalide (DH, 2 décimales max)." });
    }

    // Détail du crédit : ignoré (NULL) pour « comptant » ou sans méthode.
    const aCredit = methode === 'credit' || methode === 'leasing';
    let apport = null;
    let mensualite = null;
    let nbMensualites = null;
    let premiereMensualite = null;
    if (aCredit) {
      apport = parseMontant(req.body?.apport);
      mensualite = parseMontant(req.body?.mensualite);
      if (apport === undefined || mensualite === undefined) {
        return res.status(400).json({ message: 'Montant du crédit invalide (DH, 2 décimales max).' });
      }
      const nbRaw = String(req.body?.nbMensualites ?? '').trim();
      if (nbRaw) {
        const nb = Number(nbRaw);
        if (!Number.isInteger(nb) || nb <= 0 || nb > 600) {
          return res.status(400).json({ message: 'Nombre de mensualités invalide (entier 1 à 600).' });
        }
        nbMensualites = nb;
      }
      premiereMensualite = parseDay(req.body?.premiereMensualite);
      if (premiereMensualite === undefined) {
        return res.status(400).json({ message: 'Date de 1ère mensualité invalide.' });
      }
    }

    await pool.query(
      `INSERT INTO delevery_logistique_financement
         (lf_moyen, lf_prix_achat, lf_methode, lf_apport, lf_mensualite,
          lf_nb_mensualites, lf_premiere_mensualite, lf_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         lf_prix_achat = VALUES(lf_prix_achat), lf_methode = VALUES(lf_methode),
         lf_apport = VALUES(lf_apport), lf_mensualite = VALUES(lf_mensualite),
         lf_nb_mensualites = VALUES(lf_nb_mensualites),
         lf_premiere_mensualite = VALUES(lf_premiere_mensualite),
         lf_updated_at = NOW()`,
      [fiche.id, prixAchat, methode, apport, mensualite, nbMensualites, premiereMensualite]
    );
    res.json(await buildFinancement(fiche.id));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listFiltres,
  listMoyens,
  createMoyen,
  getMoyen,
  updateMoyen,
  deleteMoyen,
  getMaintenanceMoyen,
  createVidange,
  deleteVidange,
  createEntretien,
  deleteEntretien,
  createConsommation,
  deleteConsommation,
  getDocuments,
  updateDocuments,
  addAutreDocument: addDocsLibres('autre', buildDocuments),
  deleteAutreDocument: deleteDocLibre('autre', buildDocuments),
  getFinancement,
  updateFinancement,
  addFinancementDocument: addDocsLibres('financement', buildFinancement),
  deleteFinancementDocument: deleteDocLibre('financement', buildFinancement),
  ensureUploadDir
};
