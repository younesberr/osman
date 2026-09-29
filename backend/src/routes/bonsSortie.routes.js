const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listBons,
  createBon,
  listUsers,
  getBon,
  listAvailable,
  addParcels,
  removeParcel,
  affecterBon,
  traiterBon,
  deleteBon,
  listLabels
} = require('../controllers/bonsSortie.controller');

// Bons de sortie de stock (delevery_delivery_note_stock) : service STOCK.
router.use(requireAuth, requireService('STOCK'));

router.get('/users', listUsers);
router.get('/', listBons);
router.post('/', createBon);
router.get('/:id', getBon);
router.delete('/:id', deleteBon);
router.get('/:id/available', listAvailable);
router.get('/:id/labels', listLabels);
router.post('/:id/parcels', addParcels);
router.delete('/:id/parcels/:parcelId', removeParcel);
router.patch('/:id/affecter', affecterBon);
router.patch('/:id/traiter', traiterBon);

module.exports = router;
