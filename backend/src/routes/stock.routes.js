const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService, requireKind, requireRole } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const {
  listInventaire,
  listMagasins,
  listPositions,
  listMouvements,
  listColisEnAttente,
  getColisEnAttenteProduits,
  getProduit,
  createProduit,
  updateProduit,
  setProduitStatut,
  createMouvement,
  validerAttente,
  listClientProduits,
  listClientMouvements,
  getClientProduit,
  createClientProduit,
  updateClientProduit,
  setClientProduitStatut,
  createClientMouvement,
  ensureProductUploadDir
} = require('../controllers/stock.controller');

const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureProductUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `produit-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (png, jpg, webp).'));
    }
    cb(null, true);
  }
});

// Gestion propre des erreurs multer (taille, format) : message lisible côté client.
function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Image trop volumineuse (max 2 Mo).' : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

// Routes du dashboard client : un client ne gère que ses propres produits.
// Les membres d'équipe n'accèdent qu'aux tâches attribuées (clientAccess).
router.get('/client/produits', requireAuth, requireKind('customer'), requireClientPermission('STOCK_PRODUITS'), listClientProduits);
router.get('/client/mouvements', requireAuth, requireKind('customer'), requireClientPermission('STOCK_MOUVEMENTS'), listClientMouvements);
router.post('/client/produits', requireAuth, requireKind('customer'), requireClientPermission('STOCK_PRODUITS'), handleUpload, createClientProduit);
router.get('/client/produits/:id', requireAuth, requireKind('customer'), requireClientPermission('STOCK_PRODUITS'), getClientProduit);
router.put('/client/produits/:id', requireAuth, requireKind('customer'), requireClientPermission('STOCK_PRODUITS'), handleUpload, updateClientProduit);
router.patch('/client/produits/:id/statut', requireAuth, requireKind('customer'), requireClientPermission('STOCK_PRODUITS'), setClientProduitStatut);
router.post('/client/produits/:id/mouvements', requireAuth, requireKind('customer'), requireClientPermission('STOCK_MOUVEMENTS'), createClientMouvement);

// Inventaire / Mouvement produits : fermés au ramasseur (type 6), qui n'a droit
// qu'aux colis en attente et bons de sortie. Miroir frontend : adminMenu.js (GESTION_STOCK_TYPES).
const gestionStock = requireRole(1, 2, 3, 4);

router.get('/inventaire', requireAuth, gestionStock, requireService('STOCK'), listInventaire);
router.get('/magasins', requireAuth, gestionStock, requireService('STOCK'), listMagasins);
router.get('/positions', requireAuth, gestionStock, requireService('STOCK'), listPositions);
router.get('/mouvements', requireAuth, gestionStock, requireService('STOCK'), listMouvements);
router.get('/colis-en-attente', requireAuth, requireService('STOCK'), listColisEnAttente);
router.get('/colis-en-attente/:id/produits', requireAuth, requireService('STOCK'), getColisEnAttenteProduits);
router.post('/produits', requireAuth, gestionStock, requireService('STOCK'), handleUpload, createProduit);
router.get('/produits/:id', requireAuth, gestionStock, requireService('STOCK'), getProduit);
router.put('/produits/:id', requireAuth, gestionStock, requireService('STOCK'), handleUpload, updateProduit);
router.patch('/produits/:id/statut', requireAuth, gestionStock, requireService('STOCK'), setProduitStatut);
router.post('/produits/:id/mouvements', requireAuth, gestionStock, requireService('STOCK'), createMouvement);
router.post('/produits/:id/valider-attente', requireAuth, gestionStock, requireService('STOCK'), validerAttente);

module.exports = router;
