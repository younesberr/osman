import { LIVREUR_MENU, LIVREUR_DETAIL_LABELS } from '../config/livreurMenu';
import SidebarLayout from './SidebarLayout';

/** Dashboard livreur : SidebarLayout avec le menu livreur (pas de filtrage par service). */
export default function LivreurLayout() {
  return (
    <SidebarLayout
      menu={LIVREUR_MENU}
      homePath="/livreur"
      detailLabels={LIVREUR_DETAIL_LABELS}
      accountPath="/livreur/ma-fiche"
    />
  );
}
