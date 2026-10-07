const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const { statsStructure, statsPeriode } = require('../controllers/statistiquesAdmin.controller');

// Statistiques globales admin (/admin/statistiques/globales) : service STATISTIQUES.
router.use(requireAuth, requireService('STATISTIQUES'));

router.get('/globales/structure', statsStructure);
router.get('/globales/periode', statsPeriode);

module.exports = router;
