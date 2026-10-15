import {
  Home,
  Package,
  Download,
  Warehouse,
  ScanLine,
  Send,
  Truck,
  FileText,
  ReceiptText,
  Undo2,
  PackageOpen,
  HandCoins,
  MessageSquareWarning,
  PencilLine,
  MessagesSquare,
  UserPlus,
  Users,
  Landmark,
  BellRing,
  Bike,
  UserCog,
  Boxes,
  Wrench,
  BarChart3,
  Settings
} from 'lucide-react';

/**
 * Menu du dashboard admin.
 * `service` = code stocké dans delevery_users.users_services (liste séparée par des virgules).
 * Un item sans `service` est visible par tous les employés du dashboard admin.
 * Les sous-menus héritent du code d'accès de leur parent, sauf s'ils portent leur
 * propre `service` : ce code remplace alors celui du
 * parent pour ce sous-menu seul, et le parent reste affiché dès qu'un de ses
 * sous-menus est accessible (voir childService, AdminLayout). `serviceLabel` =
 * libellé de la case à cocher de Utilisateurs › Comptes (sinon libellé du menu).
 * `types` restreint en plus un item aux fonctions listées (users_type, superAdmin
 * toujours admis).
 */

/** Fonctions autorisées sur Inventaire / Mouvement produits : le ramasseur (type 6)
 *  n'a droit qu'à « Colis en attente » et « Bon de sortie ». Miroir backend : stock.routes.js. */
export const GESTION_STOCK_TYPES = [1, 2, 3, 4];
/** Fonctions qui ont la page Accueil (tableau de bord) : le ramasseur (type 6) n'en a
 *  pas, il arrive sur Ramassage par scan (adminHomePath). Miroir backend : dashboard.routes.js. */
export const ACCUEIL_TYPES = [1, 2, 3, 4];
/** Page d'arrivée des fonctions sans Accueil. */
const HOME_SANS_ACCUEIL = '/admin/ramassage-scan';
export const ADMIN_MENU = [
  { label: 'Accueil', path: '/admin', icon: Home, types: ACCUEIL_TYPES },
  { label: 'Colis', path: '/admin/colis', icon: Package, service: 'COLIS' },
  {
    label: 'Import Colis',
    icon: Download,
    // Code legacy « IMPORT » : delevery_users.users_services est partagé avec l'ancien système.
    service: 'IMPORT',
    children: [
      { label: 'Import Colis normal', path: '/admin/import-colis/normal' },
      { label: 'Import Colis de stock', path: '/admin/import-colis/stock' }
    ]
  },
  {
    label: 'Gestion de stock',
    icon: Warehouse,
    service: 'STOCK',
    children: [
      { label: 'Inventaire', path: '/admin/stock/inventaire', types: GESTION_STOCK_TYPES },
      { label: 'Mouvement produits', path: '/admin/stock/mouvement-produits', types: GESTION_STOCK_TYPES },
      { label: 'Colis en attente', path: '/admin/stock/colis-en-attente' },
      { label: 'Bon de sortie', path: '/admin/stock/bon-de-sortie' }
    ]
  },
  { label: 'Ramassage par scan', path: '/admin/ramassage-scan', icon: ScanLine, service: 'RAMASSAGE_SCAN' },
  { label: "Bons d'envoi", path: '/admin/bons-envoi', icon: Send, service: 'BON_ENVOI' },
  { label: 'Bons de distribution', path: '/admin/bons-distribution', icon: Truck, service: 'BON_DISTRIBUTION' },
  {
    label: 'Facturation livreurs',
    icon: FileText,
    service: 'FACTURATION',
    children: [
      { label: 'Frais supplémentaires', path: '/admin/facturation-livreurs/frais-supplementaires' },
      { label: 'Factures', path: '/admin/facturation-livreurs/factures' }
    ]
  },
  {
    label: 'Facturation clients',
    icon: ReceiptText,
    service: 'FACTURATION',
    children: [
      { label: 'Frais supplémentaires', path: '/admin/facturation-clients/frais-supplementaires' },
      { label: 'Factures', path: '/admin/facturation-clients/factures' }
    ]
  },
  {
    label: 'Bons de retour',
    icon: Undo2,
    service: 'RETOUR',
    children: [
      { label: 'Livreur', path: '/admin/bons-retour/livreur' },
      { label: 'Client', path: '/admin/bons-retour/client' }
    ]
  },
  { label: 'Ramassage', path: '/admin/ramassage', icon: PackageOpen, service: 'RAMASSAGE' },
  { label: 'Remboursement', path: '/admin/remboursement', icon: HandCoins, service: 'REMBOURSEMENT' },
  { label: 'Réclamations', path: '/admin/reclamations', icon: MessageSquareWarning, service: 'RECLAMATIONS' },
  { label: 'Modifications Colis', path: '/admin/modifications-colis', icon: PencilLine, service: 'MODIFICATIONS_COLIS' },
  {
    label: 'Messages',
    icon: MessagesSquare,
    service: 'MESSAGES',
    children: [
      { label: 'Clients', path: '/admin/messages/clients' }
    ]
  },
  { label: 'Nouveaux clients', path: '/admin/nouveaux-clients', icon: UserPlus, service: 'NOUVEAUX_CLIENTS' },
  { label: 'Clients', path: '/admin/clients', icon: Users, service: 'CLIENTS' },
  { label: 'Caisse Agence', path: '/admin/caisse-agence', icon: Landmark, service: 'CAISSE_AGENCE' },
  {
    label: 'Notifications',
    icon: BellRing,
    // Code legacy « NOTIFICATIONS_EMPLOYES » : conservé car déjà stocké dans users_services.
    service: 'NOTIFICATIONS_EMPLOYES',
    children: [
      { label: 'Employés', path: '/admin/notifications/employes', types: [1, 2] },
      { label: 'Clients', path: '/admin/notifications/clients', types: [1, 2] }
    ]
  },
  { label: 'Livreurs', path: '/admin/livreurs', icon: Bike, service: 'LIVREURS' },
  { label: 'Utilisateurs', path: '/admin/utilisateurs', icon: UserCog, service: 'UTILISATEURS' },
  { label: 'Logistiques', path: '/admin/logistiques', icon: Boxes, service: 'LOGISTIQUES' },
  { label: 'Matériel', path: '/admin/materiel', icon: Wrench, service: 'MATERIEL' },
  {
    label: 'Statistiques',
    icon: BarChart3,
    service: 'STATISTIQUES',
    children: [
      { label: 'Globales', path: '/admin/statistiques/globales' }
    ]
  },
  {
    label: 'Configuration',
    icon: Settings,
    service: 'CONFIGURATION',
    children: [
      { label: 'Gestion agences', path: '/admin/configuration/agences' },
      { label: 'Gestion zones', path: '/admin/configuration/zones' },
      { label: 'Gestion villes', path: '/admin/configuration/villes' },
      { label: 'Gestion tarifs', path: '/admin/configuration/tarifs' },
      { label: 'Options', path: '/admin/configuration/options' },
      { label: 'Plateforme', path: '/admin/configuration/plateforme' }
    ]
  }
];

/**
 * Pages de détail hors menu (ex. /admin/utilisateurs/47) : libellé du dernier
 * niveau du breadcrumb et du titre d'onglet, indexé par le chemin parent.
 * Valeur : chaîne simple, ou objet indexé par dernier segment de l'URL
 * ('*' = défaut) quand un même parent a plusieurs pages de détail.
 */
export const DETAIL_LABELS = {
  '/admin/colis': 'Nouveau colis',
  '/admin/bons-envoi': "Bon d'envoi",
  '/admin/bons-retour/livreur': 'Bon de retour livreur',
  '/admin/bons-retour/client': 'Bon de retour client',
  '/admin/facturation-livreurs/factures': 'Facture livreur',
  '/admin/facturation-clients/factures': 'Facture client',
  '/admin/utilisateurs': 'Fiche utilisateur',
  '/admin/logistiques': 'Fiche moyen logistique',
  '/admin/livreurs': 'Fiche livreur',
  '/admin/clients': 'Fiche client',
  '/admin/stock/inventaire': { nouveau: 'Nouveau produit', '*': 'Fiche produit' },
  '/admin/stock/bon-de-sortie': 'Création bon de sortie'
};

/** Résout un libellé de DETAIL_LABELS pour le chemin courant. */
export function resolveDetailLabel(value, pathname) {
  if (!value || typeof value === 'string') return value;
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return value[segment] || value['*'];
}

const SUPER_ADMIN_TYPE = 1;

/**
 * Contrôle d'accès aux pages et à l'affichage du menu.
 * - superAdmin (users_type = 1) : accès à tout ;
 * - sinon : le code du service doit figurer dans users_services (user.services).
 * `service` peut être une chaîne ou un tableau de codes (accès si au moins un correspond).
 */
export function hasAccess(user, service) {
  if (!service) return true;
  if (!user || user.kind !== 'employee') return false;
  if (Number(user.role) === SUPER_ADMIN_TYPE) return true;
  const granted = Array.isArray(user.services) ? user.services : [];
  const wanted = Array.isArray(service) ? service : [service];
  return wanted.some((code) => granted.includes(code));
}

/** Restriction par fonction (`types` d'un item de menu) : superAdmin toujours admis. */
export function hasTypeAccess(user, types) {
  if (!types) return true;
  if (!user || user.kind !== 'employee') return false;
  const role = Number(user.role);
  return role === SUPER_ADMIN_TYPE || types.includes(role);
}

/** Code de service d'un sous-menu : le sien s'il en porte un, sinon celui de son parent. */
export function childService(item, child) {
  return child.service || item.service;
}

/** Liste plate des pages du menu : { path, label, service, types } — sert à générer les routes. */
export function adminPages() {
  const pages = [];
  for (const item of ADMIN_MENU) {
    if (item.children) {
      for (const child of item.children) {
        pages.push({
          path: child.path,
          label: `${item.label} — ${child.label}`,
          service: childService(item, child),
          types: child.types
        });
      }
    } else if (item.path && item.path !== '/admin') {
      pages.push({ path: item.path, label: item.label, service: item.service, types: item.types });
    }
  }
  return pages;
}

/**
 * Page d'arrivée du dashboard admin (connexion, retour de ServiceRoute) :
 * '/admin' (Accueil) pour les fonctions de ACCUEIL_TYPES ; sinon Ramassage par
 * scan, ou à défaut la première page accessible du menu. null si aucune page
 * n'est accessible (pas de redirection, sinon boucle avec ServiceRoute).
 */
export function adminHomePath(user) {
  if (hasTypeAccess(user, ACCUEIL_TYPES)) return '/admin';
  const pages = adminPages().filter((p) => hasAccess(user, p.service) && hasTypeAccess(user, p.types));
  return (pages.find((p) => p.path === HOME_SANS_ACCUEIL) || pages[0])?.path ?? null;
}
