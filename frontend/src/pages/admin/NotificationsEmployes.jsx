import NotificationsAdmin from '../../components/NotificationsAdmin';

/*
 * Notifications > Employés (/admin/notifications/employes) — bannières
 * affichées sur les pages des dashboards admin et livreur. Tout le contenu est
 * dans le composant partagé NotificationsAdmin (prop audience).
 */
export default function NotificationsEmployes() {
  return <NotificationsAdmin audience="employe" />;
}
