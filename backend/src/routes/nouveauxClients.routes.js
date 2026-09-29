const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listDemandes,
  listVilles,
  accepterDemande,
  refuserDemande
} = require('../controllers/nouveauxClients.controller');

// Demandes de création de compte client (page admin Nouveaux clients) :
// service NOUVEAUX_CLIENTS (types 1 et 2 uniquement — pas de scope agence).
router.use(requireAuth, requireService('NOUVEAUX_CLIENTS'));

router.get('/', listDemandes);
router.get('/villes', listVilles);
router.post('/:id/accepter', accepterDemande);
router.post('/:id/refuser', refuserDemande);

module.exports = router;
