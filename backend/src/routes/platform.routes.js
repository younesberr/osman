const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService } = require('../middleware/auth');
const {
  getConfig,
  updateConfig,
  getSociete,
  updateSociete,
  uploadBranding,
  ensureUploadDir,
  getContrats,
  uploadContrat,
  ensureContratsDir,
  CONTRAT_VERSIONS
} = require('../controllers/platform.controller');

const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.kind}-${Date.now()}${ext}`);
  }
});

/* Taille max par type de fichier (le papier à en-tête des PDF est fixe, non chargeable). */
const MAX_MO = { logo: 2, icon: 2 };

function makeUpload(maxMo) {
  return multer({
    storage,
    limits: { fileSize: maxMo * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.includes(ext)) {
        return cb(new Error('Format non autorisé (png, jpg, svg, webp, ico).'));
      }
      cb(null, true);
    }
  });
}

const uploads = Object.fromEntries(Object.entries(MAX_MO).map(([kind, mo]) => [kind, makeUpload(mo)]));

// Gestion propre des erreurs multer (taille, format) : message lisible côté client.
// Le type est contrôlé AVANT multer : aucun fichier écrit pour un type inconnu (ex. ancien « entete »).
function handleUpload(req, res, next) {
  const upload = uploads[req.params.kind];
  if (!upload) {
    return res.status(400).json({ message: 'Type de fichier inconnu.' });
  }
  const maxMo = MAX_MO[req.params.kind];
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop volumineux (max ${maxMo} Mo).` : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

/* Contrats de prestation (page publique /contrat) : un PDF par version
   (particulier_fr, particulier_ar, societe_fr, societe_ar), 10 Mo max. */
const CONTRAT_MAX_MO = 10;

const contratStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureContratsDir()),
  filename: (req, file, cb) => cb(null, `contrat-${req.params.version.replace('_', '-')}-${Date.now()}.pdf`)
});

const contratUpload = multer({
  storage: contratStorage,
  limits: { fileSize: CONTRAT_MAX_MO * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('Format non autorisé (PDF attendu).'));
    }
    cb(null, true);
  }
});

// La version est contrôlée AVANT multer : aucun fichier écrit pour une version inconnue.
function handleContratUpload(req, res, next) {
  if (!CONTRAT_VERSIONS[req.params.version]) {
    return res.status(400).json({ message: 'Version de contrat inconnue.' });
  }
  contratUpload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop volumineux (max ${CONTRAT_MAX_MO} Mo).` : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

router.get('/config', getConfig);
router.put('/config', requireAuth, requireService('CONFIGURATION'), updateConfig);
// Lecture ouverte à tout utilisateur connecté : l'information société alimente
// l'en-tête / pied de page des documents imprimés (ex. PDF des bons d'envoi).
router.get('/societe', requireAuth, getSociete);
router.put('/societe', requireAuth, requireService('CONFIGURATION'), updateSociete);
router.post('/upload/:kind', requireAuth, requireService('CONFIGURATION'), handleUpload, uploadBranding);
// Contrats de prestation : lecture publique (page /contrat), envoi réservé au service CONFIGURATION.
router.get('/contrats', getContrats);
router.post('/contrats/:version', requireAuth, requireService('CONFIGURATION'), handleContratUpload, uploadContrat);

module.exports = router;
