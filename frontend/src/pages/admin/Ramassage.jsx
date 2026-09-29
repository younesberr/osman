import { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  MapPin,
  MessageSquare,
  PackageOpen,
  Phone,
  Plus,
  Search,
  SlidersHorizontal,
  Undo2,
  UserRoundPlus,
  X
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect from '../../components/DateRangeSelect';

/*
 * Page /admin/ramassage — gestion des demandes de ramassage (table legacy
 * delevery_pickup_request, partagée avec la production) :
 *  - demandes manuelles (page client /client/demande-ramassage, ou créées ici
 *    par l'admin via « Nouvelle demande », ex. ramassage demandé par
 *    téléphone) et demandes automatiques (créées à la saisie d'un colis ou à
 *    12h00 par la périodicité de ramassage de la fiche client, une seule
 *    demande ouverte par client), traitées de la même manière ;
 *  - admins (types 1-4) : tableau avec filtres + affectation des demandes à
 *    un ramasseur (users_type = 6) — statut NEW « En attente » → RECEIVED
 *    « Affectée » → TREATED « Ramassée », ou « Annuler le ramassage » (TREATED
 *    annulée, badge rouge : le cycle repart au prochain colis saisi) ;
 *  - ramasseur (type 6) : deux onglets en cartes compactes mobile-first —
 *    « À ramasser » (ses demandes affectées : téléphone accolé à l'enseigne,
 *    heure de ramassage préférée de la fiche client si elle est fixée,
 *    remarque masquée pour les demandes automatiques, badge « Non vérifié »,
 *    actions icônes « Appeler » (tel:), « Appel / Message WhatsApp » (wa.me),
 *    « Annuler le ramassage » et « Ramasser ») et « À retourner » (ses bons
 *    de retour client expédiés,
 *    GET /bons-retour-client/ramasseur : « Marquer comme retourné » passe le
 *    bon en « Reçu (non vérifié) », la vérification restant à un admin 1-4).
 *    Clôtures confirmées en modale, jamais par window.confirm (le scan reste
 *    sur « Ramassage par scan »).
 */

const TYPE_LABELS = { SIMPLE_PARCEL: 'Ramassage de colis', STOCK: 'Ramassage de stock' };
// Note des demandes automatiques (même texte que NOTE_AUTO côté backend) :
// sans intérêt pour le ramasseur, elle est masquée sur ses cartes.
const NOTE_AUTO = 'Demande automatique (saisie de colis)';
const STATUTS = {
  new: { label: 'En attente', badge: 'badge-attente' },
  received: { label: 'Affectée', badge: 'badge-ram-recue' },
  treated: { label: 'Ramassée', badge: 'badge-ram-traitee' }
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

/** Téléphone de la demande, sinon celui de la fiche client. */
function phoneOf(d) {
  return d.phone || d.clientPhone || '';
}

/** Numéro marocain "06…" → format international WhatsApp "2126…" (wa.me). */
function waPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `212${digits.slice(1)}` : digits;
}

/** Nom affiché : enseigne du client, sinon son nom (comme les bons). */
function clientLabel(d) {
  return d.clientStore || d.clientNom || '—';
}

/** Filtres par défaut : demandes en attente d'affectation, toutes dates. */
function defaultFilters() {
  return { statut: 'new', type: '', origine: '', range: { from: '', to: '', preset: 'all' } };
}

/**
 * Modale de confirmation de clôture (tableau admin + cartes ramasseur) :
 * « Ramasser » (mode 'ramasser') marque la demande ramassée ; « Annuler le
 * ramassage » (mode 'annuler') la clôt aussi mais annulée (badge rouge). Dans
 * les deux cas le cycle repart : le prochain colis saisi par le client
 * recréera une demande automatique. Erreurs affichées dans la modale.
 */
function ClotureModal({ demande, mode, onClose, onDone }) {
  const annulation = mode === 'annuler';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/demandes-ramassage/${demande.id}/${annulation ? 'annuler' : 'ramasser'}`);
      onDone();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la clôture de la demande.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {annulation ? <Ban size={18} /> : <CheckCircle2 size={18} />}
            <div className="cell-main">{annulation ? 'Annuler le ramassage' : 'Confirmer le ramassage'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <p className="modal-confirm-txt">
          {annulation ? (
            <>
              Annuler le ramassage du jour de « <b>{clientLabel(demande)}</b> » ? La demande sera
              clôturée : le prochain colis saisi par le client créera une nouvelle demande de
              ramassage.
            </>
          ) : (
            <>
              Marquer la demande de « <b>{clientLabel(demande)}</b> » comme ramassée ?
            </>
          )}
        </p>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Retour
          </button>
          <button
            type="button"
            className={`btn ${annulation ? 'btn-danger' : 'btn-primary'}`}
            onClick={confirmer}
            disabled={busy}
          >
            {annulation ? <Ban size={15} /> : <CheckCircle2 size={15} />}{' '}
            {busy ? 'Clôture…' : annulation ? 'Annuler le ramassage' : 'Ramasser'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modale « Affecter la demande » : liste des ramasseurs avec recherche. */
function AffecterModal({ demande, onClose, onChanged }) {
  const [ramasseurs, setRamasseurs] = useState([]);
  const [userId, setUserId] = useState(demande.affecterId ? String(demande.affecterId) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/demandes-ramassage/ramasseurs')
      .then((res) => setRamasseurs(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement des ramasseurs.'));
  }, []);

  async function affecter(e) {
    e.preventDefault();
    setError('');
    if (!userId) {
      setError('Veuillez sélectionner un ramasseur.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.patch(`/demandes-ramassage/${demande.id}/affecter`, {
        userId: Number(userId)
      });
      onChanged(demande.id, {
        statut: 'received',
        affecterId: res.data.affecterId,
        affecterNom: res.data.affecterNom
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'affectation.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-affecter" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <UserRoundPlus size={18} />
            <div>
              <div className="cell-main">Affecter la demande — {clientLabel(demande)}</div>
              {demande.affecterNom && (
                <div className="cell-sub">Actuellement affectée à {demande.affecterNom}</div>
              )}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={affecter}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Ramasseur</span>
              <SearchableSelect
                value={userId}
                onChange={setUserId}
                placeholder="— Sélectionner un ramasseur —"
                options={ramasseurs.map((r) => ({ value: String(r.id), label: r.nom }))}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !userId}>
              <UserRoundPlus size={15} /> {busy ? 'Affectation…' : 'Affecter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modale « Nouvelle demande » : création manuelle d'une demande de ramassage
 * par l'admin pour un client (ex. ramassage demandé par appel téléphonique),
 * afin de pouvoir ensuite l'affecter à un ramasseur. Téléphone et adresse
 * préremplis depuis la fiche du client sélectionné (modifiables), remarque
 * facultative.
 */
function NouvelleDemandeModal({ onClose, onCreated }) {
  const [clients, setClients] = useState([]);
  const [form, setForm] = useState({
    clientId: '',
    type: 'SIMPLE_PARCEL',
    phone: '',
    address: '',
    note: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/demandes-ramassage/clients')
      .then((res) => setClients(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement des clients.'));
  }, []);

  const setField = (name) => (value) => setForm((prev) => ({ ...prev, [name]: value }));

  /** Client choisi : téléphone / adresse de sa fiche préremplis. */
  function choisirClient(clientId) {
    const client = clients.find((c) => String(c.id) === String(clientId));
    setForm((prev) => ({
      ...prev,
      clientId: String(clientId),
      phone: client?.phone || '',
      address: client?.address || ''
    }));
  }

  async function creer(e) {
    e.preventDefault();
    setError('');
    if (!form.clientId) {
      setError('Veuillez sélectionner un client.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/demandes-ramassage', {
        clientId: Number(form.clientId),
        type: form.type,
        phone: form.phone,
        address: form.address,
        note: form.note
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création de la demande.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-affecter" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Plus size={18} />
            <div className="cell-main">Nouvelle demande de ramassage</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={creer}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Client</span>
              <SearchableSelect
                value={form.clientId}
                onChange={choisirClient}
                placeholder="— Sélectionner un client —"
                options={clients.map((c) => ({
                  value: String(c.id),
                  label: c.store ? `${c.store} — ${c.nom}` : c.nom
                }))}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Type de ramassage</span>
              <select value={form.type} onChange={(e) => setField('type')(e.target.value)}>
                <option value="SIMPLE_PARCEL">{TYPE_LABELS.SIMPLE_PARCEL}</option>
                <option value="STOCK">{TYPE_LABELS.STOCK}</option>
              </select>
            </label>
            <label className="modal-form-full">
              <span className="field-label">Téléphone</span>
              <input
                type="tel"
                placeholder="Ex. 0612345678"
                value={form.phone}
                onChange={(e) => setField('phone')(e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse de ramassage</span>
              <input
                type="text"
                placeholder="Adresse de ramassage"
                value={form.address}
                onChange={(e) => setField('address')(e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Remarque (facultative)</span>
              <input
                type="text"
                placeholder="Ex. demande reçue par téléphone"
                value={form.note}
                onChange={(e) => setField('note')(e.target.value)}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !form.clientId}>
              <Plus size={15} /> {busy ? 'Création…' : 'Créer la demande'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau admin : demande + affectation / clôture (ramassée ou annulée). */
function DemandeRow({ demande, onAffecter, onChanged }) {
  const [confirm, setConfirm] = useState(null); // 'ramasser' | 'annuler' | null
  // Une demande annulée est TREATED en base : le badge la distingue en rouge.
  const statut = demande.canceled
    ? { label: 'Annulée', badge: 'badge-annulee' }
    : STATUTS[demande.statut] || STATUTS.new;
  const traitee = demande.statut === 'treated';

  return (
    <tr>
      <td>
        <div className="cell-main">{clientLabel(demande)}</div>
        {demande.clientStore && demande.clientNom && <div className="cell-sub">{demande.clientNom}</div>}
      </td>
      <td>{demande.ville || '—'}</td>
      <td>
        <span
          className={`badge badge-type ${demande.type === 'STOCK' ? 'badge-stock' : 'badge-normale'}`}
          title={TYPE_LABELS[demande.type] || demande.type}
        >
          {demande.type === 'STOCK' ? 'Stock' : 'Colis'}
        </span>
      </td>
      <td>
        {demande.auto ? (
          <span
            className="badge badge-affecte"
            title="Créée automatiquement (saisie d'un colis ou périodicité de ramassage)"
          >
            Auto
          </span>
        ) : (
          <span className="cell-sub">Manuelle</span>
        )}
      </td>
      <td className="mono">{phoneOf(demande) || '—'}</td>
      <td className="ram-cell-txt">{demande.address || '—'}</td>
      <td className="ram-cell-txt">{demande.note || '—'}</td>
      <td>{demande.parcelsEnAttente}</td>
      <td>{formatDate(demande.time)}</td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
      </td>
      <td>{demande.affecterNom || '—'}</td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="row-action"
            title={traitee ? 'Demande traitée : affectation impossible' : demande.affecterId ? 'Réaffecter à un ramasseur' : 'Affecter à un ramasseur'}
            onClick={() => onAffecter(demande)}
            disabled={traitee}
          >
            <UserRoundPlus size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-success"
            title={traitee ? 'Demande déjà clôturée' : 'Marquer la demande comme ramassée'}
            onClick={() => setConfirm('ramasser')}
            disabled={traitee}
          >
            <CheckCircle2 size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title={
              traitee
                ? 'Demande déjà clôturée'
                : 'Annuler le ramassage du jour (une nouvelle demande sera créée au prochain colis)'
            }
            onClick={() => setConfirm('annuler')}
            disabled={traitee}
          >
            <Ban size={16} />
          </button>
        </div>
        {confirm && (
          <ClotureModal
            demande={demande}
            mode={confirm}
            onClose={() => setConfirm(null)}
            onDone={() =>
              onChanged(demande.id, { statut: 'treated', canceled: confirm === 'annuler' ? 1 : 0 })
            }
          />
        )}
      </td>
    </tr>
  );
}

/** Vue admin (types 1-4) : compteurs, filtres et tableau des demandes. */
function AdminTable() {
  const [demandes, setDemandes] = useState([]);
  const [counts, setCounts] = useState({ new: 0, received: 0, treated: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [search, setSearch] = useState('');
  const [affecter, setAffecter] = useState(null);
  const [nouvelle, setNouvelle] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/demandes-ramassage', {
        params: {
          statut: applied.statut,
          type: applied.type,
          origine: applied.origine,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setDemandes(res.data.demandes);
        setCounts(res.data.counts);
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

  // Recherche locale sur les demandes chargées.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return demandes;
    return demandes.filter((d) =>
      [d.clientNom, d.clientStore, d.ville, phoneOf(d), d.address, d.note, d.affecterNom].some((v) =>
        String(v || '').toLowerCase().includes(q)
      )
    );
  }, [demandes, search]);

  const pager = usePagination(filtered, 'demande');
  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  /** Puce de statut : applique directement le filtre correspondant. */
  function applyStatut(statut) {
    setDraft((d) => ({ ...d, statut }));
    setApplied((a) => ({ ...a, statut }));
    pager.setPage(1);
  }

  /** Mise à jour d'une demande après affectation / clôture. */
  function handleChanged(id, patch) {
    const demande = demandes.find((d) => d.id === id);
    if (demande && patch.statut && patch.statut !== demande.statut) {
      setCounts((c) => ({
        ...c,
        [demande.statut]: Math.max(0, c[demande.statut] - 1),
        [patch.statut]: c[patch.statut] + 1
      }));
    }
    if (applied.statut && patch.statut && patch.statut !== applied.statut) {
      // La demande ne correspond plus au filtre courant : elle sort de la liste.
      setDemandes((prev) => prev.filter((d) => d.id !== id));
    } else {
      setDemandes((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    }
  }

  return (
    <div className="platform-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <PackageOpen size={18} /> Demandes de ramassage
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setNouvelle(true)}>
            <Plus size={15} /> Nouvelle demande
          </button>
        </div>

        <div className="ram-chips">
          {['new', 'received', 'treated'].map((code) => (
            <button
              key={code}
              type="button"
              className={`ram-chip ${applied.statut === code ? 'is-active' : ''}`}
              onClick={() => applyStatut(applied.statut === code ? '' : code)}
              title={applied.statut === code ? 'Retirer le filtre statut' : `Filtrer : ${STATUTS[code].label}`}
            >
              <span className={`ram-chip-dot ${STATUTS[code].badge}`} />
              {STATUTS[code].label}
              <b>{counts[code]}</b>
            </button>
          ))}
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
            <option value="received">Affectée</option>
            <option value="treated">Ramassée</option>
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
          <select
            className="datatable-select"
            value={draft.origine}
            onChange={(e) => setDraftField('origine')(e.target.value)}
            title="Origine de la demande"
          >
            <option value="">Toutes les origines</option>
            <option value="auto">Automatique (saisie de colis / périodicité)</option>
            <option value="manuelle">Manuelle (page client / admin)</option>
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
              placeholder="Rechercher : client, ville, téléphone, adresse, remarque, ramasseur…"
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
                <th>Client</th>
                <th>Ville</th>
                <th>Type</th>
                <th>Origine</th>
                <th>Téléphone</th>
                <th>Adresse</th>
                <th>Remarque</th>
                <th>Colis en attente</th>
                <th>Date demande</th>
                <th>Statut</th>
                <th>Ramasseur</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={12} className="datatable-empty">
                    Aucune demande de ramassage trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((d) => (
                  <DemandeRow key={d.id} demande={d} onAffecter={setAffecter} onChanged={handleChanged} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {affecter && (
        <AffecterModal demande={affecter} onClose={() => setAffecter(null)} onChanged={handleChanged} />
      )}
      {nouvelle && (
        <NouvelleDemandeModal
          onClose={() => setNouvelle(false)}
          onCreated={() => {
            // Nouvelle référence : recharge la liste et les compteurs.
            setApplied((a) => ({ ...a }));
            pager.setPage(1);
          }}
        />
      )}
    </div>
  );
}

/**
 * Carte compacte d'une demande côté ramasseur : téléphone accolé à l'enseigne,
 * remarque des demandes automatiques masquée, actions en icônes seules
 * (taille tactile conservée) et clôture confirmée en modale.
 */
function RamasseurCard({ demande, actif, onRamasse }) {
  const [confirm, setConfirm] = useState(null); // 'ramasser' | 'annuler' | null
  const phone = phoneOf(demande);
  const noteAuto = demande.auto || demande.note === NOTE_AUTO;

  return (
    <article className="ram-card">
      <div className="ram-card-head">
        <div>
          <div className="ram-card-client">
            {clientLabel(demande)}
            {phone && (
              <a className="ram-card-phone mono" href={`tel:${phone}`}>
                {phone}
              </a>
            )}
          </div>
          {demande.clientStore && demande.clientNom && (
            <div className="cell-sub">{demande.clientNom}</div>
          )}
        </div>
        <div className="ram-card-badges">
          <span className={`badge badge-type ${demande.type === 'STOCK' ? 'badge-stock' : 'badge-normale'}`}>
            {demande.type === 'STOCK' ? 'Stock' : 'Colis'}
          </span>
          {/* Heure de ramassage préférée de la fiche client : rien si non fixée. */}
          {demande.clientRamassageHeure && (
            <span className="badge badge-type badge-heure" title="Heure de ramassage souhaitée">
              {demande.clientRamassageHeure.replace(':', 'H')}
            </span>
          )}
          {!demande.clientVerifie && (
            <span className="badge badge-non-verifie" title="Ce client n'est pas encore vérifié">
              Non vérifié
            </span>
          )}
        </div>
      </div>

      <div className="ram-card-row">
        <MapPin size={15} />
        <span>
          {demande.address || '—'}
          {demande.ville ? ` — ${demande.ville}` : ''}
        </span>
      </div>
      {demande.note && !noteAuto && (
        <div className="ram-card-row">
          <MessageSquare size={15} />
          <span>{demande.note}</span>
        </div>
      )}

      {actif && (
        <div className="ram-card-actions">
          {phone && (
            <>
              <a
                className="btn ram-action-ico ram-action-tel"
                href={`tel:${phone}`}
                title="Appeler"
                aria-label="Appeler"
              >
                <Phone size={18} />
              </a>
              <a
                className="btn ram-action-ico ram-action-wa btn-whatsapp"
                href={`https://wa.me/${waPhone(phone)}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Appel WhatsApp"
                aria-label="Appel WhatsApp"
              >
                <i className="fab fa-whatsapp" />
              </a>
              <a
                className="btn ram-action-ico ram-action-wa btn-whatsapp"
                href={`https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(
                  'Bonjour, je suis le ramasseur ORTALOG. Je vous contacte au sujet du ramassage de vos colis.'
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Message WhatsApp"
                aria-label="Message WhatsApp"
              >
                <i className="fas fa-comment-dots" />
              </a>
            </>
          )}
          <button
            type="button"
            className="btn ram-action-ico ram-action-annuler"
            onClick={() => setConfirm('annuler')}
            title="Annuler le ramassage du jour"
            aria-label="Annuler le ramassage du jour"
          >
            <Ban size={18} />
          </button>
          <button
            type="button"
            className="btn btn-primary ram-action-ico"
            onClick={() => setConfirm('ramasser')}
            title="Marquer comme ramassée"
            aria-label="Marquer comme ramassée"
          >
            <CheckCircle2 size={18} />
          </button>
        </div>
      )}

      {confirm && (
        <ClotureModal
          demande={demande}
          mode={confirm}
          onClose={() => setConfirm(null)}
          onDone={() => onRamasse(demande.id)}
        />
      )}
    </article>
  );
}

/**
 * Modale de confirmation « Marquer comme retourné » (cartes ramasseur) : le
 * bon passe en « Reçu (non vérifié) » — la vérification reste à faire par un
 * admin (types 1-4) — et ses colis en « Reçu par le client » (colis de stock :
 * « Retourné au stock », produits réintégrés ; avertissements éventuels
 * renvoyés par l'API affichés après la clôture).
 */
function RetournerModal({ bon, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    setBusy(true);
    setError('');
    try {
      const res = await api.patch(`/bons-retour-client/${bon.id}/retourner`);
      onDone();
      onClose();
      const avertissements = res.data?.avertissements || [];
      if (avertissements.length) alert(avertissements.join('\n'));
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la clôture du bon.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <CheckCircle2 size={18} />
            <div className="cell-main">Confirmer le retour</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <p className="modal-confirm-txt">
          Marquer le bon « <b>{bon.ref}</b> » de «{' '}
          <b>{bon.store || bon.client_name || '—'}</b> » comme retourné au client ?
        </p>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="btn btn-primary" onClick={confirmer} disabled={busy}>
            <CheckCircle2 size={15} /> {busy ? 'Clôture…' : 'Retourné'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Carte d'un bon retour client côté ramasseur (onglet « À retourner ») : même
 * gabarit que les demandes — enseigne + téléphone, adresse — ville, référence
 * du bon, badge nombre de colis, actions tel / WhatsApp et « Marquer comme
 * retourné » (confirmé en modale).
 */
function BonRetourCard({ bon, onRetourne }) {
  const [confirm, setConfirm] = useState(false);
  const phone = bon.phone || '';

  return (
    <article className="ram-card">
      <div className="ram-card-head">
        <div>
          <div className="ram-card-client">
            {bon.store || bon.client_name || '—'}
            {phone && (
              <a className="ram-card-phone mono" href={`tel:${phone}`}>
                {phone}
              </a>
            )}
          </div>
          {bon.store && bon.client_name && bon.store !== bon.client_name && (
            <div className="cell-sub">{bon.client_name}</div>
          )}
        </div>
        <div className="ram-card-badges">
          <span className="badge badge-ram-recue">
            {Number(bon.nb_colis) || 0} colis
          </span>
        </div>
      </div>

      <div className="ram-card-row">
        <MapPin size={15} />
        <span>
          {bon.address || '—'}
          {bon.ville ? ` — ${bon.ville}` : ''}
        </span>
      </div>
      <div className="ram-card-row">
        <Undo2 size={15} />
        <span className="mono">{bon.ref || '—'}</span>
      </div>

      <div className="ram-card-actions">
        {phone && (
          <>
            <a
              className="btn ram-action-ico ram-action-tel"
              href={`tel:${phone}`}
              title="Appeler"
              aria-label="Appeler"
            >
              <Phone size={18} />
            </a>
            <a
              className="btn ram-action-ico ram-action-wa btn-whatsapp"
              href={`https://wa.me/${waPhone(phone)}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Appel WhatsApp"
              aria-label="Appel WhatsApp"
            >
              <i className="fab fa-whatsapp" />
            </a>
            <a
              className="btn ram-action-ico ram-action-wa btn-whatsapp"
              href={`https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(
                'Bonjour, je suis le ramasseur ORTALOG. Je vous contacte au sujet du retour de vos colis.'
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Message WhatsApp"
              aria-label="Message WhatsApp"
            >
              <i className="fas fa-comment-dots" />
            </a>
          </>
        )}
        <button
          type="button"
          className="btn btn-primary ram-action-ico"
          onClick={() => setConfirm(true)}
          title="Marquer comme retourné"
          aria-label="Marquer comme retourné"
        >
          <CheckCircle2 size={18} />
        </button>
      </div>

      {confirm && (
        <RetournerModal
          bon={bon}
          onClose={() => setConfirm(false)}
          onDone={() => onRetourne(bon.id)}
        />
      )}
    </article>
  );
}

/**
 * Vue ramasseur (type 6) : deux onglets — « À ramasser » (demandes affectées)
 * et « À retourner » (bons de retour client expédiés qui lui sont affectés),
 * en cartes mobile-first. Les deux listes sont rechargées à chaque bascule
 * d'onglet (compteurs à jour).
 */
function RamasseurCards() {
  const [onglet, setOnglet] = useState('received');
  const [demandes, setDemandes] = useState([]);
  const [counts, setCounts] = useState({ new: 0, received: 0, treated: 0 });
  const [bons, setBons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get('/demandes-ramassage', { params: { statut: 'received' } }),
      api.get('/bons-retour-client/ramasseur')
    ])
      .then(([demandesRes, bonsRes]) => {
        if (cancelled) return;
        setDemandes(demandesRes.data.demandes);
        setCounts(demandesRes.data.counts);
        setBons(bonsRes.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onglet]);

  /** Demande clôturée : elle quitte « À ramasser ». */
  function handleRamasse(id) {
    setDemandes((prev) => prev.filter((d) => d.id !== id));
    setCounts((c) => ({ ...c, received: Math.max(0, c.received - 1) }));
  }

  /** Bon marqué retourné : il quitte « À retourner » (reçu, à vérifier par un admin). */
  function handleRetourne(id) {
    setBons((prev) => prev.filter((b) => b.id !== id));
  }

  return (
    <div className="platform-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <PackageOpen size={18} /> Mes ramassages
          </h2>
        </div>

        <div className="tabs ram-tabs">
          <button
            type="button"
            className={`tab ${onglet === 'received' ? 'active' : ''}`}
            onClick={() => setOnglet('received')}
          >
            À ramasser ({counts.received})
          </button>
          <button
            type="button"
            className={`tab ${onglet === 'retour' ? 'active' : ''}`}
            onClick={() => setOnglet('retour')}
          >
            À retourner ({bons.length})
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <p className="ram-cards-vide">Chargement…</p>
        ) : onglet === 'received' ? (
          demandes.length === 0 ? (
            <p className="ram-cards-vide">Aucune demande à ramasser pour le moment.</p>
          ) : (
            <div className="ram-cards">
              {demandes.map((d) => (
                <RamasseurCard key={d.id} demande={d} actif onRamasse={handleRamasse} />
              ))}
            </div>
          )
        ) : bons.length === 0 ? (
          <p className="ram-cards-vide">Aucun bon retour à remettre au client.</p>
        ) : (
          <div className="ram-cards">
            {bons.map((b) => (
              <BonRetourCard key={b.id} bon={b} onRetourne={handleRetourne} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Ramassage — tableau + affectation pour les admins, cartes pour le ramasseur. */
export default function Ramassage() {
  const { user } = useAuth();
  return Number(user?.role) === 6 ? <RamasseurCards /> : <AdminTable />;
}
