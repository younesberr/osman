const router = require('express').Router();
const { requireAuth, requireKind, requireRole, requireService } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const {
  listClientDemandes,
  getClientDemandeDefaults,
  createClientDemande,
  listDemandes,
  listClientsAdmin,
  createAdminDemande,
  listRamasseurs,
  affecterDemande,
  ramasserDemande,
  annulerDemande
} = require('../controllers/demandesRamassage.controller');

// Demandes de ramassage du dashboard client (tâche RAMASSAGE du menu client).
router.get('/client', requireAuth, requireKind('customer'), requireClientPermission('RAMASSAGE'), listClientDemandes);
router.get('/client/new', requireAuth, requireKind('customer'), requireClientPermission('RAMASSAGE'), getClientDemandeDefaults);
router.post('/client', requireAuth, requireKind('customer'), requireClientPermission('RAMASSAGE'), createClientDemande);

// Gestion admin / ramasseur (page /admin/ramassage, service RAMASSAGE) :
// l'affectation et la création manuelle d'une demande pour un client (ex.
// ramassage demandé par téléphone) sont réservées aux types 1-4, les clôtures
// « Ramasser » et « Annuler le ramassage » sont aussi ouvertes au ramasseur
// (type 6) pour ses propres demandes.
router.get('/', requireAuth, requireKind('employee'), requireService('RAMASSAGE'), listDemandes);
router.post('/', requireAuth, requireKind('employee'), requireRole(1, 2, 3, 4), requireService('RAMASSAGE'), createAdminDemande);
router.get('/clients', requireAuth, requireKind('employee'), requireRole(1, 2, 3, 4), requireService('RAMASSAGE'), listClientsAdmin);
router.get('/ramasseurs', requireAuth, requireKind('employee'), requireRole(1, 2, 3, 4), requireService('RAMASSAGE'), listRamasseurs);
router.patch('/:id/affecter', requireAuth, requireKind('employee'), requireRole(1, 2, 3, 4), requireService('RAMASSAGE'), affecterDemande);
router.patch('/:id/ramasser', requireAuth, requireKind('employee'), requireService('RAMASSAGE'), ramasserDemande);
router.patch('/:id/annuler', requireAuth, requireKind('employee'), requireService('RAMASSAGE'), annulerDemande);

module.exports = router;
