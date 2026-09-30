import { useEffect, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Boxes, CheckCircle, Truck, TrendingUp, TrendingDown, Coins, HandCoins, Wallet } from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, formatMontant, tauxColis } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { useAuth } from '../../context/AuthContext';

export default function Accueil() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(defaultRange());

  useEffect(() => {
    api
      .get('/dashboard/livreur', { params: { dateFrom: range.from, dateTo: range.to } })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [range.from, range.to]);

  const c = data?.counts;

  return (
    <>
      <div className="welcome-banner">
        <h1>☀️ Bonjour, {user?.name} !</h1>
        <p>Bienvenue sur votre espace livreur {BRAND.name}.</p>
      </div>

      {error && <div className="form-error">{error}</div>}

      <section className="dash-section" style={{ marginTop: 0 }}>
        <div className="dash-section-head">
          <h2>Statistiques des colis</h2>
          <DateRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="stats-grid">
          <StatIconCard icon={Boxes} label="Total colis" value={formatNombre(c?.total_colis)} color={BRAND.colorPrimary} bg="rgba(216, 6, 19, 0.08)" />
          <StatIconCard icon={CheckCircle} label="Livrés" value={formatNombre(c?.livres)} color="#28a745" bg="rgba(40, 167, 69, 0.08)" />
          <StatIconCard icon={Truck} label="En cours" value={formatNombre(c?.en_cours)} color="#17a2b8" bg="rgba(23, 162, 184, 0.08)" />
          <StatIconCard icon={TrendingUp} label="Taux de livrés" value={tauxColis(c?.livres, c)} color="#28a745" bg="rgba(40, 167, 69, 0.08)" />
          <StatIconCard icon={TrendingDown} label="Taux de retour" value={tauxColis(c?.retournes, c)} color="#dc3545" bg="rgba(220, 53, 69, 0.08)" />
        </div>
      </section>

      {/* Solde à percevoir : indépendant du sélecteur de dates (logique legacy). */}
      <section className="dash-section">
        <h2>Solde à percevoir</h2>
        <div className="stats-grid">
          <StatIconCard icon={Coins} label="Total Crbt" value={formatMontant(c?.total_crbt)} color={BRAND.colorPrimary} bg="rgba(216, 6, 19, 0.08)" />
          <StatIconCard icon={HandCoins} label="Frais livraison" value={formatMontant(c?.frais_livraison)} color="#fd7e14" bg="rgba(253, 126, 20, 0.08)" />
          <StatIconCard icon={Wallet} label="Net à payer" value={formatMontant(c?.net_a_payer)} color="#28a745" bg="rgba(40, 167, 69, 0.08)" />
        </div>
      </section>
    </>
  );
}
