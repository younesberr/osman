const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listFiltres,
  listReclamations,
  lancerReclamation,
  traiterReclamation
} = require('../controllers/reclamations.controller');

// Réclamations à suivre (delevery_reclamation_suivre) : service RECLAMATIONS.
router.use(requireAuth, requireService('RECLAMATIONS'));

router.get('/filtres', listFiltres);
router.get('/', listReclamations);
router.post('/:id/lancer', lancerReclamation);
router.post('/:id/traiter', traiterReclamation);

module.exports = router;
