import {
  Home,
  BarChart3,
  PackagePlus,
  Download,
  Package,
  Truck,
  Warehouse,
  FileText,
  MapPinOff,
  Undo2,
  MessagesSquare,
  Users,
  Plug,
  Settings
} from 'lucide-react';

/**
 * Menu du dashboard client. Même structure que ADMIN_MENU (adminMenu.js).
 * `service` : tâche requise pour un MEMBRE d'équipe (delevery_customer_members,
 * page /client/equipe) — le propriétaire voit tout son menu. EQUIPE n'est pas
 * attribuable (voir config/clientServices.js) : seul le propriétaire y accède.
 */
export const CLIENT_MENU = [
  { label: 'Accueil', path: '/client', icon: Home },
  { label: 'Liste des colis', path: '/client/colis', icon: Package, service: 'COLIS_CONSULTATION' },
  // Colis scannés « sans adresse » par l'agence (attente de confirmation) :
  // pendant client de la page admin Sans adresse, sans scan.
  { label: 'Sans adresse', path: '/client/sans-adresse', icon: MapPinOff, service: 'COLIS_CONSULTATION' },
  { label: 'Nouveau colis', path: '/client/nouveau-colis', icon: PackagePlus, service: 'COLIS_SAISIE' },
  {
    label: 'Importation colis',
    icon: Download,
    children: [
      { label: 'Colis normal', path: '/client/import-colis/normal', service: 'COLIS_SAISIE' },
      { label: 'Colis de stock', path: '/client/import-colis/stock', service: 'COLIS_SAISIE' }
    ]
  },
  { label: 'Demande ramassage', path: '/client/demande-ramassage', icon: Truck, service: 'RAMASSAGE' },
  {
    label: 'Gestion stock',
    icon: Warehouse,
    children: [
      { label: 'Liste des produits', path: '/client/stock/produits', service: 'STOCK_PRODUITS' },
      { label: 'Mouvement stock', path: '/client/stock/mouvements', service: 'STOCK_MOUVEMENTS' }
    ]
  },
  { label: 'Factures', path: '/client/factures', icon: FileText, service: 'FACTURES' },
  { label: 'Bon de retour', path: '/client/bon-de-retour', icon: Undo2, service: 'BON_RETOUR' },
  { label: 'Messages', path: '/client/messages', icon: MessagesSquare, service: 'MESSAGES' },
  { label: 'Statistiques', path: '/client/statistiques', icon: BarChart3, service: 'STATISTIQUES' },
  { label: "Gestion d'équipe", path: '/client/equipe', icon: Users, service: 'EQUIPE' },
  // API liaison : connecteurs boutique (Coming soon) + documentation API client.
  // Sans `service` : visible par le propriétaire et tous les membres d'équipe
  // (l'API applique ensuite les tâches de chacun).
  {
    label: 'API liaison',
    icon: Plug,
    children: [
      { label: 'WooCommerce', path: '/client/api/woocommerce' },
      { label: 'Shopify', path: '/client/api/shopify' },
      { label: 'Documentation', path: '/client/api/documentation' }
    ]
  },
  { label: 'Configuration', path: '/client/configuration', icon: Settings, service: 'CONFIGURATION' }
];

/**
 * Pages de détail hors menu client (ex. /client/stock/produits/12) : libellé du
 * dernier niveau du breadcrumb et du titre d'onglet, même format que DETAIL_LABELS.
 */
export const CLIENT_DETAIL_LABELS = {
  '/client/stock/produits': { nouveau: 'Nouveau produit', '*': 'Fiche produit' }
};

/** Liste plate des pages du menu client : { path, label, service } — sert à générer les routes. */
export function clientPages() {
  const pages = [];
  for (const item of CLIENT_MENU) {
    if (item.children) {
      for (const child of item.children) {
        pages.push({ path: child.path, label: `${item.label} — ${child.label}`, service: child.service });
      }
    } else if (item.path && item.path !== '/client') {
      pages.push({ path: item.path, label: item.label, service: item.service });
    }
  }
  return pages;
}
