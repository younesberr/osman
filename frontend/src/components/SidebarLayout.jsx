import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu as MenuIcon, UserRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { hydrateStatutLabels } from '../utils/statuts';
import Brand from './Brand';
import Breadcrumb from './Breadcrumb';
import NotificationsBanner from './NotificationsBanner';

/** Badge rouge « compteur de notification » d'une entrée de menu (rien si 0). */
function SideBadge({ count }) {
  if (!(count > 0)) return null;
  return <span className="side-badge">{count > 999 ? '999+' : count}</span>;
}

function SidebarItem({ item, open, onToggle }) {
  const location = useLocation();
  const childActive = item.children?.some((c) => location.pathname.startsWith(c.path));

  if (!item.children) {
    return (
      <NavLink to={item.path} end={item.end} className="side-link">
        <item.icon size={18} className="side-icon" />
        <span className="side-label">{item.label}</span>
        <SideBadge count={item.badge} />
      </NavLink>
    );
  }

  return (
    <div className={`side-group ${open ? 'open' : ''}`}>
      <button type="button" className={`side-link ${childActive ? 'active' : ''}`} onClick={onToggle}>
        <item.icon size={18} className="side-icon" />
        <span className="side-label">{item.label}</span>
        <SideBadge count={item.badge} />
        <ChevronDown size={15} className="side-chevron" />
      </button>
      {open && (
        <div className="side-sub">
          {item.children.map((child) => (
            <NavLink key={child.path} to={child.path} className="side-sublink">
              <span className="side-sublabel">{child.label}</span>
              <SideBadge count={child.badge} />
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Menu utilisateur de la topbar : avatar rond (photo si `user.pic` est une URL
 * complète, sinon silhouette par défaut) qui déroule « Ma fiche » +
 * « Déconnexion ». `accountPath` absent (ex. membre d'équipe client) :
 * seule la déconnexion est proposée.
 */
function UserMenu({ user, accountPath, onLogout }) {
  const [open, setOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  /* Referme au clic hors du menu ou à la touche Échap. */
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /* Referme à chaque navigation. */
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const pic = user?.pic || '';
  // Comme dans UsersDatatable : seules les URL complètes sont affichables
  // (les fichiers legacy ne sont pas servis par cette plateforme).
  const showImg = /^https?:\/\//.test(pic) && !imgError;

  return (
    <div className="topbar-user" ref={ref}>
      <button
        type="button"
        className="topbar-avatar"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.name}
      >
        {showImg ? (
          <img src={pic} alt={user?.name} onError={() => setImgError(true)} />
        ) : (
          <UserRound size={20} strokeWidth={2.2} />
        )}
      </button>
      {open && (
        <div className="topbar-menu" role="menu">
          <div className="topbar-menu-name">{user?.name}</div>
          {accountPath && (
            <button
              type="button"
              className="topbar-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(accountPath);
              }}
            >
              <UserRound size={16} /> Ma fiche
            </button>
          )}
          <button
            type="button"
            className="topbar-menu-item topbar-menu-logout"
            role="menuitem"
            onClick={onLogout}
          >
            <LogOut size={16} /> Déconnexion
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Layout commun des dashboards à sidebar (admin, client) :
 * sidebar repliable + topbar + fil d'Ariane + Outlet.
 * - `menu` : items { label, path, icon, children?, badge? } (déjà filtrés par accès) ;
 * - `homePath` : racine du dashboard ('/admin', '/client') ;
 * - `detailLabels` : libellés des pages de détail hors menu (cf. Breadcrumb) ;
 * - `accountPath` : page « Ma fiche » du menu avatar (absent = pas d'entrée).
 */
export default function SidebarLayout({ menu, homePath, detailLabels, accountPath }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  // Un seul sous-menu ouvert à la fois (accordéon) ; au chargement, on ouvre
  // celui contenant la page courante.
  const [openGroup, setOpenGroup] = useState(
    () =>
      menu.find((item) => item.children?.some((c) => location.pathname.startsWith(c.path)))?.label ??
      null
  );
  // Libellés statuts depuis delevery_string : le compteur force un re-rendu
  // des pages déjà montées une fois les libellés reçus.
  const [, setStatutsVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    hydrateStatutLabels().then(() => {
      if (!cancelled) setStatutsVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sur mobile (< 900px) la sidebar est une surcouche : `collapsed` inversé
  // par le CSS signifie « menu ouvert ». On le referme à chaque navigation.
  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setCollapsed(false);
    }
  }, [location.pathname]);

  async function handleLogout() {
    await logout();
    navigate('/', { replace: true });
  }

  return (
    <div className={`admin ${collapsed ? 'admin-collapsed' : ''}`}>
      {/* Fond assombri derrière la sidebar mobile ; un clic referme le menu. */}
      <div className="admin-backdrop" onClick={() => setCollapsed(false)} aria-hidden="true" />
      <aside className="admin-sidebar">
        <nav className="side-nav">
          {menu.map((item) => (
            <SidebarItem
              key={item.label}
              item={{ ...item, end: item.path === homePath }}
              open={openGroup === item.label}
              onToggle={() => setOpenGroup(openGroup === item.label ? null : item.label)}
            />
          ))}
        </nav>
        <button type="button" className="side-link side-logout" onClick={handleLogout}>
          <LogOut size={18} className="side-icon" />
          <span className="side-label">Déconnexion</span>
        </button>
      </aside>

      <div className="admin-body">
        <header className="admin-topbar">
          <button
            type="button"
            className="topbar-burger"
            onClick={() => setCollapsed(!collapsed)}
            aria-label="Basculer le menu"
          >
            <MenuIcon size={22} />
          </button>
          <Brand className="topbar-brand" />
          <UserMenu user={user} accountPath={accountPath} onLogout={handleLogout} />
        </header>
        <main className="admin-main">
          <Breadcrumb
            menu={menu}
            homePath={homePath}
            detailLabels={detailLabels}
            // Page hors menu du menu avatar : fil d'Ariane explicite.
            items={
              accountPath && location.pathname === accountPath
                ? [{ label: 'Ma fiche' }]
                : undefined
            }
          />
          <NotificationsBanner />
          {/* Pages différées (React.lazy, App.jsx) : le chunk se télécharge à la
              première visite ; la barre latérale reste affichée pendant ce temps. */}
          <Suspense fallback={<div className="page-loader page-loader--inline">Chargement…</div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
