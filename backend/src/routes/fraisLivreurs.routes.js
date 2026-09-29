const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listFiltres,
  listFrais,
  createFrais,
  updateFrais,
  deleteFrais
} = require('../controllers/fraisLivreurs.controller');

// Frais supplémentaires livreurs (delevery_livreur_frais) : service FACTURATION.
router.use(requireAuth, requireService('FACTURATION'));

router.get('/filtres', listFiltres);
router.get('/', listFrais);
router.post('/', createFrais);
router.patch('/:id', updateFrais);
router.delete('/:id', deleteFrais);

module.exports = router;
