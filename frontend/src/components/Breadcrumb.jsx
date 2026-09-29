import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { ADMIN_MENU, DETAIL_LABELS, resolveDetailLabel } from '../config/adminMenu';

/**
 * Retrouve le fil d'Ariane depuis le menu pour le chemin courant :
 * - page simple  → [{ label }]
 * - sous-page    → [{ label: parent }, { label: enfant }]
 * - page de détail (chemin qui prolonge une page du menu, ex. /admin/utilisateurs/47)
 *   → niveau supplémentaire avec le libellé de detailLabels.
 */
function trailFromMenu(pathname, menu, homePath, detailLabels) {
  for (const item of menu) {
    if (item.children) {
      for (const child of item.children) {
        if (pathname === child.path) {
          return [{ label: item.label }, { label: child.label, path: child.path }];
        }
        if (pathname.startsWith(`${child.path}/`)) {
          return [
            { label: item.label },
            { label: child.label, path: child.path },
            { label: resolveDetailLabel(detailLabels[child.path], pathname) || 'Détail' }
          ];
        }
      }
    } else if (item.path && item.path !== homePath) {
      if (pathname === item.path) {
        return [{ label: item.label, path: item.path }];
      }
      if (pathname.startsWith(`${item.path}/`)) {
        return [
          { label: item.label, path: item.path },
          { label: resolveDetailLabel(detailLabels[item.path], pathname) || 'Détail' }
        ];
      }
    }
  }
  return pathname === homePath ? [{ label: 'Accueil' }] : [];
}

/**
 * Fil d'Ariane affiché en haut de chaque page d'un dashboard à sidebar
 * (rendu par SidebarLayout). Par défaut il est déduit du menu admin ;
 * SidebarLayout passe `menu`, `homePath` et `detailLabels` du dashboard actif.
 * Passer `items` ([{ label, path? }]) pour le compléter ou le remplacer sur une page précise.
 */
export default function Breadcrumb({ items, menu = ADMIN_MENU, homePath = '/admin', detailLabels = DETAIL_LABELS }) {
  const location = useLocation();
  const trail = items ?? trailFromMenu(location.pathname, menu, homePath, detailLabels);
  if (trail.length === 0) return null;

  return (
    <nav className="breadcrumb" aria-label="Fil d'Ariane">
      <Link to={homePath} className="breadcrumb-home" aria-label="Accueil">
        <Home size={16} />
      </Link>
      {trail.map((crumb, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span key={crumb.label} className="breadcrumb-item">
            <ChevronRight size={14} className="breadcrumb-sep" />
            {isLast || !crumb.path ? (
              <span className={isLast ? 'breadcrumb-current' : 'breadcrumb-parent'} aria-current={isLast ? 'page' : undefined}>
                {crumb.label}
              </span>
            ) : (
              <Link to={crumb.path} className="breadcrumb-parent">
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
