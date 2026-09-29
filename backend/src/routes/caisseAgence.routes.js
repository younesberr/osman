const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listFiltres,
  listEntrees,
  createEntree,
  validateEntree,
  validateEntrees,
  deleteEntree,
  listCaisses,
  listArrets,
  createArret,
  deleteArret
} = require('../controllers/caisseAgence.controller');

// Caisse Agence (delevery_spent, legacy) : service CAISSE_AGENCE
// (type 1 toujours, type 2 si coché, type 3 par défaut).
router.use(requireAuth, requireService('CAISSE_AGENCE'));

router.get('/filtres', listFiltres);
router.get('/', listEntrees);
router.post('/', createEntree);

// État des caisses et arrêts (table delevery_caisse_arret) : types 1 et 2 ;
// suppression du dernier arrêt d'une caisse : type 1.
router.get('/caisses', requireRole(1, 2), listCaisses);
router.get('/arrets', requireRole(1, 2), listArrets);
router.post('/arrets', requireRole(1, 2), createArret);
router.delete('/arrets/:id', requireRole(1), deleteArret);

// Validation (à l'unité ou en masse) : types 1 et 2 (comme le legacy).
router.patch('/valider', requireRole(1, 2), validateEntrees);
router.patch('/:id/valider', requireRole(1, 2), validateEntree);
// Suppression d'une entrée (hors arrêt) : super admin (type 1) uniquement.
router.delete('/:id', requireRole(1), deleteEntree);

module.exports = router;
