import { useEffect, useMemo, useState } from 'react';
import { HandCoins, Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Facturation clients > Frais supplémentaires — frais saisis manuellement
 * pour un client (magasin) : ajout / modification en modale, filtres
 * (magasin, type de frais, statut — « Nouveau » par défaut) et datatable.
 * Un frais n'est modifiable / supprimable qu'au statut « Nouveau » ; les
 * statuts « Enregistré » et « Payé » viendront de la facturation clients.
 * Pour le type « emballage » : l'article vient du catalogue matériel (types
 * emballage / consommable, page /admin/materiel), l'agence dont le stock est
 * décrémenté est obligatoire (imposée pour les employés d'agence) et le
 * montant est prérempli avec prix de vente × quantité.
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

/* Types de frais (codes frais_type). */
const FRAIS_TYPES = [
  { value: 'emballage', label: 'Emballage' },
  { value: 'ramassage', label: 'Ramassage' },
  { value: 'retour_express', label: 'Retour express' },
  { value: 'autre', label: 'Autre' }
];

function fraisTypeLabel(code) {
  return FRAIS_TYPES.find((t) => t.value === code)?.label || '—';
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

/** Libellé d'un client dans les listes déroulantes : magasin (nom). */
function clientLabel(c) {
  if (c.store && c.nom && c.store !== c.nom) return `${c.store} — ${c.nom}`;
  return c.store || c.nom || `Client ${c.id}`;
}

/**
 * Modale « Ajouter / Modifier frais supp » : magasin, type de frais, titre
 * (ou article d'emballage + agence + quantité pour « emballage »), date,
 * montant (prérempli prix × quantité pour l'emballage, rééditable).
 */
function FraisModal({ frais, clients, emballages, agences, agenceImposee, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    client: frais ? String(frais.client_id) : '',
    type: frais ? frais.type : '',
    titre: frais ? frais.titre : '',
    materiel: frais?.materiel_id ? String(frais.materiel_id) : '',
    agence: frais?.agence_id
      ? String(frais.agence_id)
      : agenceImposee
        ? String(agenceImposee)
        : '',
    quantite: frais?.quantite ? String(frais.quantite) : '',
    date: frais ? unixToDay(frais.date_frais) : todayStr(),
    montant: frais ? String(frais.montant) : ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const isEmballage = form.type === 'emballage';

  /** Montant proposé pour un article + quantité (null si prix inconnu). */
  function montantPropose(materielId, quantite) {
    const article = emballages.find((a) => String(a.id) === String(materielId));
    const q = Number(quantite);
    if (!article || article.prix == null || !Number.isInteger(q) || q <= 0) return null;
    return (article.prix * q).toFixed(2);
  }

  // Changement de type : le titre change de nature (texte libre ↔ article
  // d'emballage) ; article, agence et quantité ne concernent que l'emballage.
  function changeType(e) {
    const type = e.target.value;
    setForm((f) => ({ ...f, type, titre: '', materiel: '', quantite: '' }));
  }

  /** Article ou quantité modifié : préremplit le montant (prix × quantité). */
  function changeVente(key, value) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      const montant = montantPropose(next.materiel, next.quantite);
      return montant === null ? next : { ...next, montant };
    });
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.client) {
      setError('Veuillez sélectionner un magasin.');
      return;
    }
    if (!form.type) {
      setError('Veuillez sélectionner le type de frais.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        client: Number(form.client),
        type: form.type,
        titre: form.titre,
        materiel: isEmballage ? Number(form.materiel) : undefined,
        agence: isEmballage ? Number(form.agence) : undefined,
        quantite: isEmballage ? Number(form.quantite) : undefined,
        date: form.date,
        montant: form.montant
      };
      if (frais) await api.patch(`/frais-clients/${frais.id}`, body);
      else await api.post('/frais-clients', body);
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
              <span className="field-label">Nom de magasin</span>
              <SearchableSelect
                value={form.client}
                onChange={(v) => setForm((f) => ({ ...f, client: String(v) }))}
                placeholder="— Sélectionner un magasin —"
                options={clients.map((c) => ({ value: c.id, label: clientLabel(c) }))}
              />
            </div>
            <label className="modal-form-full">
              <span className="field-label">Type de frais</span>
              <select value={form.type} onChange={changeType} required>
                <option value="">— Sélectionner —</option>
                {FRAIS_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {isEmballage ? (
              <>
                <label>
                  <span className="field-label">Type d'emballage</span>
                  <select
                    value={form.materiel}
                    onChange={(e) => changeVente('materiel', e.target.value)}
                    required
                  >
                    <option value="">
                      {emballages.length
                        ? '— Sélectionner —'
                        : "— Aucun type d'emballage disponible —"}
                    </option>
                    {emballages.map((a) => (
                      <option key={a.id} value={String(a.id)}>
                        {a.nom}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="field-label">Quantité</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.quantite}
                    onChange={(e) => changeVente('quantite', e.target.value)}
                    placeholder="0"
                    required
                  />
                </label>
                <label className="modal-form-full">
                  <span className="field-label">Agence (stock décrémenté)</span>
                  <select
                    value={form.agence}
                    onChange={setField('agence')}
                    disabled={Boolean(agenceImposee)}
                    required
                  >
                    <option value="">— Sélectionner une agence —</option>
                    {agences.map((a) => (
                      <option key={a.id} value={String(a.id)}>
                        {a.nom}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label className="modal-form-full">
                <span className="field-label">Titre du frais</span>
                <input
                  type="text"
                  value={form.titre}
                  onChange={setField('titre')}
                  maxLength={255}
                  placeholder="Ex. : ramassage exceptionnel…"
                  required
                />
              </label>
            )}
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
  return { magasin: '', type: '', statut: 'new' };
}

/** Frais supplémentaires clients — page principale : ajout, filtres et tableau. */
export default function FraisClients() {
  const [fraisList, setFraisList] = useState([]);
  const [clients, setClients] = useState([]);
  const [emballages, setEmballages] = useState([]);
  const [agences, setAgences] = useState([]);
  const [agenceImposee, setAgenceImposee] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  // Modale d'ajout / modification : null = fermée, 'new' = ajout, objet = frais édité.
  const [modal, setModal] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const pager = usePagination(fraisList, 'frais');

  useEffect(() => {
    api
      .get('/frais-clients/filtres')
      .then((res) => {
        setClients(res.data.clients);
        setEmballages(res.data.emballages || []);
        setAgences(res.data.agences || []);
        setAgenceImposee(res.data.agenceImposee ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/frais-clients', {
        params: { magasin: applied.magasin, type: applied.type, statut: applied.statut }
      })
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

  const clientOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: clientLabel(c) })),
    [clients]
  );

  async function remove(frais) {
    if (!window.confirm(`Supprimer le frais « ${frais.titre} » (${frais.store || '—'}) ?`)) {
      return;
    }
    try {
      await api.delete(`/frais-clients/${frais.id}`);
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
            <HandCoins size={18} /> Frais supplémentaires clients
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Plus size={15} /> Ajouter frais supp
          </button>
        </div>

        <div className="filters-bar">
          <SearchSelect
            label="Magasin"
            options={clientOptions}
            value={draft.magasin}
            onChange={setDraftField('magasin')}
            allLabel="Tous"
          />
          <select
            className="datatable-select"
            value={draft.type}
            onChange={(e) => setDraftField('type')(e.target.value)}
            title="Type de frais"
          >
            <option value="">Tous les types</option>
            {FRAIS_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
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
                <th>Magasin</th>
                <th>Type de frais</th>
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
                  // Un frais enregistré / payé ou rattaché à une facture client
                  // n'est plus ni modifiable ni supprimable (même verrou que l'API).
                  const verrou =
                    statut.key !== 'new'
                      ? 'Ce frais est enregistré ou payé'
                      : frais.facture_id
                        ? 'Ce frais est rattaché à une facture client'
                        : null;
                  return (
                    <tr key={frais.id}>
                      <td>
                        <div className="cell-main">{frais.store || '—'}</div>
                        <div className="cell-sub">{frais.client_name || '—'}</div>
                      </td>
                      <td>
                        <div className="cell-main">{fraisTypeLabel(frais.type)}</div>
                        <div className="cell-sub">
                          {frais.quantite ? `${frais.titre} × ${frais.quantite}` : frais.titre}
                          {frais.agence ? ` — ${frais.agence}` : ''}
                        </div>
                      </td>
                      <td>{formatJour(frais.date_frais)}</td>
                      <td>
                        <div className="cell-main">{formatDate(frais.added_time)}</div>
                        <div className="cell-sub">{frais.added_by || '—'}</div>
                      </td>
                      <td>{formatMontant(frais.montant)}</td>
                      <td>
                        <span className={`badge ${statut.badge}`}>{statut.label}</span>
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
          clients={clients}
          emballages={emballages}
          agences={agences}
          agenceImposee={agenceImposee}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
