const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listDemandes,
  accepterDemande,
  refuserDemande
} = require('../controllers/modificationsColis.controller');

// Demandes de modification de colis (page admin Modifications Colis) :
// service MODIFICATIONS_COLIS.
router.use(requireAuth, requireService('MODIFICATIONS_COLIS'));

router.get('/', listDemandes);
router.post('/:id/accepter', accepterDemande);
router.post('/:id/refuser', refuserDemande);

module.exports = router;
