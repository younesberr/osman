const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const { statsStructure, statsPeriode } = require('../controllers/statistiquesAdmin.controller');
const { statsMateriels } = require('../controllers/statistiquesMateriel.controller');

// Statistiques admin (/admin/statistiques/*) : service STATISTIQUES.
router.use(requireAuth, requireService('STATISTIQUES'));

router.get('/globales/structure', statsStructure);
router.get('/globales/periode', statsPeriode);
router.get('/materiels', statsMateriels);

module.exports = router;
