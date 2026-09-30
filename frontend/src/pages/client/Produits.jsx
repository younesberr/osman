import { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpDown,
  ArrowUpFromLine,
  Boxes,
  Eye,
  Image,
  PackagePlus,
  PackageSearch,
  Pencil,
  Plus,
  Power,
  Save,
  Search,
  TriangleAlert,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Gestion stock > Liste des produits — même datatable que l'inventaire admin
 * mais limitée aux produits du client connecté (API /stock/client/produits) :
 * pas de colonne ni de filtre magasin, le magasin étant toujours le sien.
 * Actions : modifier (fiche produit), info produit, entrée/sortie de stock
 * (flux normal côté client) et activer/désactiver.
 */

/** Modale « Info produit » : détail du produit avec photo agrandissable. */
function InfoProduitModal({ produitId, onClose }) {
  const [produit, setProduit] = useState(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    api
      .get(`/stock/client/produits/${produitId}`)
      .then((res) => setProduit(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du produit.'));
  }, [produitId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <PackageSearch size={18} />
            <div className="cell-main">Info produit</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}
        {!error && !produit && <p className="modal-loading">Chargement…</p>}

        {produit && (
          <>
            <dl className="detail-grid produit-info-grid">
              <div className="detail-row">
                <dt>Nom du produit</dt>
                <dd>{produit.nom || '—'}</dd>
              </div>
              <div className="detail-row">
                <dt>Réf produit</dt>
                <dd>{produit.ref || '—'}</dd>
              </div>
              <div className="detail-row produit-info-desc">
                <dt>Description du produit</dt>
                <dd>{produit.description || '—'}</dd>
              </div>
            </dl>

            <div className="produit-info-photo-bloc">
              <span className="field-label">Photo du produit</span>
              {produit.imageUrl ? (
                <button
                  type="button"
                  className="produit-info-photo"
                  onClick={() => setZoom(true)}
                  title="Cliquer pour agrandir"
                >
                  <img src={produit.imageUrl} alt={`Photo du produit ${produit.nom || ''}`} />
                </button>
              ) : (
                <div className="produit-info-photo produit-info-photo-vide">
                  <Image size={26} className="upload-placeholder" />
                  <span className="upload-hint">Aucune photo</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Visionneuse plein écran : clic n'importe où pour fermer. */}
      {zoom && produit?.imageUrl && (
        <div className="lightbox-overlay" onClick={(e) => { e.stopPropagation(); setZoom(false); }}>
          <button type="button" className="lightbox-close" title="Fermer">
            <X size={22} />
          </button>
          <img src={produit.imageUrl} alt={`Photo du produit ${produit.nom || ''}`} />
        </div>
      )}
    </div>
  );
}

/**
 * Modale « Entrée au stock » / « Sortie du stock » : mouvement fait par le
 * client sur son propre produit (flux normal, tracé dans delevery_product_mvnt).
 * Le mouvement part en « stock en attente » (product_qte_attente) et ne sera
 * appliqué au stock disponible qu'après validation par la société.
 * Le commentaire est facultatif et enregistré dans mvnt_commentaire.
 */
function MouvementModal({ produit, type, onClose, onSaved }) {
  const entree = type === 'entree';
  const [qte, setQte] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    const errors = {};
    const quantite = Number(qte);
    if (!qte || !Number.isInteger(quantite) || quantite <= 0) {
      errors.qte = 'La quantité doit être un nombre entier supérieur à 0.';
    }
    setFieldErrors(errors);
    setSaveError('');
    if (Object.keys(errors).length) return;

    setSaving(true);
    try {
      const res = await api.post(`/stock/client/produits/${produit.id}/mouvements`, {
        type,
        qte: quantite,
        commentaire: commentaire.trim()
      });
      onSaved(produit.id, res.data.stockAttente);
      onClose();
    } catch (err) {
      setSaveError(err.response?.data?.message || "Erreur lors de l'enregistrement du mouvement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal modal-mvnt ${entree ? 'modal-mvnt-entree' : 'modal-mvnt-sortie'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title mvnt-title">
            {entree ? <ArrowDownToLine size={18} /> : <ArrowUpFromLine size={18} />}
            <div className="cell-main">
              {entree ? 'Entrée au stock' : 'Sortie du stock'} — {produit.nom || 'Produit'}
              {produit.ref ? ` (Réf : ${produit.ref})` : ''}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">{entree ? 'Quantité entrée *' : 'Quantité sortie *'}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={qte}
                onChange={(e) => {
                  setQte(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, qte: '' }));
                }}
              />
              {fieldErrors.qte && <span className="field-error">{fieldErrors.qte}</span>}
            </label>
            <label className="modal-form-full">
              <span className="field-label">Commentaire</span>
              <textarea
                rows={3}
                value={commentaire}
                onChange={(e) => setCommentaire(e.target.value)}
              />
            </label>
          </div>

          {saveError && <div className="form-error">{saveError}</div>}

          <p className="mvnt-warning">
            <TriangleAlert size={16} />
            <span>
              Ce mouvement sera ajouté au stock en attente et appliqué au stock disponible après
              validation par {BRAND.name}.
            </span>
          </p>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button
              type="submit"
              className={`btn ${entree ? 'btn-success' : 'btn-danger'}`}
              disabled={saving}
            >
              <Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau : un produit du client. */
function ProduitRow({ produit, onInfo, onMouvement, onToggle, busy }) {
  const actif = Number(produit.active) === 1;
  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>{produit.nom || '—'}</td>
      <td>{produit.ref || '—'}</td>
      <td>{produit.stock ?? 0}</td>
      <td className={Number(produit.stockAttente) ? 'stock-attente-cell' : ''}>
        {produit.stockAttente ?? 0}
      </td>
      <td>{produit.position || '—'}</td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Activé' : 'Désactivé'}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <Link to={`/client/stock/produits/${produit.id}`} className="row-action" title="Modifier">
            <Pencil size={16} />
          </Link>
          <button type="button" className="row-action" title="Info produit" onClick={() => onInfo(produit)}>
            <Eye size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-success"
            title="Entrer au stock"
            onClick={() => onMouvement(produit, 'entree')}
          >
            <ArrowDownToLine size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title="Sortir du stock"
            onClick={() => onMouvement(produit, 'sortie')}
          >
            <ArrowUpFromLine size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={() => onToggle(produit)}
            disabled={busy}
          >
            <Power size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Gestion stock > Liste des produits — datatable des produits du client. */
export default function Produits() {
  const [produits, setProduits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [infoProduit, setInfoProduit] = useState(null);
  // Mouvement de stock en cours : { produit, type: 'entree' | 'sortie' }.
  const [mouvement, setMouvement] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [recherche, setRecherche] = useState('');
  const [filtreProduit, setFiltreProduit] = useState('');
  const [filtreRef, setFiltreRef] = useState('');
  const [filtreActive, setFiltreActive] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    api
      .get('/stock/client/produits')
      .then((res) => setProduits(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des produits.'))
      .finally(() => setLoading(false));
  }, []);

  /** Noms de produits distincts pour le filtre (triés alphabétiquement). */
  const nomsProduits = useMemo(() => {
    const vus = new Set();
    produits.forEach((p) => {
      if (p.nom) vus.add(p.nom);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }));
  }, [produits]);

  /** Réfs distinctes pour le filtre (tri naturel : REF2 < REF12). */
  const refs = useMemo(() => {
    const vues = new Set();
    produits.forEach((p) => {
      if (p.ref) vues.add(p.ref);
    });
    return [...vues].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }));
  }, [produits]);

  const produitsFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtres = produits.filter((p) => {
      if (filtreProduit !== '' && (p.nom || '') !== filtreProduit) return false;
      if (filtreRef !== '' && (p.ref || '') !== filtreRef) return false;
      if (filtreActive !== '' && Number(p.active) !== Number(filtreActive)) return false;
      if (!q) return true;
      return [p.nom, p.ref, p.position].some((v) => String(v || '').toLowerCase().includes(q));
    });
    if (!sortBy) return filtres;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtres].sort((a, b) => {
      if (sortBy === 'stock' || sortBy === 'stockAttente' || sortBy === 'active') {
        return sens * (Number(a[sortBy] || 0) - Number(b[sortBy] || 0));
      }
      return sens * String(a[sortBy] || '').localeCompare(String(b[sortBy] || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [produits, recherche, filtreProduit, filtreRef, filtreActive, sortBy, sortDir]);

  const pager = usePagination(produitsFiltres, 'produit');

  /** Active/désactive un produit (product_statut) après confirmation. */
  async function toggleActive(produit) {
    const activer = Number(produit.active) !== 1;
    const verbe = activer ? 'activer' : 'désactiver';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le produit « ${produit.nom} » ?`)) return;
    setBusyId(produit.id);
    try {
      const res = await api.patch(`/stock/client/produits/${produit.id}/statut`, { active: activer ? 1 : 0 });
      setProduits((prev) => prev.map((p) => (p.id === produit.id ? { ...p, active: res.data.active } : p)));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour du statut.');
    } finally {
      setBusyId(null);
    }
  }

  /** Répercute le stock en attente d'un produit après un mouvement enregistré. */
  function applyStockAttente(produitId, stockAttente) {
    setProduits((prev) => prev.map((p) => (p.id === produitId ? { ...p, stockAttente } : p)));
  }

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
    <div className="platform-page inventaire-page">
      {/* Section de création : bouton vers la page Nouveau produit. */}
      <section className="platform-card">
        <div className="card-head-actions inventaire-create-head">
          <h2>
            <PackagePlus size={18} /> Produits
          </h2>
          <Link to="/client/stock/produits/nouveau" className="btn btn-primary">
            <Plus size={16} /> Créer un nouveau produit
          </Link>
        </div>
      </section>

      <section className="platform-card">
        <h2>
          <Boxes size={18} /> Liste des produits
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher : produit, réf, position…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
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
              ...nomsProduits.map((n) => ({ value: n, label: n }))
            ]}
          />
          <SearchableSelect
            className="ss-toolbar"
            value={filtreRef}
            onChange={(v) => {
              setFiltreRef(v);
              pager.setPage(1);
            }}
            placeholder="Toutes les réfs"
            options={[
              { value: '', label: 'Toutes les réfs' },
              ...refs.map((r) => ({ value: r, label: r }))
            ]}
          />
          <select
            className="datatable-select"
            value={filtreActive}
            onChange={(e) => {
              setFiltreActive(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Tous les statuts</option>
            <option value="1">Activés</option>
            <option value="0">Désactivés</option>
          </select>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <SortableTh sortKey="nom">Nom du produit</SortableTh>
                <SortableTh sortKey="ref">Réf produit</SortableTh>
                <SortableTh sortKey="stock">Stock disponible</SortableTh>
                <SortableTh sortKey="stockAttente">Stock en attente</SortableTh>
                <SortableTh sortKey="position">Position</SortableTh>
                <SortableTh sortKey="active">Statut</SortableTh>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {produitsFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun produit trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((p) => (
                  <ProduitRow
                    key={p.id}
                    produit={p}
                    onInfo={setInfoProduit}
                    onMouvement={(produit, type) => setMouvement({ produit, type })}
                    onToggle={toggleActive}
                    busy={busyId === p.id}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {infoProduit && (
        <InfoProduitModal produitId={infoProduit.id} onClose={() => setInfoProduit(null)} />
      )}

      {mouvement && (
        <MouvementModal
          produit={mouvement.produit}
          type={mouvement.type}
          onClose={() => setMouvement(null)}
          onSaved={applyStockAttente}
        />
      )}
    </div>
  );
}
