import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, HandCoins, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Configuration > Gestion tarifs — tarifs par couple de villes
 * (ville de ramassage → ville de destination), avec frais de livraison,
 * de retour et de refusé. Ajout et édition via une modale ; liste filtrable
 * par ville de ramassage et recherche sur la ville de destination.
 */

/** Options de ville pour un select : villes actives + la ville courante si désactivée. */
function villeOptions(villes, currentId, currentNom) {
  const options = villes.filter((v) => v.active === 1);
  if (currentId && !options.some((v) => v.villeId === currentId)) {
    options.push({ villeId: currentId, nom: currentNom || `Ville #${currentId}` });
  }
  return options;
}

/** Modale d'ajout / édition d'un tarif (tarif = null en création). */
function TarifModal({ tarif, villes, onClose, onSaved }) {
  const [form, setForm] = useState({
    pickupVilleId: tarif?.pickupVilleId || '',
    destVilleId: tarif?.destVilleId || '',
    fraisLivraison: tarif?.fraisLivraison ?? '',
    fraisRetour: tarif?.fraisRetour ?? '',
    fraisRefuse: tarif?.fraisRefuse ?? ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.pickupVilleId) {
      setError('Veuillez sélectionner une ville de ramassage.');
      return;
    }
    if (!form.destVilleId) {
      setError('Veuillez sélectionner une ville de destination.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        pickupVilleId: Number(form.pickupVilleId),
        destVilleId: Number(form.destVilleId),
        fraisLivraison: Number(form.fraisLivraison || 0),
        fraisRetour: Number(form.fraisRetour || 0),
        fraisRefuse: Number(form.fraisRefuse || 0)
      };
      const res = tarif
        ? await api.put(`/config/tarifs/${tarif.id}`, body)
        : await api.post('/config/tarifs', body);
      onSaved(tarif ? tarif.id : null, res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {tarif ? <Pencil size={18} /> : <Plus size={18} />}
            <div className="cell-main">{tarif ? 'Modifier le tarif' : 'Ajouter un tarif'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Ville de ramassage</span>
              <SearchableSelect
                value={form.pickupVilleId}
                onChange={(v) => setField('pickupVilleId', v)}
                placeholder="— Sélectionner une ville —"
                options={villeOptions(villes, tarif?.pickupVilleId, tarif?.pickupVille).map((v) => ({
                  value: v.villeId,
                  label: v.nom
                }))}
              />
            </label>
            <label>
              <span className="field-label">Ville de destination</span>
              <SearchableSelect
                value={form.destVilleId}
                onChange={(v) => setField('destVilleId', v)}
                placeholder="— Sélectionner une ville —"
                options={villeOptions(villes, tarif?.destVilleId, tarif?.destVille).map((v) => ({
                  value: v.villeId,
                  label: v.nom
                }))}
              />
            </label>
            <label>
              <span className="field-label">Frais de livraison</span>
              <input
                type="number"
                className="frais-input"
                min="0"
                step="0.01"
                value={form.fraisLivraison}
                placeholder="0.00"
                onChange={(e) => setField('fraisLivraison', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Frais de retour</span>
              <input
                type="number"
                className="frais-input"
                min="0"
                step="0.01"
                value={form.fraisRetour}
                placeholder="0.00"
                onChange={(e) => setField('fraisRetour', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Frais de refusé</span>
              <input
                type="number"
                className="frais-input"
                min="0"
                step="0.01"
                value={form.fraisRefuse}
                placeholder="0.00"
                onChange={(e) => setField('fraisRefuse', e.target.value)}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {tarif ? <Save size={15} /> : <Plus size={15} />}
              {saving ? 'Enregistrement…' : tarif ? 'Enregistrer' : 'Ajouter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau des tarifs : affichage + édition (modale) et suppression. */
function TarifRow({ tarif, onEdit, onDeleted }) {
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    if (
      !window.confirm(
        `Voulez-vous vraiment supprimer le tarif « ${tarif.pickupVille || `Ville #${tarif.pickupVilleId}`} → ${tarif.destVille || `Ville #${tarif.destVilleId}`} » ?`
      )
    )
      return;
    setDeleting(true);
    try {
      await api.delete(`/config/tarifs/${tarif.id}`);
      onDeleted(tarif.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setDeleting(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main">{tarif.pickupVille || `Ville #${tarif.pickupVilleId}`}</div>
      </td>
      <td>{tarif.destVille || `Ville #${tarif.destVilleId}`}</td>
      <td>{Number(tarif.fraisLivraison).toFixed(2)}</td>
      <td>{Number(tarif.fraisRetour).toFixed(2)}</td>
      <td>{Number(tarif.fraisRefuse).toFixed(2)}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Modifier" onClick={() => onEdit(tarif)}>
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title="Supprimer"
            onClick={remove}
            disabled={deleting}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Configuration > Gestion tarifs. */
export default function Tarifs() {
  const [tarifs, setTarifs] = useState([]);
  const [villes, setVilles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // modal : null = fermée, 'new' = ajout, objet tarif = édition.
  const [modal, setModal] = useState(null);

  const [filtrePickup, setFiltrePickup] = useState('');
  const [recherche, setRecherche] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('desc');

  /** Villes de ramassage présentes dans les tarifs (pour le filtre). */
  const villesPickupFiltre = useMemo(() => {
    const vues = new Map();
    tarifs.forEach((t) => {
      if (!vues.has(t.pickupVilleId)) vues.set(t.pickupVilleId, t.pickupVille || `Ville #${t.pickupVilleId}`);
    });
    return [...vues.entries()]
      .map(([id, nom]) => ({ id, nom }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }));
  }, [tarifs]);

  const tarifsFiltres = useMemo(() => {
    const terme = recherche.trim().toLowerCase();
    const filtres = tarifs.filter(
      (t) =>
        (filtrePickup === '' || t.pickupVilleId === Number(filtrePickup)) &&
        (terme === '' || (t.destVille || '').toLowerCase().includes(terme))
    );
    if (!sortBy) return filtres;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtres].sort((a, b) => sens * (Number(a[sortBy] || 0) - Number(b[sortBy] || 0)));
  }, [tarifs, filtrePickup, recherche, sortBy, sortDir]);

  const pager = usePagination(tarifsFiltres, 'tarif');

  /** Tri client : 1er clic = décroissant, 2e clic = croissant. */
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  }

  function SortableTh({ sortKey, children }) {
    const isActive = sortBy === sortKey;
    return (
      <th
        className={`th-sortable ${isActive ? 'th-sorted' : ''}`}
        onClick={() => toggleSort(sortKey)}
        title="Trier"
      >
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

  useEffect(() => {
    Promise.all([api.get('/config/tarifs'), api.get('/config/villes')])
      .then(([tarifsRes, villesRes]) => {
        setTarifs(tarifsRes.data);
        setVilles(villesRes.data);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des tarifs.'))
      .finally(() => setLoading(false));
  }, []);

  const triFr = (a, b) => (a.pickupVille || '').localeCompare(b.pickupVille || '', 'fr', { sensitivity: 'base' }) ||
    (a.destVille || '').localeCompare(b.destVille || '', 'fr', { sensitivity: 'base' });

  function handleSaved(id, data) {
    setTarifs((prev) =>
      (id ? prev.map((t) => (t.id === id ? { ...t, ...data } : t)) : [...prev, data]).sort(triFr)
    );
  }

  function handleDeleted(id) {
    setTarifs((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div className="platform-page tarifs-page">
      <section className="platform-card">
        <div className="card-head-actions">
          <h2>
            <HandCoins size={18} /> Gestion des tarifs
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Plus size={15} /> Ajouter un tarif
          </button>
        </div>

        <div className="datatable-toolbar">
          <SearchableSelect
            className="ss-toolbar"
            value={filtrePickup}
            onChange={(v) => {
              setFiltrePickup(v);
              pager.setPage(1);
            }}
            options={[
              { value: '', label: 'Toutes les villes de ramassage' },
              ...villesPickupFiltre.map((v) => ({ value: v.id, label: v.nom }))
            ]}
          />
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher une ville de destination…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Ville de ramassage</th>
                <th>Ville de destination</th>
                <SortableTh sortKey="fraisLivraison">Frais de livraison</SortableTh>
                <SortableTh sortKey="fraisRetour">Frais de retour</SortableTh>
                <SortableTh sortKey="fraisRefuse">Frais de refusé</SortableTh>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tarifsFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun tarif trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((t) => (
                  <TarifRow key={t.id} tarif={t} onEdit={setModal} onDeleted={handleDeleted} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />

        {modal && (
          <TarifModal
            tarif={modal === 'new' ? null : modal}
            villes={villes}
            onClose={() => setModal(null)}
            onSaved={handleSaved}
          />
        )}
      </section>
    </div>
  );
}
