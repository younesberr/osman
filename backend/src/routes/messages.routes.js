const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService, requireKind } = require('../middleware/auth');
const { requireClientPermission } = require('../middleware/clientAccess');
const {
  ensureMessageUploadDir,
  IMAGE_EXT,
  AUDIO_EXT,
  listClientChats,
  createClientChat,
  getClientChat,
  sendClientMessage,
  listAdminChats,
  listAdminFilters,
  getAdminChat,
  sendAdminMessage,
  setChatStatut
} = require('../controllers/messages.controller');
const {
  listFormAccueil,
  getFormAccueil,
  traiterFormAccueil,
  rouvrirFormAccueil,
  deleteFormAccueil
} = require('../controllers/formAccueil.controller');

/* Pièces jointes des messages : photos et messages vocaux (MediaRecorder -> webm). */
const ALLOWED_EXT = [...IMAGE_EXT, ...AUDIO_EXT];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureMessageUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `msg-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (photo : png, jpg, webp, gif — audio : webm, ogg, mp3, m4a, wav).'));
    }
    cb(null, true);
  }
});

// Gestion propre des erreurs multer (taille, format) : message lisible côté client.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 8 Mo).' : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

// Dashboard client : un client ne voit que ses propres discussions.
// Les membres d'équipe n'accèdent qu'aux tâches attribuées (clientAccess).
router.get('/client/chats', requireAuth, requireKind('customer'), requireClientPermission('MESSAGES'), listClientChats);
router.post('/client/chats', requireAuth, requireKind('customer'), requireClientPermission('MESSAGES'), createClientChat);
router.get('/client/chats/:id', requireAuth, requireKind('customer'), requireClientPermission('MESSAGES'), getClientChat);
router.post('/client/chats/:id/messages', requireAuth, requireKind('customer'), requireClientPermission('MESSAGES'), handleUpload, sendClientMessage);

// Dashboard admin (service MESSAGES) : discussions de tous les clients.
router.get('/chats', requireAuth, requireService('MESSAGES'), listAdminChats);
router.get('/filters', requireAuth, requireService('MESSAGES'), listAdminFilters);
router.get('/chats/:id', requireAuth, requireService('MESSAGES'), getAdminChat);
router.post('/chats/:id/messages', requireAuth, requireService('MESSAGES'), handleUpload, sendAdminMessage);
router.patch('/chats/:id/statut', requireAuth, requireService('MESSAGES'), setChatStatut);

// Messages du formulaire de contact de la page d'accueil (delevery_home_msg).
router.get('/form-accueil', requireAuth, requireService('MESSAGES'), listFormAccueil);
router.get('/form-accueil/:id', requireAuth, requireService('MESSAGES'), getFormAccueil);
router.post('/form-accueil/:id/traiter', requireAuth, requireService('MESSAGES'), traiterFormAccueil);
router.post('/form-accueil/:id/rouvrir', requireAuth, requireService('MESSAGES'), rouvrirFormAccueil);
router.delete('/form-accueil/:id', requireAuth, requireService('MESSAGES'), deleteFormAccueil);

module.exports = router;
