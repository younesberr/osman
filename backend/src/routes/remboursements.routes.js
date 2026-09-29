const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const {
  listRemboursements,
  accepterRemboursement,
  refuserRemboursement
} = require('../controllers/remboursements.controller');

// Demandes de remboursement (page admin Remboursement) : service REMBOURSEMENT.
router.use(requireAuth, requireService('REMBOURSEMENT'));

router.get('/', listRemboursements);
router.post('/:id/accepter', accepterRemboursement);
router.post('/:id/refuser', refuserRemboursement);

module.exports = router;
