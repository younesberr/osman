import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  FileText,
  PackagePlus,
  PackageX,
  Plus,
  Search,
  Trash2
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Page de création / modification d'un bon de sortie de stock.
 * Section 1 : informations du bon (référence, date de création, créé par,
 * statut, nombre de colis).
 * Section 2 : colis de stock en attente de ramassage (pas encore dans un
 * bon) — ajout à l'unité ou par sélection (cases à cocher), filtres par
 * magasin et par produit.
 * Section 3 : colis du bon — mêmes colonnes, avec le retrait du bon.
 * Les deux tableaux sont triables par colonne (1er clic croissant, 2e décroissant).
 * L'ajout / retrait ne change pas le statut du colis (il passera en
 * « Ramassé » au traitement du bon). Bon traité : lecture seule.
 */

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
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

/** Statut affiché d'un bon : Traité > Affecté > Nouveau. */
function bonStatut(bon) {
  if (Number(bon.delivered) === 1) return { label: 'Traité', badge: 'badge-active' };
  if (bon.affecter_id) return { label: 'Affecté', badge: 'badge-affecte' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Nom de magasin affiché : enseigne du client, sinon son nom. */
function magasinLabel(colis) {
  return colis.magasin || colis.clientNom || '';
}

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Valeur de tri d'un colis pour une colonne donnée. */
function sortValue(parcel, key) {
  if (key === 'magasin') return magasinLabel(parcel);
  if (key === 'produit') return parcel.produits?.[0]?.nom || '';
  if (key === 'qty') return (parcel.produits || []).reduce((s, pr) => s + (Number(pr.qty) || 0), 0);
  return parcel[key];
}

/** Trie les colis selon { key, dir } (time et qty en numérique, le reste en texte). */
function sortRows(rows, sort) {
  if (!sort.key) return rows;
  const sens = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (sort.key === 'time' || sort.key === 'qty') {
      return sens * ((Number(va) || 0) - (Number(vb) || 0));
    }
    return sens * String(va || '').localeCompare(String(vb || ''), 'fr', {
      sensitivity: 'base',
      numeric: true
    });
  });
}

/** Cellules « Produit » et « Quantité » : une ligne par produit du colis. */
function ProduitsCell({ produits }) {
  if (!produits?.length) return <span className="cell-sub">—</span>;
  return (
    <ul className="bon-sortie-produits">
      {produits.map((pr, i) => (
        <li key={i}>
          {pr.nom || '—'}
          {pr.variante ? ` — ${pr.variante}` : ''}
        </li>
      ))}
    </ul>
  );
}

function QuantitesCell({ produits }) {
  if (!produits?.length) return <span className="cell-sub">—</span>;
  return (
    <ul className="bon-sortie-produits bon-sortie-qtes">
      {produits.map((pr, i) => (
        <li key={i}>{pr.qty}</li>
      ))}
    </ul>
  );
}

export default function BonSortieEdit() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [bon, setBon] = useState(null);
  const [bonParcels, setBonParcels] = useState([]);
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState(null);

  const [searchDispo, setSearchDispo] = useState('');
  const [searchBon, setSearchBon] = useState('');
  const [filtreMagasin, setFiltreMagasin] = useState('');
  const [filtreProduit, setFiltreProduit] = useState('');
  const [sortDispo, setSortDispo] = useState({ key: '', dir: 'asc' });
  const [sortBon, setSortBon] = useState({ key: '', dir: 'asc' });
  const [selectedDispo, setSelectedDispo] = useState(() => new Set());
  const [selectedBon, setSelectedBon] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const editable = bon && Number(bon.delivered) !== 1;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get(`/bons-sortie/${id}`), api.get(`/bons-sortie/${id}/available`)])
      .then(([bonRes, dispoRes]) => {
        if (cancelled) return;
        const { parcels, ...info } = bonRes.data;
        setBon(info);
        setBonParcels(parcels);
        setAvailable(dispoRes.data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Erreur de chargement du bon.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Ajout de colis au bon (à l'unité ou par sélection) : ids → POST /parcels. */
  async function addByIds(ids) {
    if (!ids.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.post(`/bons-sortie/${id}/parcels`, { ids });
      const addedIds = new Set(res.data.added.map((p) => p.id));
      const moved = available.filter((p) => addedIds.has(p.id));
      setAvailable((prev) => prev.filter((p) => !addedIds.has(p.id)));
      setBonParcels((prev) => [...moved, ...prev]);
      setSelectedDispo(new Set());
      if (res.data.skipped.length) {
        setFeedback({
          type: 'error',
          text: `Colis ignorés : ${res.data.skipped.map((s) => `${s.code} (${s.reason})`).join(' — ')}`
        });
      } else if (res.data.added.length) {
        setFeedback({ type: 'success', text: `${res.data.added.length} colis ajouté(s) au bon.` });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Erreur lors de l'ajout." });
    } finally {
      setBusy(false);
    }
  }

  /** Retire un colis du bon : il redevient disponible dans la section 2. */
  async function removeParcel(parcel) {
    if (busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.delete(`/bons-sortie/${id}/parcels/${parcel.id}`);
      setBonParcels((prev) => prev.filter((p) => p.id !== parcel.id));
      setAvailable((prev) => [parcel, ...prev]);
      setSelectedBon((prev) => {
        const next = new Set(prev);
        next.delete(parcel.id);
        return next;
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait.' });
    } finally {
      setBusy(false);
    }
  }

  /** Retrait par sélection : un appel par colis (chaque retrait est atomique). */
  async function removeSelection() {
    const parcels = bonParcels.filter((p) => selectedBon.has(p.id));
    if (!parcels.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    const removed = [];
    let error = '';
    for (const parcel of parcels) {
      try {
        await api.delete(`/bons-sortie/${id}/parcels/${parcel.id}`);
        removed.push(parcel);
      } catch (err) {
        error = err.response?.data?.message || 'Erreur lors du retrait.';
        break;
      }
    }
    if (removed.length) {
      const ids = new Set(removed.map((p) => p.id));
      setBonParcels((prev) => prev.filter((p) => !ids.has(p.id)));
      setAvailable((prev) => [...removed, ...prev]);
    }
    setSelectedBon(new Set());
    if (error) setFeedback({ type: 'error', text: error });
    setBusy(false);
  }

  const filtrer = (rows, q) => {
    const terme = normalize(q.trim());
    if (!terme) return rows;
    return rows.filter((p) =>
      [p.code, p.ville, p.adresse, magasinLabel(p), ...(p.produits || []).map((pr) => pr.nom)].some(
        (v) => normalize(v).includes(terme)
      )
    );
  };

  /** Magasins distincts des colis disponibles (filtre de la section 2). */
  const magasins = useMemo(() => {
    const vus = new Set();
    available.forEach((p) => {
      const label = magasinLabel(p);
      if (label) vus.add(label);
    });
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [available]);

  /** Produits distincts des colis disponibles (filtre de la section 2). */
  const produits = useMemo(() => {
    const vus = new Set();
    available.forEach((p) => (p.produits || []).forEach((pr) => pr.nom && vus.add(pr.nom)));
    return [...vus].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }, [available]);

  const dispoFiltres = useMemo(() => {
    let rows = filtrer(available, searchDispo);
    if (filtreMagasin) rows = rows.filter((p) => magasinLabel(p) === filtreMagasin);
    if (filtreProduit) {
      rows = rows.filter((p) => (p.produits || []).some((pr) => pr.nom === filtreProduit));
    }
    return sortRows(rows, sortDispo);
  }, [available, searchDispo, filtreMagasin, filtreProduit, sortDispo]);

  const bonFiltres = useMemo(
    () => sortRows(filtrer(bonParcels, searchBon), sortBon),
    [bonParcels, searchBon, sortBon]
  );

  const dispoPager = usePagination(dispoFiltres, 'colis', 'colis');
  const bonPager = usePagination(bonFiltres, 'colis', 'colis');

  /** Tri d'un tableau : 1er clic = croissant, 2e clic = décroissant. */
  function toggleSort(setter, pagerToReset) {
    return (key) => {
      setter((prev) =>
        prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
      );
      pagerToReset.setPage(1);
    };
  }

  /** En-tête de colonne triable (flèche selon l'état du tri). */
  function SortableTh({ sort, onSort, sortKey, children }) {
    const isActive = sort.key === sortKey;
    return (
      <th
        className={`th-sortable ${isActive ? 'th-sorted' : ''}`}
        onClick={() => onSort(sortKey)}
        title="Trier"
      >
        <span className="th-sort-label">
          {children}
          {isActive ? (
            sort.dir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
          ) : (
            <ArrowUpDown size={13} className="th-sort-idle" />
          )}
        </span>
      </th>
    );
  }

  function toggleSet(setter, parcelId) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(parcelId)) next.delete(parcelId);
      else next.add(parcelId);
      return next;
    });
  }

  /** Coche/décoche tous les colis de la page courante. */
  function togglePage(setter, selected, rows) {
    const ids = rows.map((p) => p.id);
    const allChecked = ids.length > 0 && ids.every((pid) => selected.has(pid));
    setter((prev) => {
      const next = new Set(prev);
      ids.forEach((pid) => (allChecked ? next.delete(pid) : next.add(pid)));
      return next;
    });
  }

  if (loadError) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{loadError}</div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/stock/bon-de-sortie')}
          >
            <ArrowLeft size={15} /> Retour aux bons de sortie
          </button>
        </section>
      </div>
    );
  }

  const statut = bon ? bonStatut(bon) : null;

  /** En-tête de tableau commun aux sections 2 et 3 (colonnes triables). */
  const TableHead = ({ selected, setter, rows, sort, onSort }) => (
    <tr>
      <th className="bon-check-col">
        <input
          type="checkbox"
          checked={rows.length > 0 && rows.every((p) => selected.has(p.id))}
          onChange={() => togglePage(setter, selected, rows)}
          title="Tout cocher / décocher"
          disabled={!editable}
        />
      </th>
      <SortableTh sort={sort} onSort={onSort} sortKey="code">Code colis</SortableTh>
      <SortableTh sort={sort} onSort={onSort} sortKey="magasin">Nom magasin</SortableTh>
      <SortableTh sort={sort} onSort={onSort} sortKey="time">Date de création</SortableTh>
      <SortableTh sort={sort} onSort={onSort} sortKey="ville">Ville</SortableTh>
      <SortableTh sort={sort} onSort={onSort} sortKey="produit">Produit</SortableTh>
      <SortableTh sort={sort} onSort={onSort} sortKey="qty">Quantité</SortableTh>
      <th>Actions</th>
    </tr>
  );

  /** Ligne commune aux sections 2 et 3 (seule l'action change). */
  const ParcelRow = ({ parcel, selected, setter, action }) => (
    <tr>
      <td className="bon-check-col">
        <input
          type="checkbox"
          checked={selected.has(parcel.id)}
          onChange={() => toggleSet(setter, parcel.id)}
          disabled={!editable}
        />
      </td>
      <td className="mono">{parcel.code || '—'}</td>
      <td>{magasinLabel(parcel) || '—'}</td>
      <td>{formatDate(parcel.time)}</td>
      <td>
        <div className="cell-main">{parcel.ville || '—'}</div>
        {parcel.adresse && <div className="cell-sub">{parcel.adresse}</div>}
      </td>
      <td>
        <ProduitsCell produits={parcel.produits} />
      </td>
      <td>
        <QuantitesCell produits={parcel.produits} />
      </td>
      <td>{action}</td>
    </tr>
  );

  return (
    <div className="platform-page bon-edit-page">
      {/* Section 1 : informations du bon. */}
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <FileText size={18} /> Information du bon
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/stock/bon-de-sortie')}
          >
            <ArrowLeft size={15} /> Retour aux bons de sortie
          </button>
        </div>
        <div className={`bon-infos ${loading ? 'is-loading' : ''}`}>
          <div className="bon-info">
            <span className="field-label">Référence</span>
            <span className="cell-main mono">{bon?.ref || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Date de création</span>
            <span className="cell-main">{bon ? formatDate(bon.time) : '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Créé par</span>
            <span className="cell-main">{bon?.by_name || '—'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Affecté à</span>
            <span className="cell-main">{bon?.affecter_name || '—'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Statut</span>
            {statut && <span className={`badge ${statut.badge}`}>{statut.label}</span>}
          </div>
          <div className="bon-info">
            <span className="field-label">Nombre de colis</span>
            <span className="cell-main">{bonParcels.length}</span>
          </div>
        </div>
        {bon && !editable && (
          <div className="form-error">Ce bon est traité : la modification des colis est désactivée.</div>
        )}
      </section>

      {feedback && (
        <div className={`bon-feedback field-${feedback.type === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </div>
      )}

      {/* Section 2 : colis de stock en attente de ramassage, à ajouter au bon. */}
      {editable && (
        <section className="platform-card">
          <h2>
            <PackagePlus size={18} /> Colis de stock en attente de ramassage ({dispoFiltres.length})
          </h2>

          <div className="datatable-toolbar">
            <div className="datatable-search">
              <Search size={16} className="datatable-search-icon" />
              <input
                type="search"
                placeholder="Rechercher : code, magasin, ville, produit…"
                value={searchDispo}
                onChange={(e) => {
                  setSearchDispo(e.target.value);
                  dispoPager.setPage(1);
                }}
              />
            </div>
            <SearchableSelect
              className="ss-toolbar"
              value={filtreMagasin}
              onChange={(v) => {
                setFiltreMagasin(v);
                dispoPager.setPage(1);
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
                dispoPager.setPage(1);
              }}
              placeholder="Tous les produits"
              options={[
                { value: '', label: 'Tous les produits' },
                ...produits.map((p) => ({ value: p, label: p }))
              ]}
            />
          </div>

          <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <TableHead
                  selected={selectedDispo}
                  setter={setSelectedDispo}
                  rows={dispoPager.pageRows}
                  sort={sortDispo}
                  onSort={toggleSort(setSortDispo, dispoPager)}
                />
              </thead>
              <tbody>
                {dispoFiltres.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={8} className="datatable-empty">
                      Aucun colis de stock en attente de ramassage.
                    </td>
                  </tr>
                ) : (
                  dispoPager.pageRows.map((p) => (
                    <ParcelRow
                      key={p.id}
                      parcel={p}
                      selected={selectedDispo}
                      setter={setSelectedDispo}
                      action={
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => addByIds([p.id])}
                          disabled={busy}
                        >
                          <Plus size={14} /> Ajouter
                        </button>
                      }
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager pager={dispoPager} />

          <div className="bon-bulk-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => addByIds([...selectedDispo])}
              disabled={busy || selectedDispo.size === 0}
            >
              <PackagePlus size={15} /> Ajouter la sélection ({selectedDispo.size})
            </button>
          </div>
        </section>
      )}

      {/* Section 3 : colis du bon. */}
      <section className="platform-card">
        <h2>
          <FileText size={18} /> Colis du bon ({bonFiltres.length})
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, magasin, ville, produit…"
              value={searchBon}
              onChange={(e) => {
                setSearchBon(e.target.value);
                bonPager.setPage(1);
              }}
            />
          </div>
        </div>

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <TableHead
                selected={selectedBon}
                setter={setSelectedBon}
                rows={bonPager.pageRows}
                sort={sortBon}
                onSort={toggleSort(setSortBon, bonPager)}
              />
            </thead>
            <tbody>
              {bonFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                bonPager.pageRows.map((p) => (
                  <ParcelRow
                    key={p.id}
                    parcel={p}
                    selected={selectedBon}
                    setter={setSelectedBon}
                    action={
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm bon-btn-danger"
                        onClick={() => removeParcel(p)}
                        disabled={busy || !editable}
                        title={editable ? 'Retirer du bon' : 'Bon traité : retrait impossible'}
                      >
                        <Trash2 size={14} /> Supprimer
                      </button>
                    }
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={bonPager} />

        {editable && (
          <div className="bon-bulk-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={removeSelection}
              disabled={busy || selectedBon.size === 0}
            >
              <PackageX size={15} /> Supprimer la sélection ({selectedBon.size})
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
