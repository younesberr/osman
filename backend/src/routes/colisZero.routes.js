const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listMagasins,
  listColisMagasin,
  listColisEnCoursMagasin,
  marquerPaye,
  marquerAvise
} = require('../controllers/colisZero.controller');

// Colis montant zéro (page admin Colis montant zéro) : service COLIS_ZERO.
router.use(requireAuth, requireService('COLIS_ZERO'));

router.get('/magasins', listMagasins);
router.get('/magasins/:id/colis', listColisMagasin);
router.get('/magasins/:id/colis-en-cours', listColisEnCoursMagasin);
router.post('/:id/paye', marquerPaye);
router.post('/:id/avise', marquerAvise);

module.exports = router;
