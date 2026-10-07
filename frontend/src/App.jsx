import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
import PageTitle from './components/PageTitle';
import ServiceRoute from './components/ServiceRoute';
import ClientServiceRoute from './components/ClientServiceRoute';
import AdminLayout from './components/AdminLayout';
import ClientLayout from './components/ClientLayout';
import LivreurLayout from './components/LivreurLayout';
import EmptyPage from './pages/admin/EmptyPage';
import { adminPages, GESTION_STOCK_TYPES } from './config/adminMenu';
import { clientPages } from './config/clientMenu';
import { livreurPages } from './config/livreurMenu';

/**
 * Chargement différé (React.lazy) : chaque page part dans son propre chunk
 * Vite, téléchargé à la première visite de la route. Le bundle initial ne
 * contient plus que le socle (routeur, contextes, layouts, page d'accueil
 * publique et connexion) — score mobile de la page d'accueil. Les chunks
 * périmés après un déploiement sont gérés par vite:preloadError (main.jsx).
 */

/** Indicateur affiché le temps de télécharger le chunk d'une page. */
const PageLoader = () => <div className="page-loader">Chargement…</div>;

const Register = lazy(() => import('./pages/Register'));
const TarifsPublic = lazy(() => import('./pages/TarifsPublic'));
const ContratPublic = lazy(() => import('./pages/ContratPublic'));
const MentionsLegales = lazy(() => import('./pages/MentionsLegales'));
const ConditionsUtilisation = lazy(() => import('./pages/ConditionsUtilisation'));
const Accueil = lazy(() => import('./pages/admin/Accueil'));
const ClientAccueil = lazy(() => import('./pages/client/Accueil'));
const ClientColis = lazy(() => import('./pages/client/Colis'));
const ClientNouveauColis = lazy(() => import('./pages/client/NouveauColis'));
const ClientProduits = lazy(() => import('./pages/client/Produits'));
const ClientMouvementsStock = lazy(() => import('./pages/client/MouvementsStock'));
const ClientNouveauProduit = lazy(() => import('./pages/client/NouveauProduit'));
const ClientFicheProduit = lazy(() => import('./pages/client/FicheProduit'));
const ClientConfiguration = lazy(() => import('./pages/client/Configuration'));
const ClientEquipe = lazy(() => import('./pages/client/Equipe'));
const ClientMessages = lazy(() => import('./pages/client/Messages'));
const ClientFactures = lazy(() => import('./pages/client/Factures'));
const ClientBonsRetour = lazy(() => import('./pages/client/BonsRetour'));
const ClientImportColisNormal = lazy(() => import('./pages/client/ImportColisNormal'));
const ClientStatistiques = lazy(() => import('./pages/client/Statistiques'));
const ClientDemandeRamassage = lazy(() => import('./pages/client/DemandeRamassage'));
const ClientImportColisStock = lazy(() => import('./pages/client/ImportColisStock'));
const ClientApiComingSoon = lazy(() => import('./pages/client/ApiComingSoon'));
const ClientDocumentationApi = lazy(() => import('./pages/client/DocumentationApi'));
const LivreurAccueil = lazy(() => import('./pages/livreur/Accueil'));
const LivreurColis = lazy(() => import('./pages/livreur/Colis'));
const LivreurChangerStatutScan = lazy(() => import('./pages/livreur/ChangerStatutScan'));
const LivreurBonPaiement = lazy(() => import('./pages/livreur/BonPaiement'));
const LivreurBonsDistribution = lazy(() => import('./pages/livreur/BonsDistribution'));
const LivreurDocumentationApi = lazy(() => import('./pages/livreur/DocumentationApi'));
const PlatformSettings = lazy(() => import('./pages/admin/PlatformSettings'));
const Options = lazy(() => import('./pages/admin/Options'));
const Colis = lazy(() => import('./pages/admin/Colis'));
const AdminNouveauColis = lazy(() => import('./pages/admin/NouveauColis'));
const Inventaire = lazy(() => import('./pages/admin/Inventaire'));
const MouvementsProduits = lazy(() => import('./pages/admin/MouvementsProduits'));
const ColisEnAttente = lazy(() => import('./pages/admin/ColisEnAttente'));
const NouveauProduit = lazy(() => import('./pages/admin/NouveauProduit'));
const FicheProduit = lazy(() => import('./pages/admin/FicheProduit'));
const Utilisateurs = lazy(() => import('./pages/admin/Utilisateurs'));
const FicheUtilisateur = lazy(() => import('./pages/admin/FicheUtilisateur'));
const Livreurs = lazy(() => import('./pages/admin/Livreurs'));
const FicheLivreur = lazy(() => import('./pages/admin/FicheLivreur'));
const Clients = lazy(() => import('./pages/admin/Clients'));
const FicheClient = lazy(() => import('./pages/admin/FicheClient'));
const Agences = lazy(() => import('./pages/admin/Agences'));
const Zones = lazy(() => import('./pages/admin/Zones'));
const Villes = lazy(() => import('./pages/admin/Villes'));
const Tarifs = lazy(() => import('./pages/admin/Tarifs'));
const MessagesClients = lazy(() => import('./pages/admin/MessagesClients'));
const Reclamations = lazy(() => import('./pages/admin/Reclamations'));
const RamassageScan = lazy(() => import('./pages/admin/RamassageScan'));
const Ramassage = lazy(() => import('./pages/admin/Ramassage'));
const BonsEnvoi = lazy(() => import('./pages/admin/BonsEnvoi'));
const BonEnvoiEdit = lazy(() => import('./pages/admin/BonEnvoiEdit'));
const BonsDistribution = lazy(() => import('./pages/admin/BonsDistribution'));
const BonDistributionEdit = lazy(() => import('./pages/admin/BonDistributionEdit'));
const BonsRetourLivreur = lazy(() => import('./pages/admin/BonsRetourLivreur'));
const BonRetourLivreurEdit = lazy(() => import('./pages/admin/BonRetourLivreurEdit'));
const BonsRetourClient = lazy(() => import('./pages/admin/BonsRetourClient'));
const BonRetourClientEdit = lazy(() => import('./pages/admin/BonRetourClientEdit'));
const BonsSortie = lazy(() => import('./pages/admin/BonsSortie'));
const BonSortieEdit = lazy(() => import('./pages/admin/BonSortieEdit'));
const FacturesLivreurs = lazy(() => import('./pages/admin/FacturesLivreurs'));
const FraisLivreurs = lazy(() => import('./pages/admin/FraisLivreurs'));
const CaisseAgence = lazy(() => import('./pages/admin/CaisseAgence'));
const FraisClients = lazy(() => import('./pages/admin/FraisClients'));
const FactureLivreurEdit = lazy(() => import('./pages/admin/FactureLivreurEdit'));
const FacturesClients = lazy(() => import('./pages/admin/FacturesClients'));
const FactureClientEdit = lazy(() => import('./pages/admin/FactureClientEdit'));
const ImportColisNormal = lazy(() => import('./pages/admin/ImportColisNormal'));
const ImportColisStock = lazy(() => import('./pages/admin/ImportColisStock'));
const Remboursements = lazy(() => import('./pages/admin/Remboursements'));
const ModificationsColis = lazy(() => import('./pages/admin/ModificationsColis'));
const NouveauxClients = lazy(() => import('./pages/admin/NouveauxClients'));
const NotificationsClients = lazy(() => import('./pages/admin/NotificationsClients'));
const NotificationsEmployes = lazy(() => import('./pages/admin/NotificationsEmployes'));
const Logistiques = lazy(() => import('./pages/admin/Logistiques'));
const FicheLogistique = lazy(() => import('./pages/admin/FicheLogistique'));
const Materiel = lazy(() => import('./pages/admin/Materiel'));
const StatistiquesGlobales = lazy(() => import('./pages/admin/StatistiquesGlobales'));

/** Pages admin développées ; les autres chemins retombent sur EmptyPage. */
const PAGE_COMPONENTS = {
  '/admin/colis': Colis,
  '/admin/import-colis/normal': ImportColisNormal,
  '/admin/import-colis/stock': ImportColisStock,
  '/admin/stock/inventaire': Inventaire,
  '/admin/stock/mouvement-produits': MouvementsProduits,
  '/admin/stock/colis-en-attente': ColisEnAttente,
  '/admin/stock/bon-de-sortie': BonsSortie,
  '/admin/ramassage-scan': RamassageScan,
  '/admin/ramassage': Ramassage,
  '/admin/bons-envoi': BonsEnvoi,
  '/admin/bons-distribution': BonsDistribution,
  '/admin/bons-retour/livreur': BonsRetourLivreur,
  '/admin/bons-retour/client': BonsRetourClient,
  '/admin/remboursement': Remboursements,
  '/admin/modifications-colis': ModificationsColis,
  '/admin/nouveaux-clients': NouveauxClients,
  '/admin/facturation-livreurs/frais-supplementaires': FraisLivreurs,
  '/admin/facturation-livreurs/factures': FacturesLivreurs,
  '/admin/facturation-clients/frais-supplementaires': FraisClients,
  '/admin/facturation-clients/factures': FacturesClients,
  '/admin/reclamations': Reclamations,
  '/admin/livreurs': Livreurs,
  '/admin/clients': Clients,
  '/admin/caisse-agence': CaisseAgence,
  '/admin/utilisateurs': Utilisateurs,
  '/admin/logistiques': Logistiques,
  '/admin/materiel': Materiel,
  '/admin/statistiques/globales': StatistiquesGlobales,
  '/admin/messages/clients': MessagesClients,
  '/admin/notifications/employes': NotificationsEmployes,
  '/admin/notifications/clients': NotificationsClients,
  '/admin/configuration/agences': Agences,
  '/admin/configuration/zones': Zones,
  '/admin/configuration/villes': Villes,
  '/admin/configuration/tarifs': Tarifs,
  '/admin/configuration/options': Options,
  '/admin/configuration/plateforme': PlatformSettings
};

/** Bons de retour du livreur connecté : page admin réutilisée en mode « self ». */
const LivreurBonsRetour = () => <BonsRetourLivreur self />;

/** Pages livreur développées ; les autres chemins retombent sur EmptyPage. */
const LIVREUR_PAGE_COMPONENTS = {
  '/livreur/changer-statut': LivreurChangerStatutScan,
  '/livreur/colis': LivreurColis,
  '/livreur/bon-distribution': LivreurBonsDistribution,
  '/livreur/bon-paiement': LivreurBonPaiement,
  '/livreur/bon-retour': LivreurBonsRetour,
  '/livreur/api': LivreurDocumentationApi
};

/** API liaison : connecteurs boutique en attente (page « Coming soon »). */
const ClientApiWooCommerce = () => <ClientApiComingSoon platform="woocommerce" />;
const ClientApiShopify = () => <ClientApiComingSoon platform="shopify" />;

/** Pages client développées ; les autres chemins retombent sur EmptyPage. */
const CLIENT_PAGE_COMPONENTS = {
  '/client/colis': ClientColis,
  '/client/nouveau-colis': ClientNouveauColis,
  '/client/import-colis/normal': ClientImportColisNormal,
  '/client/import-colis/stock': ClientImportColisStock,
  '/client/demande-ramassage': ClientDemandeRamassage,
  '/client/stock/produits': ClientProduits,
  '/client/stock/mouvements': ClientMouvementsStock,
  '/client/factures': ClientFactures,
  '/client/bon-de-retour': ClientBonsRetour,
  '/client/messages': ClientMessages,
  '/client/statistiques': ClientStatistiques,
  '/client/equipe': ClientEquipe,
  '/client/api/woocommerce': ClientApiWooCommerce,
  '/client/api/shopify': ClientApiShopify,
  '/client/api/documentation': ClientDocumentationApi,
  '/client/configuration': ClientConfiguration
};

export default function App() {
  return (
    <>
      <PageTitle />
      <Suspense fallback={<PageLoader />}>
        <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        {/* Pages publiques liées depuis la page d'accueil. */}
        <Route path="/register" element={<Register />} />
        <Route path="/tarifs" element={<TarifsPublic />} />
        <Route path="/mentions-legales" element={<MentionsLegales />} />
        <Route path="/contrat" element={<ContratPublic />} />
        <Route path="/conditions-utilisation" element={<ConditionsUtilisation />} />
        <Route
          path="/client"
          element={
            <ProtectedRoute dashboard="client">
              <ClientLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<ClientAccueil />} />
          {/* Page hors menu : fiche du client connecté (menu avatar → Ma fiche).
              Propriétaire : fiche complète ; membre d'équipe (sous-compte) :
              version réduite à ses identifiants de connexion (MaFicheMembre). */}
          <Route path="ma-fiche" element={<FicheClient self />} />
          {/* Page hors menu : création d'un produit depuis la liste des produits. */}
          <Route
            path="stock/produits/nouveau"
            element={
              <ClientServiceRoute service="STOCK_PRODUITS">
                <ClientNouveauProduit />
              </ClientServiceRoute>
            }
          />
          {/* Page hors menu : fiche d'un produit (Modifier depuis la liste). */}
          <Route
            path="stock/produits/:id"
            element={
              <ClientServiceRoute service="STOCK_PRODUITS">
                <ClientFicheProduit />
              </ClientServiceRoute>
            }
          />
          {/* Pages du menu client : développées au fur et à mesure, sinon EmptyPage.
              Les membres d'équipe sont limités à leurs tâches (ClientServiceRoute). */}
          {clientPages().map((page) => {
            const PageComponent = CLIENT_PAGE_COMPONENTS[page.path];
            return (
              <Route
                key={page.path}
                path={page.path.replace('/client/', '')}
                element={
                  <ClientServiceRoute service={page.service}>
                    {PageComponent ? <PageComponent /> : <EmptyPage title={page.label} />}
                  </ClientServiceRoute>
                }
              />
            );
          })}
        </Route>
        <Route
          path="/admin"
          element={
            <ProtectedRoute dashboard="admin">
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Accueil />} />
          {/* Page hors menu : fiche du compte connecté (menu avatar → Ma fiche).
              Accessible à tout employé du dashboard admin, sans ServiceRoute. */}
          <Route path="ma-fiche" element={<FicheUtilisateur self />} />
          {/* Page de détail hors menu : fiche d'un utilisateur (Voir détail). */}
          <Route
            path="utilisateurs/:id"
            element={
              <ServiceRoute service="UTILISATEURS">
                <FicheUtilisateur />
              </ServiceRoute>
            }
          />
          {/* Page de détail hors menu : fiche d'un livreur (Voir détail). */}
          <Route
            path="livreurs/:id"
            element={
              <ServiceRoute service="LIVREURS">
                <FicheLivreur />
              </ServiceRoute>
            }
          />
          {/* Page de détail hors menu : fiche d'un client (Modifier la fiche). */}
          <Route
            path="clients/:id"
            element={
              <ServiceRoute service="CLIENTS">
                <FicheClient />
              </ServiceRoute>
            }
          />
          {/* Page de détail hors menu : fiche d'un moyen logistique (Plus d'info). */}
          <Route
            path="logistiques/:id"
            element={
              <ServiceRoute service="LOGISTIQUES">
                <FicheLogistique />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'un bon d'envoi. */}
          <Route
            path="bons-envoi/:id"
            element={
              <ServiceRoute service="BON_ENVOI">
                <BonEnvoiEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'un bon de distribution. */}
          <Route
            path="bons-distribution/:id"
            element={
              <ServiceRoute service="BON_DISTRIBUTION">
                <BonDistributionEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'un bon de retour livreur. */}
          <Route
            path="bons-retour/livreur/:id"
            element={
              <ServiceRoute service="RETOUR">
                <BonRetourLivreurEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'un bon de retour client. */}
          <Route
            path="bons-retour/client/:id"
            element={
              <ServiceRoute service="RETOUR">
                <BonRetourClientEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'une facture livreur. */}
          <Route
            path="facturation-livreurs/factures/:id"
            element={
              <ServiceRoute service="FACTURATION">
                <FactureLivreurEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'une facture client. */}
          <Route
            path="facturation-clients/factures/:id"
            element={
              <ServiceRoute service="FACTURATION">
                <FactureClientEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création / modification d'un bon de sortie de stock. */}
          <Route
            path="stock/bon-de-sortie/:id"
            element={
              <ServiceRoute service="STOCK">
                <BonSortieEdit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création d'un colis au nom d'un client (page Colis). */}
          <Route
            path="colis/nouveau"
            element={
              <ServiceRoute service="COLIS">
                <AdminNouveauColis />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : création d'un produit depuis l'inventaire. */}
          <Route
            path="stock/inventaire/nouveau"
            element={
              <ServiceRoute service="STOCK" types={GESTION_STOCK_TYPES}>
                <NouveauProduit />
              </ServiceRoute>
            }
          />
          {/* Page hors menu : fiche d'un produit (Modifier depuis l'inventaire). */}
          <Route
            path="stock/inventaire/:id"
            element={
              <ServiceRoute service="STOCK" types={GESTION_STOCK_TYPES}>
                <FicheProduit />
              </ServiceRoute>
            }
          />
          {/* Ancien chemin unique de Notifications employés → sous-page Employés. */}
          <Route
            path="notifications-employes"
            element={<Navigate to="/admin/notifications/employes" replace />}
          />
          {/* Ancien chemin unique de Statistiques → sous-page Globales. */}
          <Route
            path="statistiques"
            element={<Navigate to="/admin/statistiques/globales" replace />}
          />
          {adminPages().map((page) => {
            const PageComponent = PAGE_COMPONENTS[page.path];
            return (
              <Route
                key={page.path}
                path={page.path.replace('/admin/', '')}
                element={
                  <ServiceRoute service={page.service} types={page.types}>
                    {PageComponent ? <PageComponent /> : <EmptyPage title={page.label} />}
                  </ServiceRoute>
                }
              />
            );
          })}
        </Route>
        <Route
          path="/livreur"
          element={
            <ProtectedRoute dashboard="livreur">
              <LivreurLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<LivreurAccueil />} />
          {/* Page hors menu : fiche du livreur connecté (menu avatar → Ma fiche). */}
          <Route path="ma-fiche" element={<FicheLivreur self />} />
          {/* Page hors menu : création / modification d'un bon de retour du livreur. */}
          <Route path="bon-retour/:id" element={<BonRetourLivreurEdit self />} />
          {/* Pages du menu livreur : développées au fur et à mesure, sinon EmptyPage. */}
          {livreurPages().map((page) => {
            const PageComponent = LIVREUR_PAGE_COMPONENTS[page.path];
            return (
              <Route
                key={page.path}
                path={page.path.replace('/livreur/', '')}
                element={PageComponent ? <PageComponent /> : <EmptyPage title={page.label} />}
              />
            );
          })}
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
