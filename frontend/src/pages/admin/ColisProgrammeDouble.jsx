import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarClock,
  CalendarRange,
  Check,
  Hourglass,
  MapPin,
  Route,
  Search,
  TriangleAlert
} from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import { SuiviModal } from '../../components/ParcelModals';

/*
 * Programmé doublé (Colis besoin d'attention, fonctions 1-2) : colis encore en
 * distribution dont les programmations sont anormales, en trois onglets :
 * - « +1 jour » : colis programmé / reporté pour au moins un jour après le
 *   jour où le statut a été posé (posé le 16/09 pour le 17/09 ou plus tard) ;
 * - « Double programmé » : colis programmé / reporté plus d'une fois ;
 * - « +30 jours distribution » : colis expédié depuis 30 jours ou plus et
 *   toujours ni livré ni retourné.
 * Colonnes empilées (magasin sous le code, date d'expédition sous la ville de
 * ramassage, date programmée sous le statut), écart en jours, nombre de
 * programmations ou jours depuis l'expédition selon l'onglet (colonne
 * VALEURS), actions Détail de suivi / Traiter (même
 * marquage que Colis à suivre : le colis disparaît de la page jusqu'à son
 * prochain changement de statut). Liste complète sans pagination, recherche
 * et filtre livreur côté frontend.
 */
const TABS = [
  { key: 'plus_un_jour', label: '+1 jour', icon: CalendarClock, color: '#d97706' },
  { key: 'double', label: 'Double programmé', icon: CalendarRange, color: '#7c3aed' },
  { key: 'plus_30_jours', label: '+30 jours distribution', icon: Hourglass, color: '#dc2626' }
];

/* Colonne chiffrée de chaque onglet : champ trié (décroissant), critère de
   rouge, en-tête, icône, unité, et sous-ligne (date) avec son champ. */
const VALEURS = {
  plus_un_jour: {
    champ: 'jours',
    critique: 3,
    entete: "Jours d'avance",
    icon: CalendarClock,
    unite: 'j',
    sousLigne: 'Programmé le',
    sousChamp: 'derniere_programmation'
  },
  double: {
    champ: 'nb_programmations',
    critique: 3,
    entete: 'Nb programmations',
    icon: CalendarRange,
    unite: 'fois',
    sousLigne: 'Dernière le',
    sousChamp: 'derniere_programmation'
  },
  plus_30_jours: {
    champ: 'jours_expedition',
    critique: 60,
    entete: 'Jours depuis expédition',
    icon: Hourglass,
    unite: 'j',
    sousLigne: 'Dernière MAJ le',
    sousChamp: 'parcel_last_update'
  }
};

const AUTRES_PAGES = [
  { path: '/admin/colis-attention/alerte', label: 'Colis alerte 00H00' },
  { path: '/admin/colis-attention/a-suivre', label: 'Colis à suivre' }
];

/* Statuts (affichés) pour lesquels la date programmée est montrée sous le statut. */
const STATUTS_PROGRAMMES = ['PROGRAMMER', 'POSTPONED'];

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA". */
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value.trim();
}

export default function ColisProgrammeDouble() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('plus_un_jour');
  const [searchInput, setSearchInput] = useState('');
  const [livreur, setLivreur] = useState('');
  // Modale « Détail de suivi » : colis ouvert.
  const [suivi, setSuivi] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/parcels/attention/programmes')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
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
  }, []);

  /** Compteurs des tuiles-onglets : un colis peut compter dans plusieurs. */
  const counts = useMemo(
    () => Object.fromEntries(TABS.map((t) => [t.key, rows.filter((r) => r[t.key]).length])),
    [rows]
  );

  /** Livreurs présents dans la liste (options du filtre). */
  const livreurs = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      if (Number(r.parcel_livreur) > 0 && r.livreur) map.set(String(r.parcel_livreur), r.livreur);
    });
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  /** Lignes de l'onglet, filtrées (livreur, recherche) et triées du plus anormal au moins. */
  const filtered = useMemo(() => {
    const q = normalize(searchInput.trim());
    const liste = rows.filter((r) => {
      if (!r[tab]) return false;
      if (livreur && String(r.parcel_livreur) !== livreur) return false;
      if (!q) return true;
      return normalize(
        [r.parcel_code, r.magasin, r.livreur, r.ville_ramassage, r.ville, statutLabel(r.statut)].join(' ')
      ).includes(q);
    });
    const { champ, sousChamp } = VALEURS[tab];
    return liste.sort(
      (a, b) => Number(b[champ]) - Number(a[champ]) || Number(a[sousChamp]) - Number(b[sousChamp])
    );
  }, [rows, tab, livreur, searchInput]);

  /**
   * « Traiter » (après confirmation) : masque le colis sans changer son
   * statut ; il ne réapparaîtra que si son statut change à nouveau.
   */
  const traiter = async (r) => {
    if (
      !window.confirm(
        `Marquer le colis « ${r.parcel_code} » comme traité ?\n` +
          'Il disparaîtra de cette page et ne réapparaîtra que si son statut change à nouveau.'
      )
    ) {
      return;
    }
    try {
      await api.post(`/parcels/${r.parcel_id}/traiter`);
      setRows((prev) => prev.filter((x) => x.parcel_id !== r.parcel_id));
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du marquage du colis.');
    }
  };

  const valeurs = VALEURS[tab];
  const IconValeur = valeurs.icon;

  return (
    <div className="rs-page">
      <div className="rs-hero rs-hero-2">
        <div className="rs-hero-icon">
          <TriangleAlert size={26} />
        </div>
        <div className="rs-hero-body">
          <h1 className="rs-hero-title">Programmé doublé</h1>
          <p className="rs-hero-sub">
            Colis en distribution programmés pour plus d&apos;un jour après le jour de
            programmation, programmés plusieurs fois, ou expédiés depuis plus de 30 jours
            sans être livrés ni retournés.
          </p>
        </div>
        <div className="rs-hero-nav">
          {AUTRES_PAGES.map((p) => (
            <Link key={p.path} to={p.path} className="rs-hero-btn">
              {p.label} <ArrowRight size={15} />
            </Link>
          ))}
        </div>
      </div>

      <div className="ca-tiles">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              className={`ca-tile ${tab === t.key ? 'ca-tile-active' : ''}`}
              style={{ '--ca-c': t.color }}
              onClick={() => setTab(t.key)}
            >
              <span className="ca-tile-ico">
                <Icon size={19} />
              </span>
              <span>
                <span className="ca-tile-count">{counts[t.key] || 0}</span>
                <span className="ca-tile-lbl">{t.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, client, livreur, ville…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <SearchSelect
          label="Livreur"
          options={livreurs}
          value={livreur}
          onChange={setLivreur}
          allLabel="Tous les livreurs"
        />
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Code Colis</th>
              <th>Ville de ramassage</th>
              <th>Statut</th>
              <th>Ville destination</th>
              <th>{valeurs.entete}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="datatable-empty">
                  Aucun colis dans cette catégorie — tout est à jour.
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => {
                const valeur = Number(r[valeurs.champ]);
                const critique = valeur >= valeurs.critique;
                return (
                  <tr key={r.parcel_id}>
                    <td className="cell-sub">{i + 1}</td>
                    <td>
                      <span className="cell-main mono">{r.parcel_code || '—'}</span>
                      <div className="cell-sub">{r.magasin || '—'}</div>
                    </td>
                    <td>
                      <span className="rs-ville">
                        <MapPin size={13} /> {r.ville_ramassage || '—'}
                      </span>
                      <div className="cell-sub">
                        {Number(r.parcel_sent_time) > 0
                          ? `Expédié le ${formatDate(r.parcel_sent_time)}`
                          : 'Non expédié'}
                      </div>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={r.statut_color ? { background: r.statut_color } : undefined}
                      >
                        {statutLabel(r.statut)}
                      </span>
                      {STATUTS_PROGRAMMES.includes(r.statut) && r.report_time && (
                        <div className="ca-stack-sub">
                          <span className="ca-date-prog">{formatReportDate(r.report_time)}</span>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="rs-ville">
                        <MapPin size={13} /> {r.ville || '—'}
                      </span>
                    </td>
                    <td>
                      <span className={`rs-days rs-days-${critique ? 'critical' : 'warning'}`}>
                        <IconValeur size={12} /> {valeur} {valeurs.unite}
                      </span>
                      <div className="cell-sub">
                        {valeurs.sousLigne} {formatDate(r[valeurs.sousChamp])}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Détail de suivi"
                          onClick={() => setSuivi(r)}
                        >
                          <Route size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action row-action-success"
                          title="Marquer comme traité — disparaît de la page sans changer le statut"
                          onClick={() => traiter(r)}
                        >
                          <Check size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">
          {filtered.length.toLocaleString('fr-FR')} colis affiché(s)
        </span>
      </div>

      {suivi && <SuiviModal parcel={suivi} onClose={() => setSuivi(null)} />}
    </div>
  );
}
