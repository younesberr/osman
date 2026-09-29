import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Eye,
  Search,
  X,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect from '../../components/DateRangeSelect';

const PAGE_SIZES = [10, 25, 50, 100];

/* Seuils du filtre "nombre minimum de colis saisis". */
const MIN_COLIS = [5, 10, 20, 50, 100];

/** Nombre entier au format fr-FR ('1 234'). */
function formatCount(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA". */
function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDateTime(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Modale "Voir fiche client" : coordonnées, banque et activité colis. */
function DetailModal({ client, onClose }) {
  const rows = [
    ['Nom complet', client.name],
    ['CIN', client.cin],
    ['N° téléphone personnel', client.phone_personal],
    ['N° téléphone magasin', client.phone],
    ['Adresse électronique', client.email],
    ['Ville', client.city],
    ['Adresse', client.address],
    ['Banque', client.banque],
    ['RIB', client.rib],
    ['Inscrit le', formatDateTime(client.inscription)],
    ['Colis saisis', formatCount(client.colis_total)],
    ['Premier colis saisi', formatDateTime(client.premier_colis)],
    ['Dernier colis saisi', formatDateTime(client.dernier_colis)]
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">{client.store || '—'}</div>
              <div className="cell-sub">
                {client.active === 1 ? 'Client actif' : 'Client désactivé'} — non vérifié
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <dl className="detail-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="detail-row">
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * Page Clients non vérifiés : comptes marchands non vérifiés
 * (customers_verified = 0) ayant saisi au moins un colis. Action principale :
 * marquer le client vérifié, il sort alors de la liste.
 */
export default function ClientsNonVerifies() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [ville, setVille] = useState('');
  const [agence, setAgence] = useState('');
  const [active, setActive] = useState('');
  const [minColis, setMinColis] = useState('');
  // Plage du dernier colis saisi ('' = sans limite) : toutes les dates par défaut.
  const [dernier, setDernier] = useState({ from: '', to: '', preset: 'all' });
  const [sortBy, setSortBy] = useState('dernier_colis');
  const [sortDir, setSortDir] = useState('desc');
  const [filtres, setFiltres] = useState({ villes: [], agences: [] });
  const [detail, setDetail] = useState(null);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const COL_COUNT = 5;

  /** Tri serveur : 1er clic = décroissant, 2e clic = croissant. */
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
    setPage(1);
  }

  function SortableTh({ sortKey, children }) {
    const isActive = sortBy === sortKey;
    return (
      <th className={`th-sortable ${isActive ? 'th-sorted' : ''}`} onClick={() => toggleSort(sortKey)} title="Trier">
        <span className="th-sort-label">
          {children}
          {isActive ? (
            sortDir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
          ) : (
            <ArrowUpDown size={13} className="th-sort-idle" />
          )}
        </span>
      </th>
    );
  }

  // Recherche débouncée : on n'interroge le serveur que 400 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    api
      .get('/clients-non-verifies/filtres')
      .then((res) => setFiltres(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/clients-non-verifies', {
        params: {
          page,
          pageSize,
          search,
          ville,
          agence,
          active,
          minColis,
          dernierFrom: dernier.from,
          dernierTo: dernier.to,
          sortBy,
          sortDir
        }
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
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
  }, [page, pageSize, search, ville, agence, active, minColis, dernier, sortBy, sortDir, reload]);

  const rangeLabel = useMemo(() => {
    if (!total) return '0 client';
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} clients`;
  }, [page, pageSize, total]);

  async function verifier(c) {
    if (
      !window.confirm(
        `Voulez-vous vraiment marquer le client « ${c.store || c.name} » comme vérifié ? Il sortira de cette liste.`
      )
    ) {
      return;
    }
    setBusyId(c.customers_id);
    try {
      await api.patch(`/clients-non-verifies/${c.customers_id}/verifier`);
      // Le client vérifié sort de la liste : rechargement pour garder total et
      // pagination exacts (et reculer d'une page si celle-ci se vide).
      setPage((p) => (rows.length === 1 && p > 1 ? p - 1 : p));
      setReload((n) => n + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="utilisateurs-page">
      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : magasin, nom, CIN, téléphone, email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <SearchableSelect
          className="ss-toolbar"
          value={ville}
          onChange={(v) => {
            setVille(v);
            setPage(1);
          }}
          placeholder="Toutes les villes de ramassage"
          options={[
            { value: '', label: 'Toutes les villes de ramassage' },
            ...filtres.villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))
          ]}
        />
        <select
          className="datatable-select"
          value={agence}
          onChange={(e) => {
            setAgence(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Toutes les agences</option>
          {filtres.agences.map((a) => (
            <option key={a.agence_id} value={a.agence_id}>
              {a.agence_name}
            </option>
          ))}
        </select>
        <select
          className="datatable-select"
          value={minColis}
          onChange={(e) => {
            setMinColis(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Nombre de colis : au moins 1</option>
          {MIN_COLIS.map((n) => (
            <option key={n} value={n}>
              Nombre de colis : au moins {n}
            </option>
          ))}
        </select>
        {/* Plage du dernier colis saisi : cible les clients récemment actifs. */}
        <DateRangeSelect
          value={dernier}
          onChange={(v) => {
            setDernier(v);
            setPage(1);
          }}
        />
        <select
          className="datatable-select"
          value={active}
          onChange={(e) => {
            setActive(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Tous les statuts</option>
          <option value="1">Activés</option>
          <option value="0">Désactivés</option>
        </select>
        <select
          className="datatable-select"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Nom magasin</th>
              <th>Ville de ramassage</th>
              <th>Contact</th>
              <SortableTh sortKey="dernier_colis">Dernier colis</SortableTh>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={COL_COUNT} className="datatable-empty">
                  Aucun client non vérifié avec colis trouvé.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.customers_id} className={c.active === 1 ? '' : 'row-inactive'}>
                  <td>
                    <div className="cell-main">{c.store || '—'}</div>
                    <div className="cell-sub">
                      {c.name || '—'}
                      {c.active !== 1 && <span className="badge badge-inactive">Désactivé</span>}
                    </div>
                  </td>
                  <td>
                    <div className="cell-main">{c.ville_ramassage || '—'}</div>
                    {/* Zone et agence dérivées de la ville de ramassage. */}
                    <div className="cell-sub">{[c.zone, c.agence].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td>
                    <div className="cell-main">{c.phone_personal || c.phone || '—'}</div>
                    <div className="cell-sub">{c.email || '—'}</div>
                  </td>
                  <td>
                    <div className="cell-main">{formatDate(c.dernier_colis)}</div>
                    <div className="cell-sub">1er : {formatDate(c.premier_colis)}</div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title="Voir fiche client"
                        onClick={() => setDetail(c)}
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        type="button"
                        className="row-action row-action-success"
                        title="Marquer vérifié"
                        onClick={() => verifier(c)}
                        disabled={busyId === c.customers_id}
                      >
                        <BadgeCheck size={16} />
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
        <span className="datatable-range">{rangeLabel}</span>
        <div className="datatable-pager">
          <button type="button" className="page-btn" onClick={() => setPage(1)} disabled={page <= 1} title="Première page">
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n - 1)}
            disabled={page <= 1}
            title="Page précédente"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="page-info">
            Page {page.toLocaleString('fr-FR')} / {totalPages.toLocaleString('fr-FR')}
          </span>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n + 1)}
            disabled={page >= totalPages}
            title="Page suivante"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            title="Dernière page"
          >
            <ChevronsRight size={16} />
          </button>
        </div>
      </div>

      {detail && <DetailModal client={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
