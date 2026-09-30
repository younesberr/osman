const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { BRAND, cfgKey } = require('../config/brand');

/**
 * Paramètres de la plateforme (branding) stockés dans delevery_configs.
 * Clés préfixées « app_ » (cfgKey) : propres à cette application,
 * on ne touche jamais aux clés historiques (config_company_logo, etc.).
 */
const KEYS = {
  logo: cfgKey('platform_logo'),
  icon: cfgKey('platform_favicon'),
  colorPrimary: cfgKey('platform_color_primary'),
  colorSecondary: cfgKey('platform_color_secondary'),
  entete: cfgKey('company_entete')
};

const DEFAULTS = {
  logo: null,
  icon: null,
  colorPrimary: BRAND.colorPrimary,
  colorSecondary: BRAND.colorSecondary,
  entete: null
};

/* Information société : une ligne delevery_configs par champ (créée si absente). */
const SOCIETE_KEYS = {
  nom: cfgKey('company_name'),
  formeJuridique: cfgKey('company_forme_juridique'),
  siege: cfgKey('company_siege'),
  telFixe: cfgKey('company_tel_fixe'),
  telMobile: cfgKey('company_tel_mobile'),
  email: cfgKey('company_email'),
  website: cfgKey('company_website'),
  ice: cfgKey('company_ice'),
  rc: cfgKey('company_rc'),
  ifFiscal: cfgKey('company_if'),
  cnss: cfgKey('company_cnss')
};

const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'branding');
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/*
 * Version allégée de la page en-tête pour les PDF. L'originale peut être un
 * scan de plusieurs Mo (max 10 Mo) que chaque génération de PDF téléchargeait
 * et que html2canvas redécodait à chaque page. On en dérive un JPEG de
 * 1600 px de large (la page A4 est capturée à 1575 px : voir
 * frontend/src/utils/pdfCapture.js), soit quelques centaines de Ko, produit à
 * l'upload et, pour un fichier déjà en place (prod), à la première demande.
 * `sharp` est chargé paresseusement : s'il manque (binaire natif absent sur
 * l'hébergement), l'API renvoie null et le front se replie sur l'originale.
 */
const ENTETE_PDF_WIDTH = 1600;
const ENTETE_PDF_QUALITY = 82;
const enteteEnCours = new Map(); // fichier original → Promise<string|null>

function entetePdfName(filename) {
  return `${path.parse(filename).name}-pdf.jpg`;
}

/** Nom du fichier allégé (créé si besoin), ou null si indisponible. */
function ensureEntetePdf(filename) {
  if (!filename) return Promise.resolve(null);
  const target = entetePdfName(filename);
  const targetPath = path.join(UPLOAD_DIR, target);
  if (fs.existsSync(targetPath)) return Promise.resolve(target);
  if (enteteEnCours.has(filename)) return enteteEnCours.get(filename);

  const job = (async () => {
    let sharp;
    try {
      sharp = require('sharp');
    } catch (err) {
      console.warn('[platform] sharp indisponible, en-tête PDF non allégée :', err.message);
      return null;
    }
    // Écriture dans un .tmp puis renommage : jamais de fichier partiel servi.
    const tmp = `${targetPath}.tmp`;
    try {
      await sharp(path.join(UPLOAD_DIR, filename))
        .resize({ width: ENTETE_PDF_WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: ENTETE_PDF_QUALITY, mozjpeg: true })
        .toFile(tmp);
      await fs.promises.rename(tmp, targetPath);
      return target;
    } catch (err) {
      console.warn('[platform] en-tête PDF non générée :', err.message);
      fs.promises.unlink(tmp).catch(() => {});
      return null;
    } finally {
      enteteEnCours.delete(filename);
    }
  })();
  enteteEnCours.set(filename, job);
  return job;
}

async function readConfig() {
  const vars = Object.values(KEYS);
  const [rows] = await pool.query(
    'SELECT configs_var, configs_val FROM delevery_configs WHERE configs_var IN (?)',
    [vars]
  );
  const byVar = Object.fromEntries(rows.map((r) => [r.configs_var, r.configs_val]));
  const config = {};
  for (const [field, key] of Object.entries(KEYS)) {
    config[field] = byVar[key] || DEFAULTS[field];
  }
  return config;
}

/** Insère ou met à jour une clé de delevery_configs (la table n'a pas d'index unique sur configs_var). */
async function upsertConfig(key, value) {
  const [rows] = await pool.query(
    'SELECT configs_id FROM delevery_configs WHERE configs_var = ? ORDER BY configs_id LIMIT 1',
    [key]
  );
  if (rows.length) {
    await pool.query('UPDATE delevery_configs SET configs_val = ? WHERE configs_id = ?', [value, rows[0].configs_id]);
  } else {
    await pool.query('INSERT INTO delevery_configs (configs_var, configs_val) VALUES (?, ?)', [key, value]);
  }
}

function toPublicUrl(filename) {
  return filename ? `/uploads/branding/${filename}` : null;
}

/** GET /api/platform/config — public : branding nécessaire avant connexion (favicon, logo, couleurs). */
async function getConfig(req, res, next) {
  try {
    const config = await readConfig();
    res.json({
      logo: toPublicUrl(config.logo),
      icon: toPublicUrl(config.icon),
      colorPrimary: config.colorPrimary,
      colorSecondary: config.colorSecondary
    });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/platform/config — met à jour les couleurs de marque. */
async function updateConfig(req, res, next) {
  try {
    const { colorPrimary, colorSecondary } = req.body || {};
    if (!HEX_RE.test(colorPrimary || '') || !HEX_RE.test(colorSecondary || '')) {
      return res.status(400).json({ message: 'Couleurs invalides (format attendu : #rrggbb).' });
    }
    await upsertConfig(KEYS.colorPrimary, colorPrimary.toLowerCase());
    await upsertConfig(KEYS.colorSecondary, colorSecondary.toLowerCase());
    res.json({ message: 'Couleurs enregistrées.' });
  } catch (err) {
    next(err);
  }
}

/** GET /api/platform/societe — information société (coordonnées, identifiants légaux, en-tête). */
async function getSociete(req, res, next) {
  try {
    const vars = [...Object.values(SOCIETE_KEYS), KEYS.entete];
    const [rows] = await pool.query(
      'SELECT configs_var, configs_val FROM delevery_configs WHERE configs_var IN (?)',
      [vars]
    );
    const byVar = Object.fromEntries(rows.map((r) => [r.configs_var, r.configs_val]));
    const societe = {};
    for (const [field, key] of Object.entries(SOCIETE_KEYS)) {
      societe[field] = byVar[key] || '';
    }
    const enteteFile = byVar[KEYS.entete] || null;
    societe.entete = toPublicUrl(enteteFile);
    // Version allégée pour les PDF ; null si indisponible (le front se replie sur l'originale).
    societe.entetePdf = toPublicUrl(await ensureEntetePdf(enteteFile));
    res.json(societe);
  } catch (err) {
    next(err);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PUT /api/platform/societe — enregistre les champs texte (les lignes absentes sont créées). */
async function updateSociete(req, res, next) {
  try {
    const body = req.body || {};
    const values = {};
    for (const field of Object.keys(SOCIETE_KEYS)) {
      const val = String(body[field] ?? '').trim();
      if (val.length > 255) {
        return res.status(400).json({ message: `Valeur trop longue pour « ${field} » (max 255 caractères).` });
      }
      values[field] = val;
    }
    if (values.email && !EMAIL_RE.test(values.email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    for (const [field, key] of Object.entries(SOCIETE_KEYS)) {
      await upsertConfig(key, values[field]);
    }
    res.json({ message: 'Information société enregistrée.' });
  } catch (err) {
    next(err);
  }
}

/** POST /api/platform/upload/:kind (logo | icon | entete) — enregistre le fichier et lie la plateforme à celui-ci. */
async function uploadBranding(req, res, next) {
  try {
    const kind = req.params.kind;
    if (!KEYS[kind] || (kind !== 'logo' && kind !== 'icon' && kind !== 'entete')) {
      return res.status(400).json({ message: 'Type de fichier inconnu.' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Aucun fichier reçu.' });
    }

    const previous = (await readConfig())[kind];
    await upsertConfig(KEYS[kind], req.file.filename);
    // La version allégée pour les PDF est produite tout de suite (sinon à la première demande).
    if (kind === 'entete') await ensureEntetePdf(req.file.filename);

    // Supprime l'ancien fichier (et sa version allégée) pour ne pas accumuler d'orphelins.
    if (previous && previous !== req.file.filename) {
      fs.promises.unlink(path.join(UPLOAD_DIR, previous)).catch(() => {});
      if (kind === 'entete') {
        fs.promises.unlink(path.join(UPLOAD_DIR, entetePdfName(previous))).catch(() => {});
      }
    }

    res.json({ message: 'Fichier enregistré.', url: toPublicUrl(req.file.filename) });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------
 * Contrats de prestation de services (page publique /contrat) : quatre
 * versions PDF — particulier / société × français / arabe — chargées par
 * l'admin (Configuration › Plateforme). Une ligne delevery_configs par
 * version (nom du fichier) ; fichiers dans <uploads>/contrats/.
 * ------------------------------------------------------------------ */
const CONTRAT_VERSIONS = {
  particulier_fr: cfgKey('contrat_particulier_fr'),
  particulier_ar: cfgKey('contrat_particulier_ar'),
  societe_fr: cfgKey('contrat_societe_fr'),
  societe_ar: cfgKey('contrat_societe_ar')
};
const CONTRATS_DIR = path.join(UPLOADS_ROOT, 'contrats');

function ensureContratsDir() {
  fs.mkdirSync(CONTRATS_DIR, { recursive: true });
  return CONTRATS_DIR;
}

/** Nom de fichier enregistré pour chaque version (null = jamais chargée). */
async function readContratsFiles() {
  const [rows] = await pool.query(
    'SELECT configs_var, configs_val FROM delevery_configs WHERE configs_var IN (?)',
    [Object.values(CONTRAT_VERSIONS)]
  );
  const byVar = Object.fromEntries(rows.map((r) => [r.configs_var, r.configs_val]));
  const files = {};
  for (const [version, key] of Object.entries(CONTRAT_VERSIONS)) {
    files[version] = byVar[key] || null;
  }
  return files;
}

/**
 * Métadonnées publiques d'une version : null si aucun fichier n'est
 * enregistré OU si le fichier manque sur le disque (ex. UPLOADS_DIR non
 * défini en prod et uploads effacés par un déploiement) — la page publique
 * affiche alors « non disponible » plutôt qu'une visionneuse cassée.
 */
async function contratInfo(filename) {
  if (!filename) return null;
  try {
    const stat = await fs.promises.stat(path.join(CONTRATS_DIR, filename));
    return {
      url: `/uploads/contrats/${filename}`,
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } catch {
    return null;
  }
}

/** GET /api/platform/contrats — public : les quatre versions du contrat (null = non chargée). */
async function getContrats(req, res, next) {
  try {
    const files = await readContratsFiles();
    const result = {};
    for (const version of Object.keys(CONTRAT_VERSIONS)) {
      result[version] = await contratInfo(files[version]);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/* Le fichier est servi publiquement : on vérifie la signature « %PDF- » en
   plus de l'extension, pour refuser un fichier renommé en .pdf. */
const PDF_MAGIC = Buffer.from('%PDF-');

async function isPdfFile(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(PDF_MAGIC.length), 0, PDF_MAGIC.length, 0);
    return bytesRead === PDF_MAGIC.length && buffer.equals(PDF_MAGIC);
  } finally {
    await fh.close();
  }
}

/** POST /api/platform/contrats/:version — enregistre le PDF d'une version et remplace l'ancien. */
async function uploadContrat(req, res, next) {
  try {
    const { version } = req.params;
    if (!CONTRAT_VERSIONS[version]) {
      return res.status(400).json({ message: 'Version de contrat inconnue.' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Aucun fichier reçu.' });
    }
    if (!(await isPdfFile(req.file.path))) {
      fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ message: 'Le fichier reçu n’est pas un PDF valide.' });
    }

    const previous = (await readContratsFiles())[version];
    await upsertConfig(CONTRAT_VERSIONS[version], req.file.filename);

    // Supprime l'ancien fichier pour ne pas accumuler d'orphelins.
    if (previous && previous !== req.file.filename) {
      fs.promises.unlink(path.join(CONTRATS_DIR, previous)).catch(() => {});
    }

    res.json({ message: 'Contrat enregistré.', contrat: await contratInfo(req.file.filename) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getConfig,
  updateConfig,
  getSociete,
  updateSociete,
  uploadBranding,
  ensureUploadDir,
  UPLOAD_DIR,
  getContrats,
  uploadContrat,
  ensureContratsDir,
  CONTRAT_VERSIONS
};
