const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listLivreurs,
  listBons,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  scanReception,
  setReceived,
  deleteBon,
  getSons,
  listBonsLivreur,
  createBonLivreur,
  getBonLivreur,
  listAvailableLivreur,
  addParcelsLivreur,
  scanParcelLivreur,
  removeScanParcelLivreur,
  removeParcelLivreur,
  deleteBonLivreur
} = require('../controllers/bonsRetourLivreur.controller');

// Dashboard livreur (page /livreur/bon-retour) : un livreur (type 5) crée et
// modifie SES bons uniquement ; la réception (bon reçu / non reçu, scan de
// réception) reste réservée au service RETOUR. Déclarées avant le middleware.
router.get('/livreur/sons', requireAuth, requireRole(5), getSons);
router.get('/livreur', requireAuth, requireRole(5), listBonsLivreur);
router.post('/livreur', requireAuth, requireRole(5), createBonLivreur);
router.get('/livreur/:id', requireAuth, requireRole(5), getBonLivreur);
router.delete('/livreur/:id', requireAuth, requireRole(5), deleteBonLivreur);
router.get('/livreur/:id/available', requireAuth, requireRole(5), listAvailableLivreur);
router.post('/livreur/:id/parcels', requireAuth, requireRole(5), addParcelsLivreur);
router.post('/livreur/:id/scan', requireAuth, requireRole(5), scanParcelLivreur);
router.post('/livreur/:id/scan-retrait', requireAuth, requireRole(5), removeScanParcelLivreur);
router.delete('/livreur/:id/parcels/:parcelId', requireAuth, requireRole(5), removeParcelLivreur);

// Bons de retour livreur (delevery_return_note) : accès réservé au service RETOUR.
router.use(requireAuth, requireService('RETOUR'));

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
router.post('/:id/scan-reception', scanReception);
router.patch('/:id/receive', setReceived);

module.exports = router;
