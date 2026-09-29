const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ensurePreuveDir } = require('../utils/preuveStatut');

/*
 * Champ multipart « preuve » (photo, facultatif) du changement de statut :
 * POST /api/parcels/:id/statut (admin) et /api/livreurs/me/colis/…/statut
 * (dashboard + API livreur). Les requêtes JSON (plateformes des livreurs sans
 * preuve) passent sans être touchées : multer ignore tout ce qui n'est pas
 * multipart/form-data.
 */

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_SIZE = 8 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensurePreuveDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `preuve-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!IMAGE_EXT.includes(ext) || !String(file.mimetype || '').startsWith('image/')) {
      return cb(new Error('Format de preuve non autorisé (photo JPG, PNG ou WEBP attendue).'));
    }
    cb(null, true);
  }
});

/*
 * Erreurs multer → message lisible. Le fichier est écrit sur disque avant
 * que le contrôleur ne valide quoi que ce soit : s'il n'est pas enregistré en
 * base à la fin de la réponse (colis introuvable, statut refusé, erreur…),
 * il est retiré du disque. Le contrôleur pose res.locals.preuveEnregistree
 * après le commit.
 */
function handlePreuveUpload(req, res, next) {
  upload.single('preuve')(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Photo trop volumineuse (max 8 Mo).'
          : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
            ? 'Un seul fichier « preuve » est attendu.'
            : err.message;
      return res.status(400).json({ message });
    }
    if (req.file?.path) {
      res.once('finish', () => {
        if (!res.locals.preuveEnregistree) fs.unlink(req.file.path, () => {});
      });
    }
    next();
  });
}

module.exports = { handlePreuveUpload };
