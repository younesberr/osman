import { useEffect, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Navigate } from 'react-router-dom';
import { Boxes, CheckCircle, Truck, Undo2, Send, Hand, Route, TrendingUp, TrendingDown } from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, tauxColis } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { useAuth } from '../../context/AuthContext';
import { adminHomePath } from '../../config/adminMenu';

export default function Accueil() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(defaultRange());
  // Le ramasseur (type 6) n'a pas de tableau de bord : il arrive sur Ramassage par scan.
  const home = adminHomePath(user);
  const sansAccueil = home !== '/admin';

  useEffect(() => {
    if (sansAccueil) return;
    api
      .get('/dashboard/admin', { params: { dateFrom: range.from, dateTo: range.to } })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [sansAccueil, range.from, range.to]);

  if (sansAccueil) {
    return home ? (
      <Navigate to={home} replace />
    ) : (
      <div className="form-error">Aucune page ne vous est attribuée. Contactez votre responsable.</div>
    );
  }

  // Même logique que la page Statistiques globales (onglet Par période) :
  // total hors attente de ramassage ; en cours = ni attente, ni livré, ni
  // retourné ; taux = part / (total − en cours), soit sur livrés + retournés.
  const c = data?.counts;
  const baseTaux = c ? (Number(c.total_colis) || 0) - (Number(c.en_cours) || 0) : null;
  const subTaux = (part) => (c ? `${formatNombre(part)} / ${formatNombre(baseTaux)} colis` : undefined);

  return (
    <>
      <div className="welcome-banner welcome-compact">
        <h1>☀️ Bonjour, {user?.name} !</h1>
        <p>Bienvenue sur votre tableau de bord {BRAND.name}.</p>
      </div>

      {error && <div className="form-error">{error}</div>}

      <section className="dash-section" style={{ marginTop: 0 }}>
        <div className="dash-section-head">
          <h2>Statistiques des colis</h2>
          <DateRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="stats-grid stats-grid-accueil">
          <StatIconCard icon={Boxes} label="Total colis" value={formatNombre(c?.total_colis)} color={BRAND.colorPrimary} bg="rgba(216, 6, 19, 0.08)" />
          <StatIconCard icon={CheckCircle} label="Livrés" value={formatNombre(c?.livres)} color="#28a745" bg="rgba(40, 167, 69, 0.08)" />
          <StatIconCard icon={Truck} label="En cours" value={formatNombre(c?.en_cours)} color="#17a2b8" bg="rgba(23, 162, 184, 0.08)" />
          <StatIconCard icon={Undo2} label="Retournés" value={formatNombre(c?.retournes)} color="#dc3545" bg="rgba(220, 53, 69, 0.08)" />
          <StatIconCard icon={Send} label="Expédiés" value={formatNombre(c?.expedies)} color="#6f42c1" bg="rgba(111, 66, 193, 0.08)" />
          <StatIconCard icon={Hand} label="Ramassés" value={formatNombre(c?.ramasses)} color="#fd7e14" bg="rgba(253, 126, 20, 0.08)" />
          <StatIconCard icon={Route} label="En distribution" value={formatNombre(c?.distribution)} color="#0090e7" bg="rgba(0, 144, 231, 0.08)" />
          <StatIconCard icon={TrendingUp} label="Taux de livraison" value={tauxColis(c?.livres, c)} sub={subTaux(c?.livres)} color="#28a745" bg="rgba(40, 167, 69, 0.08)" />
          <StatIconCard icon={TrendingDown} label="Taux de retour" value={tauxColis(c?.retournes, c)} sub={subTaux(c?.retournes)} color="#dc3545" bg="rgba(220, 53, 69, 0.08)" />
        </div>
      </section>
    </>
  );
}
