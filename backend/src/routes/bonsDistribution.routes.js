const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listZones,
  listLivreurs,
  listBons,
  listBonsLivreur,
  getBonLivreur,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  setSaved,
  deleteBon,
  getSons
} = require('../controllers/bonsDistribution.controller');

// Dashboard livreur (page /livreur/bon-distribution) : un livreur (type 5) ne
// voit que ses propres bons, en lecture seule. Déclarées avant le middleware
// BON_DISTRIBUTION (réservé aux employés du service).
router.get('/livreur', requireAuth, requireRole(5), listBonsLivreur);
router.get('/livreur/:id', requireAuth, requireRole(5), getBonLivreur);

// Bons de distribution (delevery_distribution_note) : service BON_DISTRIBUTION.
router.use(requireAuth, requireService('BON_DISTRIBUTION'));

router.get('/zones', listZones);
router.get('/livreurs', listLivreurs);
router.get('/sons', getSons);
router.get('/', listBons);
router.post('/', createBon);
router.get('/:id', getBon);
router.delete('/:id', deleteBon);
router.get('/:id/available', listAvailable);
router.post('/:id/parcels', addParcels);
router.post('/:id/scan', scanParcel);
router.post('/:id/scan-retrait', removeScanParcel);
router.delete('/:id/parcels/:parcelId', removeParcel);
router.patch('/:id/save', setSaved);

module.exports = router;
