import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Info, PackageSearch, Search, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Gestion de stock > Colis en attente — colis créés depuis le stock
 * (parcel_from_stock = 1) en attente de ramassage (WAITING_PICKUP) :
 * code, magasin, destinataire + téléphone, ville + adresse, date de création,
 * commentaire, et modale listant les produits du colis avec leurs quantités.
 * Tri par défaut : date de création croissante (les plus anciens en haut).
 */

/** Nom de magasin affiché : enseigne du client, sinon son nom. */
function magasinLabel(colis) {
  return colis.magasin || colis.clientNom || '';
}

/** Date de création (timestamp unix en secondes) au format fr : jj/mm/aaaa hh:mm. */
function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Modale « Produits du colis » : liste des produits avec quantité. */
function ProduitsModal({ colis, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api
      .get(`/stock/colis-en-attente/${colis.id}/produits`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [colis.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main mono">{colis.code || '—'}</div>
              <div className="cell-sub">Produits du colis</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {!data && !error && <div className="modal-loading">Chargement…</div>}
        {data && (
          <div className="info-produits">
            <span className="field-label">Produits</span>
            {data.produits.length === 0 ? (
              <div className="cell-sub">Aucun produit lié à ce colis.</div>
            ) : (
              <ul>
                {data.produits.map((pr, i) => (
                  <li key={i}>
                    <b>({pr.qty})</b> {pr.produit || '—'}
                    {pr.variante ? ` — ${pr.variante}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ligne du tableau : un colis en attente de ramassage. */
function ColisRow({ colis, onInfo }) {
  return (
    <tr>
      <td className="mono">{colis.code || '—'}</td>
      <td>{magasinLabel(colis) || '—'}</td>
      <td>
        <div className="cell-main">{colis.destinataire || '—'}</div>
        {colis.telephone && <div className="cell-sub">{colis.telephone}</div>}
      </td>
      <td>
        <div className="cell-main">{colis.ville || '—'}</div>
        {colis.adresse && <div className="cell-sub">{colis.adresse}</div>}
      </td>
      <td>{formatDate(colis.dateCreation)}</td>
      <td className="mvnt-cell-texte">{colis.commentaire || '—'}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Voir les produits" onClick={onInfo}>
            <Info size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Gestion de stock > Colis en attente — datatable des colis à ramasser. */
export default function ColisEnAttente() {
  const [colis, setColis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null);

  const [recherche, setRecherche] = useState('');
  const [filtreMagasin, setFiltreMagasin] = useState('');
  const [filtreVille, setFiltreVille] = useState('');
  const [sortBy, setSortBy] = useState('dateCreation');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    api
      .get('/stock/colis-en-attente')
      .then((res) => setColis(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des colis.'))
      .finally(() => setLoading(false));
  }, []);

  /** Magasins distincts pour le filtre (triés alphabétiquement). */
  const magasins = useMemo(() => {
    const vus = new Set();
    colis.forEach((c) => {
      const label = magasinLabel(c);
      if (label) vus.add(label);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [colis]);

  /** Villes distinctes pour le filtre (triées alphabétiquement). */
  const villes = useMemo(() => {
    const vus = new Set();
    colis.forEach((c) => {
      if (c.ville) vus.add(c.ville);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [colis]);

  const colisFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtres = colis.filter((c) => {
      if (filtreMagasin !== '' && magasinLabel(c) !== filtreMagasin) return false;
      if (filtreVille !== '' && (c.ville || '') !== filtreVille) return false;
      if (!q) return true;
      return [c.code, c.magasin, c.clientNom, c.destinataire, c.telephone, c.ville, c.adresse, c.commentaire].some(
        (v) => String(v || '').toLowerCase().includes(q)
      );
    });
    if (!sortBy) return filtres;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtres].sort((a, b) => {
      if (sortBy === 'dateCreation') return sens * ((a.dateCreation || 0) - (b.dateCreation || 0));
      const va = sortBy === 'magasin' ? magasinLabel(a) : a[sortBy];
      const vb = sortBy === 'magasin' ? magasinLabel(b) : b[sortBy];
      return sens * String(va || '').localeCompare(String(vb || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [colis, recherche, filtreMagasin, filtreVille, sortBy, sortDir]);

  const pager = usePagination(colisFiltres, 'colis', 'colis');

  /** Tri : 1er clic = croissant, 2e clic = décroissant. */
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
    pager.setPage(1);
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

  return (
    <div className="platform-page colis-attente-page">
      <section className="platform-card">
        <h2>
          <PackageSearch size={18} /> Colis en attente de ramassage
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher : code, magasin, destinataire, ville…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
          <SearchableSelect
            className="ss-toolbar"
            value={filtreMagasin}
            onChange={(v) => {
              setFiltreMagasin(v);
              pager.setPage(1);
            }}
            placeholder="Tous les magasins"
            options={[
              { value: '', label: 'Tous les magasins' },
              ...magasins.map((m) => ({ value: m, label: m }))
            ]}
          />
          <SearchableSelect
            className="ss-toolbar"
            value={filtreVille}
            onChange={(v) => {
              setFiltreVille(v);
              pager.setPage(1);
            }}
            placeholder="Toutes les villes"
            options={[
              { value: '', label: 'Toutes les villes' },
              ...villes.map((v) => ({ value: v, label: v }))
            ]}
          />
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="code">Code colis</SortableTh>
                <SortableTh sortKey="magasin">Nom de magasin</SortableTh>
                <SortableTh sortKey="destinataire">Destinataire</SortableTh>
                <SortableTh sortKey="ville">Ville</SortableTh>
                <SortableTh sortKey="dateCreation">Date création</SortableTh>
                <th>Commentaire</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {colisFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun colis en attente de ramassage.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((c) => <ColisRow key={c.id} colis={c} onInfo={() => setModal(c)} />)
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {modal && <ProduitsModal colis={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
