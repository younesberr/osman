require('dotenv').config();
const { BRAND } = require('./config/brand');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const platformRoutes = require('./routes/platform.routes');
const parcelsRoutes = require('./routes/parcels.routes');
const usersRoutes = require('./routes/users.routes');
const livreursRoutes = require('./routes/livreurs.routes');
const clientsRoutes = require('./routes/clients.routes');
const configRoutes = require('./routes/config.routes');
const stockRoutes = require('./routes/stock.routes');
const messagesRoutes = require('./routes/messages.routes');
const bonsEnvoiRoutes = require('./routes/bonsEnvoi.routes');
const bonsSortieRoutes = require('./routes/bonsSortie.routes');
const bonsDistributionRoutes = require('./routes/bonsDistribution.routes');
const bonsRetourLivreurRoutes = require('./routes/bonsRetourLivreur.routes');
const bonsRetourClientRoutes = require('./routes/bonsRetourClient.routes');
const facturesLivreursRoutes = require('./routes/facturesLivreurs.routes');
const fraisLivreursRoutes = require('./routes/fraisLivreurs.routes');
const fraisClientsRoutes = require('./routes/fraisClients.routes');
const facturesClientsRoutes = require('./routes/facturesClients.routes');
const demandesRamassageRoutes = require('./routes/demandesRamassage.routes');
const reclamationsRoutes = require('./routes/reclamations.routes');
const remboursementsRoutes = require('./routes/remboursements.routes');
const modificationsColisRoutes = require('./routes/modificationsColis.routes');
const publicRoutes = require('./routes/public.routes');
const nouveauxClientsRoutes = require('./routes/nouveauxClients.routes');
const caisseAgenceRoutes = require('./routes/caisseAgence.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const logistiquesRoutes = require('./routes/logistiques.routes');
const materielRoutes = require('./routes/materiel.routes');
const statistiquesRoutes = require('./routes/statistiques.routes');
const pool = require('./config/db');
const UPLOADS_ROOT = require('./config/uploadsRoot');
const { startRamassagePeriodique } = require('./jobs/ramassagePeriodique');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('ERREUR: JWT_SECRET manquant ou trop court (min 32 caractères) dans .env');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Derrière le proxy de l'hébergeur (TLS terminé en amont) : IP client réelle
// pour express-rate-limit et cookies secure.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        // Polices (Cairo, Font Awesome) auto-hébergées dans le build Vite : aucune origine externe.
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'data:'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        // Retiré des défauts : casserait les tests locaux du build sur http://localhost.
        'upgrade-insecure-requests': null
      }
    }
  })
);
app.use(
  cors({
    origin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(','),
    credentials: true
  })
);
// 2 Mo : les imports Excel de colis (jusqu'à 500 lignes, POST /api/parcels/
// import*) envoient un JSON qui dépasse largement les 10 Ko par défaut.
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Trop de requêtes, veuillez patienter.' }
  })
);

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch {
    res.status(503).json({ status: 'ok', db: 'down' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/parcels', parcelsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/livreurs', livreursRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/bons-envoi', bonsEnvoiRoutes);
app.use('/api/bons-sortie', bonsSortieRoutes);
app.use('/api/bons-distribution', bonsDistributionRoutes);
app.use('/api/bons-retour-livreur', bonsRetourLivreurRoutes);
app.use('/api/bons-retour-client', bonsRetourClientRoutes);
app.use('/api/factures-livreurs', facturesLivreursRoutes);
app.use('/api/frais-livreurs', fraisLivreursRoutes);
app.use('/api/frais-clients', fraisClientsRoutes);
app.use('/api/factures-clients', facturesClientsRoutes);
app.use('/api/demandes-ramassage', demandesRamassageRoutes);
app.use('/api/reclamations', reclamationsRoutes);
app.use('/api/remboursements', remboursementsRoutes);
app.use('/api/modifications-colis', modificationsColisRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/nouveaux-clients', nouveauxClientsRoutes);
app.use('/api/caisse-agence', caisseAgenceRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/logistiques', logistiquesRoutes);
app.use('/api/materiel', materielRoutes);
app.use('/api/statistiques', statistiquesRoutes);

// Fichiers uploadés (branding, fiches, pièces jointes…). En production,
// UPLOADS_DIR pointe hors du checkout git : voir src/config/uploadsRoot.js.
fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
app.use(
  '/uploads',
  express.static(UPLOADS_ROOT, {
    maxAge: '1h',
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  })
);

// Frontend buildé : servi par la même app Express (même origine que l'API).
// Absent en dev local (Vite dev server) grâce au garde existsSync.
const DIST_DIR = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        // Assets Vite hashés : cache long ; le reste : revalidation.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      }
    })
  );
  // Fallback SPA (BrowserRouter) : toute navigation GET hors /api et /uploads.
  app.get('*', (req, res, next) => {
    if (
      req.path === '/api' ||
      req.path.startsWith('/api/') ||
      req.path === '/uploads' ||
      req.path.startsWith('/uploads/')
    ) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ message: 'Route introuvable.' }));

// Gestionnaire d'erreurs : ne divulgue jamais les détails internes au client.
app.use((err, req, res, next) => {
  // Erreurs du parseur JSON (body-parser) : corps trop gros ou mal formé →
  // réponse 4xx explicite plutôt qu'un 500 opaque.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Données envoyées trop volumineuses (max 2 Mo).' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Corps de la requête invalide.' });
  }
  console.error(`[${new Date().toISOString()}]`, err.message);
  res.status(500).json({ message: 'Erreur interne du serveur.' });
});

const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`${BRAND.name} API démarrée sur http://localhost:${PORT}`);
  // Demandes de ramassage périodiques (12h00, jours de la fiche client).
  startRamassagePeriodique();
});
