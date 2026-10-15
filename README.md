# OSMAN EXPRESS — plateforme de gestion de livraison

Application web de gestion de colis (agences, livreurs, clients e-commerce, bons, factures, stock).

- `backend/` : API Node.js (Express 4, MySQL via `mysql2`), sert aussi le frontend compilé.
- `frontend/` : interface React 18 (Vite 5) : espaces admin, client et livreur + site public en arabe.

## Prérequis

- Node.js 24.x
- MySQL 8 (base en `utf8mb4_unicode_ci`)

## Installation

1. Copier `backend/.env.example` vers `backend/.env` et renseigner :
   - accès MySQL (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) ;
   - `JWT_SECRET` (48 octets aléatoires, commande indiquée dans le fichier) ;
   - `CLIENT_ORIGIN` (URL du site) et, en production, `UPLOADS_DIR` (dossier des fichiers envoyés, hors du code).
2. Importer la base de données (structure `delevery_*` et données) dans la base indiquée par `DB_NAME`, créer les tables et colonnes propres à l'application (fichiers `sql/01` à `sql/04`, voir `sql/LISEZMOI.md`), puis exécuter le script d'adaptation :

   ```bash
   mysql -u <utilisateur> -p <base> < backend/sql/apres-import.sql
   ```

   Ce script retire les tables du CRM WhatsApp, renomme les clés de configuration propres à l'application (préfixe `app_`) et installe l'identité OSMAN EXPRESS. Il ne nettoie pas les données métier.
3. Installer et compiler :

   ```bash
   npm run build      # dépendances + build du frontend, dépendances de production du backend
   npm start          # démarre l'API (port PORT, 5000 par défaut) qui sert aussi frontend/dist
   ```

   En développement : `cd backend && npm run dev` et `cd frontend && npm run dev` (Vite sur le port 5173, proxy `/api` et `/uploads` vers le port 5000).

## Premier compte administrateur

La connexion des employés se fait par e-mail. Si la base importée ne contient pas de super-administrateur (`delevery_users.users_type = '1'`, `users_active = 1`), générer un mot de passe chiffré :

```bash
cd backend && node scripts/hash-password.js "MotDePasse"
```

puis insérer la ligne dans `delevery_users` avec ce hash dans `users_password`. Changer ce mot de passe dès la première connexion.

## Personnalisation

- **Logo, favicon, couleurs, informations légales (ICE, RC, IF, CNSS), contrats** : Admin > Configuration > Plateforme. Ces valeurs sont enregistrées en base et priment sur les valeurs par défaut du code.
- **Papier à en-tête des PDF** (bons, factures) : image fixe `frontend/src/assets/papier-entete.jpg` (logo, adresse, téléphone, email, sans filigrane), non modifiable depuis l'administration. Pour la changer, remplacer ce fichier (A4 portrait, 1600 px de large) et reconstruire le frontend.
- **Valeurs par défaut de la marque** (nom, nom arabe, domaine, e-mail, coordonnées et mentions légales du site public, messages pré-remplis) : `frontend/src/config/brand.js` et `backend/src/config/brand.js`. Les champs marqués `À COMPLÉTER` doivent être renseignés avant la mise en ligne.
- **Logo du site public** : `frontend/public/home/header-logo.png` (et `favicon.png`). Le script `backend/scripts/make-brand-assets.js` les régénère depuis un logo source, ainsi que les copies utilisées par l'admin dans `backend/uploads/branding/`.
- **Message WhatsApp du livreur** : Admin > Configuration > Options. Il alimente un simple lien `wa.me` ; l'application n'utilise pas l'API WhatsApp de Meta.

## Fichiers envoyés

`backend/uploads/` (ou `UPLOADS_DIR`) : `branding/` (logo, favicon), `contrats/`, `messages/`, `preuves/`, `products/`, `users/`, `sons/`. Sauvegarder ce dossier avec la base de données.
