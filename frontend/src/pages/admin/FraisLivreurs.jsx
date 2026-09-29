import { useEffect, useMemo, useState } from 'react';
import { HandCoins, Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Facturation livreurs > Frais supplémentaires — frais saisis manuellement
 * pour un livreur (y compris les livreurs salariés) : ajout / modification en
 * modale, filtres (livreur, statut — « Nouveau » par défaut) et datatable.
 * Un frais n'est modifiable / supprimable qu'au statut « Nouveau » ; les
 * statuts « Enregistré » et « Payé » viendront de la facturation.
 */

/** Timestamp unix (secondes) → "JJ/MM/AAAA". */
function formatJour(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

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

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/* Statuts d'un frais (codes frais_statut). */
const FRAIS_STATUTS = {
  0: { key: 'new', label: 'Nouveau', badge: 'badge-attente' },
  1: { key: 'saved', label: 'Enregistré', badge: 'badge-mvnt-colis' },
  2: { key: 'paid', label: 'Payé', badge: 'badge-active' }
};

function fraisStatut(code) {
  return FRAIS_STATUTS[Number(code)] || { key: '', label: '—', badge: 'badge-neutral' };
}

/** Timestamp unix → valeur d'un input type="date" ("AAAA-MM-JJ"). */
function unixToDay(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Date du jour au format "AAAA-MM-JJ" (heure locale). */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Modale « Ajouter / Modifier frais supp » : livreur, titre, date, montant. */
function FraisModal({ frais, livreurs, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    livreur: frais ? String(frais.livreur_id) : '',
    titre: frais ? frais.titre : '',
    date: frais ? unixToDay(frais.date_frais) : todayStr(),
    montant: frais ? String(frais.montant) : ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.livreur) {
      setError('Veuillez sélectionner un livreur.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        livreur: Number(form.livreur),
        titre: form.titre,
        date: form.date,
        montant: form.montant
      };
      if (frais) await api.patch(`/frais-livreurs/${frais.id}`, body);
      else await api.post('/frais-livreurs', body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du frais.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <HandCoins size={18} />
            <div className="cell-main">{frais ? 'Modifier frais supp' : 'Ajouter frais supp'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Livreur</span>
              <SearchableSelect
                value={form.livreur}
                onChange={(v) => setForm((f) => ({ ...f, livreur: String(v) }))}
                placeholder="— Sélectionner un livreur —"
                options={livreurs.map((l) => ({ value: l.id, label: l.nom }))}
              />
            </div>
            <label className="modal-form-full">
              <span className="field-label">Titre du frais</span>
              <input
                type="text"
                value={form.titre}
                onChange={setField('titre')}
                maxLength={255}
                placeholder="Ex. : carburant, réparation…"
                required
              />
            </label>
            <label>
              <span className="field-label">Date du frais</span>
              <input type="date" value={form.date} onChange={setField('date')} required />
            </label>
            <label>
              <span className="field-label">Montant (DH)</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.montant}
                onChange={setField('montant')}
                placeholder="0.00"
                required
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Filtres appliqués par défaut : frais au statut « Nouveau ». */
function defaultFilters() {
  return { livreur: '', statut: 'new' };
}

/** Frais supplémentaires livreurs — page principale : ajout, filtres et tableau. */
export default function FraisLivreurs() {
  const [fraisList, setFraisList] = useState([]);
  const [livreurs, setLivreurs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  // Modale d'ajout / modification : null = fermée, 'new' = ajout, objet = frais édité.
  const [modal, setModal] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const pager = usePagination(fraisList, 'frais');

  useEffect(() => {
    api.get('/frais-livreurs/filtres').then((res) => setLivreurs(res.data.livreurs)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/frais-livreurs', { params: { livreur: applied.livreur, statut: applied.statut } })
      .then((res) => {
        if (cancelled) return;
        setFraisList(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des frais.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, reloadKey]);

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  const livreurOptions = useMemo(
    () => livreurs.map((l) => ({ value: l.id, label: l.nom })),
    [livreurs]
  );

  async function remove(frais) {
    if (!window.confirm(`Supprimer le frais « ${frais.titre} » (${frais.livreur_name || '—'}) ?`)) {
      return;
    }
    try {
      await api.delete(`/frais-livreurs/${frais.id}`);
      setFraisList((prev) => prev.filter((f) => f.id !== frais.id));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  function handleSaved() {
    setModal(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <HandCoins size={18} /> Frais supplémentaires livreurs
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Plus size={15} /> Ajouter frais supp
          </button>
        </div>

        <div className="filters-bar">
          <SearchSelect
            label="Livreur"
            options={livreurOptions}
            value={draft.livreur}
            onChange={setDraftField('livreur')}
            allLabel="Tous"
          />
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraftField('statut')(e.target.value)}
            title="Statut du frais"
          >
            <option value="">Tous les statuts</option>
            <option value="new">Nouveau</option>
            <option value="saved">Enregistré</option>
            <option value="paid">Payé</option>
          </select>
          <button
            type="button"
            className="btn-apply"
            onClick={() => {
              // Nouvelle référence : recharge même si les filtres n'ont pas changé.
              setApplied({ ...draft });
              pager.setPage(1);
            }}
          >
            <SlidersHorizontal size={15} />
            Appliquer filtres
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Livreur</th>
                <th>Titre du frais</th>
                <th>Date frais</th>
                <th>Date d'ajout</th>
                <th>Montant</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {fraisList.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun frais supplémentaire trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((frais) => {
                  const statut = fraisStatut(frais.statut);
                  // Un frais enregistré / payé ou rattaché à une facture livreur
                  // n'est plus ni modifiable ni supprimable (même verrou que l'API).
                  const verrou =
                    statut.key !== 'new'
                      ? 'Ce frais est enregistré ou payé'
                      : frais.facture_id
                        ? 'Ce frais est rattaché à une facture livreur'
                        : null;
                  return (
                    <tr key={frais.id}>
                      <td>
                        <div className="cell-main">{frais.livreur_name || '—'}</div>
                        <div className="cell-sub">{frais.zone || '—'}</div>
                      </td>
                      <td>{frais.titre}</td>
                      <td>{formatJour(frais.date_frais)}</td>
                      <td>
                        <div className="cell-main">{formatDate(frais.added_time)}</div>
                        <div className="cell-sub">{frais.added_by || '—'}</div>
                      </td>
                      <td>{formatMontant(frais.montant)}</td>
                      <td>
                        <span className={`badge ${statut.badge}`}>{statut.label}</span>
                        {frais.facture_ref && (
                          <div className="cell-sub mono" title="Facture livreur liée">
                            {frais.facture_ref}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title={
                              verrou
                                ? `${verrou} : modification impossible`
                                : 'Modifier le frais'
                            }
                            disabled={!!verrou}
                            onClick={() => setModal(frais)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title={
                              verrou
                                ? `${verrou} : suppression impossible`
                                : 'Supprimer le frais'
                            }
                            disabled={!!verrou}
                            onClick={() => remove(frais)}
                          >
                            <Trash2 size={16} />
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
        <Pager pager={pager} />
      </section>

      {modal && (
        <FraisModal
          frais={modal === 'new' ? null : modal}
          livreurs={livreurs}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
