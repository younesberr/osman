const pool = require('../config/db');
const { BRAND, cfgKey } = require('../config/brand');
const {
  CONFIG_VAR: SON_CONFIG_VAR,
  SON_TYPES,
  parseSonRow,
  listSons: listSonRows,
  deleteSonFile
} = require('../utils/scanSons');
const { invaliderStatutLabels } = require('../utils/statutLabels');

/*
 * Configuration > Options — gestion des statuts colis (delevery_parcel_statut).
 * Les nouveaux statuts créés depuis le dashboard sont de type 2 (statut colis).
 * Le libellé est porté par delevery_string (string_ref = parcel_statut_name,
 * lang 'fr'), comme dans le système legacy ; parcel_statut_name reçoit une clé
 * de langue lang_db_parcel_statut_<code>. parcel_statut_nom n'est conservé
 * qu'en miroir : l'API mobile de l'ancien système PHP le lit encore.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,49}$/;
const NEW_STATUT_TYPE = 2;
const STATUT_LANG = 'fr';

/** Crée ou met à jour la traduction française d'une clé de delevery_string.
 * Les clés en doublon (ex. lang_db_parcel_statut_err) sont toutes alignées. */
async function upsertStatutTraduction(ref, text) {
  const [result] = await pool.query(
    `UPDATE delevery_string SET string_text = ?
      WHERE string_ref = ? AND string_lang = ?`,
    [text, ref, STATUT_LANG]
  );
  if (result.affectedRows === 0) {
    await pool.query(
      `INSERT INTO delevery_string (string_ref, string_lang, string_text) VALUES (?, ?, ?)`,
      [ref, STATUT_LANG, text]
    );
  }
}

/** GET /api/config/statuts — tous les statuts, tous types confondus. */
async function listStatuts(req, res, next) {
  try {
    // Sous-requête groupée : certaines clés ont des lignes fr en doublon.
    const [rows] = await pool.query(
      `SELECT s.parcel_statut_id   AS id,
              s.parcel_statut_type AS type,
              s.parcel_statut_code AS code,
              COALESCE(st.string_text, s.parcel_statut_name) AS nom,
              s.parcel_statut_color AS color,
              s.parcel_statut_active AS active
         FROM delevery_parcel_statut s
         LEFT JOIN (SELECT string_ref, MIN(string_text) AS string_text
                      FROM delevery_string
                     WHERE string_lang = ?
                     GROUP BY string_ref) st
           ON st.string_ref COLLATE utf8mb4_unicode_ci = s.parcel_statut_name
        ORDER BY s.parcel_statut_type, s.parcel_statut_id`,
      [STATUT_LANG]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** POST /api/config/statuts — { code, nom, color } → nouveau statut type 2. */
async function createStatut(req, res, next) {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const nom = String(req.body.nom || '').trim();
    const color = String(req.body.color || '').trim();

    if (!CODE_RE.test(code)) {
      return res.status(400).json({
        message: 'Code invalide : lettres majuscules, chiffres et _ (2 à 50 caractères, commence par une lettre).'
      });
    }
    if (!nom) return res.status(400).json({ message: 'Le nom du statut est obligatoire.' });
    if (!HEX_RE.test(color)) {
      return res.status(400).json({ message: 'Couleur invalide (format attendu : #RRGGBB).' });
    }

    const [[dup]] = await pool.query(
      `SELECT parcel_statut_id FROM delevery_parcel_statut
        WHERE parcel_statut_code = ? AND parcel_statut_type = ? LIMIT 1`,
      [code, NEW_STATUT_TYPE]
    );
    if (dup) return res.status(409).json({ message: `Le code « ${code} » existe déjà.` });

    // Clé de langue à la convention legacy ; parcel_statut_nom en miroir.
    const name = `lang_db_parcel_statut_${code.toLowerCase()}`;
    const [result] = await pool.query(
      `INSERT INTO delevery_parcel_statut
         (parcel_statut_type, parcel_statut_code, parcel_statut_name,
          parcel_statut_nom, parcel_statut_color, parcel_statut_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [NEW_STATUT_TYPE, code, name, nom, color]
    );
    await upsertStatutTraduction(name, nom);
    invaliderStatutLabels();
    res.status(201).json({ id: result.insertId, type: NEW_STATUT_TYPE, code, nom, color, active: 1 });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/statuts/:id — { nom, color } (le code n'est pas modifiable). */
async function updateStatut(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const nom = String(req.body.nom || '').trim();
    const color = String(req.body.color || '').trim();
    if (!nom) return res.status(400).json({ message: 'Le nom du statut est obligatoire.' });
    if (!HEX_RE.test(color)) {
      return res.status(400).json({ message: 'Couleur invalide (format attendu : #RRGGBB).' });
    }

    const [[statut]] = await pool.query(
      `SELECT parcel_statut_name AS name FROM delevery_parcel_statut
        WHERE parcel_statut_id = ? LIMIT 1`,
      [id]
    );
    if (!statut) return res.status(404).json({ message: 'Statut introuvable.' });

    await pool.query(
      `UPDATE delevery_parcel_statut
          SET parcel_statut_nom = ?, parcel_statut_color = ?
        WHERE parcel_statut_id = ?`,
      [nom, color, id]
    );
    // Le libellé affiché vit dans delevery_string ; statuts partageant la même
    // clé (ex. DELIVERED type 2 et 3) : le libellé change pour les deux.
    if (statut.name) await upsertStatutTraduction(statut.name, nom);
    invaliderStatutLabels();
    res.json({ id, nom, color });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/statuts/:id/active — { active: 0|1 }. */
async function setStatutActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const active = Number(req.body.active) === 1 ? 1 : 0;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_parcel_statut SET parcel_statut_active = ? WHERE parcel_statut_id = ?`,
      [active, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Statut introuvable.' });
    }
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

/*
 * Listes de valeurs stockées dans delevery_configs (une ligne par valeur).
 * Seules les variables déclarées ici sont gérables via l'API : cela protège
 * les autres lignes de configuration (nom société, logo, etc.).
 */
const LISTE_VARS = {
  'formes-juridiques': 'ws_config_companies_type',
  banques: 'ws_config_banks_name',
  positions: 'ws_config_stock_positions'
};

/* Position de stock (rayonnage) : une lettre majuscule + un nombre de 1 à 99. */
const POSITION_RE = /^[A-Z][1-9][0-9]?$/;
const POSITION_MSG =
  "Position invalide : une lettre majuscule suivie d'un nombre de 1 à 99 (ex : A1, N7, X66).";

/** Normalise et valide une valeur de liste ; répond 400 et renvoie null si invalide. */
function listeVal(configsVar, rawVal, res) {
  let val = String(rawVal || '').trim();
  if (configsVar === LISTE_VARS.positions) {
    val = val.toUpperCase();
    if (!POSITION_RE.test(val)) {
      res.status(400).json({ message: POSITION_MSG });
      return null;
    }
    return val;
  }
  if (!val) {
    res.status(400).json({ message: 'La valeur est obligatoire.' });
    return null;
  }
  if (val.length > 255) {
    res.status(400).json({ message: 'Valeur trop longue (max 255 caractères).' });
    return null;
  }
  return val;
}

function listeVar(req, res) {
  const configsVar = LISTE_VARS[req.params.kind];
  if (!configsVar) {
    res.status(404).json({ message: 'Liste inconnue.' });
    return null;
  }
  return configsVar;
}

/** GET /api/config/listes/:kind — valeurs de la liste (banques ou formes juridiques). */
async function listListe(req, res, next) {
  try {
    const configsVar = listeVar(req, res);
    if (!configsVar) return;
    const [rows] = await pool.query(
      `SELECT configs_id AS id, configs_val AS val, configs_active AS active
         FROM delevery_configs
        WHERE configs_var = ?
        ORDER BY configs_val`,
      [configsVar]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** POST /api/config/listes/:kind — { val } → nouvelle valeur. */
async function createListeItem(req, res, next) {
  try {
    const configsVar = listeVar(req, res);
    if (!configsVar) return;
    const val = listeVal(configsVar, req.body.val, res);
    if (val === null) return;

    const [[dup]] = await pool.query(
      `SELECT configs_id FROM delevery_configs
        WHERE configs_var = ? AND LOWER(TRIM(configs_val)) = LOWER(?) LIMIT 1`,
      [configsVar, val]
    );
    if (dup) return res.status(409).json({ message: `« ${val} » existe déjà.` });

    const [result] = await pool.query(
      `INSERT INTO delevery_configs (configs_var, configs_val, configs_active) VALUES (?, ?, 1)`,
      [configsVar, val]
    );
    res.status(201).json({ id: result.insertId, val, active: 1 });
  } catch (err) {
    next(err);
  }
}

/** Charge une ligne de liste et vérifie qu'elle appartient à une variable gérée. */
async function findListeItem(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT configs_id AS id, configs_var, configs_val AS val
       FROM delevery_configs WHERE configs_id = ? LIMIT 1`,
    [id]
  );
  if (!row || !Object.values(LISTE_VARS).includes(row.configs_var)) return null;
  return row;
}

/** PUT /api/config/listes/items/:id — { val } (modifier). */
async function updateListeItem(req, res, next) {
  try {
    const id = Number(req.params.id);
    const item = await findListeItem(id);
    if (!item) return res.status(404).json({ message: 'Valeur introuvable.' });

    const val = listeVal(item.configs_var, req.body.val, res);
    if (val === null) return;

    const [[dup]] = await pool.query(
      `SELECT configs_id FROM delevery_configs
        WHERE configs_var = ? AND LOWER(TRIM(configs_val)) = LOWER(?) AND configs_id <> ? LIMIT 1`,
      [item.configs_var, val, id]
    );
    if (dup) return res.status(409).json({ message: `« ${val} » existe déjà.` });

    await pool.query(`UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?`, [val, id]);
    res.json({ id, val });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/listes/items/:id/active — { active: 0|1 }. */
async function setListeItemActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const item = await findListeItem(id);
    if (!item) return res.status(404).json({ message: 'Valeur introuvable.' });

    const active = Number(req.body.active) === 1 ? 1 : 0;
    await pool.query(`UPDATE delevery_configs SET configs_active = ? WHERE configs_id = ?`, [active, id]);
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

/*
 * Configuration > Gestion zones — zones de livraison (delevery_zone),
 * chaque zone étant rattachée à une agence (delevery_agences).
 */

/** GET /api/config/zones — toutes les zones avec le nom de leur agence. */
async function listZones(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT z.zone_id        AS id,
              z.zone_name      AS nom,
              z.zone_agence_id AS agenceId,
              a.agence_name    AS agence,
              z.zone_active    AS active
         FROM delevery_zone z
         LEFT JOIN delevery_agences a ON a.agence_id = z.zone_agence_id
        ORDER BY z.zone_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** Valide { nom, agenceId } d'une zone ; renvoie null et répond en cas d'erreur. */
async function zonePayload(req, res, excludeId = null) {
  const nom = String(req.body.nom || '').trim();
  const agenceId = Number(req.body.agenceId);
  if (!nom) {
    res.status(400).json({ message: 'Le nom de la zone est obligatoire.' });
    return null;
  }
  if (nom.length > 100) {
    res.status(400).json({ message: 'Nom trop long (max 100 caractères).' });
    return null;
  }
  if (!Number.isInteger(agenceId) || agenceId <= 0) {
    res.status(400).json({ message: 'Veuillez sélectionner une agence.' });
    return null;
  }
  const [[agence]] = await pool.query(
    `SELECT agence_id FROM delevery_agences WHERE agence_id = ? LIMIT 1`,
    [agenceId]
  );
  if (!agence) {
    res.status(400).json({ message: 'Agence introuvable.' });
    return null;
  }
  const [[dup]] = await pool.query(
    `SELECT zone_id FROM delevery_zone
      WHERE LOWER(TRIM(zone_name)) = LOWER(?) ${excludeId ? 'AND zone_id <> ?' : ''} LIMIT 1`,
    excludeId ? [nom, excludeId] : [nom]
  );
  if (dup) {
    res.status(409).json({ message: `La zone « ${nom} » existe déjà.` });
    return null;
  }
  return { nom, agenceId };
}

/** POST /api/config/zones — { nom, agenceId } → nouvelle zone active. */
async function createZone(req, res, next) {
  try {
    const payload = await zonePayload(req, res);
    if (!payload) return;
    const [result] = await pool.query(
      `INSERT INTO delevery_zone (zone_name, zone_agence_id, zone_active) VALUES (?, ?, 1)`,
      [payload.nom, payload.agenceId]
    );
    const [[row]] = await pool.query(
      `SELECT z.zone_id AS id, z.zone_name AS nom, z.zone_agence_id AS agenceId,
              a.agence_name AS agence, z.zone_active AS active
         FROM delevery_zone z
         LEFT JOIN delevery_agences a ON a.agence_id = z.zone_agence_id
        WHERE z.zone_id = ?`,
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/zones/:id — { nom, agenceId } (modifier). */
async function updateZone(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const payload = await zonePayload(req, res, id);
    if (!payload) return;
    const [result] = await pool.query(
      `UPDATE delevery_zone SET zone_name = ?, zone_agence_id = ? WHERE zone_id = ?`,
      [payload.nom, payload.agenceId, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Zone introuvable.' });
    }
    const [[agence]] = await pool.query(
      `SELECT agence_name AS nom FROM delevery_agences WHERE agence_id = ?`,
      [payload.agenceId]
    );
    res.json({ id, nom: payload.nom, agenceId: payload.agenceId, agence: agence ? agence.nom : null });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/zones/:id/active — { active: 0|1 }. */
async function setZoneActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const active = Number(req.body.active) === 1 ? 1 : 0;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Identifiant invalide.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_zone SET zone_active = ? WHERE zone_id = ?`,
      [active, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Zone introuvable.' });
    }
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

/*
 * Configuration > Options — sons du scanner, un par étape (ramassage / envoi /
 * distribution / retour, succès ou échec). Stockage : delevery_configs (une
 * ligne JSON par son, voir utils/scanSons). Uploader un son pour une étape
 * remplace celui déjà en place.
 */

/** GET /api/config/sons — tous les sons chargés, du plus récent au plus ancien. */
async function listSons(req, res, next) {
  try {
    res.json(await listSonRows());
  } catch (err) {
    next(err);
  }
}

/** Valide { type } d'un son ; répond 400 et renvoie null si invalide. */
function sonPayload(req, res) {
  const type = String(req.body.type || '').trim();
  if (!SON_TYPES.includes(type)) {
    res.status(400).json({ message: "Étape invalide : veuillez choisir l'étape du son." });
    return null;
  }
  return { type };
}

/** POST /api/config/sons — multipart { type, file } → son de l'étape (remplace l'existant). */
async function createSon(req, res, next) {
  try {
    const payload = sonPayload(req, res);
    if (!payload) return;
    if (!req.file) return res.status(400).json({ message: 'Aucun fichier audio reçu.' });

    // Un seul son par étape : les anciennes lignes du même type sont supprimées.
    const existing = (await listSonRows()).filter((s) => s.type === payload.type);

    const val = JSON.stringify({ type: payload.type, file: req.file.filename });
    const [result] = await pool.query(
      `INSERT INTO delevery_configs (configs_var, configs_val, configs_active) VALUES (?, ?, 1)`,
      [SON_CONFIG_VAR, val]
    );
    for (const old of existing) {
      await pool.query(`DELETE FROM delevery_configs WHERE configs_id = ?`, [old.id]);
      deleteSonFile(old.file);
    }
    const son = parseSonRow({ configs_id: result.insertId, configs_val: val });
    res.status(201).json(son);
  } catch (err) {
    next(err);
  }
}

/** Charge une ligne son et vérifie qu'elle appartient bien à la variable des sons. */
async function findSon(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT configs_id, configs_var, configs_val FROM delevery_configs WHERE configs_id = ? LIMIT 1`,
    [id]
  );
  if (!row || row.configs_var !== SON_CONFIG_VAR) return null;
  return parseSonRow(row);
}

/** PUT /api/config/sons/:id — multipart { type, file? } (file absent = type seul). */
async function updateSon(req, res, next) {
  try {
    const id = Number(req.params.id);
    const son = await findSon(id);
    if (!son) return res.status(404).json({ message: 'Son introuvable.' });

    const payload = sonPayload(req, res);
    if (!payload) return;

    const file = req.file ? req.file.filename : son.file;
    const val = JSON.stringify({ type: payload.type, file });
    await pool.query(`UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?`, [val, id]);

    // Supprime l'ancien fichier remplacé pour ne pas accumuler d'orphelins.
    if (req.file && son.file && son.file !== file) deleteSonFile(son.file);

    res.json(parseSonRow({ configs_id: id, configs_val: val }));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/config/sons/:id — supprime la ligne et le fichier audio. */
async function deleteSon(req, res, next) {
  try {
    const id = Number(req.params.id);
    const son = await findSon(id);
    if (!son) return res.status(404).json({ message: 'Son introuvable.' });

    await pool.query(`DELETE FROM delevery_configs WHERE configs_id = ?`, [id]);
    deleteSonFile(son.file);
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

/*
 * Configuration > Options — moyens logistiques : catalogue des marques de
 * véhicules et intervalles de maintenance par type de moyen (Moto, VL, PL).
 * Stockage : delevery_configs — une ligne JSON par marque
 * (var app_moyen_marque) et une ligne JSON d'intervalles par type
 * (var app_moyen_maintenance).
 */

const MARQUE_CONFIG_VAR = cfgKey('moyen_marque');
const MAINTENANCE_CONFIG_VAR = cfgKey('moyen_maintenance');

const MOYEN_TYPES = ['moto', 'vl', 'pl'];

/* Kilométrage par défaut entre deux entretiens, par pièce / entretien. */
const MAINTENANCE_DEFAUTS = {
  vidange: 10000,
  filtre_huile: 10000,
  filtre_carburant: 10000,
  filtre_air: 20000,
  adblue: 10000,
  anti_cristallisant: 20000,
  vidange_boite: 80000,
  chaine_tendeur: 80000,
  pneus_avant: 60000,
  pneus_arriere: 80000
};

function parseMarqueRow(row) {
  try {
    const data = JSON.parse(row.configs_val);
    if (!data || typeof data.marque !== 'string') return null;
    return { id: row.configs_id, marque: data.marque, type: data.type, active: row.configs_active };
  } catch {
    return null;
  }
}

async function listMarqueRows() {
  const [rows] = await pool.query(
    `SELECT configs_id, configs_val, configs_active
       FROM delevery_configs
      WHERE configs_var = ?`,
    [MARQUE_CONFIG_VAR]
  );
  return rows.map(parseMarqueRow).filter(Boolean);
}

/** Valide { marque, type } ; répond 400 et renvoie null si invalide. */
function marquePayload(req, res) {
  const marque = String(req.body.marque || '').trim();
  const type = String(req.body.type || '').trim();
  if (!marque) {
    res.status(400).json({ message: 'La marque est obligatoire.' });
    return null;
  }
  if (marque.length > 100) {
    res.status(400).json({ message: 'Marque trop longue (max 100 caractères).' });
    return null;
  }
  if (!MOYEN_TYPES.includes(type)) {
    res.status(400).json({ message: 'Type invalide : Moto, VL (permis B) ou PL (permis C).' });
    return null;
  }
  return { marque, type };
}

/** GET /api/config/moyens/marques — toutes les marques, triées par type puis nom. */
async function listMarques(req, res, next) {
  try {
    const marques = await listMarqueRows();
    marques.sort(
      (a, b) =>
        MOYEN_TYPES.indexOf(a.type) - MOYEN_TYPES.indexOf(b.type) ||
        a.marque.localeCompare(b.marque, 'fr', { sensitivity: 'base' })
    );
    res.json(marques);
  } catch (err) {
    next(err);
  }
}

/** POST /api/config/moyens/marques — { marque, type } → nouvelle marque active. */
async function createMarque(req, res, next) {
  try {
    const payload = marquePayload(req, res);
    if (!payload) return;

    const dup = (await listMarqueRows()).find(
      (m) => m.type === payload.type && m.marque.toLowerCase() === payload.marque.toLowerCase()
    );
    if (dup) {
      return res.status(409).json({ message: `« ${payload.marque} » existe déjà pour ce type.` });
    }

    const [result] = await pool.query(
      `INSERT INTO delevery_configs (configs_var, configs_val, configs_active) VALUES (?, ?, 1)`,
      [MARQUE_CONFIG_VAR, JSON.stringify({ marque: payload.marque, type: payload.type })]
    );
    res.status(201).json({ id: result.insertId, marque: payload.marque, type: payload.type, active: 1 });
  } catch (err) {
    next(err);
  }
}

/** Charge une ligne marque et vérifie qu'elle appartient bien à la variable des marques. */
async function findMarque(id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT configs_id, configs_var, configs_val, configs_active
       FROM delevery_configs WHERE configs_id = ? LIMIT 1`,
    [id]
  );
  if (!row || row.configs_var !== MARQUE_CONFIG_VAR) return null;
  return parseMarqueRow(row);
}

/** PUT /api/config/moyens/marques/:id — { marque, type } (modifier). */
async function updateMarque(req, res, next) {
  try {
    const id = Number(req.params.id);
    const marque = await findMarque(id);
    if (!marque) return res.status(404).json({ message: 'Marque introuvable.' });

    const payload = marquePayload(req, res);
    if (!payload) return;

    const dup = (await listMarqueRows()).find(
      (m) =>
        m.id !== id &&
        m.type === payload.type &&
        m.marque.toLowerCase() === payload.marque.toLowerCase()
    );
    if (dup) {
      return res.status(409).json({ message: `« ${payload.marque} » existe déjà pour ce type.` });
    }

    await pool.query(`UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?`, [
      JSON.stringify({ marque: payload.marque, type: payload.type }),
      id
    ]);
    res.json({ id, marque: payload.marque, type: payload.type });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/config/moyens/marques/:id/active — { active: 0|1 }. */
async function setMarqueActive(req, res, next) {
  try {
    const id = Number(req.params.id);
    const marque = await findMarque(id);
    if (!marque) return res.status(404).json({ message: 'Marque introuvable.' });

    const active = Number(req.body.active) === 1 ? 1 : 0;
    await pool.query(`UPDATE delevery_configs SET configs_active = ? WHERE configs_id = ?`, [active, id]);
    res.json({ id, active });
  } catch (err) {
    next(err);
  }
}

/** Intervalles de maintenance par type, défauts appliqués — réutilisé par la
 * fiche moyen logistique (estimation de la prochaine vidange). */
async function maintenanceIntervalles() {
  const [rows] = await pool.query(
    `SELECT configs_val FROM delevery_configs WHERE configs_var = ?`,
    [MAINTENANCE_CONFIG_VAR]
  );
  const result = {};
  for (const type of MOYEN_TYPES) result[type] = { ...MAINTENANCE_DEFAUTS };
  for (const row of rows) {
    try {
      const data = JSON.parse(row.configs_val);
      if (!MOYEN_TYPES.includes(data.type)) continue;
      for (const key of Object.keys(MAINTENANCE_DEFAUTS)) {
        const v = Number(data.intervalles?.[key]);
        if (Number.isInteger(v) && v > 0) result[data.type][key] = v;
      }
    } catch {
      /* ligne illisible : les défauts restent en place */
    }
  }
  return result;
}

/** GET /api/config/moyens/maintenance — intervalles par type, défauts appliqués. */
async function getMaintenance(req, res, next) {
  try {
    res.json(await maintenanceIntervalles());
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/moyens/maintenance/:type — { intervalles } (une ligne par type). */
async function saveMaintenance(req, res, next) {
  try {
    const type = String(req.params.type || '');
    if (!MOYEN_TYPES.includes(type)) {
      return res.status(404).json({ message: 'Type de moyen inconnu.' });
    }
    const raw = req.body.intervalles || {};
    const intervalles = {};
    for (const key of Object.keys(MAINTENANCE_DEFAUTS)) {
      const v = Number(raw[key]);
      if (!Number.isInteger(v) || v <= 0 || v > 1000000) {
        return res.status(400).json({
          message: 'Intervalle invalide : kilométrage entier entre 1 et 1 000 000 km pour chaque entretien.'
        });
      }
      intervalles[key] = v;
    }

    const val = JSON.stringify({ type, intervalles });
    const [rows] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs WHERE configs_var = ?`,
      [MAINTENANCE_CONFIG_VAR]
    );
    const existing = rows.find((row) => {
      try {
        return JSON.parse(row.configs_val).type === type;
      } catch {
        return false;
      }
    });
    if (existing) {
      await pool.query(`UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?`, [
        val,
        existing.configs_id
      ]);
    } else {
      await pool.query(
        `INSERT INTO delevery_configs (configs_var, configs_val, configs_active) VALUES (?, ?, 1)`,
        [MAINTENANCE_CONFIG_VAR, val]
      );
    }
    res.json({ type, intervalles });
  } catch (err) {
    next(err);
  }
}

/*
 * Configuration > Options — modèle du message WhatsApp que le livreur envoie
 * au destinataire depuis /livreur/colis (bouton « Message WhatsApp »).
 * Stockage : delevery_configs, une ligne (var app_message_livreur),
 * créée au premier enregistrement. Balises remplacées côté livreur par les
 * données du colis : {destinataire} {code} {magasin} {crbt} {adresse} {ville}.
 */

const MESSAGE_LIVREUR_CONFIG_VAR = cfgKey('message_livreur');
const MESSAGE_LIVREUR_DEFAUT =
  BRAND.messages.livreurDefaut;
const MESSAGE_LIVREUR_MAX = 1000;

/** Modèle courant (défaut si jamais enregistré) — réutilisé par l'API livreur. */
async function messageLivreurTemplate() {
  const [[row]] = await pool.query(
    `SELECT configs_val FROM delevery_configs
      WHERE configs_var = ?
      ORDER BY configs_id DESC LIMIT 1`,
    [MESSAGE_LIVREUR_CONFIG_VAR]
  );
  const template = row ? String(row.configs_val || '').trim() : '';
  return template || MESSAGE_LIVREUR_DEFAUT;
}

/** GET /api/config/message-livreur — modèle courant + défaut (bouton « Message par défaut »). */
async function getMessageLivreur(req, res, next) {
  try {
    res.json({ template: await messageLivreurTemplate(), defaut: MESSAGE_LIVREUR_DEFAUT });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/config/message-livreur — { template } (vide = retour au défaut). */
async function saveMessageLivreur(req, res, next) {
  try {
    const template = String(req.body.template || '').trim() || MESSAGE_LIVREUR_DEFAUT;
    if (template.length > MESSAGE_LIVREUR_MAX) {
      return res
        .status(400)
        .json({ message: `Message trop long (max ${MESSAGE_LIVREUR_MAX} caractères).` });
    }
    const [result] = await pool.query(
      `UPDATE delevery_configs SET configs_val = ?, configs_active = 1 WHERE configs_var = ?`,
      [template, MESSAGE_LIVREUR_CONFIG_VAR]
    );
    if (result.affectedRows === 0) {
      await pool.query(
        `INSERT INTO delevery_configs (configs_var, configs_val, configs_active) VALUES (?, ?, 1)`,
        [MESSAGE_LIVREUR_CONFIG_VAR, template]
      );
    }
    res.json({ template });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listStatuts,
  createStatut,
  updateStatut,
  setStatutActive,
  listSons,
  createSon,
  updateSon,
  deleteSon,
  listListe,
  createListeItem,
  updateListeItem,
  setListeItemActive,
  listZones,
  createZone,
  updateZone,
  setZoneActive,
  listMarques,
  createMarque,
  updateMarque,
  setMarqueActive,
  getMaintenance,
  saveMaintenance,
  getMessageLivreur,
  saveMessageLivreur,
  // Réutilisés par le contrôleur logistiques (parc des moyens).
  listMarqueRows,
  maintenanceIntervalles,
  MOYEN_TYPES,
  // Réutilisé par l'API livreur (message WhatsApp de /livreur/colis).
  messageLivreurTemplate
};
