import { useEffect, useMemo, useState } from 'react';
import { Search, Send, SlidersHorizontal, Truck, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect from '../../components/DateRangeSelect';

/*
 * Page /client/demande-ramassage — le client demande le passage d'un ramasseur
 * (table legacy delevery_pickup_request, partagée avec la production) :
 *  - carte du haut : gros bouton centré « Demande ramassage » → modale
 *    (type colis / stock, téléphone, adresse, remarque, préremplie depuis la
 *    fiche client), maximum 3 demandes en attente simultanées (règle legacy) ;
 *  - carte du bas : historique des demandes avec filtres statut (En attente
 *    par défaut) / type / période + recherche locale.
 */

const TYPE_LABELS = { SIMPLE_PARCEL: 'Ramassage de colis', STOCK: 'Ramassage de stock' };
const STATUTS = {
  new: { label: 'En attente', badge: 'badge-attente' },
  received: { label: 'Reçue', badge: 'badge-ram-recue' },
  treated: { label: 'Traitée', badge: 'badge-ram-traitee' }
};

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

/** Filtres par défaut : demandes en attente, toutes dates confondues. */
function defaultFilters() {
  return { statut: 'new', type: '', range: { from: '', to: '', preset: 'all' } };
}

/** Modale « Nouvelle demande de ramassage » (téléphone / adresse préremplis). */
function NouvelleDemandeModal({ defaults, onClose, onCreated }) {
  const [form, setForm] = useState({
    type: 'SIMPLE_PARCEL',
    phone: defaults.phone || '',
    address: defaults.address || '',
    note: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!/^0[5-8]\d{8}$/.test(form.phone.replace(/[\s.\-/]/g, ''))) {
      setError('Veuillez saisir un téléphone valide (10 chiffres, ex. 0612345678).');
      return;
    }
    if (!form.address.trim()) {
      setError("L'adresse de ramassage est obligatoire.");
      return;
    }
    if (!form.note.trim()) {
      setError('La remarque est obligatoire (créneau, instructions…).');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/demandes-ramassage/client', {
        type: form.type,
        phone: form.phone,
        address: form.address,
        note: form.note
      });
      onCreated(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'envoi de la demande.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Truck size={18} />
            <div className="cell-main">Nouvelle demande de ramassage</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Type de ramassage</span>
              <select value={form.type} onChange={(e) => setField('type', e.target.value)}>
                <option value="SIMPLE_PARCEL">{TYPE_LABELS.SIMPLE_PARCEL}</option>
                <option value="STOCK">{TYPE_LABELS.STOCK}</option>
              </select>
            </label>
            <label>
              <span className="field-label">Téléphone</span>
              <input
                type="text"
                value={form.phone}
                maxLength={20}
                placeholder="Téléphone de la personne disponible au ramassage"
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse de ramassage</span>
              <input
                type="text"
                value={form.address}
                maxLength={500}
                placeholder="Adresse de collecte / lieu de ramassage"
                onChange={(e) => setField('address', e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Remarque</span>
              <textarea
                rows={3}
                value={form.note}
                maxLength={500}
                placeholder="Créneau souhaité, nombre de colis, instructions…"
                onChange={(e) => setField('note', e.target.value)}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Send size={15} /> {saving ? 'Envoi…' : 'Envoyer la demande'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Demande ramassage — page principale : bouton central + historique filtré. */
export default function DemandeRamassage() {
  const [demandes, setDemandes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [search, setSearch] = useState('');
  // Préremplissage + quota (GET /client/new) ; null tant que pas chargé.
  const [defaults, setDefaults] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  function loadDefaults() {
    api
      .get('/demandes-ramassage/client/new')
      .then((res) => setDefaults(res.data))
      .catch(() => setDefaults({ phone: '', address: '', enAttente: 0, max: 3 }));
  }

  useEffect(loadDefaults, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/demandes-ramassage/client', {
        params: {
          statut: applied.statut,
          type: applied.type,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setDemandes(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des demandes.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  // Recherche locale sur les demandes chargées (remarque, téléphone, adresse).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return demandes;
    return demandes.filter((d) =>
      [d.note, d.phone, d.address].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }, [demandes, search]);

  const pager = usePagination(filtered, 'demande');

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const quotaAtteint = defaults ? defaults.enAttente >= defaults.max : false;

  /** Après création : la demande apparaît si le filtre courant l'affiche. */
  function onCreated(demande) {
    if (!applied.statut || applied.statut === 'new') {
      setDemandes((rows) => [demande, ...rows]);
    }
    loadDefaults();
  }

  return (
    <div className="platform-page">
      <section className="platform-card ram-hero">
        <span className="ram-hero-icon">
          <Truck size={30} />
        </span>
        <h2 className="ram-hero-title">Besoin d'un ramassage ?</h2>
        <p className="ram-hero-sub">
          Envoyez votre demande et notre équipe passera récupérer vos colis à l'adresse indiquée.
        </p>
        <button
          type="button"
          className="btn btn-primary ram-hero-btn"
          onClick={() => setModalOpen(true)}
          disabled={!defaults || quotaAtteint}
        >
          <Truck size={20} /> Demande ramassage
        </button>
        {defaults && (
          <p className={`ram-hero-quota ${quotaAtteint ? 'ram-quota-max' : ''}`}>
            {quotaAtteint
              ? `Vous avez atteint la limite de ${defaults.max} demandes en attente. Veuillez patienter avant d'en envoyer une nouvelle.`
              : `${defaults.enAttente} demande${defaults.enAttente > 1 ? 's' : ''} en attente sur ${defaults.max} maximum.`}
          </p>
        )}
      </section>

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Truck size={18} /> Mes demandes de ramassage
          </h2>
        </div>

        <div className="filters-bar">
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraftField('statut')(e.target.value)}
            title="Statut de la demande"
          >
            <option value="">Tous les statuts</option>
            <option value="new">En attente</option>
            <option value="received">Reçue</option>
            <option value="treated">Traitée</option>
          </select>
          <select
            className="datatable-select"
            value={draft.type}
            onChange={(e) => setDraftField('type')(e.target.value)}
            title="Type de ramassage"
          >
            <option value="">Tous les types</option>
            <option value="SIMPLE_PARCEL">{TYPE_LABELS.SIMPLE_PARCEL}</option>
            <option value="STOCK">{TYPE_LABELS.STOCK}</option>
          </select>
          <DateRangeSelect value={draft.range} onChange={setDraftField('range')} />
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

        <div className="datatable-topbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : remarque, téléphone, adresse…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Remarque</th>
                <th>Téléphone</th>
                <th>Adresse</th>
                <th>Date demande</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucune demande de ramassage trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((d) => {
                  const statut = STATUTS[d.statut] || STATUTS.new;
                  return (
                    <tr key={d.id}>
                      <td>
                        <span className={`badge badge-type ${d.type === 'STOCK' ? 'badge-stock' : 'badge-normale'}`}>
                          {d.type === 'STOCK' ? 'Stock' : 'Colis'}
                        </span>
                      </td>
                      <td className="ram-cell-txt">{d.note || '—'}</td>
                      <td className="mono">{d.phone || '—'}</td>
                      <td className="ram-cell-txt">{d.address || '—'}</td>
                      <td>{formatDate(d.time)}</td>
                      <td>
                        <span className={`badge ${statut.badge}`}>{statut.label}</span>
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

      {modalOpen && defaults && (
        <NouvelleDemandeModal
          defaults={defaults}
          onClose={() => setModalOpen(false)}
          onCreated={onCreated}
        />
      )}
    </div>
  );
}
