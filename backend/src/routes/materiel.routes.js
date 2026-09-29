const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listFiltres,
  listMateriels,
  createMateriel,
  updateMateriel,
  setMaterielStatut,
  deleteMateriel,
  createMouvement,
  listStockAgences,
  listMouvements,
  listAffectations,
  createAffectation,
  createRecuperation
} = require('../controllers/materiel.controller');

// Matériel de la société (tables delevery_materiel*) : service MATERIEL,
// fonctions 1 et 2 uniquement (pas de scope agence — vue globale du siège).
router.use(requireAuth, requireService('MATERIEL'), requireRole(1, 2));

// Chemins statiques avant les paramétrés (/:id).
router.get('/filtres', listFiltres);
router.get('/mouvements', listMouvements);
router.get('/affectations', listAffectations);
router.post('/affectations', createAffectation);
router.post('/affectations/:id/recuperation', createRecuperation);

router.get('/', listMateriels);
router.post('/', createMateriel);
router.put('/:id', updateMateriel);
router.patch('/:id/statut', setMaterielStatut);
router.delete('/:id', deleteMateriel);
router.post('/:id/mouvements', createMouvement);
router.get('/:id/agences', listStockAgences);

module.exports = router;
