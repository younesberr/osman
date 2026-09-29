import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ArrowLeftRight, Search } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Gestion de stock > Mouvement produits — historique des mouvements de stock
 * de tous les produits (delevery_product_mvnt) : magasin, produit + réf,
 * type ('entrer stock' / 'sortir stock' / 'colis envoyé' / 'colis supprimé' /
 * 'colis retourné' — réception d'un bon retour client),
 * quantité, date, client à l'origine du mouvement, commentaire client,
 * utilisateur validant et note utilisateur.
 * Tri sur les colonnes principales ; filtres par magasin et type de mouvement
 * en plus de la recherche libre.
 */

/** Nom de magasin affiché : enseigne du client, sinon son nom. */
function magasinLabel(mvnt) {
  return mvnt.magasin || mvnt.clientNom || '';
}

/** Date + heure du mouvement au format français (ex. 06/08/2026 14:35). */
function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Couleur du badge selon le type de mouvement (neutre pour les types futurs). */
function typeBadgeClass(type) {
  if (type === 'entrer stock') return 'badge-mvnt-entree';
  if (type === 'sortir stock') return 'badge-mvnt-sortie';
  if (type === 'colis envoyé') return 'badge-mvnt-colis';
  if (type === 'colis retourné') return 'badge-mvnt-entree';
  return 'badge-neutral';
}

/* Statut du mouvement (mvnt_statut) : 0 = en attente de validation, 1 = validé, 2 = refusé.
   La validation se fait depuis l'inventaire (badge rouge « stock en attente »). */
const STATUT_LABELS = { 0: 'En attente', 1: 'Validé', 2: 'Refusé' };
const STATUT_BADGES = { 0: 'badge-attente', 1: 'badge-active', 2: 'badge-inactive' };

/** Ligne du tableau : un mouvement de stock. */
function MouvementRow({ mvnt }) {
  const qte = Number(mvnt.qte) || 0;
  const statut = Number(mvnt.statut);
  return (
    <tr>
      <td>{magasinLabel(mvnt) || '—'}</td>
      <td>
        <div className="cell-main">{mvnt.produit || '—'}</div>
        {mvnt.ref && <div className="cell-sub">Réf : {mvnt.ref}</div>}
      </td>
      <td>
        <span className={`badge ${typeBadgeClass(mvnt.type)}`}>{mvnt.type || '—'}</span>
      </td>
      <td className={qte >= 0 ? 'mvnt-qte-entree' : 'mvnt-qte-sortie'}>{Math.abs(qte)}</td>
      <td>
        <span className={`badge ${STATUT_BADGES[statut] || 'badge-neutral'}`}>
          {STATUT_LABELS[statut] || '—'}
        </span>
      </td>
      <td>{formatDate(mvnt.date)}</td>
      {/* « magasin — membre » quand un membre d'équipe du client a fait le mouvement. */}
      <td>
        {mvnt.mouvementPar
          ? mvnt.mouvementParMembre
            ? `${mvnt.mouvementPar} — ${mvnt.mouvementParMembre}`
            : mvnt.mouvementPar
          : '—'}
      </td>
      <td className="mvnt-cell-texte">{mvnt.commentaire || '—'}</td>
      <td>{mvnt.validePar || '—'}</td>
      <td className="mvnt-cell-texte">{mvnt.note || '—'}</td>
    </tr>
  );
}

/** Gestion de stock > Mouvement produits — datatable des mouvements. */
export default function MouvementsProduits() {
  const [mouvements, setMouvements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [recherche, setRecherche] = useState('');
  const [filtreMagasin, setFiltreMagasin] = useState('');
  const [filtreProduit, setFiltreProduit] = useState('');
  const [filtreType, setFiltreType] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    api
      .get('/stock/mouvements')
      .then((res) => setMouvements(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des mouvements.'))
      .finally(() => setLoading(false));
  }, []);

  /** Magasins distincts pour le filtre (triés alphabétiquement). */
  const magasins = useMemo(() => {
    const vus = new Set();
    mouvements.forEach((m) => {
      const label = magasinLabel(m);
      if (label) vus.add(label);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [mouvements]);

  /** Noms de produit distincts pour le filtre (triés alphabétiquement). */
  const produits = useMemo(() => {
    const vus = new Set();
    mouvements.forEach((m) => {
      if (m.produit) vus.add(m.produit);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [mouvements]);

  /** Types de mouvement distincts pour le filtre. */
  const types = useMemo(() => {
    const vus = new Set();
    mouvements.forEach((m) => {
      if (m.type) vus.add(m.type);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [mouvements]);

  const mouvementsFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtres = mouvements.filter((m) => {
      if (filtreMagasin !== '' && magasinLabel(m) !== filtreMagasin) return false;
      if (filtreProduit !== '' && (m.produit || '') !== filtreProduit) return false;
      if (filtreType !== '' && (m.type || '') !== filtreType) return false;
      if (filtreStatut !== '' && Number(m.statut) !== Number(filtreStatut)) return false;
      if (!q) return true;
      return [m.magasin, m.clientNom, m.produit, m.ref, m.mouvementPar, m.mouvementParMembre, m.validePar, m.commentaire, m.note].some(
        (v) => String(v || '').toLowerCase().includes(q)
      );
    });
    if (!sortBy) return filtres;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtres].sort((a, b) => {
      if (sortBy === 'qte') {
        return sens * (Math.abs(Number(a.qte) || 0) - Math.abs(Number(b.qte) || 0));
      }
      if (sortBy === 'date') {
        return sens * (new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
      }
      const va = sortBy === 'magasin' ? magasinLabel(a) : a[sortBy];
      const vb = sortBy === 'magasin' ? magasinLabel(b) : b[sortBy];
      return sens * String(va || '').localeCompare(String(vb || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [mouvements, recherche, filtreMagasin, filtreProduit, filtreType, filtreStatut, sortBy, sortDir]);

  const pager = usePagination(mouvementsFiltres, 'mouvement');

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
    <div className="platform-page mouvements-page">
      <section className="platform-card">
        <h2>
          <ArrowLeftRight size={18} /> Mouvements des produits
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher : magasin, produit, réf, commentaire…"
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
            value={filtreProduit}
            onChange={(v) => {
              setFiltreProduit(v);
              pager.setPage(1);
            }}
            placeholder="Tous les produits"
            options={[
              { value: '', label: 'Tous les produits' },
              ...produits.map((p) => ({ value: p, label: p }))
            ]}
          />
          <select
            className="datatable-select"
            value={filtreType}
            onChange={(e) => {
              setFiltreType(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Tous les types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            className="datatable-select"
            value={filtreStatut}
            onChange={(e) => {
              setFiltreStatut(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Tous les statuts</option>
            <option value="0">En attente</option>
            <option value="1">Validés</option>
            <option value="2">Refusés</option>
          </select>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="magasin">Nom de magasin</SortableTh>
                <SortableTh sortKey="produit">Nom du produit</SortableTh>
                <SortableTh sortKey="type">Type de mouvement</SortableTh>
                <SortableTh sortKey="qte">Quantité</SortableTh>
                <SortableTh sortKey="statut">Statut</SortableTh>
                <SortableTh sortKey="date">Date mouvement</SortableTh>
                <SortableTh sortKey="mouvementPar">Mouvement par</SortableTh>
                <th>Commentaire</th>
                <SortableTh sortKey="validePar">Valider par</SortableTh>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {mouvementsFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={10} className="datatable-empty">
                    Aucun mouvement trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((m) => <MouvementRow key={m.id} mvnt={m} />)
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>
    </div>
  );
}
