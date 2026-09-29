import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { adminPages, DETAIL_LABELS, resolveDetailLabel } from '../config/adminMenu';
import { clientPages, CLIENT_DETAIL_LABELS } from '../config/clientMenu';
import { livreurPages, LIVREUR_DETAIL_LABELS } from '../config/livreurMenu';

// Titre de la page d'accueil publique : identique à l'ancien site (arabe).
const DEFAULT_TITLE = 'أورتالوج — التوصيل في كل مكان بالمغرب';

/** Titres des routes hors menus. */
const STATIC_TITLES = {
  '/': null,
  '/login': 'Connexion',
  '/register': 'إنشاء حساب',
  '/tarifs': 'الأسعار والتعريفات',
  '/mentions-legales': 'الإشارات القانونية',
  '/contrat': 'عقد الخدمة',
  '/conditions-utilisation': 'شروط الاستخدام',
  '/client': 'Accueil',
  '/livreur': 'Accueil',
  '/admin': 'Accueil',
  '/admin/ma-fiche': 'Ma fiche',
  '/client/ma-fiche': 'Ma fiche',
  '/livreur/ma-fiche': 'Ma fiche'
};

/**
 * Synchronise le titre de l'onglet du navigateur avec la page active :
 * « <Nom de la page> - ORTALOG » (la page d'accueil garde le titre complet).
 */
export default function PageTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    const path = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    let label;
    if (path in STATIC_TITLES) {
      label = STATIC_TITLES[path];
    } else {
      const pages = [...adminPages(), ...clientPages(), ...livreurPages()];
      const detailLabels = { ...DETAIL_LABELS, ...CLIENT_DETAIL_LABELS, ...LIVREUR_DETAIL_LABELS };
      const page = pages.find((p) => p.path === path);
      // Pages de détail hors menu (ex. /admin/utilisateurs/47).
      const parent = page ? null : pages.find((p) => path.startsWith(`${p.path}/`));
      label = page
        ? page.label
        : parent
          ? resolveDetailLabel(detailLabels[parent.path], path) || parent.label
          : null;
    }
    document.title = label ? `${label} - ORTALOG` : DEFAULT_TITLE;
  }, [pathname]);

  return null;
}
