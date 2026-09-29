import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bike,
  Boxes,
  CalendarDays,
  CheckCircle,
  Clock,
  Coins,
  HandCoins,
  Hourglass,
  MapPin,
  MessageSquareWarning,
  Search,
  Star,
  Timer,
  TrendingUp,
  Truck,
  Undo2,
  Wallet
} from 'lucide-react';
import api from '../api/client';
import { StatIconCard, formatNombre, formatMontant } from './DashboardLayout';
import DateRangeSelect, { defaultRange } from './DateRangeSelect';
import { usePagination, Pager } from './Pagination';

/*
 * Onglet "Analyse" de la fiche livreur (/admin/livreurs/:id) : dix sections
 * alimentées par GET /livreurs/:id/analyse. Toutes filtrées par le sélecteur
 * de dates SAUF la section 1 (score global, toutes dates confondues).
 * La période porte sur la date d'affectation des colis (mise en distribution
 * chez ce livreur) ; l'encaissement porte sur la date de création (voir
 * livreursAnalyse.controller.js).
 */

const VERT_CLAIR = '#2fc98f';
const VERT_FONCE = '#0f7a52';

/** Fond translucide d'une carte à partir de sa couleur hexadécimale. */
function bg(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.08)`;
}

/** % formaté fr, 1 décimale. */
function pct(v) {
  return `${(Number(v) || 0).toFixed(1).replace('.', ',')} %`;
}

/** Durée en secondes → libellé lisible ("45 min", "5 h 30", "2 j 4 h"). */
function fmtDuree(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '—';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const rmin = min - h * 60;
    return rmin > 0 ? `${h} h ${String(rmin).padStart(2, '0')}` : `${h} h`;
  }
  const j = Math.floor(h / 24);
  const rh = h - j * 24;
  return rh > 0 ? `${j} j ${rh} h` : `${j} j`;
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
  return <span className="badge" style={style}>{pct(t)}</span>;
}

/** Badge d'un taux de retour (échelle inversée : bas = bon). */
function TauxRetourBadge({ taux }) {
  const t = Number(taux) || 0;
  const style =
    t <= 10
      ? { background: '#28a745', color: '#fff' }
      : t <= 25
        ? { background: '#ffc107', color: '#212529' }
        : { background: '#dc3545', color: '#fff' };
  return <span className="badge" style={style}>{pct(t)}</span>;
}

/** Pas "rond" de l'axe Y (1, 2, 5 × 10^n) pour ~4 graduations. */
function nicePas(max) {
  const brut = Math.max(1, max / 4);
  const mag = 10 ** Math.floor(Math.log10(brut));
  for (const m of [1, 2, 5, 10]) {
    if (brut <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/**
 * Graphique en courbes lissées avec aires (section 3 — évolution) : deux
 * séries sur les jours d'activité. SVG à largeur proportionnelle au nombre
 * de points, dans un conteneur à défilement horizontal.
 */
function CourbesEvolution({ evolution }) {
  const labels = evolution?.labels || [];
  if (!labels.length) {
    return <p className="chart-empty">Aucune donnée sur la période.</p>;
  }
  const series = [
    { nom: 'Affectés', couleur: VERT_CLAIR, valeurs: evolution.affectes || [] },
    { nom: 'Livrés', couleur: VERT_FONCE, valeurs: evolution.livres || [] }
  ];

  const H = 250;
  const M = { haut: 12, bas: 26, gauche: 38, droite: 16 };
  const W = Math.max(640, M.gauche + M.droite + labels.length * 46);
  const maxVal = Math.max(1, ...series.flatMap((s) => s.valeurs.map((v) => Number(v) || 0)));
  const pas = nicePas(maxVal);
  const plafond = Math.ceil(maxVal / pas) * pas;
  const ticks = [];
  for (let t = 0; t <= plafond; t += pas) ticks.push(t);

  const x = (i) =>
    labels.length === 1
      ? M.gauche + (W - M.gauche - M.droite) / 2
      : M.gauche + (i * (W - M.gauche - M.droite)) / (labels.length - 1);
  const y = (v) => M.haut + (1 - (Number(v) || 0) / plafond) * (H - M.haut - M.bas);

  /* Courbe lissée (Catmull-Rom → Bézier cubiques). */
  function cheminLisse(valeurs) {
    const pts = valeurs.map((v, i) => [x(i), y(v)]);
    if (pts.length === 1) return '';
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }

  const yBase = y(0);
  const step = Math.max(1, Math.ceil(labels.length / 16));

  return (
    <div>
      <div className="lva-chart-legend">
        {series.map((s) => (
          <span key={s.nom}>
            <span className="chart-row-dot" style={{ background: s.couleur }} /> {s.nom}
          </span>
        ))}
      </div>
      <div className="lva-chart-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="lva-chart" role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.gauche} y1={y(t)} x2={W - M.droite} y2={y(t)} className="lva-grid" />
              <text x={M.gauche - 6} y={y(t) + 3} className="lva-axis" textAnchor="end">
                {formatNombre(t)}
              </text>
            </g>
          ))}
          {labels.map((lb, i) => (
            <g key={`${lb}-${i}`}>
              <line x1={x(i)} y1={M.haut} x2={x(i)} y2={yBase} className="lva-grid lva-grid-v" />
              <text x={x(i)} y={H - 8} className="lva-axis" textAnchor="middle">
                {i % step === 0 ? lb : ''}
              </text>
            </g>
          ))}
          {series.map((s) => {
            const chemin = cheminLisse(s.valeurs);
            return (
              <g key={s.nom}>
                {chemin && (
                  <path
                    d={`${chemin} L ${x(s.valeurs.length - 1)} ${yBase} L ${x(0)} ${yBase} Z`}
                    fill={s.couleur}
                    opacity="0.13"
                  />
                )}
                {chemin && <path d={chemin} fill="none" stroke={s.couleur} strokeWidth="2.2" />}
                {s.valeurs.map((v, i) => (
                  <circle key={i} cx={x(i)} cy={y(v)} r="3.2" fill={s.couleur}>
                    <title>{`${labels[i]} — ${s.nom.toLowerCase()} : ${formatNombre(v)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/**
 * Barres verticales + liste latérale (sections 5 et 10) : `lignes` =
 * [{ label, n, pct }], `avant` = contenu optionnel au-dessus de la liste.
 */
function BarresEtListe({ lignes, couleur = '#4cd7a6', unite = '', avant = null }) {
  const total = lignes.reduce((s, l) => s + l.n, 0);
  if (total === 0) {
    return <p className="chart-empty">Aucune donnée sur la période.</p>;
  }
  const max = Math.max(1, ...lignes.map((l) => l.n));
  return (
    <div className="lva-split">
      <div className="lva-vbars">
        {lignes.map((l) => (
          <div key={l.label} className="lva-vbar-col" title={`${l.label} : ${formatNombre(l.n)}${unite}`}>
            <div className="lva-vbar-track">
              <span style={{ height: `${(l.n / max) * 100}%`, background: couleur }} />
            </div>
            <span className="lva-vbar-label">{l.label}</span>
          </div>
        ))}
      </div>
      <div className="lva-side">
        {avant}
        <ul className="lva-list">
          {lignes.map((l) => (
            <li key={l.label}>
              <span className="lva-list-label">{l.label}</span>
              <strong>{formatNombre(l.n)}</strong>
              <em>({pct(l.pct)})</em>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* Colonnes du tableau géographique (section 6). */
const COLONNES_VILLES = [
  { key: 'ville', label: 'Ville', value: (r) => r.ville, render: (r) => r.ville },
  { key: 'affectes', label: 'Affectés', align: 'c', value: (r) => r.affectes, render: (r) => formatNombre(r.affectes) },
  { key: 'livres', label: 'Livrés', align: 'c', value: (r) => r.livres, render: (r) => formatNombre(r.livres) },
  { key: 'taux_livraison', label: 'Taux livraison', align: 'c', value: (r) => r.taux_livraison, render: (r) => <TauxBadge taux={r.taux_livraison} /> },
  { key: 'retournes', label: 'Retournés', align: 'c', value: (r) => r.retournes, render: (r) => formatNombre(r.retournes) },
  { key: 'taux_retour', label: 'Taux retour', align: 'c', value: (r) => r.taux_retour, render: (r) => <TauxRetourBadge taux={r.taux_retour} /> },
  { key: 'delai_livraison_sec', label: 'Délai moyen livraison', align: 'c', value: (r) => r.delai_livraison_sec ?? -1, render: (r) => fmtDuree(r.delai_livraison_sec) },
  { key: 'delai_retour_sec', label: 'Délai moyen retour', align: 'c', value: (r) => r.delai_retour_sec ?? -1, render: (r) => fmtDuree(r.delai_retour_sec) }
];

/** Tableau des villes : recherche + tri par colonne + pagination côté client. */
function TableVilles({ villes }) {
  const [recherche, setRecherche] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  const filtrees = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    let data = villes || [];
    if (q) data = data.filter((r) => String(r.ville || '').toLowerCase().includes(q));
    const col = COLONNES_VILLES.find((c) => c.key === sortBy);
    if (!col) return data;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...data].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (typeof va === 'number' && typeof vb === 'number') return sens * (va - vb);
      return sens * String(va || '').localeCompare(String(vb || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [villes, recherche, sortBy, sortDir]);

  const pager = usePagination(filtrees, 'ville');

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
      <label className="lva-search">
        <Search size={15} />
        <input
          type="search"
          placeholder="Rechercher une ville…"
          value={recherche}
          onChange={(e) => {
            setRecherche(e.target.value);
            pager.setPage(1);
          }}
        />
      </label>
      <div className="table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              {COLONNES_VILLES.map((c) => {
                const isActive = sortBy === c.key;
                return (
                  <th
                    key={c.key}
                    className={`th-sortable ${isActive ? 'th-sorted' : ''} ${c.align === 'c' ? 'ta-c' : ''}`}
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
            {!filtrees.length ? (
              <tr>
                <td colSpan={COLONNES_VILLES.length} className="ta-c empty-cell">
                  Aucune ville sur la période.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => (
                <tr key={r.ville}>
                  {COLONNES_VILLES.map((c) => (
                    <td key={c.key} className={c.align === 'c' ? 'ta-c' : ''}>
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

/** Section 1 — score global sur 100 (anneau SVG) + classement + détail des points. */
function ScoreGlobal({ score }) {
  if (!score || score.score === null) {
    return (
      <p className="chart-empty">
        Pas encore de score : ce livreur n'a aucun colis traité (livré ou retourné).
      </p>
    );
  }
  const s = Number(score.score) || 0;
  const couleur = s >= 75 ? '#28a745' : s >= 50 ? '#ffab00' : '#dc3545';
  const R = 52;
  const C = 2 * Math.PI * R;
  const composantes = [
    { label: 'Taux de livraison', pts: score.pts.livraison, max: 60 },
    { label: 'Réclamations', pts: score.pts.reclamations, max: 20 },
    { label: 'Volume de livraisons', pts: score.pts.volume, max: 20 }
  ];
  return (
    <div className="lva-score">
      <div className="lva-score-ring">
        <svg viewBox="0 0 130 130" role="img">
          <circle cx="65" cy="65" r={R} fill="none" stroke="var(--border)" strokeWidth="11" />
          <circle
            cx="65"
            cy="65"
            r={R}
            fill="none"
            stroke={couleur}
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={`${(s / 100) * C} ${C}`}
            transform="rotate(-90 65 65)"
          />
          <text x="65" y="62" textAnchor="middle" className="lva-score-val">
            {String(Math.round(s))}
          </text>
          <text x="65" y="82" textAnchor="middle" className="lva-score-sur">
            / 100
          </text>
        </svg>
      </div>
      <div className="lva-score-infos">
        <p className="lva-score-rang">
          <Star size={15} /> Classement : <strong>{score.rang}ᵉ</strong> sur {score.total} livreurs
        </p>
        <ul className="lva-score-detail">
          {composantes.map((c) => (
            <li key={c.label}>
              <span className="lva-list-label">{c.label}</span>
              <span className="lva-progress">
                <span style={{ width: `${(c.pts / c.max) * 100}%`, background: couleur }} />
              </span>
              <strong>
                {String(c.pts).replace('.', ',')} / {c.max}
              </strong>
            </li>
          ))}
        </ul>
        <p className="lva-score-note">
          Toutes dates confondues : {formatNombre(score.affectes)} affectés ·{' '}
          {formatNombre(score.livres)} livrés · {formatNombre(score.retournes)} retournés ·{' '}
          {formatNombre(score.reclamations)} réclamations.
        </p>
      </div>
    </div>
  );
}

/** Titre numéroté d'une section de l'analyse. */
function TitreSection({ icon: Icon, numero, titre, hint }) {
  return (
    <h3 className="lva-title">
      <Icon size={16} /> {numero}. {titre}
      {hint && <span className="lva-title-hint">({hint})</span>}
    </h3>
  );
}

export default function LivreurAnalyse({ fiche }) {
  const [range, setRange] = useState(defaultRange());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/livreurs/${fiche.users_id}/analyse`, {
        params: { dateFrom: range.from, dateTo: range.to }
      })
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fiche.users_id, range.from, range.to]);

  const p = data?.productivite;
  const t = data?.temps;
  const r = data?.reclamations;
  const e = data?.encaissement;
  const jourTop = useMemo(() => {
    const jours = data?.jours?.jours || [];
    return jours.reduce((top, j) => (j.n > (top?.n || 0) ? j : top), null);
  }, [data]);

  return (
    <div className="lva">
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <BarChart3 size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Analyse — {fiche.users_name || `Livreur n°${fiche.users_id}`}</h2>
            <p className="fiche-head-sub">
              {`Compte livreur n°${fiche.users_id}`}
              {[fiche.ville_fonction, fiche.zone, fiche.agence].some(Boolean) &&
                ` — ${[fiche.ville_fonction, fiche.zone, fiche.agence].filter(Boolean).join(' · ')}`}
            </p>
          </div>
          <div className="fiche-head-role">
            <span className="fiche-hint">Rôle(s) / mission(s)</span>
            <span className="badge fiche-role-badge">
              <Bike size={13} /> Livreur
            </span>
          </div>
        </header>
        <div className="lva-toolbar">
          <span className="fiche-hint">
            Toutes les sections sont filtrées par la période, sauf le score global (n° 1). La
            période porte sur la date d'affectation des colis à ce livreur.
          </span>
          <DateRangeSelect value={range} onChange={setRange} />
        </div>
        {error && <div className="form-error">{error}</div>}
        {loading && !data && <p className="cell-sub">Chargement de l'analyse…</p>}
      </section>

      {data && (
        <div className={loading ? 'lva-stale' : ''}>
          <section className="platform-card fiche-card">
            <TitreSection icon={Star} numero={1} titre="Score global & classement" hint="toutes dates confondues" />
            <ScoreGlobal score={data.score} />
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={TrendingUp} numero={2} titre="Productivité" />
            <div className="stats-grid stats-grid-4">
              <StatIconCard
                icon={Boxes}
                label="Colis affectés"
                value={formatNombre(p?.affectes)}
                color="#7987a1"
                bg={bg('#7987a1')}
              />
              <StatIconCard
                icon={CheckCircle}
                label="Colis livrés"
                value={formatNombre(p?.livres)}
                sub={p ? `Taux de livraison : ${pct(p.taux_livraison)}` : undefined}
                color="#10b759"
                bg={bg('#10b759')}
              />
              <StatIconCard
                icon={Undo2}
                label="Colis retournés"
                value={formatNombre(p?.retournes)}
                sub={p ? `Taux de retour : ${pct(p.taux_retour)}` : undefined}
                color="#e74c3c"
                bg={bg('#e74c3c')}
              />
              <StatIconCard
                icon={Truck}
                label="Colis en cours"
                value={formatNombre(p?.en_cours)}
                sub={p ? `Taux en cours : ${pct(p.taux_en_cours)}` : undefined}
                color="#ffab00"
                bg={bg('#ffab00')}
              />
            </div>
            <p className="lva-note">
              Taux de livraison et de retour calculés hors colis en cours (base ={' '}
              {formatNombre(p ? p.affectes - p.en_cours : 0)} colis traités).
            </p>
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={BarChart3} numero={3} titre="Évolution" hint="jours d'activité de la période" />
            <CourbesEvolution evolution={data.evolution} />
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={Timer} numero={4} titre="Temps moyens" hint="durées de moins d'une heure exclues" />
            <div className="stats-grid stats-grid-4 lva-grid-3">
              <StatIconCard
                icon={Hourglass}
                label="Avant 1ᵉʳ changement"
                value={fmtDuree(t?.premier_changement?.sec)}
                sub={t ? `mise en distribution → 1ᵉʳ changement · ${formatNombre(t.premier_changement.nb)} colis` : undefined}
                color="#0090e7"
                bg={bg('#0090e7')}
              />
              <StatIconCard
                icon={CheckCircle}
                label="Temps moyen de livraison"
                value={fmtDuree(t?.livraison?.sec)}
                sub={t ? `mise en distribution → livré · ${formatNombre(t.livraison.nb)} colis` : undefined}
                color="#10b759"
                bg={bg('#10b759')}
              />
              <StatIconCard
                icon={Undo2}
                label="Temps moyen de retour"
                value={fmtDuree(t?.retour?.sec)}
                sub={t ? `dernier statut → reçu par agence · ${formatNombre(t.retour.nb)} colis` : undefined}
                color="#e74c3c"
                bg={bg('#e74c3c')}
              />
            </div>
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={Clock} numero={5} titre="Analyse des horaires" hint="changements de statut sur ses colis" />
            <BarresEtListe
              lignes={(data.horaires?.tranches || []).map((h) => ({ label: h.label, n: h.n, pct: h.pct }))}
              unite=" changement(s)"
            />
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={MapPin} numero={6} titre="Analyse géographique" hint="colis affectés groupés par ville" />
            <TableVilles villes={data.villes} />
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={Undo2} numero={7} titre="Analyse des retournés" hint="statut avant le retour" />
            {!data.retours?.total ? (
              <p className="chart-empty">Aucun colis retourné sur la période.</p>
            ) : (
              <ul className="lva-list lva-list-retours">
                {data.retours.statuts.map((s) => (
                  <li key={s.label}>
                    <span className="lva-list-label">{s.label}</span>
                    <span className="lva-progress">
                      <span style={{ width: `${s.pct}%`, background: '#e74c3c' }} />
                    </span>
                    <strong>{formatNombre(s.n)}</strong>
                    <em>({pct(s.pct)})</em>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={MessageSquareWarning} numero={8} titre="Réclamations" hint="sur ses colis, créées dans la période" />
            <div className="stats-grid stats-grid-4">
              <StatIconCard
                icon={MessageSquareWarning}
                label="Réclamations"
                value={formatNombre(r?.total)}
                color="#7987a1"
                bg={bg('#7987a1')}
              />
              <StatIconCard
                icon={CheckCircle}
                label="Traitées"
                value={r ? `${formatNombre(r.traitees)} (${pct(r.pct_traitees)})` : undefined}
                color="#10b759"
                bg={bg('#10b759')}
              />
              <StatIconCard
                icon={Hourglass}
                label="En cours"
                value={r ? `${formatNombre(r.en_cours)} (${pct(r.pct_en_cours)})` : undefined}
                color="#ffab00"
                bg={bg('#ffab00')}
              />
              <StatIconCard
                icon={Clock}
                label="Délai moyen de traitement"
                value={fmtDuree(r?.delai_moyen_sec)}
                sub="heures ouvrées (9h00 – 18h30)"
                color="#0090e7"
                bg={bg('#0090e7')}
              />
            </div>
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={HandCoins} numero={9} titre="Encaissement" hint="colis créés dans la période, factures payées" />
            <div className="stats-grid stats-grid-4">
              <StatIconCard
                icon={Coins}
                label="Montant COD collecté"
                value={formatMontant(e?.cod_collecte)}
                sub={e ? `${formatNombre(e.nb_colis_factures)} colis sur factures clients payées` : undefined}
                color="#0090e7"
                bg={bg('#0090e7')}
              />
              <StatIconCard
                icon={Wallet}
                label="Frais facturés aux clients"
                value={formatMontant(e?.frais_clients)}
                color="#1c428a"
                bg={bg('#1c428a')}
              />
              <StatIconCard
                icon={HandCoins}
                label="Moyenne frais de livraison"
                value={e?.frais_moyen_client != null ? formatMontant(e.frais_moyen_client) : '—'}
                sub="frais clients / nombre de colis"
                color="#10b759"
                bg={bg('#10b759')}
              />
              <StatIconCard
                icon={Bike}
                label="Frais du livreur"
                value={formatMontant(e?.frais_livreur)}
                sub={e ? `${formatNombre(e.nb_colis_livreur)} colis sur factures livreur payées` : undefined}
                color="#ffab00"
                bg={bg('#ffab00')}
              />
              <StatIconCard
                icon={Boxes}
                label="Coût moyen par colis"
                value={e?.cout_moyen != null ? formatMontant(e.cout_moyen) : '—'}
                sub="frais du livreur / nombre de colis"
                color="#7987a1"
                bg={bg('#7987a1')}
              />
              <StatIconCard
                icon={TrendingUp}
                label="Bénéfice société"
                value={formatMontant(e?.benefice)}
                sub="frais clients − frais du livreur"
                color="#8f5fe8"
                bg={bg('#8f5fe8')}
              />
            </div>
          </section>

          <section className="platform-card fiche-card">
            <TitreSection icon={CalendarDays} numero={10} titre="Analyse des jours" hint="colis affectés par jour de la semaine" />
            <BarresEtListe
              lignes={(data.jours?.jours || []).map((j) => ({ label: j.label, n: j.n, pct: j.pct }))}
              unite=" colis"
              avant={
                jourTop && (
                  <p className="lva-jour-top">
                    <Star size={14} /> Jour le plus actif : <strong>{jourTop.label}</strong> (
                    {formatNombre(jourTop.n)} colis)
                  </p>
                )
              }
            />
          </section>
        </div>
      )}
    </div>
  );
}
