const router = require('express').Router();
const { requireAuth, requireService } = require('../middleware/auth');
const { listSocietes, verifierCodes } = require('../controllers/ticketsVides.controller');

// Tickets vides (générateurs d'étiquettes, aucune écriture) : service
// TICKETS_VIDES.
router.use(requireAuth, requireService('TICKETS_VIDES'));

router.get('/societes', listSocietes);
router.post('/verifier', verifierCodes);

module.exports = router;
