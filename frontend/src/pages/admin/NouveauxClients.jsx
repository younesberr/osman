import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Search,
  UserPlus,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Nouveaux clients (/admin/nouveaux-clients, service NOUVEAUX_CLIENTS) —
 * demandes de création de compte client envoyées depuis la page publique
 * /register (table legacy delevery_new_customers ; admin legacy :
 * admin/files/new_customer.php). Onglets par statut (En attente par défaut,
 * avec compteur), recherche + pagination côté serveur.
 *  - Accepter : modale préremplie (nom, CIN, email, téléphone, adresse +
 *    ville de ramassage à choisir) → crée le compte delevery_customers en
 *    conservant le mot de passe choisi par le client à l'inscription ;
 *  - Refuser : statut 1 (même valeur que le « delete » de l'ancien admin).
 */

const PAGE_SIZES = [10, 25, 50, 100];

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

/* Onglets de filtre par statut (PENDING par défaut). */
const TABS = [
  { value: 'PENDING', label: 'En attente' },
  { value: 'ACCEPTED', label: 'Acceptées' },
  { value: 'REFUSED', label: 'Refusées' },
  { value: 'ALL', label: 'Toutes' }
];

/* Badge de statut d'une demande. Les refusées incluent les demandes
   supprimées depuis l'ancien admin (même valeur en base). */
const STATUT_BADGES = {
  PENDING: { label: 'En attente', badge: 'badge-attente' },
  ACCEPTED: { label: 'Acceptée', badge: 'badge-active' },
  REFUSED: { label: 'Refusée', badge: 'badge-refuse' }
};

/**
 * Modale "Accepter la demande" : équivalent du lien "+" legacy qui ouvrait le
 * formulaire de création de client prérempli. Champs modifiables par l'admin ;
 * la ville de ramassage (référentiel delevery_tarifs) est à choisir — la
 * demande ne contient que la ville en texte libre, rappelée sous le select.
 */
function AcceptModal({ demande, villes, onClose, onAccepted }) {
  const [form, setForm] = useState({
    name: demande.name || '',
    cin: demande.cin || '',
    email: demande.email || '',
    phone: demande.phone || '',
    address: demande.address || '',
    pickupCity: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    if (!form.pickupCity) {
      setError('Veuillez choisir la ville de ramassage.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post(`/nouveaux-clients/${demande.id}/accepter`, {
        name: form.name.trim(),
        cin: form.cin.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        pickupCity: form.pickupCity
      });
      onAccepted(demande);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'acceptation de la demande.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <UserPlus size={18} />
            <div>
              <div className="cell-main">Accepter la demande — créer le compte client</div>
              <div className="cell-sub">
                Le mot de passe choisi par le client à l&apos;inscription est conservé. Magasin,
                téléphone personnel, site web et RIB sont recopiés de la demande.
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom complet</span>
              <input
                type="text"
                value={form.name}
                maxLength={100}
                required
                onChange={(e) => setField('name', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">CIN</span>
              <input
                type="text"
                value={form.cin}
                maxLength={100}
                required
                onChange={(e) => setField('cin', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Adresse électronique (connexion)</span>
              <input
                type="email"
                value={form.email}
                maxLength={100}
                required
                onChange={(e) => setField('email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone</span>
              <input
                type="tel"
                value={form.phone}
                maxLength={50}
                required
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse</span>
              <input
                type="text"
                value={form.address}
                maxLength={250}
                required
                onChange={(e) => setField('address', e.target.value)}
              />
            </label>
            <div className="modal-form-full">
              <span className="field-label">
                Ville de ramassage{demande.city ? ` — demandée : « ${demande.city} »` : ''}
              </span>
              <SearchableSelect
                value={form.pickupCity}
                onChange={(v) => setField('pickupCity', v)}
                placeholder="— Sélectionner —"
                options={villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))}
              />
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Check size={15} /> {saving ? 'Création…' : 'Accepter et créer le compte'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Nouveaux clients — page principale : onglets, recherche, datatable serveur. */
export default function NouveauxClients() {
  const [statut, setStatut] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [pending, setPending] = useState(0);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [villes, setVilles] = useState([]);
  const [accept, setAccept] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null); // { kind: 'success' | 'info', text }

  const COL_COUNT = 7;

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
      .get('/nouveaux-clients/villes')
      .then((res) => setVilles(res.data.villes))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/nouveaux-clients', { params: { page, pageSize, search, statut } })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setPending(res.data.pending);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
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
  }, [page, pageSize, search, statut, reload]);

  const rangeLabel = useMemo(() => {
    if (!total) return '0 demande';
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} demandes`;
  }, [page, pageSize, total]);

  async function refuser(d) {
    if (!window.confirm(`Refuser la demande de « ${d.store || d.name} » ? Aucun compte ne sera créé.`)) {
      return;
    }
    setBusyId(d.id);
    try {
      await api.post(`/nouveaux-clients/${d.id}/refuser`);
      setFlash({ kind: 'info', text: 'Demande refusée.' });
      setError('');
      setReload((n) => n + 1);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du refus de la demande.');
      setFlash(null);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="platform-page remb-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <UserPlus size={18} /> Nouveaux clients
          </h2>
        </div>

        <nav className="fiche-tabs" aria-label="Filtre par statut">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`fiche-tab ${statut === tab.value ? 'active' : ''}`}
              onClick={() => {
                setStatut(tab.value);
                setFlash(null);
                setPage(1);
              }}
            >
              {tab.label}
              {tab.value === 'PENDING' && pending > 0 && (
                <span className="badge badge-attente">{pending}</span>
              )}
            </button>
          ))}
        </nav>

        {flash && (
          <div className={flash.kind === 'success' ? 'form-success' : 'remb-info'}>{flash.text}</div>
        )}
        {error && <div className="form-error">{error}</div>}

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : nom, magasin, téléphone, email, ville, CIN…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
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

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Demandeur</th>
                <th>Contact</th>
                <th>Ville / Adresse</th>
                <th>Compléments</th>
                <th>Date demande</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={COL_COUNT} className="datatable-empty">
                    Aucune demande trouvée.
                  </td>
                </tr>
              ) : (
                rows.map((d) => {
                  const badge = STATUT_BADGES[d.statut] || STATUT_BADGES.REFUSED;
                  return (
                    <tr key={d.id}>
                      <td>
                        <div className="cell-main">{d.store || d.name || '—'}</div>
                        <div className="cell-sub">
                          {d.store ? d.name : ''}
                          {d.cin ? `${d.store && d.name ? ' — ' : ''}CIN : ${d.cin}` : ''}
                        </div>
                      </td>
                      <td>
                        <div className="cell-main">{d.email || '—'}</div>
                        <div className="cell-sub">
                          {[d.phone, d.phone_personal].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </td>
                      <td>
                        <div className="cell-main">{d.city || '—'}</div>
                        <div className="cell-sub">{d.address || '—'}</div>
                      </td>
                      <td>
                        <div className="cell-main">{d.website || '—'}</div>
                        <div className="cell-sub">{d.rib ? `RIB : ${d.rib}` : '—'}</div>
                      </td>
                      <td>{formatDate(d.time)}</td>
                      <td>
                        <span className={`badge ${badge.badge}`}>{badge.label}</span>
                      </td>
                      <td>
                        {d.statut === 'PENDING' ? (
                          <div className="row-actions">
                            <button
                              type="button"
                              className="row-action row-action-success"
                              title="Accepter : créer le compte client"
                              onClick={() => setAccept(d)}
                              disabled={busyId === d.id}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              type="button"
                              className="row-action row-action-danger"
                              title="Refuser la demande"
                              onClick={() => refuser(d)}
                              disabled={busyId === d.id}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })
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

        {accept && (
          <AcceptModal
            demande={accept}
            villes={villes}
            onClose={() => setAccept(null)}
            onAccepted={(d) => {
              setFlash({
                kind: 'success',
                text: `Compte client « ${d.store || d.name} » créé — visible sur la page Clients.`
              });
              setError('');
              setReload((n) => n + 1);
            }}
          />
        )}
      </section>
    </div>
  );
}
