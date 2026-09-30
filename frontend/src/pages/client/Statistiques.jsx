import { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../config/brand';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Boxes,
  CheckCircle,
  Clock,
  Coins,
  FileText,
  Hand,
  HandCoins,
  Send,
  TrendingUp,
  Truck,
  Undo2,
  Wallet
} from 'lucide-react';
import api from '../../api/client';
import { StatIconCard, formatNombre, formatMontant } from '../../components/DashboardLayout';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Statistiques du client : bandeaux colis / KPIs / chiffre d'affaires,
 * graphique créés vs livrés par jour, donut des statuts, tableaux villes /
 * produits stock / marchandises (tri + pagination côté client). Volumes, KPIs
 * et charges repris de l'ancien système ; le chiffre d'affaires est basé sur
 * les factures clients payées (voir statistiquesClient.controller.js).
 */

/** Fond translucide d'une carte à partir de sa couleur hexadécimale. */
function bg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.08)`;
}

/** % formaté fr, 1 décimale. */
function pct(v) {
  return `${(Number(v) || 0).toFixed(1).replace('.', ',')} %`;
}

/** Badge coloré d'un taux de livraison : vert ≥ 75 %, orange ≥ 50 %, rouge sinon. */
function TauxBadge({ taux }) {
  const t = Number(taux) || 0;
  const style =
    t >= 75
      ? { background: '#28a745', color: '#fff' }
      : t >= 50
        ? { background: '#ffc107', color: '#212529' }
        : { background: '#dc3545', color: '#fff' };
  return (
    <span className="badge" style={style}>
      {pct(t)}
    </span>
  );
}

/**
 * Donut SVG avec légende (valeur + part). Les valeurs négatives sont exclues
 * du tracé mais restent affichées dans la légende.
 */
function Donut({ data, format = formatNombre }) {
  const traces = data.filter((d) => (Number(d.value) || 0) > 0);
  const total = traces.reduce((s, d) => s + Number(d.value), 0);
  if (total <= 0) {
    return <p className="chart-empty">Aucune donnée sur la période.</p>;
  }
  const R = 58;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 160 160" className="donut-svg" role="img">
        {traces.map((d) => {
          const frac = Number(d.value) / total;
          const el = (
            <circle
              key={d.label}
              cx="80"
              cy="80"
              r={R}
              fill="none"
              stroke={d.color}
              strokeWidth="26"
              strokeDasharray={`${frac * C} ${C}`}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 80 80)"
            >
              <title>{`${d.label} : ${format(d.value)}`}</title>
            </circle>
          );
          offset += frac;
          return el;
        })}
      </svg>
      <ul className="donut-legend">
        {data.map((d) => {
          const v = Number(d.value) || 0;
          return (
            <li key={d.label}>
              <span className="chart-row-dot" style={{ background: d.color }} />
              <span className="donut-legend-label">{d.label}</span>
              <strong>{format(v)}</strong>
              <em>{v > 0 ? pct((v / total) * 100) : '—'}</em>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Graphique en barres groupées « colis créés vs livrés » (par jour ou par mois). */
function BarsCreesLivres({ parJour }) {
  const labels = parJour?.labels || [];
  if (!labels.length) {
    return <p className="chart-empty">Aucune donnée sur la période.</p>;
  }
  const crees = parJour.crees || [];
  const livres = parJour.livres || [];
  const max = Math.max(...crees, ...livres, 1);
  // Étiquettes de l'axe : ~10 au maximum pour rester lisible.
  const step = Math.max(1, Math.ceil(labels.length / 10));
  return (
    <div>
      <div className="bars-scroll">
        <div className="bars" style={{ minWidth: `${labels.length * 22}px` }}>
          {labels.map((lb, i) => (
            <div
              key={`${lb}-${i}`}
              className="bars-col"
              title={`${lb} — créés : ${crees[i] || 0}, livrés : ${livres[i] || 0}`}
            >
              <div className="bars-track">
                <span className="bar" style={{ height: `${((crees[i] || 0) / max) * 100}%`, background: '#00c1b2' }} />
                <span className="bar" style={{ height: `${((livres[i] || 0) / max) * 100}%`, background: '#0034c1' }} />
              </div>
              <span className="bars-label">{i % step === 0 ? lb : ''}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="bars-legend">
        <span>
          <span className="chart-row-dot" style={{ background: '#00c1b2' }} /> Créés
        </span>
        <span>
          <span className="chart-row-dot" style={{ background: '#0034c1' }} /> Livrés
        </span>
      </div>
    </div>
  );
}

/**
 * Tableau statistique générique : tri par colonne (1er clic croissant, 2e
 * décroissant — mêmes conventions que les datatables) + pagination côté
 * client. `colonnes` : { key, label, align ('c' | 'r'), value(r), render(r) }.
 */
function StatsTable({ rows, colonnes, unit, unitPlural, rowKey }) {
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  const triees = useMemo(() => {
    const data = rows || [];
    const col = colonnes.find((c) => c.key === sortBy);
    if (!col) return data;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...data].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (typeof va === 'number' && typeof vb === 'number') return sens * (va - vb);
      return sens * String(va || '').localeCompare(String(vb || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [rows, colonnes, sortBy, sortDir]);

  const pager = usePagination(triees, unit, unitPlural);

  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
    pager.setPage(1);
  }

  return (
    <>
      <div className="table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              {colonnes.map((c) => {
                const isActive = sortBy === c.key;
                return (
                  <th
                    key={c.key}
                    className={`th-sortable ${isActive ? 'th-sorted' : ''} ${c.align === 'c' ? 'ta-c' : c.align === 'r' ? 'ta-r' : ''}`}
                    onClick={() => toggleSort(c.key)}
                    title="Trier"
                  >
                    <span className="th-sort-label">
                      {c.label}
                      {isActive ? (
                        sortDir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
                      ) : (
                        <ArrowUpDown size={13} className="th-sort-idle" />
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!triees.length ? (
              <tr>
                <td colSpan={colonnes.length} className="ta-c empty-cell">
                  Aucune donnée sur la période.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => (
                <tr key={rowKey(r)}>
                  {colonnes.map((c) => (
                    <td key={c.key} className={c.align === 'c' ? 'ta-c' : c.align === 'r' ? 'ta-r' : ''}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </>
  );
}

/** Taux de livraison d'une ligne (livrés / total). */
function tauxLigne(r, totalKey = 'total', livresKey = 'livres') {
  const total = Number(r[totalKey]) || 0;
  return total > 0 ? ((Number(r[livresKey]) || 0) / total) * 100 : 0;
}

/* Colonnes des tableaux produits stock / marchandises. */
const COLONNES_PRODUITS = [
  { key: 'produit', label: 'Produit', value: (r) => r.produit, render: (r) => r.produit },
  { key: 'total', label: 'Colis', align: 'c', value: (r) => Number(r.total) || 0, render: (r) => formatNombre(r.total) },
  { key: 'quantite', label: 'Quantité', align: 'c', value: (r) => Number(r.quantite) || 0, render: (r) => formatNombre(r.quantite) },
  { key: 'livres', label: 'Livrés', align: 'c', value: (r) => Number(r.livres) || 0, render: (r) => formatNombre(r.livres) },
  { key: 'taux', label: 'Taux livraison', align: 'c', value: (r) => tauxLigne(r), render: (r) => <TauxBadge taux={tauxLigne(r)} /> },
  { key: 'cod', label: 'CA livré', align: 'r', value: (r) => Number(r.cod) || 0, render: (r) => formatMontant(r.cod) }
];

/* Colonnes du tableau performance par ville. */
const COLONNES_VILLES = [
  { key: 'ville', label: 'Ville', value: (r) => r.ville, render: (r) => r.ville },
  { key: 'total', label: 'Envoyés', align: 'c', value: (r) => Number(r.total) || 0, render: (r) => formatNombre(r.total) },
  { key: 'livres', label: 'Livrés', align: 'c', value: (r) => Number(r.livres) || 0, render: (r) => formatNombre(r.livres) },
  { key: 'retours', label: 'Retours', align: 'c', value: (r) => Number(r.retours) || 0, render: (r) => formatNombre(r.retours) },
  { key: 'taux', label: 'Taux', align: 'c', value: (r) => tauxLigne(r), render: (r) => <TauxBadge taux={tauxLigne(r)} /> },
  { key: 'cod', label: 'COD livré', align: 'r', value: (r) => Number(r.cod) || 0, render: (r) => formatMontant(r.cod) }
];

export default function Statistiques() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState(defaultRange());

  useEffect(() => {
    api
      .get('/dashboard/client/statistiques', { params: { dateFrom: range.from, dateTo: range.to } })
      .then((res) => {
        setData(res.data);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [range.from, range.to]);

  const c = data?.colis;
  const k = data?.kpis;
  const ca = data?.ca;

  return (
    <>
      {error && <div className="form-error">{error}</div>}

      <div className="stats-toolbar">
        <DateRangeSelect value={range} onChange={setRange} />
      </div>

      <section className="dash-section">
        <h2>Statistiques colis</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard icon={Boxes} label="Total colis" value={formatNombre(c?.total)} color="#7987a1" bg={bg('#7987a1')} />
          <StatIconCard icon={CheckCircle} label="Livrés" value={formatNombre(c?.livres)} color="#10b759" bg={bg('#10b759')} />
          <StatIconCard icon={Undo2} label="Retournés" value={formatNombre(c?.retournes)} color="#e74c3c" bg={bg('#e74c3c')} />
          <StatIconCard icon={Hand} label="Ramassés" value={formatNombre(c?.ramasses)} color="#0090e7" bg={bg('#0090e7')} />
          <StatIconCard icon={Send} label="Expédiés" value={formatNombre(c?.expedies)} color="#8f5fe8" bg={bg('#8f5fe8')} />
          <StatIconCard icon={Truck} label="En cours" value={formatNombre(c?.en_cours)} color="#ffab00" bg={bg('#ffab00')} />
        </div>
      </section>

      <section className="dash-section">
        <h2>Statistiques KPIs</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard
            icon={CheckCircle}
            label="Taux de livraison"
            value={k ? pct(k.taux_livraison) : undefined}
            sub={k ? `${formatNombre(k.livres)} / ${formatNombre(k.traites)} colis traités` : undefined}
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard
            icon={Undo2}
            label="Taux de retour / refus"
            value={k ? pct(k.taux_retour) : undefined}
            sub={k ? `${formatNombre(k.retournes + k.refuses)} colis` : undefined}
            color="#e74c3c"
            bg={bg('#e74c3c')}
          />
          <StatIconCard
            icon={Clock}
            label="Délai moyen de livraison"
            value={k ? (k.delai_moyen_jours > 0 ? `${String(k.delai_moyen_jours).replace('.', ',')} j` : '—') : undefined}
            sub="du ramassage à la livraison"
            color="#fc424a"
            bg={bg('#fc424a')}
          />
        </div>
      </section>

      <section className="dash-section">
        <h2>Statistiques chiffre d'affaires</h2>
        <div className="stats-grid stats-grid-4">
          <StatIconCard
            icon={Coins}
            label="COD encaissé (CA livré)"
            value={formatMontant(k?.cod_livre)}
            sub={k ? `${formatNombre(k.livres)} colis livrés` : undefined}
            color="#0090e7"
            bg={bg('#0090e7')}
          />
          <StatIconCard
            icon={FileText}
            label="CA facturé"
            value={formatMontant(ca?.cod_facture)}
            sub={ca ? `${formatNombre(ca.nb_livres_factures)} colis livrés sur factures payées` : undefined}
            color={BRAND.colorPrimary}
            bg={bg(BRAND.colorPrimary)}
          />
          <StatIconCard
            icon={HandCoins}
            label="CA à facturer"
            value={formatMontant(ca?.cod_a_facturer)}
            sub={ca ? `${formatNombre(ca.nb_livres_non_payes)} colis livrés non payés` : undefined}
            color="#10b759"
            bg={bg('#10b759')}
          />
          <StatIconCard
            icon={Truck}
            label="COD en cours"
            value={formatMontant(k?.cod_en_cours)}
            sub={k ? `${formatNombre(k.en_circuit)} colis en circuit` : undefined}
            color="#ffab00"
            bg={bg('#ffab00')}
          />
          <StatIconCard
            icon={Wallet}
            label="Frais totaux payés"
            value={formatMontant(ca?.frais_payes)}
            sub="frais de livraison des factures payées"
            color="#7987a1"
            bg={bg('#7987a1')}
          />
          <StatIconCard
            icon={TrendingUp}
            label="Bénéfice net"
            value={formatMontant(data?.benefice_net)}
            sub="CA facturé − frais totaux payés"
            color="#8f5fe8"
            bg={bg('#8f5fe8')}
          />
        </div>
      </section>

      <section className="dash-section">
        <h2>Graphiques</h2>
        <div className="charts-grid charts-grid-75">
          <div className="chart-card">
            <h3>Colis créés vs livrés par jour</h3>
            <BarsCreesLivres parJour={data?.parJour} />
          </div>
          <div className="chart-card">
            <h3>Répartition des colis par statut</h3>
            {/* En cours = tout colis ni en attente de ramassage, ni livré, ni retourné. */}
            <Donut
              data={[
                { label: 'En attente de ramassage', value: c?.attente, color: '#ffab00' },
                {
                  label: 'En cours',
                  value: c ? c.total - c.attente - c.livres - c.retournes : 0,
                  color: '#0090e7'
                },
                { label: 'Livré', value: c?.livres, color: '#10b759' },
                { label: 'Retourné', value: c?.retournes, color: '#e74c3c' }
              ]}
            />
          </div>
        </div>
      </section>

      <section className="dash-section">
        <h2>Performance par ville</h2>
        <StatsTable rows={data?.villes} colonnes={COLONNES_VILLES} unit="ville" rowKey={(r) => r.ville} />
      </section>

      <section className="dash-section">
        <h2>Top produits - stock</h2>
        <StatsTable rows={data?.produits} colonnes={COLONNES_PRODUITS} unit="produit" rowKey={(r) => r.produit} />
      </section>

      <section className="dash-section">
        <h2>Top marchandises</h2>
        <StatsTable rows={data?.marchandises} colonnes={COLONNES_PRODUITS} unit="marchandise" rowKey={(r) => r.produit} />
      </section>
    </>
  );
}
