const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService } = require('../middleware/auth');
const {
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
  addAutreDocument,
  deleteAutreDocument,
  getFinancement,
  updateFinancement,
  addFinancementDocument,
  deleteFinancementDocument,
  ensureUploadDir
} = require('../controllers/logistiques.controller');
const { listMaterielsMoyen } = require('../controllers/materiel.controller');

/* Fichiers des onglets Documents / Financement : PDF ou image, 10 Mo max,
 * stockés dans backend/uploads/logistiques (servis via /uploads). */
const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${req.params.id}-${file.fieldname}-${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (PDF ou image PNG / JPG / WEBP attendu).'));
    }
    cb(null, true);
  }
});

/* Erreurs multer (taille, format) → message lisible côté client. */
function withUploadErrors(middleware) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (err) {
        const message =
          err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 10 Mo).' : err.message;
        return res.status(400).json({ message });
      }
      next();
    });
}

/* Documents réglementaires : un fichier par champ (carte grise en 2 faces). */
const handleDocsUpload = withUploadErrors(
  upload.fields(
    ['carte_grise_recto', 'carte_grise_verso', 'visite_technique', 'assurance', 'vignette'].map(
      (name) => ({ name, maxCount: 1 })
    )
  )
);
/* Documents libres (autres / financement) : plusieurs fichiers d'un coup. */
const handleFichiersUpload = withUploadErrors(upload.array('fichiers', 10));

// Parc des moyens logistiques (tables delevery_logistique_*) : service LOGISTIQUES.
router.use(requireAuth, requireService('LOGISTIQUES'));

router.get('/filtres', listFiltres);
router.get('/', listMoyens);
router.post('/', createMoyen);
router.get('/:id', getMoyen);
router.put('/:id', updateMoyen);
router.delete('/:id', deleteMoyen);

// Onglet Maintenance : vidanges, entretiens, consommation carburant.
router.get('/:id/maintenance', getMaintenanceMoyen);
router.post('/:id/vidanges', createVidange);
router.delete('/:id/vidanges/:itemId', deleteVidange);
router.post('/:id/entretiens', createEntretien);
router.delete('/:id/entretiens/:itemId', deleteEntretien);
router.post('/:id/consommations', createConsommation);
router.delete('/:id/consommations/:itemId', deleteConsommation);

// Onglet Documents : réglementaires (upsert multipart) + autres documents.
router.get('/:id/documents', getDocuments);
router.put('/:id/documents', handleDocsUpload, updateDocuments);
router.post('/:id/documents/autres', handleFichiersUpload, addAutreDocument);
router.delete('/:id/documents/autres/:docId', deleteAutreDocument);

// Onglet Matériels : consommations de matériel auto sur ce véhicule.
router.get('/:id/materiels', listMaterielsMoyen);

// Onglet Financement : achat / crédit + documents du financement.
router.get('/:id/financement', getFinancement);
router.put('/:id/financement', updateFinancement);
router.post('/:id/financement/documents', handleFichiersUpload, addFinancementDocument);
router.delete('/:id/financement/documents/:docId', deleteFinancementDocument);

module.exports = router;
