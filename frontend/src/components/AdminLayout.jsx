import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { ADMIN_MENU, DETAIL_LABELS, childService, hasAccess, hasTypeAccess } from '../config/adminMenu';
import SidebarLayout from './SidebarLayout';

/*
 * Compteur de notification (badge rouge) de chaque entrée de la sidebar :
 * chemin de menu → clé de la réponse de /api/dashboard/admin/compteurs.
 * Un sous-menu badgé remonte aussi sur son parent (somme des enfants).
 */
const BADGE_KEYS = {
  '/admin/stock/colis-en-attente': 'stockColisEnAttente',
  '/admin/ramassage': 'ramassage',
  '/admin/remboursement': 'remboursement',
  '/admin/reclamations': 'reclamations',
  '/admin/modifications-colis': 'modificationsColis',
  '/admin/messages/clients': 'messagesClients',
  '/admin/nouveaux-clients': 'nouveauxClients',
  '/admin/clients': 'clients'
};

/**
 * Dashboard admin : SidebarLayout avec le menu admin filtré par les services
 * de l'employé, puis les items et sous-menus par fonction (`types`) et, pour
 * les sous-menus qui portent leur propre `service`,
 * par ce code — le parent reste visible dès qu'un sous-menu l'est.
 * Les badges rouges (éléments en attente de chaque module) viennent d'un seul
 * appel /dashboard/admin/compteurs, rafraîchi à chaque navigation — traiter un
 * élément puis changer de page met donc les compteurs à jour.
 */
export default function AdminLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const [compteurs, setCompteurs] = useState({});

  useEffect(() => {
    let cancelled = false;
    api
      .get('/dashboard/admin/compteurs')
      .then((res) => {
        if (!cancelled) setCompteurs(res.data || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, location.pathname]);

  const badgeOf = (path) => Number(compteurs[BADGE_KEYS[path]]) || 0;

  const menu = ADMIN_MENU.map((item) => {
    if (!item.children) {
      return hasAccess(user, item.service) && hasTypeAccess(user, item.types)
        ? { ...item, badge: badgeOf(item.path) }
        : null;
    }
    const children = item.children
      .filter((child) => hasAccess(user, childService(item, child)) && hasTypeAccess(user, child.types))
      .map((child) => ({ ...child, badge: badgeOf(child.path) }));
    if (children.length === 0) return null;
    return { ...item, children, badge: children.reduce((sum, c) => sum + c.badge, 0) };
  }).filter(Boolean);

  return (
    <SidebarLayout
      menu={menu}
      homePath="/admin"
      detailLabels={DETAIL_LABELS}
      accountPath="/admin/ma-fiche"
    />
  );
}
