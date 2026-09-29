import { useEffect, useMemo, useState } from 'react';
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
 * Gestion de stock > Inventaire — liste des produits (delevery_product) :
 * magasin (delevery_customers.customers_store), nom, réf, stock disponible,
 * position (rayonnage) et statut activé/désactivé.
 * Tri sur toutes les colonnes ; filtres par magasin et position (listes
 * déroulantes avec recherche) en plus de la recherche libre et du statut.
 * Actions : modifier (fiche produit), info produit (modale avec photo) ;
 * activer/désactiver sera développé plus tard (bouton inactif).
 */

/** Nom de magasin affiché : enseigne du client, sinon son nom. */
function magasinLabel(produit) {
  return produit.magasin || produit.clientNom || '';
}

/** Modale « Info produit » : détail du produit avec photo agrandissable. */
function InfoProduitModal({ produitId, onClose }) {
  const [produit, setProduit] = useState(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    api
      .get(`/stock/produits/${produitId}`)
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
                <dt>Nom de magasin</dt>
                <dd>{magasinLabel(produit) || '—'}</dd>
              </div>
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
 * Modale « Entrée au stock » / « Sortie du stock » : mouvement exceptionnel fait
 * directement par un utilisateur (le flux normal doit passer par le client).
 * Tracé dans delevery_product_mvnt et répercuté sur le stock du produit.
 */
function MouvementModal({ produit, type, onClose, onSaved }) {
  const entree = type === 'entree';
  const [qte, setQte] = useState('');
  const [motif, setMotif] = useState('');
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
    if (!motif.trim()) {
      errors.motif = `Le motif ${entree ? "d'entrée" : 'de sortie'} est obligatoire.`;
    }
    setFieldErrors(errors);
    setSaveError('');
    if (Object.keys(errors).length) return;

    setSaving(true);
    try {
      const res = await api.post(`/stock/produits/${produit.id}/mouvements`, {
        type,
        qte: quantite,
        motif: motif.trim()
      });
      onSaved(produit.id, res.data.stock);
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
              <span className="field-label">{entree ? "Motif d'entrée *" : 'Motif de sortie *'}</span>
              <textarea
                rows={3}
                value={motif}
                onChange={(e) => {
                  setMotif(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, motif: '' }));
                }}
              />
              {fieldErrors.motif && <span className="field-error">{fieldErrors.motif}</span>}
            </label>
          </div>

          {saveError && <div className="form-error">{saveError}</div>}

          <p className="mvnt-warning">
            <TriangleAlert size={16} />
            <span>
              À n'utiliser ce formulaire que dans des cas exceptionnels : l'entrée et la sortie de
              stock doivent être faites par le client.
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

/**
 * Modale « Validation du stock » (badge rouge du stock en attente) : l'utilisateur
 * saisit la quantité effectivement reçue (ou sortie si l'attente est négative)
 * et choisit d'annuler ou non le reste non reçu. Le mouvement est tracé en
 * 'entrer stock' / 'sortir stock' avec le commentaire « validation de stock ».
 */
function ValidationAttenteModal({ produit, onClose, onSaved }) {
  const attente = Number(produit.stockAttente) || 0;
  const entree = attente > 0;
  const [qte, setQte] = useState('');
  const [annulerReste, setAnnulerReste] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    const errors = {};
    const quantite = Number(qte);
    if (!qte || !Number.isInteger(quantite) || quantite <= 0) {
      errors.qte = 'La quantité doit être un nombre entier supérieur à 0.';
    } else if (quantite > Math.abs(attente)) {
      errors.qte = `La quantité validée ne peut pas dépasser le stock en attente (${Math.abs(attente)}).`;
    }
    setFieldErrors(errors);
    setSaveError('');
    if (Object.keys(errors).length) return;

    setSaving(true);
    try {
      const res = await api.post(`/stock/produits/${produit.id}/valider-attente`, {
        qteRecue: quantite,
        annulerReste: annulerReste ? 1 : 0
      });
      onSaved(produit.id, res.data.stock, res.data.stockAttente);
      onClose();
    } catch (err) {
      setSaveError(err.response?.data?.message || 'Erreur lors de la validation du stock.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-mvnt modal-mvnt-entree" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title mvnt-title">
            <ArrowDownToLine size={18} />
            <div className="cell-main">
              Validation du stock — {produit.nom || 'Produit'}
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
              <span className="field-label">Stock en attente</span>
              <input type="text" value={attente} disabled />
            </label>
            <label className="modal-form-full">
              <span className="field-label">
                {entree ? 'Quantité stock reçu *' : 'Quantité sortie confirmée *'}
              </span>
              <input
                type="number"
                min={1}
                max={Math.abs(attente)}
                step={1}
                value={qte}
                onChange={(e) => {
                  setQte(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, qte: '' }));
                }}
              />
              {fieldErrors.qte && <span className="field-error">{fieldErrors.qte}</span>}
            </label>
            <div className="modal-form-full">
              <span className="field-label">
                {entree ? 'Annuler le reste du stock non reçu ?' : 'Annuler le reste du stock en attente ?'}
              </span>
              <div className="radio-group">
                <label className={`radio-pill ${!annulerReste ? 'radio-pill-checked' : ''}`}>
                  <input
                    type="radio"
                    name="annuler-reste"
                    checked={!annulerReste}
                    onChange={() => setAnnulerReste(false)}
                  />
                  Non — le reste reste en attente
                </label>
                <label className={`radio-pill ${annulerReste ? 'radio-pill-checked' : ''}`}>
                  <input
                    type="radio"
                    name="annuler-reste"
                    checked={annulerReste}
                    onChange={() => setAnnulerReste(true)}
                  />
                  Oui — le reste est mis à 0
                </label>
              </div>
            </div>
          </div>

          {saveError && <div className="form-error">{saveError}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button type="submit" className="btn btn-success" disabled={saving}>
              <Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau : un produit de l'inventaire. */
function ProduitRow({ produit, onInfo, onMouvement, onValidation, onToggle, busy }) {
  const actif = Number(produit.active) === 1;
  const attente = Number(produit.stockAttente) || 0;
  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>{magasinLabel(produit) || '—'}</td>
      <td>
        <div className="cell-main">{produit.nom || '—'}</div>
        {produit.ref && <div className="cell-sub">Réf : {produit.ref}</div>}
      </td>
      <td>
        <div className="stock-cell">
          <span>{produit.stock ?? 0}</span>
          {attente !== 0 && (
            <>
              <span className="stock-cell-sep">|</span>
              <button
                type="button"
                className="stock-attente-badge"
                title="Stock en attente — cliquer pour valider"
                onClick={() => onValidation(produit)}
              >
                {attente}
              </button>
            </>
          )}
        </div>
      </td>
      <td>{produit.position || '—'}</td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Activé' : 'Désactivé'}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <Link to={`/admin/stock/inventaire/${produit.id}`} className="row-action" title="Modifier">
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

/** Gestion de stock > Inventaire — datatable des produits. */
export default function Inventaire() {
  const [produits, setProduits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [infoProduit, setInfoProduit] = useState(null);
  // Mouvement de stock en cours : { produit, type: 'entree' | 'sortie' }.
  const [mouvement, setMouvement] = useState(null);
  // Produit dont le stock en attente est en cours de validation (badge rouge).
  const [validation, setValidation] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Positions configurées (Configuration > Options) pour le filtre par position.
  const [positionsConfig, setPositionsConfig] = useState([]);

  const [recherche, setRecherche] = useState('');
  const [filtreMagasin, setFiltreMagasin] = useState('');
  const [filtrePosition, setFiltrePosition] = useState('');
  const [filtreAttente, setFiltreAttente] = useState('');
  const [filtreActive, setFiltreActive] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    api
      .get('/stock/inventaire')
      .then((res) => setProduits(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || "Erreur de chargement de l'inventaire."))
      .finally(() => setLoading(false));
    api
      .get('/stock/positions')
      .then((res) => setPositionsConfig(res.data))
      .catch(() => {});
  }, []);

  /** Magasins distincts pour le filtre (triés alphabétiquement). */
  const magasins = useMemo(() => {
    const vus = new Set();
    produits.forEach((p) => {
      const label = magasinLabel(p);
      if (label) vus.add(label);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [produits]);

  /** Positions du filtre : celles configurées (Configuration > Options), tri naturel B2 < B12. */
  const positions = useMemo(
    () =>
      [...positionsConfig].sort((a, b) =>
        a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })
      ),
    [positionsConfig]
  );

  const produitsFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const filtres = produits.filter((p) => {
      if (filtreMagasin !== '' && magasinLabel(p) !== filtreMagasin) return false;
      if (filtrePosition !== '' && (p.position || '') !== filtrePosition) return false;
      // Stock en attente : Oui = attente non nulle, Non = aucune attente.
      if (filtreAttente !== '' && (Number(p.stockAttente) !== 0) !== (filtreAttente === '1')) {
        return false;
      }
      if (filtreActive !== '' && Number(p.active) !== Number(filtreActive)) return false;
      if (!q) return true;
      return [p.magasin, p.clientNom, p.nom, p.ref, p.position].some((v) =>
        String(v || '').toLowerCase().includes(q)
      );
    });
    if (!sortBy) return filtres;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtres].sort((a, b) => {
      if (sortBy === 'stock' || sortBy === 'active') {
        return sens * (Number(a[sortBy] || 0) - Number(b[sortBy] || 0));
      }
      const va = sortBy === 'magasin' ? magasinLabel(a) : a[sortBy];
      const vb = sortBy === 'magasin' ? magasinLabel(b) : b[sortBy];
      return sens * String(va || '').localeCompare(String(vb || ''), 'fr', { sensitivity: 'base', numeric: true });
    });
  }, [produits, recherche, filtreMagasin, filtrePosition, filtreAttente, filtreActive, sortBy, sortDir]);

  const pager = usePagination(produitsFiltres, 'produit');

  /** Active/désactive un produit (product_statut) après confirmation. */
  async function toggleActive(produit) {
    const activer = Number(produit.active) !== 1;
    const verbe = activer ? 'activer' : 'désactiver';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le produit « ${produit.nom} » ?`)) return;
    setBusyId(produit.id);
    try {
      const res = await api.patch(`/stock/produits/${produit.id}/statut`, { active: activer ? 1 : 0 });
      setProduits((prev) => prev.map((p) => (p.id === produit.id ? { ...p, active: res.data.active } : p)));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour du statut.');
    } finally {
      setBusyId(null);
    }
  }

  /** Répercute le nouveau stock après un mouvement. */
  function applyStock(produitId, stock) {
    setProduits((prev) => prev.map((p) => (p.id === produitId ? { ...p, stock } : p)));
  }

  /** Répercute stock + stock en attente après validation du stock en attente. */
  function applyValidation(produitId, stock, stockAttente) {
    setProduits((prev) =>
      prev.map((p) => (p.id === produitId ? { ...p, stock, stockAttente } : p))
    );
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
          <Link to="/admin/stock/inventaire/nouveau" className="btn btn-primary">
            <Plus size={16} /> Créer un nouveau produit
          </Link>
        </div>
      </section>

      <section className="platform-card">
        <h2>
          <Boxes size={18} /> Inventaire des produits
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher : magasin, produit, réf, position…"
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
            value={filtrePosition}
            onChange={(v) => {
              setFiltrePosition(v);
              pager.setPage(1);
            }}
            placeholder="Toutes les positions"
            options={[
              { value: '', label: 'Toutes les positions' },
              ...positions.map((p) => ({ value: p, label: p }))
            ]}
          />
          <select
            className="datatable-select"
            value={filtreAttente}
            onChange={(e) => {
              setFiltreAttente(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Stock en attente : tous</option>
            <option value="1">Stock en attente : Oui</option>
            <option value="0">Stock en attente : Non</option>
          </select>
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
                <SortableTh sortKey="magasin">Nom de magasin</SortableTh>
                <SortableTh sortKey="nom">Nom du produit</SortableTh>
                <SortableTh sortKey="stock">Stock disponible</SortableTh>
                <SortableTh sortKey="position">Position</SortableTh>
                <SortableTh sortKey="active">Statut</SortableTh>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {produitsFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
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
                    onValidation={setValidation}
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
          onSaved={applyStock}
        />
      )}

      {validation && (
        <ValidationAttenteModal
          produit={validation}
          onClose={() => setValidation(null)}
          onSaved={applyValidation}
        />
      )}
    </div>
  );
}
