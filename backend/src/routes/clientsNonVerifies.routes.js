const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listClientsNonVerifies,
  listFiltres,
  verifierClient
} = require('../controllers/clientsNonVerifies.controller');

// Clients non vérifiés ayant saisi au moins un colis (page admin Clients non
// vérifiés) : service CLIENTS_NON_VERIFIES, scope agence pour les types 3/4/6.
router.use(requireAuth, requireService('CLIENTS_NON_VERIFIES'));

router.get('/', listClientsNonVerifies);
router.get('/filtres', listFiltres);
router.patch('/:id/verifier', verifierClient);

module.exports = router;
