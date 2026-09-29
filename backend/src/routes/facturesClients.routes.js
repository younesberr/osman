const router = require('express').Router();
const { requireAuth, requireService, requireKind } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const {
  listFiltres,
  listPayables,
  listFactures,
  listFacturesClient,
  getFactureClient,
  createFacture,
  getFacture,
  listAvailable,
  addParcels,
  updateLigne,
  updateFraisSupp,
  removeParcel,
  attachFraisFacture,
  detachFraisFacture,
  setStatut,
  generateFactures,
  deleteFacture
} = require('../controllers/facturesClients.controller');

// Dashboard client (page /client/factures) : un client ne voit que ses
// propres factures finalisées (Enregistré / Payé), en lecture seule.
// Déclarées avant le middleware FACTURATION (réservé aux employés).
router.get('/client', requireAuth, requireKind('customer'), requireClientPermission('FACTURES'), listFacturesClient);
router.get('/client/:id', requireAuth, requireKind('customer'), requireClientPermission('FACTURES'), getFactureClient);

// Factures clients (delevery_invoice legacy) : service FACTURATION.
router.use(requireAuth, requireService('FACTURATION'));

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
router.patch('/:id/parcels/:parcelId/frais-supp', updateFraisSupp);
router.delete('/:id/parcels/:parcelId', removeParcel);
router.post('/:id/frais/:fraisId', attachFraisFacture);
router.delete('/:id/frais/:fraisId', detachFraisFacture);
router.patch('/:id/statut', setStatut);

module.exports = router;
