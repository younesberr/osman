import { useEffect, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Link } from 'react-router-dom';
import {
  Boxes,
  CheckCircle,
  Truck,
  Undo2,
  Coins,
  HandCoins,
  Wallet,
  PackagePlus,
  Hand,
  List,
  Clock
} from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, formatMontant, tauxColis } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { statutLabel } from '../../utils/statuts';
import { useAuth } from '../../context/AuthContext';

/** Lignes de graphique en barres horizontales : libellé, barre, valeur.
 * `total` sert au pourcentage affiché ; la largeur est relative au maximum. */
function BarRows({ rows, total }) {
  if (!rows?.length) {
    return <p className="chart-empty">Aucune donnée sur la période.</p>;
  }
  const max = Math.max(...rows.map((r) => Number(r.total) || 0), 1);
  return (
    <div className="chart-rows">
      {rows.map((r) => {
        const valeur = Number(r.total) || 0;
        const pct = total > 0 ? ((valeur / total) * 100).toFixed(1).replace('.', ',') : null;
        return (
          <div key={r.key} className="chart-row" title={pct ? `${r.label} : ${valeur} (${pct} %)` : `${r.label} : ${valeur}`}>
            <span className="chart-row-label">
              {r.color && <span className="chart-row-dot" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="chart-row-track">
              <span
                className="chart-row-bar"
                style={{ width: `${(valeur / max) * 100}%`, background: r.color || 'var(--primary)' }}
              />
            </span>
            <span className="chart-row-value">
              {formatNombre(valeur)}
              {pct && <em>{pct} %</em>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function Accueil() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(defaultRange());

  useEffect(() => {
    api
      .get('/dashboard/client', { params: { dateFrom: range.from, dateTo: range.to } })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [range.from, range.to]);

  const c = data?.counts;
  const totalStatuts = (data?.parcelsByStatus || []).reduce((s, r) => s + (Number(r.total) || 0), 0);

  return (
    <>
      <div className="welcome-banner welcome-compact">
        <h1>☀️ Bonjour, {user?.name} !</h1>
        <p>Bienvenue sur votre espace client {BRAND.name}.</p>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="dash-actions">
        <div className="dash-actions-left">
          <Link to="/client/nouveau-colis" className="btn btn-primary">
            <PackagePlus size={17} />
            Ajouter colis
          </Link>
          <Link to="/client/demande-ramassage" className="btn btn-ghost">
            <Hand size={17} />
            Demande ramassage
          </Link>
          <Link to="/client/colis" className="btn btn-ghost">
            <List size={17} />
            Liste colis
          </Link>
        </div>
        <DateRangeSelect value={range} onChange={setRange} />
      </div>

      {/* Comptages : attente de ramassage (hors total), total, livrés, retournés
        * (taux sur total − en cours), en cours = tout autre statut. */}
      <div className="stats-grid stats-grid-4 stats-grid-client-colis">
        <StatIconCard
          icon={Clock}
          label="En attente de ramassage"
          value={formatNombre(c?.attente_ramassage)}
          color="#f59e0b"
          bg="rgba(245, 158, 11, 0.08)"
        />
        <StatIconCard
          icon={Boxes}
          label="Total colis"
          value={formatNombre(c?.total_colis)}
          sub="Hors attente de ramassage"
          color={BRAND.colorPrimary}
          bg="rgba(216, 6, 19, 0.08)"
        />
        <StatIconCard
          icon={CheckCircle}
          label="Colis livrés"
          value={formatNombre(c?.livres)}
          sub={`Taux de livraison : ${tauxColis(c?.livres, c) ?? '—'}`}
          color="#28a745"
          bg="rgba(40, 167, 69, 0.08)"
        />
        <StatIconCard
          icon={Undo2}
          label="Colis retournés"
          value={formatNombre(c?.retournes)}
          sub={`Taux de retour : ${tauxColis(c?.retournes, c) ?? '—'}`}
          color="#dc3545"
          bg="rgba(220, 53, 69, 0.08)"
        />
        <StatIconCard icon={Truck} label="Colis en cours" value={formatNombre(c?.en_cours)} color="#17a2b8" bg="rgba(23, 162, 184, 0.08)" />
      </div>

      {/* Montants des colis facturés (factures clients enregistrées / payées). */}
      <div className="stats-grid stats-grid-4 stats-grid-client-montants">
        <StatIconCard
          icon={Coins}
          label="CA encaissé"
          value={formatMontant(c?.ca_encaisse)}
          sub="COD des colis facturés"
          color={BRAND.colorPrimary}
          bg="rgba(216, 6, 19, 0.08)"
        />
        <StatIconCard
          icon={HandCoins}
          label="Frais payés"
          value={formatMontant(c?.frais_payes)}
          sub="Frais des colis facturés"
          color="#fd7e14"
          bg="rgba(253, 126, 20, 0.08)"
        />
        <StatIconCard
          icon={Wallet}
          label="CA net"
          value={formatMontant(c?.ca_net)}
          sub="CA encaissé − frais payés"
          color="#28a745"
          bg="rgba(40, 167, 69, 0.08)"
        />
      </div>

      <section className="dash-section">
        <h2>Graphiques de performance</h2>
        <div className="charts-grid">
          <div className="chart-card">
            <h3>Répartition colis par statut</h3>
            <BarRows
              rows={(data?.parcelsByStatus || []).map((s) => ({
                key: s.statut,
                label: statutLabel(s.statut),
                color: s.color,
                total: s.total
              }))}
              total={totalStatuts}
            />
          </div>
          <div className="chart-card">
            <h3>Top 10 villes livrées</h3>
            {/* % = part des colis livrés de la période (pas du top 10 seul). */}
            <BarRows
              rows={(data?.topVilles || []).map((v, i) => ({
                key: `${v.ville}-${i}`,
                label: v.ville,
                total: v.total
              }))}
              total={Number(c?.livres) || 0}
            />
          </div>
        </div>
      </section>
    </>
  );
}
