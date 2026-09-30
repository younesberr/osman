import { useEffect, useState } from 'react';
import { BRAND } from '../../config/brand';
import {
  BarChart3,
  Boxes,
  Car,
  Coins,
  Construction,
  Fuel,
  HandCoins,
  Monitor,
  Package,
  PackageMinus,
  Paperclip,
  Undo2,
  UserPlus
} from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, formatMontant } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';

/*
 * Statistiques matériels (/admin/statistiques/materiels) — un onglet par type
 * d'article du catalogue matériel : consommation par article sur la période du
 * sélecteur (journal des mouvements, statistiquesMateriel.controller). La
 * consommation dépend du type : consommations véhicule + sorties (auto),
 * ventes clients + sorties (consommable / emballage), sorties seules
 * (non consommable — affectations / récupérations montrées à part).
 * L'onglet Globale sera développé plus tard.
 */

const TYPES = [
  { key: 'auto', label: 'Auto', icon: Car },
  { key: 'consommable', label: 'Consommable', icon: Paperclip },
  { key: 'non_consommable', label: 'Non consommable', icon: Monitor },
  { key: 'emballage', label: 'Emballage', icon: Package }
];

const TABS = [...TYPES, { key: 'globale', label: 'Globale', icon: BarChart3 }];

/* Colonnes du tableau par type (après Article / Unité). montant : valeur en
 * DH ; strong : colonne mise en avant (consommation de la période). */
const COLONNES = {
  auto: [
    { key: 'entree', label: 'Entrées' },
    { key: 'consommation', label: 'Consommations véhicules' },
    { key: 'sortie', label: 'Sorties' },
    { key: 'conso', label: 'Consommation', strong: true },
    { key: 'valeur', label: 'Valeur', montant: true },
    { key: 'stock', label: 'Stock actuel' }
  ],
  consommable: [
    { key: 'entree', label: 'Entrées' },
    { key: 'vente', label: 'Ventes clients' },
    { key: 'montant_ventes', label: 'Montant ventes', montant: true },
    { key: 'sortie', label: 'Sorties' },
    { key: 'conso', label: 'Consommation', strong: true },
    { key: 'valeur', label: 'Valeur', montant: true },
    { key: 'stock', label: 'Stock actuel' }
  ],
  non_consommable: [
    { key: 'entree', label: 'Entrées' },
    { key: 'affectation', label: 'Affectés' },
    { key: 'recuperation', label: 'Récupérés' },
    { key: 'sortie', label: 'Sorties', strong: true },
    { key: 'valeur', label: 'Valeur des sorties', montant: true },
    { key: 'stock', label: 'Stock actuel' }
  ]
};
COLONNES.emballage = COLONNES.consommable;

/** Fond translucide d'une carte à partir de sa couleur hexadécimale. */
function bg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.08)`;
}

/** Cartes de synthèse de l'onglet, selon le type d'article. */
function CartesType({ type, totaux }) {
  const t = totaux;
  const valeurSub = `quantité × prix d'achat${t?.valeur_partielle ? ' (hors articles sans prix)' : ''}`;

  if (type === 'non_consommable') {
    return (
      <div className="stats-grid stats-grid-4">
        <StatIconCard icon={UserPlus} label="Affectés" value={formatNombre(t?.affectation)} sub="aux agences et aux personnes" color="#0090e7" bg={bg('#0090e7')} />
        <StatIconCard icon={Undo2} label="Récupérés" value={formatNombre(t?.recuperation)} color="#10b759" bg={bg('#10b759')} />
        <StatIconCard icon={PackageMinus} label="Sorties stock" value={formatNombre(t?.sortie)} sub="perte / casse / correction" color="#e74c3c" bg={bg('#e74c3c')} />
        <StatIconCard icon={Coins} label="Valeur des sorties" value={t ? formatMontant(t.valeur) : undefined} sub={valeurSub} color="#8f5fe8" bg={bg('#8f5fe8')} />
      </div>
    );
  }

  if (type === 'auto') {
    return (
      <div className="stats-grid stats-grid-4">
        <StatIconCard icon={Boxes} label="Consommation totale" value={formatNombre(t?.conso)} sub="consommations véhicules + sorties" color={BRAND.colorPrimary} bg={bg(BRAND.colorPrimary)} />
        <StatIconCard icon={Fuel} label="Consommations véhicules" value={formatNombre(t?.consommation)} sub="sur les véhicules du parc" color="#fd7e14" bg={bg('#fd7e14')} />
        <StatIconCard icon={PackageMinus} label="Sorties stock" value={formatNombre(t?.sortie)} sub="perte / casse / correction" color="#e74c3c" bg={bg('#e74c3c')} />
        <StatIconCard icon={Coins} label="Valeur consommée" value={t ? formatMontant(t.valeur) : undefined} sub={valeurSub} color="#8f5fe8" bg={bg('#8f5fe8')} />
      </div>
    );
  }

  // Types vendables : consommable / emballage.
  return (
    <div className="stats-grid stats-grid-4">
      <StatIconCard icon={Boxes} label="Consommation totale" value={formatNombre(t?.conso)} sub="ventes clients + sorties" color={BRAND.colorPrimary} bg={bg(BRAND.colorPrimary)} />
      <StatIconCard
        icon={HandCoins}
        label="Ventes clients"
        value={formatNombre(t?.vente)}
        sub={t ? `${formatMontant(t.montant_ventes)} facturés (frais clients)` : undefined}
        color="#10b759"
        bg={bg('#10b759')}
      />
      <StatIconCard icon={PackageMinus} label="Sorties stock" value={formatNombre(t?.sortie)} sub="perte / casse / correction" color="#e74c3c" bg={bg('#e74c3c')} />
      <StatIconCard icon={Coins} label="Valeur consommée" value={t ? formatMontant(t.valeur) : undefined} sub={valeurSub} color="#8f5fe8" bg={bg('#8f5fe8')} />
    </div>
  );
}

/** Tableau « consommation par article » de l'onglet. */
function TableType({ type, rows, loading }) {
  const colonnes = COLONNES[type];

  const cellule = (r, col) => {
    if (col.montant) return r[col.key] == null ? '—' : formatMontant(r[col.key]);
    const v = formatNombre(r[col.key]);
    return col.strong ? <strong>{v}</strong> : v;
  };

  return (
    <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
      <table>
        <thead>
          <tr>
            <th>Article</th>
            <th>Unité</th>
            {colonnes.map((col) => (
              <th key={col.key}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td colSpan={colonnes.length + 2} className="datatable-empty">
                Aucun article de ce type.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="cell-main">{r.nom}</div>
                  {(r.reference || !r.active) && (
                    <div className="cell-sub">
                      {r.reference}
                      {!r.active && `${r.reference ? ' — ' : ''}Désactivé`}
                    </div>
                  )}
                </td>
                <td>{r.unite || '—'}</td>
                {colonnes.map((col) => (
                  <td key={col.key}>{cellule(r, col)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Onglet d'un type d'article : sélecteur de période, cartes et tableau. */
function OngletType({ type, range, onRange, data, loading, error }) {
  return (
    <>
      <div className="stats-toolbar">
        <DateRangeSelect value={range} onChange={onRange} />
      </div>

      {error && <div className="form-error">{error}</div>}

      <section className="dash-section" style={{ marginTop: 0 }}>
        <h2>Consommation de la période</h2>
        <CartesType type={type} totaux={data?.totaux} />
      </section>

      <section className="dash-section">
        <h2>Consommation par article</h2>
        <TableType type={type} rows={data?.rows || []} loading={loading} />
      </section>
    </>
  );
}

export default function StatistiquesMateriels() {
  const [tab, setTab] = useState('auto');
  const [range, setRange] = useState(defaultRange());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (tab === 'globale') return;
    setData(null);
    setLoading(true);
    api
      .get('/statistiques/materiels', {
        params: { type: tab, dateFrom: range.from, dateTo: range.to }
      })
      .then((res) => {
        setData(res.data);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, [tab, range.from, range.to]);

  return (
    <>
      <nav className="fiche-tabs" aria-label="Onglets des statistiques matériels">
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

      {tab === 'globale' ? (
        <div className="empty-page">
          <Construction size={44} className="empty-page-icon" />
          <h1>Statistiques globales matériels</h1>
          <p>Cet onglet est en cours de développement.</p>
        </div>
      ) : (
        <OngletType
          type={tab}
          range={range}
          onRange={setRange}
          data={data}
          loading={loading}
          error={error}
        />
      )}
    </>
  );
}
