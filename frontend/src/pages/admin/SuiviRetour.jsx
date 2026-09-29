import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Clock,
  FileDown,
  Hourglass,
  MapPin,
  Pencil,
  Route,
  Search,
  TriangleAlert
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import { SuiviModal, EditModal } from '../../components/ParcelModals';

/*
 * Suivi de retour (étapes 1 / 2 / 3) : colis « en circulation » sans mise à
 * jour récente, développé de la même manière que l'ancien système
 * (retour_suivre_etape1/2/3) : bannière de l'étape avec navigation entre
 * étapes, statistiques par ancienneté, recherche + filtre livreur, tableau
 * complet (sans pagination) et export PDF (A4 paysage) des lignes affichées.
 * Actions de ligne : Détail de suivi et Modifier colis (modales partagées
 * avec la page Colis).
 */

/* Types d'employé autorisés à consulter l'étape 3 (comme l'ancien système). */
const ETAPE3_TYPES = [1, 2];

/*
 * Configuration par étape : bornes en jours, thème (1 bleu / 2 orange /
 * 3 rouge), répartition des statistiques (du seuil le plus haut au plus bas)
 * et navigation vers les étapes voisines.
 */
const ETAPES = {
  1: {
    min: 2,
    max: 7,
    headerColor: '#0ea5e9',
    sousTitre: 'Colis « En cours » sans mise à jour depuis 2 à 7 jours.',
    buckets: [
      { min: 6, cls: 'critical', label: '6 j' },
      { min: 4, cls: 'warning', label: '4 à 5 j' },
      { min: 0, cls: 'recent', label: '2 à 3 j' }
    ],
    prev: null,
    next: { etape: 2, label: 'Étape 2 (7 j)' }
  },
  2: {
    min: 7,
    max: 30,
    headerColor: '#f59e0b',
    sousTitre: 'Colis « En cours » sans mise à jour depuis 7 à 30 jours.',
    buckets: [
      { min: 22, cls: 'critical', label: '22 à 29 j' },
      { min: 14, cls: 'warning', label: '14 à 21 j' },
      { min: 0, cls: 'recent', label: '7 à 13 j' }
    ],
    prev: { etape: 1, label: 'Étape 1 (2 j)' },
    next: { etape: 3, label: 'Étape 3 (30 j)' }
  },
  3: {
    min: 30,
    max: null,
    headerColor: '#b91c1c',
    sousTitre: 'Colis « En cours » non mis à jour depuis plus de 30 jours.',
    buckets: [
      { min: 60, cls: 'critical', label: '60 j et plus' },
      { min: 45, cls: 'warning', label: '45 à 59 j' },
      { min: 0, cls: 'recent', label: 'Moins de 45 j' }
    ],
    prev: { etape: 2, label: 'Étape 2 (7 j)' },
    next: null
  }
};

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Classe de la tranche d'ancienneté ('recent' | 'warning' | 'critical'). */
function bucketOf(cfg, jours) {
  return (cfg.buckets.find((b) => jours >= b.min) || cfg.buckets[cfg.buckets.length - 1]).cls;
}

function SuiviRetour({ etape }) {
  const cfg = ETAPES[etape];
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  // Horloge du serveur au moment du chargement : les jours écoulés sont
  // calculés avec elle (pas avec l'horloge du navigateur).
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [livreur, setLivreur] = useState('');
  const [exporting, setExporting] = useState(false);
  // Modale d'action de ligne : { type: 'suivi' | 'edit', parcel }.
  const [modal, setModal] = useState(null);

  // L'étape 3 est réservée aux employés type 1 / 2 (comme l'ancien système) ;
  // sert aussi à masquer le bouton "Étape 3" de la bannière de l'étape 2.
  const etape3Autorisee = user?.kind === 'employee' && ETAPE3_TYPES.includes(Number(user.role));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/parcels/suivi-retour', { params: { etape } })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setNow(res.data.now);
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
  }, [etape]);

  const jours = (r) => Math.max(0, Math.floor((now - Number(r.parcel_last_update)) / 86400));

  /** Statistiques par tranche d'ancienneté, sur l'ensemble des colis de l'étape. */
  const stats = useMemo(() => {
    const s = { recent: 0, warning: 0, critical: 0 };
    rows.forEach((r) => {
      s[bucketOf(cfg, jours(r))]++;
    });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, now]);

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

  /** Lignes affichées : filtre livreur + recherche (code, client, livreur, ville, sous-statut). */
  const filtered = useMemo(() => {
    const q = normalize(searchInput.trim());
    return rows.filter((r) => {
      if (livreur && String(r.parcel_livreur) !== livreur) return false;
      if (!q) return true;
      return normalize(
        [r.parcel_code, r.magasin, r.livreur, r.ville, r.sous_statut ? statutLabel(r.sous_statut) : ''].join(' ')
      ).includes(q);
    });
  }, [rows, livreur, searchInput]);

  /** Met à jour la ligne modifiée (modale "Modifier colis"). */
  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)));

  /** Exporte les lignes affichées en PDF A4 paysage (librairies chargées à la demande). */
  const exportPdf = async () => {
    if (exporting || !filtered.length) return;
    setExporting(true);
    try {
      const { genererSuiviRetourPdf } = await import('../../utils/suiviRetourPdf');
      await genererSuiviRetourPdf({
        etape,
        titre: `Retour à Suivre - Étape ${etape} (${cfg.min} jours)`,
        livreur: livreur ? livreurs.find((l) => l.value === livreur)?.label || '—' : 'Tous les livreurs',
        headerColor: cfg.headerColor,
        rows: filtered.map((r, i) => [
          i + 1,
          r.parcel_code || '',
          r.magasin || '',
          r.livreur || '—',
          r.ville || '',
          r.sous_statut ? statutLabel(r.sous_statut) : '—',
          formatDate(r.parcel_last_update),
          `${jours(r)} j`
        ])
      });
      setError('');
    } catch {
      setError('Impossible de générer le PDF.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rs-page">
      <div className={`rs-hero rs-hero-${etape}`}>
        <div className="rs-hero-icon">
          <TriangleAlert size={26} />
        </div>
        <div className="rs-hero-body">
          <h1 className="rs-hero-title">Retour à Suivre — Étape {etape}</h1>
          <p className="rs-hero-sub">{cfg.sousTitre}</p>
        </div>
        <div className="rs-hero-nav">
          {cfg.prev && (
            <Link to={`/admin/suivi-retour/etape-${cfg.prev.etape}`} className="rs-hero-btn">
              <ArrowLeft size={15} /> {cfg.prev.label}
            </Link>
          )}
          {cfg.next && (cfg.next.etape !== 3 || etape3Autorisee) && (
            <Link to={`/admin/suivi-retour/etape-${cfg.next.etape}`} className="rs-hero-btn">
              <Clock size={15} /> {cfg.next.label} <ArrowRight size={15} />
            </Link>
          )}
        </div>
      </div>

      <div className="rs-stats">
        <div className="rs-stat rs-stat-total">
          <div className="rs-stat-ico">
            <Boxes size={20} />
          </div>
          <div>
            <div className="rs-stat-num">{rows.length}</div>
            <div className="rs-stat-lbl">Total colis</div>
          </div>
        </div>
        {[...cfg.buckets].reverse().map((b) => (
          <div key={b.cls} className={`rs-stat rs-stat-${b.cls}`}>
            <div className="rs-stat-ico">
              <Hourglass size={20} />
            </div>
            <div>
              <div className="rs-stat-num">{stats[b.cls]}</div>
              <div className="rs-stat-lbl">{b.label}</div>
            </div>
          </div>
        ))}
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
        <button
          type="button"
          className="btn btn-danger btn-icon"
          onClick={exportPdf}
          disabled={exporting || !filtered.length}
          title={filtered.length ? 'Exporter les colis affichés en PDF' : 'Aucun colis à exporter'}
        >
          <FileDown size={16} /> {exporting ? 'Génération…' : 'Exporter PDF'}
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Code Colis</th>
              <th>Client</th>
              <th>Livreur</th>
              <th>Ville</th>
              <th>Sous-Statut</th>
              <th>Dernière mise à jour</th>
              <th>Jours écoulés</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} className="datatable-empty">
                  Aucun colis trouvé.
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => (
                <tr key={r.parcel_id}>
                  <td className="cell-sub">{i + 1}</td>
                  <td>
                    <span className="cell-main mono">{r.parcel_code || '—'}</span>
                  </td>
                  <td>{r.magasin || '—'}</td>
                  <td>
                    <span className="rs-livreur">
                      <span className="rs-avatar">
                        {(r.livreur || '—').trim().charAt(0).toUpperCase()}
                      </span>
                      {r.livreur || '—'}
                    </span>
                  </td>
                  <td>
                    <span className="rs-ville">
                      <MapPin size={13} /> {r.ville || '—'}
                    </span>
                  </td>
                  <td>
                    {r.sous_statut ? (
                      <span
                        className="badge"
                        style={r.sous_statut_color ? { background: r.sous_statut_color } : undefined}
                      >
                        {statutLabel(r.sous_statut)}
                      </span>
                    ) : (
                      <span className="badge badge-neutral">—</span>
                    )}
                  </td>
                  <td className="cell-sub">{formatDate(r.parcel_last_update)}</td>
                  <td>
                    <span className={`rs-days rs-days-${bucketOf(cfg, jours(r))}`}>
                      <Hourglass size={12} /> {jours(r)} j
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title="Détail de suivi"
                        onClick={() => setModal({ type: 'suivi', parcel: r })}
                      >
                        <Route size={16} />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title="Modifier colis"
                        onClick={() => setModal({ type: 'edit', parcel: r })}
                      >
                        <Pencil size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">
          {filtered.length.toLocaleString('fr-FR')} colis affiché(s)
        </span>
      </div>

      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'edit' && (
        <EditModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
    </div>
  );
}

export function SuiviRetourEtape1() {
  return <SuiviRetour etape={1} />;
}

export function SuiviRetourEtape2() {
  return <SuiviRetour etape={2} />;
}

export function SuiviRetourEtape3() {
  return <SuiviRetour etape={3} />;
}
