import { Home, ScanLine, Package, Truck, HandCoins, Undo2, BookOpen } from 'lucide-react';

/**
 * Menu du dashboard livreur. Même structure que ADMIN_MENU (adminMenu.js),
 * sans contrôle d'accès par service : un livreur voit tout son menu.
 */
export const LIVREUR_MENU = [
  { label: 'Accueil', path: '/livreur', icon: Home },
  { label: 'Changer statut', path: '/livreur/changer-statut', icon: ScanLine },
  { label: 'Liste des colis', path: '/livreur/colis', icon: Package },
  { label: 'Bon de distribution', path: '/livreur/bon-distribution', icon: Truck },
  { label: 'Bon paiement', path: '/livreur/bon-paiement', icon: HandCoins },
  { label: 'Bon retour', path: '/livreur/bon-retour', icon: Undo2 },
  { label: 'Documentation API', path: '/livreur/api', icon: BookOpen }
];

/** Pages de détail hors menu livreur (ex. /livreur/bon-retour/12). */
export const LIVREUR_DETAIL_LABELS = {
  '/livreur/bon-retour': 'Bon de retour'
};

/** Liste plate des pages du menu livreur : { path, label } — sert à générer les routes. */
export function livreurPages() {
  const pages = [];
  for (const item of LIVREUR_MENU) {
    if (item.children) {
      for (const child of item.children) {
        pages.push({ path: child.path, label: `${item.label} — ${child.label}` });
      }
    } else if (item.path && item.path !== '/livreur') {
      pages.push({ path: item.path, label: item.label });
    }
  }
  return pages;
}
