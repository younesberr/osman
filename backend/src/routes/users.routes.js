const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService } = require('../middleware/auth');
const { listUsers, exportPaie, listFiltres, setActive, createUser } = require('../controllers/users.controller');
const {
  getFiche,
  getFicheOptions,
  updateFiche,
  ensureUploadDir,
  FILE_FIELDS
} = require('../controllers/usersFiche.controller');
const {
  listComptes,
  createCompte,
  updateCompte,
  updateCompteSelf,
  setCompteActive,
  principalIdOf
} = require('../controllers/usersComptes.controller');
const { listMaterielsUser } = require('../controllers/materiel.controller');
const {
  getParcours,
  updateParcours,
  createContrat,
  updateContrat,
  deleteContrat,
  createSalaire,
  updateSalaire,
  deleteSalaire,
  listIndispos,
  createIndispo,
  updateIndispo,
  deleteIndispo,
  MAX_INDISPO_FICHIERS
} = require('../controllers/usersParcours.controller');

/*
 * Fichiers de la fiche (onglet "Infos personnelles") : PDF partout, la visite
 * médicale accepte aussi une image (mêmes règles que la maquette SUIVI).
 */
const PDF_EXT = ['.pdf'];
const PDF_OR_IMAGE_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

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
    const allowed = file.fieldname === 'visite_medicale' ? PDF_OR_IMAGE_EXT : PDF_EXT;
    if (!allowed.includes(ext)) {
      return cb(
        new Error(
          file.fieldname === 'visite_medicale'
            ? 'Format non autorisé pour la visite médicale (PDF ou image).'
            : 'Format non autorisé (PDF attendu).'
        )
      );
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
 * Fichiers des onglets Parcours professionnel (contrat PDF) et Congés &
 * absences (pièces PDF ou image, plusieurs par indisponibilité). Suffixe
 * aléatoire : plusieurs fichiers d'une même requête partagent le même
 * Date.now(), le nom doit rester unique.
 */
const parcoursStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}-${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

function parcoursUploader(allowedExt, message) {
  return multer({
    storage: parcoursStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowedExt.includes(ext)) return cb(new Error(message));
      cb(null, true);
    }
  });
}

const uploadContrat = parcoursUploader(PDF_EXT, 'Format non autorisé (PDF attendu).');
const uploadIndispo = parcoursUploader(PDF_OR_IMAGE_EXT, 'Format non autorisé (PDF ou image attendu).');

/* single/array + erreurs multer → message lisible côté client. */
function wrapUpload(handler) {
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (err) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Fichier trop volumineux (max 5 Mo).'
            : err.code === 'LIMIT_UNEXPECTED_FILE'
              ? `Trop de fichiers joints (max ${MAX_INDISPO_FICHIERS}).`
              : err.message;
        return res.status(400).json({ message });
      }
      next();
    });
}

const handleContratUpload = wrapUpload(uploadContrat.single('fichier'));
const handleIndispoUpload = wrapUpload(uploadIndispo.array('fichiers', MAX_INDISPO_FICHIERS));

/*
 * Routes « Ma fiche » : un employé consulte sa propre fiche sans le service
 * UTILISATEURS. On force req.params.id sur le compte PRINCIPAL de la personne
 * (la fiche est portée par le principal, même connecté via un compte
 * secondaire) puis on réutilise les contrôleurs de la fiche. Déclarées avant
 * '/:id' pour que 'me' ne soit pas capturé comme un id.
 */
async function selfEmployee(req, res, next) {
  if (req.user.kind !== 'employee') {
    return res.status(403).json({ message: 'Réservé aux comptes employés.' });
  }
  try {
    req.params.id = String(await principalIdOf(req.user.id));
    next();
  } catch (err) {
    next(err);
  }
}

/* Fiche « Infos personnelles » en LECTURE SEULE côté self (pas de PUT /me/fiche) ;
 * seuls les identifiants de connexion de ses comptes sont modifiables. */
router.get('/me', requireAuth, selfEmployee, getFiche);
router.get('/me/fiche/options', requireAuth, selfEmployee, getFicheOptions);
router.get('/me/comptes', requireAuth, selfEmployee, listComptes);
router.put('/me/comptes/:compteId', requireAuth, selfEmployee, updateCompteSelf);
router.get('/me/materiel', requireAuth, selfEmployee, listMaterielsUser);
/* Parcours & congés en LECTURE SEULE : pas d'alias self pour la création /
 * modification de contrats, salaires ou indisponibilités. */
router.get('/me/parcours', requireAuth, selfEmployee, getParcours);
router.get('/me/indisponibilites', requireAuth, selfEmployee, listIndispos);

router.get('/', requireAuth, requireService('UTILISATEURS'), listUsers('utilisateurs'));
router.post('/', requireAuth, requireService('UTILISATEURS'), createUser('utilisateurs'));
router.get('/filtres', requireAuth, requireService('UTILISATEURS'), listFiltres('utilisateurs'));
/* Export « Excel paie » (mêmes filtres que la liste, sans pagination) ; avant '/:id'. */
router.get('/export-paie', requireAuth, requireService('UTILISATEURS'), exportPaie('utilisateurs'));
router.get('/fiche/options', requireAuth, requireService('UTILISATEURS'), getFicheOptions);
router.get('/:id', requireAuth, requireService('UTILISATEURS'), getFiche);
router.put('/:id/fiche', requireAuth, requireService('UTILISATEURS'), handleFicheUpload, updateFiche);
router.patch('/:id/active', requireAuth, requireService('UTILISATEURS'), setActive('utilisateurs'));
router.get('/:id/parcours', requireAuth, requireService('UTILISATEURS'), getParcours);
router.put('/:id/parcours', requireAuth, requireService('UTILISATEURS'), updateParcours);
router.post('/:id/contrats', requireAuth, requireService('UTILISATEURS'), handleContratUpload, createContrat);
router.put('/:id/contrats/:contratId', requireAuth, requireService('UTILISATEURS'), handleContratUpload, updateContrat);
router.delete('/:id/contrats/:contratId', requireAuth, requireService('UTILISATEURS'), deleteContrat);
router.post('/:id/salaires', requireAuth, requireService('UTILISATEURS'), createSalaire);
router.put('/:id/salaires/:salaireId', requireAuth, requireService('UTILISATEURS'), updateSalaire);
router.delete('/:id/salaires/:salaireId', requireAuth, requireService('UTILISATEURS'), deleteSalaire);
router.get('/:id/indisponibilites', requireAuth, requireService('UTILISATEURS'), listIndispos);
router.post('/:id/indisponibilites', requireAuth, requireService('UTILISATEURS'), handleIndispoUpload, createIndispo);
router.put('/:id/indisponibilites/:indispoId', requireAuth, requireService('UTILISATEURS'), handleIndispoUpload, updateIndispo);
router.delete('/:id/indisponibilites/:indispoId', requireAuth, requireService('UTILISATEURS'), deleteIndispo);
router.get('/:id/materiel', requireAuth, requireService('UTILISATEURS'), listMaterielsUser);
router.get('/:id/comptes', requireAuth, requireService('UTILISATEURS'), listComptes);
router.post('/:id/comptes', requireAuth, requireService('UTILISATEURS'), createCompte);
router.put('/:id/comptes/:compteId', requireAuth, requireService('UTILISATEURS'), updateCompte);
router.patch('/:id/comptes/:compteId/active', requireAuth, requireService('UTILISATEURS'), setCompteActive);

module.exports = router;
