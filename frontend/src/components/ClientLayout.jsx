import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api/client';
import { CLIENT_MENU, CLIENT_DETAIL_LABELS } from '../config/clientMenu';
import { useAuth } from '../context/AuthContext';
import { hasClientAccess } from '../config/clientServices';
import SidebarLayout from './SidebarLayout';

/*
 * Compteur de notification (badge rouge) d'une entrée de la sidebar client :
 * chemin de menu → clé de la réponse de /api/dashboard/client/compteurs
 * (même mécanisme que BADGE_KEYS d'AdminLayout).
 */
const BADGE_KEYS = {
  '/client/sans-adresse': 'sansAdresse'
};

/**
 * Dashboard client : SidebarLayout avec le menu client. Le propriétaire voit
 * tout ; un membre d'équipe (page /client/equipe) ne voit que les entrées de
 * ses tâches attribuées — un parent dont tous les enfants sont masqués
 * disparaît aussi.
 * Les badges rouges (ex. colis « Sans adresse » en attente de confirmation)
 * viennent d'un seul appel /dashboard/client/compteurs, rafraîchi à chaque
 * navigation et sur l'événement window « ortalog:compteurs ».
 */
export default function ClientLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const [compteurs, setCompteurs] = useState({});

  useEffect(() => {
    let cancelled = false;
    const charger = () =>
      api
        .get('/dashboard/client/compteurs')
        .then((res) => {
          if (!cancelled) setCompteurs(res.data || {});
        })
        .catch(() => {});
    charger();
    window.addEventListener('ortalog:compteurs', charger);
    return () => {
      cancelled = true;
      window.removeEventListener('ortalog:compteurs', charger);
    };
  }, [user, location.pathname]);

  const badgeOf = (path) => Number(compteurs[BADGE_KEYS[path]]) || 0;

  const menu = CLIENT_MENU.map((item) => {
    if (!item.children) {
      return hasClientAccess(user, item.service) ? { ...item, badge: badgeOf(item.path) } : null;
    }
    const children = item.children
      .filter((child) => hasClientAccess(user, child.service))
      .map((child) => ({ ...child, badge: badgeOf(child.path) }));
    if (children.length === 0) return null;
    return { ...item, children, badge: children.reduce((sum, c) => sum + c.badge, 0) };
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
