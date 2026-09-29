import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { BellRing, CheckCircle2, ChevronDown, Info, OctagonAlert, TriangleAlert, X } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';

/*
 * Bannières de notification en haut des pages des trois dashboards (rendu par
 * SidebarLayout entre le fil d'Ariane et le contenu). L'API /notifications/me
 * renvoie les notifications visibles par l'utilisateur connecté (audience,
 * ciblage, dates, fermetures — résolus côté backend) avec leurs pages ; le
 * filtrage par page se fait ici sur le pathname. Les notifications groupables
 * d'une même page sont repliées dans un bloc compact avec compteur ; la croix
 * mémorise la fermeture (POST /notifications/:id/fermer).
 */

const ICONES = {
  info: Info,
  succes: CheckCircle2,
  avertissement: TriangleAlert,
  urgent: OctagonAlert
};
const ORDRE = { urgent: 0, avertissement: 1, succes: 2, info: 3 };
const ROOTS = ['/admin', '/client', '/livreur'];

/*
 * Correspondance par segment : une page ciblée couvre aussi ses pages de
 * détail (/admin/clients → /admin/clients/5) mais pas ses voisines de préfixe
 * commun (/admin/colis ≠ /admin/colis-montant-zero). Les racines des
 * dashboards (Accueil) matchent en exact uniquement.
 */
function pageMatch(page, pathname) {
  if (ROOTS.includes(page)) return pathname === page;
  return pathname === page || pathname.startsWith(`${page}/`);
}

export default function NotificationsBanner() {
  const { user } = useAuth();
  const location = useLocation();
  const [notifs, setNotifs] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    api
      .get('/notifications/me')
      .then((res) => {
        if (!cancelled) setNotifs(res.data.notifications);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Le bloc groupé se replie à chaque changement de page.
  useEffect(() => {
    setExpanded(false);
  }, [location.pathname]);

  if (!user) return null;
  const visibles = notifs.filter((n) => n.pages.some((p) => pageMatch(p, location.pathname)));
  if (!visibles.length) return null;

  const groupables = visibles.filter((n) => Number(n.groupable) === 1);
  // Une seule groupable : rendue comme un bandeau simple.
  const groupe = groupables.length >= 2 ? groupables : [];
  const simples = groupe.length ? visibles.filter((n) => Number(n.groupable) !== 1) : visibles;

  function dismiss(id) {
    setNotifs((list) => list.filter((n) => n.id !== id));
    api.post(`/notifications/${id}/fermer`).catch(() => {});
  }

  function Banner({ notif }) {
    const Icone = ICONES[notif.importance] || Info;
    return (
      <div className={`notif-banner notif-${notif.importance}`}>
        <Icone size={17} className="notif-icone" />
        <div className="notif-texte">
          {notif.titre && <div className="notif-title">{notif.titre}</div>}
          <div className="notif-message">{notif.message}</div>
        </div>
        <button type="button" className="notif-close" onClick={() => dismiss(notif.id)} title="Fermer">
          <X size={15} />
        </button>
      </div>
    );
  }

  const groupeImportance = groupe.reduce(
    (max, n) => (ORDRE[n.importance] < ORDRE[max] ? n.importance : max),
    'info'
  );

  return (
    <div className="notif-stack">
      {simples.map((n) => (
        <Banner key={n.id} notif={n} />
      ))}
      {groupe.length > 0 && (
        <div className={`notif-group notif-${groupeImportance}`}>
          <button type="button" className="notif-group-head" onClick={() => setExpanded((e) => !e)}>
            <BellRing size={16} />
            <span>Notifications</span>
            <span className="notif-count">{groupe.length}</span>
            <ChevronDown size={16} className={`notif-group-chevron ${expanded ? 'open' : ''}`} />
          </button>
          {expanded && (
            <div className="notif-group-body">
              {groupe.map((n) => (
                <Banner key={n.id} notif={n} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
