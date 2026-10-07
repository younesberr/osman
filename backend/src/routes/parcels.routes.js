const router = require('express').Router();
const { requireAuth, requireService, requireKind, requireRole } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const { handlePreuveUpload } = require('../middleware/preuveStatut');
const {
  listParcels,
  listStatuts,
  listStatutLabels,
  listFilterOptions,
  listAdminLabels,
  exportAdminParcels,
  getClientNewParcelData,
  getClientTarif,
  getAdminTarif,
  getAdminClientDefaults,
  getClientDestinataireTaux,
  getAdminDestinataireTaux,
  createClientParcel,
  createAdminParcel,
  getClientParcelEditData,
  updateClientParcel,
  getImportData,
  importParcels,
  getImportStockProducts,
  importStockParcels,
  importClientParcels,
  importClientStockParcels,
  listClientParcels,
  listClientFilterOptions,
  listClientLabels,
  getClientParcelSuivi,
  getClientParcelDetails,
  createClientRemboursement,
  createClientReclamation,
  setClientParcelBlock,
  deleteClientParcel,
  getRamassageSons,
  scanRamassage
} = require('../controllers/parcels.controller');
const {
  getParcelSuivi,
  getParcelDetails,
  getParcelEditData,
  getParcelTarif,
  updateParcel,
  createParcelReclamation,
  createParcelRemboursement,
  listActiveStatuts,
  changeParcelStatut,
  deleteParcel,
  revertDelivered,
  listLivreursActifs,
  changerLivreur,
  annulerRamassage
} = require('../controllers/parcelsAdmin.controller');

// Routes du dashboard client : un client ne voit que ses propres colis.
// Les membres d'équipe n'accèdent qu'aux tâches attribuées (clientAccess).
router.get('/client', requireAuth, requireKind('customer'), requireClientPermission('COLIS_CONSULTATION'), listClientParcels);
router.post('/client', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), createClientParcel);
// Import Excel de colis (normaux ou de stock) depuis le dashboard client.
router.post('/client/import', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), importClientParcels);
router.post('/client/import/stock', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), importClientStockParcels);
router.get('/client/new', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), getClientNewParcelData);
router.get('/client/tarif', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), getClientTarif);
router.get('/client/destinataire', requireAuth, requireKind('customer'), requireClientPermission('COLIS_SAISIE'), getClientDestinataireTaux);
router.get('/client/filters', requireAuth, requireKind('customer'), requireClientPermission('COLIS_CONSULTATION'), listClientFilterOptions);
router.get('/client/labels', requireAuth, requireKind('customer'), requireClientPermission('COLIS_CONSULTATION'), listClientLabels);
// Modification d'un colis : directe en attente de ramassage (WAITING_PICKUP),
// via demande à valider par l'admin après ramassage (IN_PROGRESS).
router.get('/client/:id/edit', requireAuth, requireKind('customer'), requireClientPermission('COLIS_MODIFICATION'), getClientParcelEditData);
router.put('/client/:id', requireAuth, requireKind('customer'), requireClientPermission('COLIS_MODIFICATION'), updateClientParcel);
router.get('/client/:id/suivi', requireAuth, requireKind('customer'), requireClientPermission('COLIS_CONSULTATION'), getClientParcelSuivi);
router.get('/client/:id/details', requireAuth, requireKind('customer'), requireClientPermission('COLIS_CONSULTATION'), getClientParcelDetails);
// Blocage / déblocage de l'expédition par le client (WAITING_PICKUP ou
// PICKED_UP) : colis refusé au scan ramassage / envoi tant qu'il est bloqué.
router.post('/client/:id/blocage', requireAuth, requireKind('customer'), requireClientPermission('COLIS_MODIFICATION'), setClientParcelBlock);
// Suppression d'un colis encore en attente de ramassage (WAITING_PICKUP) par
// le client : même traitement que la suppression admin (stock restauré).
router.delete('/client/:id', requireAuth, requireKind('customer'), requireClientPermission('COLIS_MODIFICATION'), deleteClientParcel);
router.post('/client/:id/remboursement', requireAuth, requireKind('customer'), requireClientPermission('REMBOURSEMENT_RECLAMATION'), createClientRemboursement);
router.post('/client/:id/reclamation', requireAuth, requireKind('customer'), requireClientPermission('REMBOURSEMENT_RECLAMATION'), createClientReclamation);

// Import de colis (normaux ou de stock) depuis un fichier Excel (dashboard admin).
router.get('/import/data', requireAuth, requireService('IMPORT'), getImportData);
router.post('/import', requireAuth, requireService('IMPORT'), importParcels);
router.get('/import/stock/products', requireAuth, requireService('IMPORT'), getImportStockProducts);
router.post('/import/stock', requireAuth, requireService('IMPORT'), importStockParcels);

// Page admin "Nouveau colis" (/admin/colis/nouveau) : création d'un colis au
// nom d'un client. Données (magasins + villes) et produits de stock : mêmes
// listes que l'import admin, servies ici sous le service COLIS.
router.get('/new/data', requireAuth, requireService('COLIS'), getImportData);
router.get('/new/client', requireAuth, requireService('COLIS'), getAdminClientDefaults);
router.get('/new/tarif', requireAuth, requireService('COLIS'), getAdminTarif);
router.get('/new/destinataire', requireAuth, requireService('COLIS'), getAdminDestinataireTaux);
router.get('/new/stock', requireAuth, requireService('COLIS'), getImportStockProducts);
router.post('/new', requireAuth, requireService('COLIS'), createAdminParcel);

// Ramassage par scan : douchette ou caméra → colis PICKED_UP + historique.
router.get('/ramassage/sons', requireAuth, requireService('RAMASSAGE_SCAN'), getRamassageSons);
router.post('/ramassage/scan', requireAuth, requireService('RAMASSAGE_SCAN'), scanRamassage);

router.get('/', requireAuth, requireService('COLIS'), listParcels);
router.get('/labels', requireAuth, requireService('COLIS'), listAdminLabels);
// Bouton « Exporter Excel » : colonnes complètes des colis cochés (lecture seule).
router.post('/export', requireAuth, requireService('COLIS'), exportAdminParcels);
router.get('/statuts', requireAuth, requireService('COLIS'), listStatuts);
// Libellés des statuts (delevery_string) : lus par tous les dashboards
// (admin, client, livreur) pour l'affichage — simple authentification.
router.get('/statuts/libelles', requireAuth, listStatutLabels);
// Statuts actifs de la modale « Changer statut » (page Colis).
router.get('/statuts/actifs', requireAuth, requireService('COLIS'), listActiveStatuts);
router.get('/filters', requireAuth, requireService('COLIS'), listFilterOptions);
// Livreurs actifs de la modale « Changer livreur » (employés type 1 / 2).
router.get('/livreurs/actifs', requireAuth, requireService('COLIS'), requireRole(1, 2), listLivreursActifs);

// Actions de ligne de la datatable admin Colis (suivi, info, modifier,
// réclamation, changer statut). Employés type 3/4/6 : restreint à leur agence.
// Suivi aussi ouvert au service RECLAMATIONS (bouton « Suivi du colis » de la
// page Réclamations), au service BON_DISTRIBUTION (bouton « Détail de suivi »
// des tableaux de la page d'un bon de distribution) et au service RETOUR (même
// bouton sur les deux tableaux de la page d'un bon de retour livreur).
router.get('/:id/suivi', requireAuth, requireService(['COLIS', 'RECLAMATIONS', 'BON_DISTRIBUTION', 'RETOUR']), getParcelSuivi);
router.get('/:id/details', requireAuth, requireService('COLIS'), getParcelDetails);
router.get('/:id/edit', requireAuth, requireService('COLIS'), getParcelEditData);
router.get('/:id/tarif', requireAuth, requireService('COLIS'), getParcelTarif);
router.put('/:id', requireAuth, requireService('COLIS'), updateParcel);
router.delete('/:id', requireAuth, requireService('COLIS'), deleteParcel);
router.post('/:id/reclamation', requireAuth, requireService('COLIS'), createParcelReclamation);
router.post('/:id/remboursement', requireAuth, requireService('COLIS'), createParcelRemboursement);
// Changement de statut : JSON, ou multipart/form-data avec la photo « preuve »
// (facultative, affichée dans le détail de suivi admin / client).
router.post('/:id/statut', requireAuth, requireService('COLIS'), handlePreuveUpload, changeParcelStatut);
// Annulation d'une livraison : réservée aux employés type 1 / 2 (contrôlé dans le contrôleur).
router.post('/:id/non-livre', requireAuth, requireService('COLIS'), revertDelivered);
// Bouton « Changer livreur » : réaffectation d'un colis déjà affecté (type 1 / 2).
router.post('/:id/livreur', requireAuth, requireService('COLIS'), requireRole(1, 2), changerLivreur);
// Annulation d'un ramassage : colis PICKED_UP → WAITING_PICKUP, ligne
// d'historique « Ramassé » supprimée.
router.post('/:id/annuler-ramassage', requireAuth, requireService('COLIS'), annulerRamassage);

module.exports = router;
