import { useNavigate } from 'react-router-dom';
import Brand from './Brand';
import { useAuth } from '../context/AuthContext';
import { statutLabel } from '../utils/statuts';

export default function DashboardLayout({ title, subtitle, children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/', { replace: true });
  }

  return (
    <div className="dash">
      <header className="dash-header">
        <Brand />
        <div className="dash-user">
          <span className="dash-username">{user?.name}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            Déconnexion
          </button>
        </div>
      </header>
      <main className="dash-main container">
        <div className="dash-title">
          <h1>{title}</h1>
          {subtitle && <p className="section-sub">{subtitle}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}

export function StatCard({ label, value, tone }) {
  return (
    <div className={`stat-card ${tone || ''}`}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

const num = (v) => Number(v) || 0;

/** Entier localisé fr (21 136) ; undefined tant que la valeur n'est pas chargée. */
export function formatNombre(v) {
  return v == null ? undefined : num(v).toLocaleString('fr-FR');
}

/** Montant localisé fr avec devise (12 345,50 DH) ; undefined tant que non chargé. */
export function formatMontant(v) {
  return v == null
    ? undefined
    : `${num(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`;
}

/** Taux en % d'une part des colis, hors colis en cours : part / (total − en cours). */
export function tauxColis(part, counts) {
  if (!counts) return undefined;
  const base = num(counts.total_colis) - num(counts.en_cours);
  if (base <= 0) return undefined;
  return `${((num(part) / base) * 100).toFixed(1).replace('.', ',')} %`;
}

/** Carte statistique avec pastille icône colorée (statistiques des colis).
 * `sub` : ligne secondaire optionnelle sous le libellé (ex : taux de livraison). */
export function StatIconCard({ icon: Icon, label, value, sub, color, bg }) {
  return (
    <div className="stat-icon-card">
      <span className="stat-icon-circle" style={{ background: bg, color }}>
        <Icon size={22} />
      </span>
      <div>
        <div className="stat-value" style={{ color }}>{value ?? '—'}</div>
        <div className="stat-label">{label}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function ParcelsTable({ parcels }) {
  if (!parcels?.length) {
    return <p className="empty">Aucun colis à afficher.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Destinataire</th>
            <th>Téléphone</th>
            <th>Produit</th>
            <th>Prix (DH)</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {parcels.map((p) => (
            <tr key={p.parcel_id}>
              <td className="mono">{p.parcel_code}</td>
              <td>{p.parcel_receiver}</td>
              <td>{p.parcel_phone}</td>
              <td>{p.parcel_product_name}</td>
              <td>{p.parcel_price}</td>
              <td>
                <span className="badge" style={p.statut_color ? { background: p.statut_color } : undefined}>
                  {statutLabel(p.statut)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
