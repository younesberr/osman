const router = require('express').Router();
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  listNotifications,
  getCibles,
  createNotification,
  updateNotification,
  setNotificationActive,
  deleteNotification,
  listMesNotifications,
  fermerNotification
} = require('../controllers/notifications.controller');

/*
 * Notifications par bannières (pages admin /admin/notifications/employes et
 * /admin/notifications/clients — tables delevery_notif_banner /
 * delevery_notif_cible / delevery_notif_fermeture).
 * Gestion : service NOTIFICATIONS_EMPLOYES + fonctions 1 et 2 uniquement.
 * Affichage (/me, /:id/fermer) : tout utilisateur connecté (client, employé,
 * livreur) — chacun ne voit que les notifications qui le ciblent.
 */

// Affichage : bannières de l'utilisateur connecté. Segments statiques avant /:id.
router.get('/me', requireAuth, listMesNotifications);
router.post('/:id/fermer', requireAuth, fermerNotification);

// Gestion admin.
const admin = [requireAuth, requireService('NOTIFICATIONS_EMPLOYES'), requireRole(1, 2)];
router.get('/cibles', ...admin, getCibles);
router.get('/', ...admin, listNotifications);
router.post('/', ...admin, createNotification);
router.put('/:id', ...admin, updateNotification);
router.patch('/:id/active', ...admin, setNotificationActive);
router.delete('/:id', ...admin, deleteNotification);

module.exports = router;
