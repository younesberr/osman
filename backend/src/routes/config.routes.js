const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService } = require('../middleware/auth');
const { AUDIO_EXT, ensureSonUploadDir } = require('../utils/scanSons');
const {
  listStatuts,
  createStatut,
  updateStatut,
  setStatutActive,
  listSons,
  createSon,
  updateSon,
  deleteSon,
  listListe,
  createListeItem,
  updateListeItem,
  setListeItemActive,
  listZones,
  createZone,
  updateZone,
  setZoneActive,
  listMarques,
  createMarque,
  updateMarque,
  setMarqueActive,
  getMaintenance,
  saveMaintenance,
  getMessageLivreur,
  saveMessageLivreur
} = require('../controllers/config.controller');
const { listAgences, createAgence, updateAgence, setAgenceActive } = require('../controllers/agences.controller');
const { listVilles, createVille, updateVille, setVilleActive } = require('../controllers/villes.controller');
const { listTarifs, createTarif, updateTarif, deleteTarif } = require('../controllers/tarifsMatrix.controller');

router.use(requireAuth, requireService('CONFIGURATION'));

/* Sons du scanner de ramassage : fichiers audio stockés dans uploads/sons. */
const sonStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureSonUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `son-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  }
});

const sonUpload = multer({
  storage: sonStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (mp3, wav, ogg, webm, m4a, aac).'));
    }
    cb(null, true);
  }
});

// Gestion propre des erreurs multer (taille, format) : message lisible côté client.
function handleSonUpload(req, res, next) {
  sonUpload.single('file')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 3 Mo).' : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

// Sons du scanner de ramassage (delevery_configs, var app_scan_son).
router.get('/sons', listSons);
router.post('/sons', handleSonUpload, createSon);
router.put('/sons/:id', handleSonUpload, updateSon);
router.delete('/sons/:id', deleteSon);

// Gestion agences (delevery_agences).
router.get('/agences', listAgences);
router.post('/agences', createAgence);
router.put('/agences/:id', updateAgence);
router.patch('/agences/:id/active', setAgenceActive);

// Gestion zones (delevery_zone).
router.get('/zones', listZones);
router.post('/zones', createZone);
router.put('/zones/:id', updateZone);
router.patch('/zones/:id/active', setZoneActive);

// Gestion villes (delevery_tarifs + delevery_zone_cities).
router.get('/villes', listVilles);
router.post('/villes', createVille);
router.put('/villes/:id', updateVille);
router.patch('/villes/:id/active', setVilleActive);

// Gestion tarifs par couple de villes (delevery_tarifs_matrix).
router.get('/tarifs', listTarifs);
router.post('/tarifs', createTarif);
router.put('/tarifs/:id', updateTarif);
router.delete('/tarifs/:id', deleteTarif);

router.get('/statuts', listStatuts);
router.post('/statuts', createStatut);
router.put('/statuts/:id', updateStatut);
router.patch('/statuts/:id/active', setStatutActive);

// Moyens logistiques : marques de véhicules (delevery_configs, var app_moyen_marque).
router.get('/moyens/marques', listMarques);
router.post('/moyens/marques', createMarque);
router.put('/moyens/marques/:id', updateMarque);
router.patch('/moyens/marques/:id/active', setMarqueActive);

// Moyens logistiques : intervalles maintenance par type (var app_moyen_maintenance).
router.get('/moyens/maintenance', getMaintenance);
router.put('/moyens/maintenance/:type', saveMaintenance);

// Modèle du message WhatsApp livreur → destinataire (var app_message_livreur).
router.get('/message-livreur', getMessageLivreur);
router.put('/message-livreur', saveMessageLivreur);

// Listes de valeurs (delevery_configs) : :kind = 'formes-juridiques' | 'banques' | 'positions'.
router.get('/listes/:kind', listListe);
router.post('/listes/:kind', createListeItem);
router.put('/listes/items/:id', updateListeItem);
router.patch('/listes/items/:id/active', setListeItemActive);

module.exports = router;
