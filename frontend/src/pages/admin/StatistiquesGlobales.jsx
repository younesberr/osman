import { useEffect, useState } from 'react';
import { BRAND } from '../../config/brand';
import {
  AlertCircle,
  Bike,
  Boxes,
  Building2,
  CalendarRange,
  Car,
  CheckCircle,
  Clock,
  Coins,
  FileText,
  Gauge,
  HandCoins,
  LayoutDashboard,
  MessageSquareWarning,
  Store,
  Timer,
  TrendingDown,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Wallet
} from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, formatMontant } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';

/*
 * Statistiques globales (/admin/statistiques/globales) — deux onglets :
 *  - Vue d'ensemble : compteurs hors période (agences, clients, prestataires,
 *    employés) + parc de moyens logistiques par type ;
 *  - Par période : indicateurs des colis créés dans la plage du sélecteur
 *    (volumes, taux, COD / frais des factures payées, délais issus de
 *    l'historique des statuts, réclamations).
 * Données : statistiquesAdmin.controller.js (service STATISTIQUES).
 */

const TABS = [
  { key: 'ensemble', label: "Vue d'ensemble", icon: LayoutDashboard },
  { key: 'periode', label: 'Par période', icon: CalendarRange }
];

/** Fond translucide d'une carte à partir de sa couleur hexadécimale. */
function bg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.08)`;
}

/** % formaté fr, 1 décimale. */
function pct(v) {
  return `${(Number(v) || 0).toFixed(1).replace('.', ',')} %`;
}

/** Durée en secondes → « 2,4 j » / « 5 h 12 min » / « 42 min » (— si absente). */
function formatDuree(sec) {
  if (sec == null || sec <= 0) return '—';
  if (sec >= 86400) return `${(sec / 86400).toFixed(1).replace('.', ',')} j`;
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const min = Math.round((sec % 3600) / 60);
    return min > 0 ? `${h} h ${String(min).padStart(2, '0')} min` : `${h} h`;
  }
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

/** Carte d'un type de moyen du parc : total / disponibles / indisponibles. */
function ParcCard({ icon: Icon, label, stats }) {
  return (
    <div className="parc-card">
      <h3>
        <Icon size={18} /> {label}
      </h3>
      <div className="parc-vals">
        <div className="parc-val">
          <strong>{formatNombre(stats?.total) ?? '—'}</strong>
          <span>Total</span>
        </div>
        <div className="parc-val">
          <strong className="parc-dispo">{formatNombre(stats?.disponibles) ?? '—'}</strong>
          <span>Disponible</span>
        </div>
        <div className="parc-val">
          <strong className="parc-indispo">{formatNombre(stats?.indisponibles) ?? '—'}</strong>
          <span>Indisponible</span>
        </div>
      </div>
    </div>
  );
}

/** Onglet « Vue d'ensemble » : compteurs de structure + parc de moyens. */
function OngletEnsemble({ data }) {
  return (
    <>
      <section className="dash-section" style={{ marginTop: 0 }}>
        <h2>Clients & prestataires</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard icon={Building2} label="Agences" value={formatNombre(data?.agences)} color="#8f5fe8" bg={bg('#8f5fe8')} />
          <StatIconCard icon={Store} label="Clients" value={formatNombre(data?.clients)} color="#0090e7" bg={bg('#0090e7')} />
          <StatIconCard icon={Truck} label="Prestataires" value={formatNombre(data?.livreurs)} sub="livreurs non salariés" color="#10b759" bg={bg('#10b759')} />
          <StatIconCard icon={UserCog} label="Employés" value={formatNombre(data?.employes)} color="#e83e8c" bg={bg('#e83e8c')} />
        </div>
      </section>

      <section className="dash-section">
        <h2>Logistique — Parc de moyens</h2>
        <div className="parc-grid">
          <ParcCard icon={Bike} label="Moto" stats={data?.parc?.moto} />
          <ParcCard icon={Car} label="VL (permis B)" stats={data?.parc?.vl} />
          <ParcCard icon={Truck} label="PL (permis C)" stats={data?.parc?.pl} />
        </div>
      </section>
    </>
  );
}

/** Onglet « Par période » : indicateurs des colis créés dans la plage. */
function OngletPeriode({ data, range, onRange }) {
  const c = data?.colis;
  const m = data?.montants;
  const d = data?.delais;
  const r = data?.reclamations;

  return (
    <>
      <div className="stats-toolbar">
        <DateRangeSelect value={range} onChange={onRange} />
      </div>

      <section className="dash-section" style={{ marginTop: 0 }}>
        <h2>Colis de la période</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard icon={Boxes} label="Total colis" value={formatNombre(c?.total)} color={BRAND.colorPrimary} bg={bg(BRAND.colorPrimary)} />
          <StatIconCard icon={CheckCircle} label="Colis livrés" value={formatNombre(c?.livres)} color="#10b759" bg={bg('#10b759')} />
          <StatIconCard
            icon={Truck}
            label="Colis en cours"
            value={formatNombre(c?.en_cours)}
            sub="ni en attente, ni livrés, ni retournés"
            color="#ffab00"
            bg={bg('#ffab00')}
          />
          <StatIconCard
            icon={TrendingUp}
            label="Taux de livraison"
            value={c ? pct(c.taux_livraison) : undefined}
            sub={c ? `${formatNombre(c.livres)} / ${formatNombre(c.total - c.en_cours)} colis hors en cours` : undefined}
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard
            icon={TrendingDown}
            label="Taux de retour"
            value={c ? pct(c.taux_retour) : undefined}
            sub={c ? `${formatNombre(c.retournes)} colis retournés` : undefined}
            color="#e74c3c"
            bg={bg('#e74c3c')}
          />
          <StatIconCard
            icon={Gauge}
            label="Taux de colis en cours"
            value={c ? pct(c.taux_en_cours) : undefined}
            sub={c ? `${formatNombre(c.en_cours)} / ${formatNombre(c.total)} colis` : undefined}
            color="#ffab00"
            bg={bg('#ffab00')}
          />
        </div>
      </section>

      <section className="dash-section">
        <h2>Montants & frais</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard
            icon={Coins}
            label="COD total"
            value={formatMontant(c?.cod_total)}
            sub="colis créés dans la période"
            color="#0090e7"
            bg={bg('#0090e7')}
          />
          <StatIconCard
            icon={FileText}
            label="COD facturé"
            value={formatMontant(m?.cod_facture)}
            sub={m ? `${formatNombre(m.nb_livres_factures)} colis sur factures clients payées` : undefined}
            color={BRAND.colorPrimary}
            bg={bg(BRAND.colorPrimary)}
          />
          <StatIconCard
            icon={HandCoins}
            label="Frais moyen de livraison"
            value={m ? (m.frais_moyen == null ? '—' : formatMontant(m.frais_moyen)) : undefined}
            sub="par colis livré sur facture client payée"
            color="#8f5fe8"
            bg={bg('#8f5fe8')}
          />
          <StatIconCard
            icon={Wallet}
            label="Coût moyen de livraison"
            value={m ? (m.cout_moyen == null ? '—' : formatMontant(m.cout_moyen)) : undefined}
            sub="par colis livré sur facture livreur payée"
            color="#fd7e14"
            bg={bg('#fd7e14')}
          />
        </div>
      </section>

      <section className="dash-section">
        <h2>Délais</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard
            icon={Timer}
            label="Avant 1er changement de statut"
            value={d ? formatDuree(d.premier_changement.sec) : undefined}
            sub="depuis la mise en distribution, hors changements < 1 h"
            color="#17a2b8"
            bg={bg('#17a2b8')}
          />
          <StatIconCard
            icon={Clock}
            label="Temps moyen de livraison"
            value={d ? formatDuree(d.livraison.sec) : undefined}
            sub="mise en distribution → livré"
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard
            icon={Undo2}
            label="Temps moyen de retour"
            value={d ? formatDuree(d.retour.sec) : undefined}
            sub="dernier statut → retourné (reçu par agence)"
            color="#e74c3c"
            bg={bg('#e74c3c')}
          />
        </div>
      </section>

      <section className="dash-section">
        <h2>Réclamations</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard
            icon={MessageSquareWarning}
            label="Réclamations"
            value={formatNombre(r?.total)}
            sub="créées dans la période"
            color={BRAND.colorPrimary}
            bg={bg(BRAND.colorPrimary)}
          />
          <StatIconCard
            icon={CheckCircle}
            label="Traitées"
            value={formatNombre(r?.traitees)}
            sub={r ? `${pct(r.pct_traitees)} du total` : undefined}
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard
            icon={AlertCircle}
            label="En cours"
            value={formatNombre(r?.en_cours)}
            sub={r ? `${pct(r.pct_en_cours)} du total` : undefined}
            color="#ffab00"
            bg={bg('#ffab00')}
          />
          <StatIconCard
            icon={Timer}
            label="Délai moyen de traitement"
            value={r ? formatDuree(r.delai_moyen_sec) : undefined}
            sub="heures ouvrées (9h00 – 18h30)"
            color="#8f5fe8"
            bg={bg('#8f5fe8')}
          />
        </div>
      </section>
    </>
  );
}

export default function StatistiquesGlobales() {
  const [tab, setTab] = useState('ensemble');
  const [structure, setStructure] = useState(null);
  const [periode, setPeriode] = useState(null);
  const [range, setRange] = useState(defaultRange());
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/statistiques/globales/structure')
      .then((res) => setStructure(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, []);

  useEffect(() => {
    setPeriode(null);
    api
      .get('/statistiques/globales/periode', { params: { dateFrom: range.from, dateTo: range.to } })
      .then((res) => {
        setPeriode(res.data);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [range.from, range.to]);

  return (
    <>
      <nav className="fiche-tabs" aria-label="Onglets des statistiques globales">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`fiche-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </nav>

      {error && <div className="form-error">{error}</div>}

      {tab === 'ensemble' ? (
        <OngletEnsemble data={structure} />
      ) : (
        <OngletPeriode data={periode} range={range} onRange={setRange} />
      )}
    </>
  );
}
