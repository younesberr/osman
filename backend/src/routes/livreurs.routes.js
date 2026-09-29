const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService, requireRole } = require('../middleware/auth');
const { handlePreuveUpload } = require('../middleware/preuveStatut');
const { listUsers, listFiltres, setActive, createUser } = require('../controllers/users.controller');
const {
  getFiche,
  getFicheSelf,
  getFicheOptions,
  updateCompte,
  updateCompteSelf,
  updateFiche,
  listTarifs,
  appliquerTarifs,
  createTarif,
  updateTarif,
  deleteTarif,
  ensureUploadDir,
  FILE_FIELDS
} = require('../controllers/livreursFiche.controller');
const { listMaterielsUser } = require('../controllers/materiel.controller');
const { principalIdOf } = require('../controllers/usersComptes.controller');
const {
  listMesColis,
  getMonColisParCode,
  changerStatutMonColis,
  changerStatutMonColisParCode,
  getSuiviMonColis,
  getMessageColis
} = require('../controllers/livreurColis.controller');
const { getAnalyse } = require('../controllers/livreursAnalyse.controller');
const { listActiveStatuts } = require('../controllers/parcelsAdmin.controller');

/* Fichiers de la fiche livreur (onglet "Infos personnelles") : PDF uniquement. */
const PDF_EXT = ['.pdf'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}-${file.fieldname}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!PDF_EXT.includes(ext)) {
      return cb(new Error('Format non autorisé (PDF attendu).'));
    }
    cb(null, true);
  }
});

/* Erreurs multer (taille, format) → message lisible côté client. */
function handleFicheUpload(req, res, next) {
  const fields = Object.keys(FILE_FIELDS).map((name) => ({ name, maxCount: 1 }));
  upload.fields(fields)(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (max 5 Mo).' : err.message;
      return res.status(400).json({ message });
    }
    next();
  });
}

/*
 * Routes « Ma fiche » livreur (dashboard livreur, menu avatar) : le livreur
 * connecté consulte son compte et son matériel, et modifie ses identifiants de
 * connexion, sans le service LIVREURS. Réservées à la fonction Livreur
 * (users_type 5 : AE, salarié ou compte secondaire). Déclarées avant '/:id'
 * pour que 'me' ne soit pas capturé comme un id.
 */
function selfLivreur(req, res, next) {
  req.params.id = String(req.user.id);
  next();
}

/* Matériel : les affectations des fiches visent le compte PRINCIPAL de la
 * personne (un compte secondaire livreur doit voir le matériel du principal). */
async function selfLivreurPrincipal(req, res, next) {
  try {
    req.params.id = String(await principalIdOf(req.user.id));
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/me', requireAuth, requireRole(5), selfLivreur, getFicheSelf);
router.put('/me/compte', requireAuth, requireRole(5), selfLivreur, updateCompteSelf);
router.get('/me/materiel', requireAuth, requireRole(5), selfLivreurPrincipal, listMaterielsUser);

/* Page /livreur/colis : colis en tournée du livreur connecté, détail de suivi
 * et changement de statut (mêmes modales que l'admin, restreint à ses propres
 * colis). */
router.get('/me/colis', requireAuth, requireRole(5), listMesColis);
router.get('/me/colis/message', requireAuth, requireRole(5), getMessageColis);
router.get('/me/colis/statuts/actifs', requireAuth, requireRole(5), listActiveStatuts);
router.get('/me/colis/:id/suivi', requireAuth, requireRole(5), getSuiviMonColis);
/* Page « Changer statut par scan » : colis du livreur désigné par son code (QR / code-barres). */
router.get('/me/colis/code/:code', requireAuth, requireRole(5), getMonColisParCode);
/* Changement de statut par code colis (plateformes des livreurs, qui ne
 * connaissent pas le parcel_id) ; même corps et même réponse que par id.
 * Corps JSON, ou multipart/form-data avec la photo « preuve » (facultative). */
router.post('/me/colis/code/:code/statut', requireAuth, requireRole(5), handlePreuveUpload, changerStatutMonColisParCode);
router.post('/me/colis/:id/statut', requireAuth, requireRole(5), handlePreuveUpload, changerStatutMonColis);

router.get('/', requireAuth, requireService('LIVREURS'), listUsers('livreurs'));
router.post('/', requireAuth, requireService('LIVREURS'), createUser('livreurs'));
router.get('/filtres', requireAuth, requireService('LIVREURS'), listFiltres('livreurs'));
router.get('/fiche/options', requireAuth, requireService('LIVREURS'), getFicheOptions);
router.get('/:id', requireAuth, requireService('LIVREURS'), getFiche);
router.put('/:id/compte', requireAuth, requireService('LIVREURS'), updateCompte);
router.put('/:id/fiche', requireAuth, requireService('LIVREURS'), handleFicheUpload, updateFiche);
router.patch('/:id/active', requireAuth, requireService('LIVREURS'), setActive('livreurs'));
router.get('/:id/materiel', requireAuth, requireService('LIVREURS'), listMaterielsUser);
router.get('/:id/analyse', requireAuth, requireService('LIVREURS'), getAnalyse);
router.get('/:id/tarifs', requireAuth, requireService('LIVREURS'), listTarifs);
router.post('/:id/tarifs/appliquer', requireAuth, requireService('LIVREURS'), appliquerTarifs);
router.post('/:id/tarifs', requireAuth, requireService('LIVREURS'), createTarif);
router.put('/:id/tarifs/:tarifId', requireAuth, requireService('LIVREURS'), updateTarif);
router.delete('/:id/tarifs/:tarifId', requireAuth, requireService('LIVREURS'), deleteTarif);

module.exports = router;
