const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listFiltres,
  listFrais,
  createFrais,
  updateFrais,
  deleteFrais
} = require('../controllers/fraisClients.controller');

// Frais supplémentaires clients (delevery_client_frais) : service FACTURATION.
router.use(requireAuth, requireService('FACTURATION'));

router.get('/filtres', listFiltres);
router.get('/', listFrais);
router.post('/', createFrais);
router.patch('/:id', updateFrais);
router.delete('/:id', deleteFrais);

module.exports = router;
