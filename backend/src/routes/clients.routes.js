const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireService, requireKind } = require('../middleware/auth');
const { requireClientOwner, requireClientPermission } = require('../middleware/clientAccess');
const {
  listEquipe,
  createMembre,
  updateMembre,
  setMembreActive,
  deleteMembre,
  getMonCompteMembre,
  updateMonCompteMembre
} = require('../controllers/clientEquipe.controller');
const {
  listClients,
  listFiltres,
  createClient,
  setActive,
  setVerified,
  setOptions,
  getOptions,
  getMyConfig,
  updateMyConfig
} = require('../controllers/clients.controller');
const {
  getFiche,
  getFicheOptions,
  updateCompteTarifs,
  updateCompteSelf,
  demanderFicheSelf,
  annulerDemandeSelf,
  accepterDemandeFiche,
  refuserDemandeFiche,
  listDemandesEnAttente,
  listTarifs,
  appliquerTarifs,
  updateTarif,
  updateTarifAutre,
  deleteTarif,
  updateFiche,
  ensureUploadDir,
  FILE_FIELDS,
  IMAGE_FIELDS
} = require('../controllers/clientsFiche.controller');

/* Fichiers de la fiche client (onglet "Informations") :
 * logo du brand = image, documents (CIN, RIB, contrat…) = PDF. */
const PDF_EXT = ['.pdf'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

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
    const allowed = IMAGE_FIELDS.includes(file.fieldname) ? IMAGE_EXT : PDF_EXT;
    if (!allowed.includes(ext)) {
      return cb(
        new Error(
          IMAGE_FIELDS.includes(file.fieldname)
            ? 'Format non autorisé (image PNG / JPG / WEBP attendue).'
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

// Espace client : préférences du compte connecté (page /client/configuration).
router.get('/me/config', requireAuth, requireKind('customer'), requireClientPermission('CONFIGURATION'), getMyConfig);
router.patch('/me/config', requireAuth, requireKind('customer'), requireClientPermission('CONFIGURATION'), updateMyConfig);

// Espace client : gestion d'équipe (page /client/equipe), réservée au
// propriétaire du compte — un membre ne peut pas gérer les tâches des autres.
router.get('/me/equipe', requireAuth, requireKind('customer'), requireClientOwner, listEquipe);
router.post('/me/equipe', requireAuth, requireKind('customer'), requireClientOwner, createMembre);
router.put('/me/equipe/:memberId', requireAuth, requireKind('customer'), requireClientOwner, updateMembre);
router.patch('/me/equipe/:memberId/active', requireAuth, requireKind('customer'), requireClientOwner, setMembreActive);
router.delete('/me/equipe/:memberId', requireAuth, requireKind('customer'), requireClientOwner, deleteMembre);

/*
 * Espace client : « Ma fiche » (menu avatar), réservée au propriétaire du
 * compte. On force req.params.id sur l'id du client connecté puis on réutilise
 * les contrôleurs de la fiche admin. Seuls l'email / le mot de passe sont
 * appliqués directement (PUT /me/compte) ; les périodicités de ramassage et
 * de facturation ainsi que l'onglet Informations passent par une demande à
 * valider par l'admin (delevery_client_fiche_demande) ; les tarifs ne sont
 * pas exposés.
 */
function selfCustomer(req, res, next) {
  req.params.id = String(req.user.id);
  next();
}

router.get('/me/fiche', requireAuth, requireKind('customer'), requireClientOwner, selfCustomer, getFiche);
router.get('/me/fiche/options', requireAuth, requireKind('customer'), requireClientOwner, getFicheOptions);
router.put('/me/fiche', requireAuth, requireKind('customer'), requireClientOwner, selfCustomer, handleFicheUpload, demanderFicheSelf);
router.put('/me/compte', requireAuth, requireKind('customer'), requireClientOwner, selfCustomer, updateCompteSelf);
router.delete('/me/demandes/:type', requireAuth, requireKind('customer'), requireClientOwner, selfCustomer, annulerDemandeSelf);

// « Ma fiche » d'un membre d'équipe (sous-compte) : uniquement ses
// identifiants de connexion — le contrôleur exige un memberId dans le JWT.
router.get('/me/membre-compte', requireAuth, requireKind('customer'), getMonCompteMembre);
router.put('/me/membre-compte', requireAuth, requireKind('customer'), updateMonCompteMembre);

router.get('/', requireAuth, requireService('CLIENTS'), listClients);
router.post('/', requireAuth, requireService('CLIENTS'), createClient);
router.get('/filtres', requireAuth, requireService('CLIENTS'), listFiltres);
// Fiche client (/admin/clients/:id) — /fiche/options et /demandes/en-attente avant /:id.
router.get('/fiche/options', requireAuth, requireService('CLIENTS'), getFicheOptions);
router.get('/demandes/en-attente', requireAuth, requireService('CLIENTS'), listDemandesEnAttente);
router.get('/:id', requireAuth, requireService('CLIENTS'), getFiche);
router.put('/:id/compte-tarifs', requireAuth, requireService('CLIENTS'), updateCompteTarifs);
router.put('/:id/fiche', requireAuth, requireService('CLIENTS'), handleFicheUpload, updateFiche);
router.get('/:id/tarifs', requireAuth, requireService('CLIENTS'), listTarifs);
router.post('/:id/tarifs/appliquer', requireAuth, requireService('CLIENTS'), appliquerTarifs);
// "autre" avant :tarifId pour que la ligne des villes non personnalisées matche en premier.
router.put('/:id/tarifs/autre', requireAuth, requireService('CLIENTS'), updateTarifAutre);
router.put('/:id/tarifs/:tarifId', requireAuth, requireService('CLIENTS'), updateTarif);
router.delete('/:id/tarifs/:tarifId', requireAuth, requireService('CLIENTS'), deleteTarif);
// Demandes de modification envoyées depuis « Ma fiche » du client.
router.post('/:id/demandes/:demandeId/accepter', requireAuth, requireService('CLIENTS'), accepterDemandeFiche);
router.post('/:id/demandes/:demandeId/refuser', requireAuth, requireService('CLIENTS'), refuserDemandeFiche);
router.patch('/:id/active', requireAuth, requireService('CLIENTS'), setActive);
router.patch('/:id/verified', requireAuth, requireService('CLIENTS'), setVerified);
router.get('/:id/options', requireAuth, requireService('CLIENTS'), getOptions);
router.patch('/:id/options', requireAuth, requireService('CLIENTS'), setOptions);

module.exports = router;
