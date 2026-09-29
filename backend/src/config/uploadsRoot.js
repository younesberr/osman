const path = require('path');

/*
 * Racine des fichiers uploadés (branding, fiches, versements, messages…).
 *
 * En production (Hostinger), UPLOADS_DIR doit pointer HORS du dossier de
 * l'application : l'auto-deploy git réécrit le checkout à chaque push et
 * effacerait tous les fichiers uploadés (logo, favicon, pièces jointes…).
 * Exemple dans hPanel : UPLOADS_DIR=/home/<utilisateur>/ortalog-uploads
 *
 * Sans la variable (dev local), on garde backend/uploads comme avant.
 */
const UPLOADS_ROOT = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', '..', 'uploads');

module.exports = UPLOADS_ROOT;
