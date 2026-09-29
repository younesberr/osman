const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listZones,
  listBons,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  setReceived,
  setClosed,
  deleteBon,
  getSons
} = require('../controllers/bonsEnvoi.controller');

// Bons d'envoi (delevery_sent_note) : accès réservé au service BON_ENVOI.
router.use(requireAuth, requireService('BON_ENVOI'));

router.get('/zones', listZones);
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
router.patch('/:id/receive', setReceived);
router.patch('/:id/close', setClosed);

module.exports = router;
