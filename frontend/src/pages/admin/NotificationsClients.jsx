import NotificationsAdmin from '../../components/NotificationsAdmin';

/*
 * Notifications > Clients (/admin/notifications/clients) — bannières affichées
 * sur les pages du dashboard client. Tout le contenu est dans le composant
 * partagé NotificationsAdmin (prop audience).
 */
export default function NotificationsClients() {
  return <NotificationsAdmin audience="client" />;
}
