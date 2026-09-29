const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const { LIVREUR_TYPE } = require('../controllers/auth.controller');
const {
  listFiltres,
  listPayables,
  listFactures,
  listFacturesLivreur,
  getFactureLivreur,
  createFacture,
  getFacture,
  listAvailable,
  addParcels,
  updateLigne,
  removeParcel,
  attachFraisFacture,
  detachFraisFacture,
  setStatut,
  generateFactures,
  deleteFacture,
  uploadPreuve,
  ensureUploadDir
} = require('../controllers/facturesLivreurs.controller');

// Dashboard livreur (page /livreur/bon-paiement) : un livreur ne voit que ses
// propres factures finalisées (Enregistré / Payé), en lecture seule.
// Déclarées avant le middleware FACTURATION (réservé aux employés du back-office).
router.get('/livreur', requireAuth, requireRole(LIVREUR_TYPE), listFacturesLivreur);
router.get('/livreur/:id', requireAuth, requireRole(LIVREUR_TYPE), getFactureLivreur);

// Factures livreurs (delevery_payment_note type 1) : service FACTURATION.
router.use(requireAuth, requireService('FACTURATION'));

/* Preuve de paiement : photo (jpg / png / webp) ou PDF, 10 Mo max. */
const PREUVE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `facture-${req.params.id}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!PREUVE_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (photo JPG / PNG / WEBP ou PDF attendu).'));
    }
    cb(null, true);
  }
});

/* Erreurs multer (taille, format) → message lisible côté client. */
function handlePreuveUpload(req, res, next) {
  upload.single('preuve')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 10 Mo).' : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

router.get('/filtres', listFiltres);
router.get('/payables', listPayables);
router.post('/generate', generateFactures);
router.get('/', listFactures);
router.post('/', createFacture);
router.get('/:id', getFacture);
router.delete('/:id', deleteFacture);
router.get('/:id/available', listAvailable);
router.post('/:id/parcels', addParcels);
router.patch('/:id/parcels/:parcelId', updateLigne);
router.delete('/:id/parcels/:parcelId', removeParcel);
router.post('/:id/frais/:fraisId', attachFraisFacture);
router.delete('/:id/frais/:fraisId', detachFraisFacture);
router.patch('/:id/statut', setStatut);
router.post('/:id/preuve', handlePreuveUpload, uploadPreuve);

module.exports = router;
