const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listFiltres,
  getStats,
  listColis,
  scanColis,
  createColis,
  updateColis,
  deleteColis
} = require('../controllers/transport.controller');
const {
  listSocietesFacturables,
  listFactures,
  createFacture,
  getFacture,
  addColis,
  addTousColis,
  removeColis,
  setStatut,
  deleteFacture
} = require('../controllers/transportFactures.controller');
const {
  getConfiguration,
  createSociete,
  updateSociete,
  toggleSociete,
  setTarifStandard,
  listTarifs,
  createTarif,
  updateTarif,
  deleteTarif,
  createTrajet,
  updateTrajet,
  deleteTrajet
} = require('../controllers/transportConfig.controller');
const {
  listTrajetsBons,
  listBons,
  getBon,
  listDisponibles,
  addColis: addColisBon,
  scanAjout,
  scanRetrait,
  removeColis: removeColisBon,
  deleteBon
} = require('../controllers/transportBons.controller');

// Module Transport (delevery_transport_*) : service TRANSPORT. Envoi/Retour
// et bons de transport ouverts à tous les détenteurs du service ;
// l'édition/suppression des colis scannés, la facturation, la configuration
// et la suppression d'un bon vide restent réservées aux types 1/2.
router.use(requireAuth, requireService('TRANSPORT'));

const admins = requireRole(1, 2);

// Référentiel commun (selects) + tuiles.
router.get('/filtres', listFiltres);
router.get('/stats', getStats);

// Bons de transport (tous les détenteurs du service) — déclarés avant /:direction.
router.get('/bons/trajets', listTrajetsBons);
router.get('/bons', listBons);
router.get('/bons/:id', getBon);
router.get('/bons/:id/disponibles', listDisponibles);
router.post('/bons/:id/colis', addColisBon);
router.post('/bons/:id/scan', scanAjout);
router.post('/bons/:id/scan-retrait', scanRetrait);
router.delete('/bons/:id/colis/:type/:colisId', removeColisBon);
router.delete('/bons/:id', admins, deleteBon);

// Facturation (types 1/2) — déclarée avant /:direction.
router.get('/factures/societes', admins, listSocietesFacturables);
router.get('/factures', admins, listFactures);
router.post('/factures', admins, createFacture);
router.get('/factures/:id', admins, getFacture);
router.post('/factures/:id/colis/tout', admins, addTousColis);
router.post('/factures/:id/colis', admins, addColis);
router.delete('/factures/:id/colis', admins, removeColis);
router.patch('/factures/:id/statut', admins, setStatut);
router.delete('/factures/:id', admins, deleteFacture);

// Configuration (types 1/2) — déclarée avant /:direction.
router.get('/configuration', admins, getConfiguration);
router.post('/configuration/societes', admins, createSociete);
router.patch('/configuration/societes/:id/statut', admins, toggleSociete);
router.patch('/configuration/societes/:id', admins, updateSociete);
router.patch('/configuration/tarif-standard', admins, setTarifStandard);
router.get('/configuration/tarifs', admins, listTarifs);
router.post('/configuration/tarifs', admins, createTarif);
router.patch('/configuration/tarifs/:id', admins, updateTarif);
router.delete('/configuration/tarifs/:id', admins, deleteTarif);
router.post('/configuration/trajets', admins, createTrajet);
router.patch('/configuration/trajets/:id', admins, updateTrajet);
router.delete('/configuration/trajets/:id', admins, deleteTrajet);

// Envois / retours (:direction = envois | retours).
router.get('/:direction', listColis);
router.post('/:direction/scan', scanColis);
router.post('/:direction', createColis);
router.patch('/:direction/:id', admins, updateColis);
router.delete('/:direction/:id', admins, deleteColis);

module.exports = router;
