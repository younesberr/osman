import { CLIENT_MENU, CLIENT_DETAIL_LABELS } from '../config/clientMenu';
import { useAuth } from '../context/AuthContext';
import { hasClientAccess } from '../config/clientServices';
import SidebarLayout from './SidebarLayout';

/**
 * Dashboard client : SidebarLayout avec le menu client. Le propriétaire voit
 * tout ; un membre d'équipe (page /client/equipe) ne voit que les entrées de
 * ses tâches attribuées — un parent dont tous les enfants sont masqués
 * disparaît aussi.
 */
export default function ClientLayout() {
  const { user } = useAuth();

  const menu = CLIENT_MENU.map((item) => {
    if (!item.children) {
      return hasClientAccess(user, item.service) ? item : null;
    }
    const children = item.children.filter((child) => hasClientAccess(user, child.service));
    if (children.length === 0) return null;
    return { ...item, children };
  }).filter(Boolean);
  return (
    <SidebarLayout
      menu={menu}
      homePath="/client"
      detailLabels={CLIENT_DETAIL_LABELS}
      // « Ma fiche » du menu avatar : fiche complète pour le propriétaire ;
      // pour un membre d'équipe, version réduite à ses identifiants de
      // connexion (MaFicheMembre via FicheClient self).
      accountPath="/client/ma-fiche"
    />
  );
}
