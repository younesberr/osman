const router = require('express').Router();
const { requireAuth, requireService, requireKind, requireRole } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const {
  listClients,
  listBons,
  listBonsClient,
  getBonClient,
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
  listRamasseursRetour,
  scanExpedition,
  affecterBon,
  scanVerification,
  verifierBon,
  listBonsRamasseur,
  retournerBon
} = require('../controllers/bonsRetourClient.controller');

// Dashboard client (page /client/bon-de-retour) : un client ne voit que ses
// propres bons de retour, en lecture seule. Déclarées avant le middleware
// RETOUR (réservé aux employés).
router.get('/client', requireAuth, requireKind('customer'), requireClientPermission('BON_RETOUR'), listBonsClient);
router.get('/client/:id', requireAuth, requireKind('customer'), requireClientPermission('BON_RETOUR'), getBonClient);

// Ramasseur (type 6, onglet « À retourner » de /admin/ramassage) : il n'a
// jamais le service RETOUR — accès limité à ses bons affectés, contrôlé dans
// le contrôleur (404 hors périmètre, pattern demandes de ramassage).
router.get('/ramasseur', requireAuth, requireKind('employee'), requireRole(6), listBonsRamasseur);
router.patch('/:id/retourner', requireAuth, requireKind('employee'), requireRole(6), retournerBon);

// Bons de retour client (delevery_return_note_client) : accès réservé au service RETOUR.
router.use(requireAuth, requireService('RETOUR'));

router.get('/clients', listClients);
router.get('/ramasseurs', listRamasseursRetour);
router.get('/sons', getSons);
router.post('/expedition/scan', requireRole(1, 2, 3, 4), scanExpedition);
router.post('/verification/scan', requireRole(1, 2, 3, 4), scanVerification);
router.get('/', listBons);
router.post('/', createBon);
router.get('/:id', getBon);
router.delete('/:id', deleteBon);
router.get('/:id/available', listAvailable);
router.post('/:id/parcels', addParcels);
router.post('/:id/scan', scanParcel);
router.post('/:id/scan-retrait', removeScanParcel);
router.post('/:id/scan-reception', scanReception);
router.patch('/:id/receive', setReceived);
router.patch('/:id/affecter', requireRole(1, 2, 3, 4), affecterBon);
router.patch('/:id/verifier', requireRole(1, 2, 3, 4), verifierBon);

module.exports = router;
