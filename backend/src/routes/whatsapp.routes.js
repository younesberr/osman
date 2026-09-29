const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const {
  getConfiguration,
  saveConfiguration,
  testerConnexion,
  envoyerMessageTest,
  abonnerWebhook,
  listJournal,
  getJournalItem,
  webhookVerify,
  webhookReceive
} = require('../controllers/whatsapp.controller');
const crm = require('../controllers/whatsappCrm.controller');
const { ensureEnvoiDir } = require('../services/whatsappConversations');

/*
 * API liaison › WhatsApp Business Cloud API (Meta) : configuration
 * (/admin/api-liaison/configuration) + CRM (discussions, modèles, actions
 * automatiques, statistiques). Tables delevery_whatsapp_* + clés
 * ortalog_whatsapp_* de delevery_configs.
 * - Gestion : fonctions 1 et 2 uniquement, deux services indépendants :
 *   · API_LIAISON — configuration, journal, file d'envoi, modèles, actions
 *     automatiques, statistiques, paramètres CRM (pages « API liaison » hors
 *     Discussions) ;
 *   · WHATSAPP_DISCUSSIONS — page Discussions seule (/conversations*), pour
 *     confier la boîte de réception à un employé sans le reste du menu ;
 *   · lectures partagées (référentiels, modèles + aperçu, recherche de colis,
 *     réponses rapides) et envois depuis un colis : l'un ou l'autre suffit.
 *   Miroir frontend : adminMenu.js (service propre du sous-menu Discussions).
 * - Webhook (/webhook) : public, appelé par Meta sans cookie ; exempté du
 *   limiteur global de server.js (rafales d'accusés) et protégé par son propre
 *   limiteur + signature HMAC (voir whatsapp.controller.js).
 */

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Trop de requêtes.' }
});
router.get('/webhook', webhookLimiter, webhookVerify);
router.post('/webhook', webhookLimiter, webhookReceive);

// Gestion admin (API liaison hors Discussions).
const admin = [requireAuth, requireService('API_LIAISON'), requireRole(1, 2)];
// Page Discussions seule.
const discussions = [requireAuth, requireService('WHATSAPP_DISCUSSIONS'), requireRole(1, 2)];
// Partagé : l'un des deux services suffit.
const messagerie = [requireAuth, requireService(['API_LIAISON', 'WHATSAPP_DISCUSSIONS']), requireRole(1, 2)];
router.get('/configuration', ...admin, getConfiguration);
router.put('/configuration', ...admin, saveConfiguration);
router.post('/test-connexion', ...admin, testerConnexion);
router.post('/test-message', ...admin, envoyerMessageTest);
router.post('/abonner-webhook', ...admin, abonnerWebhook);
router.get('/journal', ...admin, listJournal);
router.get('/journal/:id', ...admin, getJournalItem);

/*
 * Pièce jointe envoyée depuis une discussion, un seul fichier par message :
 *  - champ `image` : jpeg/png/webp, limite Meta 5 Mo (+ `legende`) ;
 *  - champ `audio` : message vocal, limite Meta 16 Mo. Le navigateur produit
 *    de l'ogg/opus (utils/enregistreurVocal.js), sinon m4a (Safari) ; mp3, aac
 *    et amr sont aussi acceptés par Meta. Le webm est refusé par Meta.
 * Le fichier est gardé dans uploads/whatsapp/envoi (affiché dans le fil).
 */
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXT = ['.ogg', '.opus', '.m4a', '.mp3', '.aac', '.amr'];
const IMAGE_MAX = 5 * 1024 * 1024;
const AUDIO_MAX = 16 * 1024 * 1024;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureEnvoiDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `wa-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: AUDIO_MAX, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'audio') {
      if (!AUDIO_EXT.includes(ext)) return cb(new Error('Format audio non autorisé (ogg, m4a, mp3, aac, amr).'));
    } else if (!IMAGE_EXT.includes(ext)) return cb(new Error('Format non autorisé (image : jpg, png, webp).'));
    cb(null, true);
  }
});
const MESSAGES_MULTER = {
  LIMIT_FILE_SIZE: 'Fichier trop volumineux (max 16 Mo pour un audio, 5 Mo pour une image).',
  LIMIT_FILE_COUNT: 'Un seul fichier par message.',
  LIMIT_UNEXPECTED_FILE: 'Champ de fichier inattendu (image ou audio).'
};
function handleMediaUpload(req, res, next) {
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ message: MESSAGES_MULTER[err.code] || err.message });
    const image = req.files?.image?.[0] || null;
    const audio = req.files?.audio?.[0] || null;
    if (image && image.size > IMAGE_MAX) {
      fs.promises.unlink(image.path).catch(() => {});
      return res.status(400).json({ message: 'Image trop volumineuse (max 5 Mo).' });
    }
    // Le contrôleur travaille sur req.file (un seul fichier par message).
    req.file = image || audio;
    next();
  });
}

// CRM : état, catalogue, référentiels.
router.get('/crm/etat', ...admin, crm.getEtatCrm);
router.get('/evenements', ...admin, crm.getCatalogue);
router.get('/referentiels', ...messagerie, crm.getReferentiels);

// Modèles (synchronisés depuis Meta). Liste et aperçu : aussi pour l'envoi
// d'un modèle depuis une discussion ou un colis.
router.get('/modeles', ...messagerie, crm.listModeles);
router.post('/modeles/synchroniser', ...admin, crm.syncModeles);
router.put('/modeles/:id', ...admin, crm.updateModele);
router.post('/modeles/:id/apercu', ...messagerie, crm.apercuModele);

// Actions automatiques (règles). `/regles/tester` avant `/regles/:id`.
router.get('/regles', ...admin, crm.listRegles);
router.post('/regles/tester', ...admin, crm.testerRegle);
router.post('/regles', ...admin, crm.createRegle);
router.put('/regles/:id', ...admin, crm.updateRegle);
router.patch('/regles/:id/actif', ...admin, crm.setRegleActive);
router.delete('/regles/:id', ...admin, crm.deleteRegle);

// Discussions (service WHATSAPP_DISCUSSIONS).
router.get('/conversations', ...discussions, crm.listConversations);
router.post('/conversations', ...discussions, crm.createConversation);
router.get('/conversations/:id', ...discussions, crm.getConversation);
router.patch('/conversations/:id', ...discussions, crm.updateConversation);
router.get('/conversations/:id/messages', ...discussions, crm.getMessagesConversation);
router.post('/conversations/:id/messages', ...discussions, handleMediaUpload, crm.sendMessageConversation);
router.post('/conversations/:id/notes', ...discussions, crm.addNote);

// Réponses rapides (lecture : compositeur des discussions ; gestion : Paramètres CRM).
router.get('/reponses-rapides', ...messagerie, crm.listReponsesRapides);
router.post('/reponses-rapides', ...admin, crm.createReponseRapide);
router.put('/reponses-rapides/:id', ...admin, crm.updateReponseRapide);
router.delete('/reponses-rapides/:id', ...admin, crm.deleteReponseRapide);

// Paramètres CRM, statistiques, file d'envoi.
router.get('/parametres-crm', ...admin, crm.getParametresCrm);
router.put('/parametres-crm', ...admin, crm.saveParametresCrm);
router.get('/statistiques', ...admin, crm.getStatistiques);
router.get('/file', ...admin, crm.listFile);
router.post('/file/:id/annuler', ...admin, crm.annulerFile);
router.post('/file/:id/renvoyer', ...admin, crm.renvoyerFile);

// Colis : recherche, timeline, envoi manuel (scope agence via loadAdminParcel).
router.get('/colis/recherche', ...messagerie, crm.rechercherColis);
router.get('/colis/:id/messages', ...messagerie, crm.messagesColis);
router.post('/colis/:id/envoyer', ...messagerie, crm.envoyerPourColis);

module.exports = router;
