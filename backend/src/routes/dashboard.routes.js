const router = require('express').Router();
const { requireAuth, requireKind, requireRole, refreshEmployeeAccess } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const { adminStats, livreurStats, clientStats } = require('../controllers/dashboard.controller');
const { clientStatistiques } = require('../controllers/statistiquesClient.controller');
const { compteursSidebar } = require('../controllers/compteursSidebar.controller');
const { ADMIN_TYPES, LIVREUR_TYPE } = require('../controllers/auth.controller');

// Tableau de bord de l'Accueil admin : le ramasseur (type 6) n'a pas cette page
// (miroir : ACCUEIL_TYPES de frontend/src/config/adminMenu.js).
router.get('/admin', requireAuth, requireRole(1, 2, 3, 4), adminStats);
// Badges rouges de la sidebar admin (chaque compteur est filtré par service,
// relu en base pour suivre les menus accordés après le login).
router.get('/admin/compteurs', requireAuth, requireRole(...ADMIN_TYPES), refreshEmployeeAccess, compteursSidebar);
router.get('/livreur', requireAuth, requireRole(LIVREUR_TYPE), livreurStats);
router.get('/client', requireAuth, requireKind('customer'), clientStats);
// Page Statistiques du dashboard client (tâche membre STATISTIQUES).
router.get(
  '/client/statistiques',
  requireAuth,
  requireKind('customer'),
  requireClientPermission('STATISTIQUES'),
  clientStatistiques
);

module.exports = router;
