import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeftRight,
  Route,
  Printer,
  FileSpreadsheet,
  HandCoins,
  Info,
  PackagePlus,
  PackageX,
  Pencil,
  MessageSquareWarning,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Send,
  Trash2,
  Undo2,
  UserCog
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { usePlatform } from '../../context/PlatformContext';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { ParcelModal, SuiviModal, InfoModal, EditModal, StatutModal } from '../../components/ParcelModals';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

const PAGE_SIZES = [10, 25, 50, 100];

/** Champs de date filtrables — la liste est triée sur le champ choisi. */
const DATE_FIELDS = [
  { value: 'last_update', label: 'Dernière mise à jour' },
  { value: 'created', label: 'Date de création' },
  { value: 'pickup', label: 'Date de ramassage' },
  { value: 'sent', label: "Date d'expédition" },
  { value: 'delivered', label: 'Date de livraison' }
];

/** Statuts pour lesquels on affiche la date programmée sous le badge. */
const STATUTS_AVEC_DATE = ['POSTPONED', 'PROGRAMMER'];

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → affichage "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value.trim();
}

/**
 * Colonne « Marchandise » de l'export Excel. Colis de stock (stock_produits
 * fourni par POST /parcels/export) : « nom variante (qté) | … », même format
 * que le ticket ; sinon marchandise saisie sur le colis.
 */
function marchandiseExport(p) {
  if (Array.isArray(p.stock_produits)) {
    return p.stock_produits
      .map((pr) => `${[pr.nom || '', pr.variante || ''].filter(Boolean).join(' ')} (${Number(pr.qty) || 0})`)
      .join(' | ');
  }
  return p.parcel_product_name || '';
}

/** Colonne « Quantité » de l'export Excel : unités des produits de stock, sinon quantité saisie. */
function quantiteExport(p) {
  if (Array.isArray(p.stock_produits)) {
    return p.stock_produits.reduce((sum, pr) => sum + (Number(pr.qty) || 0), 0);
  }
  return Number(p.parcel_product_qty) || 0;
}

/* Types d'employé autorisés à annuler une livraison ("Colis non livré"). */
const NON_LIVRE_TYPES = [1, 2];

/* Types d'employé autorisés à réaffecter un colis à un autre livreur ("Changer livreur"). */
const CHANGER_LIVREUR_TYPES = [1, 2];

/* Statuts seconds du circuit retour (même liste que le serveur) : un colis
 * échange livré qui les porte est engagé sur un bon de retour. */
const STATUTS_CIRCUIT_RETOUR = [
  'EXPEDIE_AGENCE_PRINCIPALE',
  'RECU_PAR_AGENCE',
  'RETURNED_TO_CUSTOMER',
  'RECU_BY_CUSTOMER',
  'RETURNED_TO_STOCK'
];

/** Vrai si le colis est retourné (RETURNED) ou échange livré en circuit de retour. */
function estRetourne(p) {
  return (
    p.parcel_status === 'RETURNED' ||
    (p.parcel_status === 'DELIVERED' &&
      STATUTS_CIRCUIT_RETOUR.includes(String(p.parcel_status_second || '').trim()))
  );
}

/* Les employés de type 6 n'ont accès qu'à ces actions de ligne. */
const TYPE6_ACTIONS = ['suivi', 'etiquette', 'info'];

function isType6(user) {
  return user?.kind === 'employee' && Number(user.role) === 6;
}

/**
 * Boutons d'action de chaque ligne. `visible` contrôle l'affichage selon le
 * statut brut (parcel_status) ou le statut effectif (statut) du colis, et
 * l'utilisateur connecté pour les actions restreintes.
 */
const ROW_ACTIONS = [
  { key: 'suivi', label: 'Détail de suivi', icon: Route, visible: () => true },
  { key: 'etiquette', label: 'Imprimer étiquette (100 × 100 mm)', icon: Printer, visible: () => true },
  { key: 'info', label: 'Information colis', icon: Info, visible: () => true },
  { key: 'edit', label: 'Modifier colis', icon: Pencil, visible: () => true },
  {
    key: 'reclamation',
    label: 'Réclamation',
    icon: MessageSquareWarning,
    visible: (p) => p.parcel_status !== 'WAITING_PICKUP'
  },
  {
    key: 'remboursement',
    label: 'Demande remboursement',
    icon: HandCoins,
    visible: (p) =>
      p.parcel_status === 'DELIVERED' &&
      Number(p.parcel_is_remb) === 0 &&
      Number(p.remb_demande) === 0
  },
  {
    key: 'statut',
    label: 'Changer statut',
    icon: RefreshCw,
    visible: (p) =>
      ['DISTRIBUTION', 'IN_PROGRESS'].includes(p.parcel_status) &&
      !['DELIVERED', 'INVOICED'].includes(p.statut)
  },
  // Réaffectation à un autre livreur : colis déjà affecté (parcel_livreur > 0),
  // ni retourné (RETURNED, « Retourné au stock » compris) ni échange livré en
  // circuit de retour ; employés type 1 / 2 uniquement.
  {
    key: 'livreur',
    label: 'Changer livreur',
    icon: UserCog,
    visible: (p, user) =>
      Number(p.parcel_livreur) > 0 &&
      !estRetourne(p) &&
      user?.kind === 'employee' &&
      CHANGER_LIVREUR_TYPES.includes(Number(user.role))
  },
  {
    key: 'nonLivre',
    label: 'Colis non livré',
    icon: PackageX,
    visible: (p, user) =>
      p.statut === 'DELIVERED' &&
      user?.kind === 'employee' &&
      NON_LIVRE_TYPES.includes(Number(user.role)),
    danger: true
  },
  {
    key: 'annulerRamassage',
    label: 'Annuler ramassage',
    icon: Undo2,
    visible: (p) => p.parcel_status === 'PICKED_UP',
    danger: true
  },
  {
    key: 'delete',
    label: 'Supprimer colis',
    icon: Trash2,
    visible: (p) => p.parcel_status === 'WAITING_PICKUP',
    danger: true
  }
];

/** Bloc récapitulatif du colis (modale réclamation). */
function InfoRecap({ rows }) {
  return (
    <div className="modal-recap">
      {rows.map(([label, value]) => (
        <div key={label} className="modal-recap-row">
          <span>{label}</span>
          <b>{value ?? '—'}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * Modale "Réclamation" : code colis en entête, infos du colis (client,
 * livreur, zone, ville de destination) dans le corps + commentaire facultatif.
 * Enregistrée dans delevery_reclamation_suivre (statut EN_COURS).
 */
function ReclamationModal({ parcel, onClose }) {
  const [details, setDetails] = useState(null);
  const [commentaire, setCommentaire] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/${parcel.parcel_id}/details`)
      .then((res) => setDetails(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  async function send(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/parcels/${parcel.parcel_id}/reclamation`, { commentaire });
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de l’enregistrement de la réclamation.');
      setSending(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Réclamation" onClose={onClose}>
      {!details && !error && <div className="modal-loading">Chargement…</div>}
      {sent ? (
        <>
          <div className="form-success">La réclamation a bien été enregistrée.</div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      ) : (
        details && (
          <form onSubmit={send}>
            <InfoRecap
              rows={[
                ['Client', details.expediteur?.store],
                ['Livreur', details.livreur],
                ['Zone', details.zone],
                ['Ville de destination', details.ville]
              ]}
            />
            <label>
              Commentaire
              <textarea
                rows={3}
                value={commentaire}
                onChange={(e) => setCommentaire(e.target.value)}
                placeholder="Commentaire (facultatif)…"
              />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={sending}>
                <Send size={15} /> {sending ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </form>
        )
      )}
      {!details && error && <div className="form-error">{error}</div>}
    </ParcelModal>
  );
}

/**
 * Modale "Demande remboursement" (version admin) : mêmes champs que la version
 * client (montant, récupération du colis, commentaire) mais sans plafond —
 * l'admin peut demander un montant supérieur au montant réel du colis. La
 * demande est enregistrée (delevery_remboursement) au nom du client du colis
 * et traitée sur la page admin Remboursement.
 */
function RemboursementModal({ parcel, onClose, onSent }) {
  const [details, setDetails] = useState(null);
  const [montant, setMontant] = useState('');
  const [recuperer, setRecuperer] = useState(0);
  const [commentaire, setCommentaire] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/${parcel.parcel_id}/details`)
      .then((res) => setDetails(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  async function send(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/parcels/${parcel.parcel_id}/remboursement`, {
        montant: Number(montant),
        recuperer,
        commentaire
      });
      onSent(parcel.parcel_id);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de l’envoi de la demande.');
      setSending(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Demande remboursement" onClose={onClose}>
      {!details && !error && <div className="modal-loading">Chargement…</div>}
      {details && (
        <form onSubmit={send}>
          <InfoRecap
            rows={[
              ['Client', details.expediteur?.store],
              ['Destinataire', details.parcel_receiver],
              ['N° téléphone', details.parcel_phone],
              ['Montant réel (CRBT)', `${details.crbt} DH`]
            ]}
          />
          <label>
            Montant à rembourser (DH)
            <input
              type="number"
              min="1"
              step="0.01"
              required
              value={montant}
              onChange={(e) => setMontant(e.target.value)}
              placeholder="Montant à rembourser…"
            />
          </label>
          <div className="cell-sub">Le montant peut dépasser le montant réel du colis.</div>
          <div className="option-row">
            <span className="field-label">Récupération du colis</span>
            <div className="radio-group">
              {[
                [1, 'Oui'],
                [0, 'Non']
              ].map(([v, text]) => (
                <label key={v} className={`radio-pill ${recuperer === v ? 'radio-pill-checked' : ''}`}>
                  <input
                    type="radio"
                    name="recuperer"
                    checked={recuperer === v}
                    onChange={() => setRecuperer(v)}
                  />
                  {text}
                </label>
              ))}
            </div>
          </div>
          <div className="cell-sub">Le livreur récupère le colis chez le destinataire.</div>
          <label>
            Commentaire
            <textarea
              rows={3}
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              placeholder="Commentaire (facultatif)…"
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              <Send size={15} /> {sending ? 'Envoi…' : 'Envoyer demande remboursement'}
            </button>
          </div>
        </form>
      )}
      {!details && error && <div className="form-error">{error}</div>}
    </ParcelModal>
  );
}

/**
 * Modale "Colis non livré" : confirmation avant annulation de la livraison.
 * Le statut "Livré" est supprimé (historique compris) et le colis revient à
 * son statut précédent ("En distribution" à défaut).
 */
function NonLivreModal({ parcel, onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/parcels/${parcel.parcel_id}/non-livre`);
      onSaved(parcel.parcel_id, {
        statut: res.data.statut,
        parcel_status: res.data.parcel_status,
        statut_color: res.data.statut_color || ''
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'annulation de la livraison.");
      setSaving(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Colis non livré" onClose={onClose}>
      <p>
        Voulez-vous vraiment marquer le colis <b className="mono">{parcel.parcel_code}</b> comme
        non livré ?
        <br />
        Le statut « Livré » sera retiré (historique compris) et le colis reviendra à son statut
        précédent.
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Annuler
        </button>
        <button type="button" className="btn btn-danger" onClick={confirmer} disabled={saving}>
          <PackageX size={15} /> {saving ? 'Enregistrement…' : 'Colis non livré'}
        </button>
      </div>
    </ParcelModal>
  );
}

/**
 * Modale "Changer livreur" (employés type 1 / 2) : réaffecte un colis déjà
 * affecté à un autre livreur actif, choisi dans une liste déroulante avec
 * recherche (GET /parcels/livreurs/actifs, livreur actuel exclu de la liste).
 */
function ChangerLivreurModal({ parcel, onClose, onSaved }) {
  const [livreurs, setLivreurs] = useState(null);
  const [livreurId, setLivreurId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/parcels/livreurs/actifs')
      .then((res) => setLivreurs(res.data))
      .catch((err) =>
        setError(err.response?.data?.message || 'Erreur de chargement des livreurs.')
      );
  }, []);

  const options = useMemo(
    () =>
      (livreurs || [])
        .filter((l) => Number(l.id) !== Number(parcel.parcel_livreur))
        .map((l) => ({ value: String(l.id), label: l.label })),
    [livreurs, parcel.parcel_livreur]
  );

  async function confirmer(e) {
    e.preventDefault();
    if (saving || !livreurId) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/parcels/${parcel.parcel_id}/livreur`, {
        livreurId: Number(livreurId)
      });
      onSaved(parcel.parcel_id, {
        parcel_livreur: res.data.parcel_livreur,
        livreur: res.data.livreur
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du changement de livreur.');
      setSaving(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Changer livreur" onClose={onClose}>
      <form onSubmit={confirmer}>
        <InfoRecap
          rows={[
            ['Livreur actuel', parcel.livreur],
            ['Destinataire', parcel.parcel_receiver],
            ['Ville', parcel.ville]
          ]}
        />
        <div className="modal-form-full">
          <span className="field-label">Nouveau livreur</span>
          <SearchableSelect
            value={livreurId}
            onChange={setLivreurId}
            options={options}
            placeholder={livreurs ? '— Choisir un livreur —' : 'Chargement…'}
            searchPlaceholder="Rechercher un livreur…"
            emptyText="Aucun livreur trouvé."
            disabled={!livreurs}
            portal
          />
        </div>
        <div className="cell-sub">
          Le colis quitte la liste de l’ancien livreur pour celle du nouveau ; le changement
          est tracé dans le suivi du colis.
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !livreurId}>
            <UserCog size={15} /> {saving ? 'Enregistrement…' : 'Changer livreur'}
          </button>
        </div>
      </form>
    </ParcelModal>
  );
}

/**
 * Modale "Annuler ramassage" : confirmation avant le retour d'un colis ramassé
 * (PICKED_UP) en attente de ramassage — la ligne « Ramassé » du suivi est
 * supprimée.
 */
function AnnulerRamassageModal({ parcel, onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/parcels/${parcel.parcel_id}/annuler-ramassage`);
      onSaved(parcel.parcel_id, {
        statut: res.data.statut,
        parcel_status: res.data.parcel_status,
        statut_color: res.data.statut_color || ''
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'annulation du ramassage.");
      setSaving(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Annuler ramassage" onClose={onClose}>
      <p>
        Voulez-vous vraiment annuler le ramassage du colis{' '}
        <b className="mono">{parcel.parcel_code}</b> ?
        <br />
        La ligne « Ramassé » sera supprimée de son suivi et le colis reviendra au statut
        « Attente de ramassage ».
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
          Annuler
        </button>
        <button type="button" className="btn btn-danger" onClick={confirmer} disabled={saving}>
          <Undo2 size={15} /> {saving ? 'Enregistrement…' : 'Annuler le ramassage'}
        </button>
      </div>
    </ParcelModal>
  );
}

/**
 * Modale "Supprimer colis" : confirmation avant suppression définitive d'un
 * colis en attente de ramassage (le stock des colis de stock est restauré).
 */
function DeleteModal({ parcel, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    if (deleting) return;
    setDeleting(true);
    setError('');
    try {
      await api.delete(`/parcels/${parcel.parcel_id}`);
      onDeleted(parcel.parcel_id);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la suppression.');
      setDeleting(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Supprimer colis" onClose={onClose}>
      <p>
        Voulez-vous vraiment supprimer le colis <b className="mono">{parcel.parcel_code}</b> ?
        <br />
        Cette action est définitive : le colis et son historique seront supprimés
        (le stock d'un colis de stock est restauré).
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={deleting}>
          Annuler
        </button>
        <button type="button" className="btn btn-danger" onClick={confirmer} disabled={deleting}>
          <Trash2 size={15} /> {deleting ? 'Suppression…' : 'Supprimer'}
        </button>
      </div>
    </ParcelModal>
  );
}

/** Filtres appliqués par défaut : 30 derniers jours de dernière mise à jour. */
function defaultFilters() {
  return {
    status: '',
    magasin: '',
    pickupCity: '',
    city: '',
    zone: '',
    agence: '',
    livreur: '',
    dateField: 'last_update',
    range: defaultRange()
  };
}

export default function Colis() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statuts, setStatuts] = useState([]);
  const [options, setOptions] = useState({
    magasins: [],
    pickupCities: [],
    cities: [],
    zones: [],
    agences: [],
    livreurs: []
  });
  // Brouillon (édité librement) vs filtres appliqués (utilisés pour la requête).
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  // Colis cochés (id → ligne), conservés lors des changements de page.
  const [selected, setSelected] = useState({});
  // Zone de filtres repliable (bouton « Filtres » avec flèche).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Modale d'action de ligne : { type: 'suivi'|'info'|'edit'|'reclamation'|
  // 'remboursement'|'statut'|'livreur'|'nonLivre'|'annulerRamassage'|'delete', parcel }.
  const [modal, setModal] = useState(null);
  const printRef = useRef(null);
  const { config } = usePlatform();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Recherche débouncée : on n'interroge le serveur que 400 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    api.get('/parcels/statuts').then((res) => setStatuts(res.data)).catch(() => {});
    api.get('/parcels/filters').then((res) => setOptions(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/parcels', {
        params: {
          page,
          pageSize,
          search,
          status: applied.status,
          magasin: applied.magasin,
          pickupCity: applied.pickupCity,
          city: applied.city,
          zone: applied.zone,
          agence: applied.agence,
          livreur: applied.livreur,
          dateField: applied.dateField,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
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
  }, [page, pageSize, search, applied]);

  // Fermeture du menu "Imprimer étiquettes" au clic hors zone / Échap.
  useEffect(() => {
    if (!printOpen) return undefined;
    const onDocClick = (e) => {
      if (printRef.current && !printRef.current.contains(e.target)) setPrintOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setPrintOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [printOpen]);

  const applyFilters = () => {
    // Nouvelle référence : recharge même si les filtres n'ont pas changé.
    setApplied({ ...draft });
    setPage(1);
  };

  /** Met à jour la ligne modifiée (modales "Modifier colis" / "Changer statut" / "Changer livreur"). */
  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)));

  /** Retire la ligne d'un colis supprimé (modale "Supprimer colis"). */
  const removeRow = (id) => {
    setRows((prev) => prev.filter((r) => r.parcel_id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setSelected((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  // Nombre de filtres appliqués (hors période, toujours renseignée) : affiché
  // sur le bouton « Filtres » pour rester visible quand la zone est repliée.
  const activeFilterCount = useMemo(
    () =>
      ['status', 'magasin', 'pickupCity', 'city', 'zone', 'agence', 'livreur'].filter(
        (k) => applied[k]
      ).length,
    [applied]
  );

  const selectedRows = useMemo(() => Object.values(selected), [selected]);
  const allChecked = rows.length > 0 && rows.every((p) => selected[p.parcel_id]);

  const toggleRow = (p) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[p.parcel_id]) delete next[p.parcel_id];
      else next[p.parcel_id] = p;
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => {
      const next = { ...prev };
      if (allChecked) rows.forEach((p) => delete next[p.parcel_id]);
      else rows.forEach((p) => (next[p.parcel_id] = p));
      return next;
    });

  /**
   * Exporte les colis cochés en fichier .xlsx (librairie chargée à la
   * demande). Les colonnes absentes de la liste (adresse, commentaire,
   * marchandise, quantité) sont lues via POST /parcels/export, qui renvoie
   * les colis du plus récent au plus ancien. Prix et quantité sont écrits en
   * nombres (sommes possibles dans Excel).
   */
  const exportExcel = async () => {
    if (!selectedRows.length || exporting) return;
    setExporting(true);
    try {
      const [res, XLSX] = await Promise.all([
        api.post('/parcels/export', { ids: selectedRows.map((p) => p.parcel_id) }),
        import('xlsx')
      ]);
      const data = res.data.rows.map((p) => ({
        'Nom magasin': p.magasin || '',
        'Code colis': p.parcel_code || '',
        Destinataire: p.parcel_receiver || '',
        'Téléphone': p.parcel_phone || '',
        Ville: p.ville || '',
        Adresse: p.parcel_address || '',
        'Prix (DH)': Number(p.parcel_price) || 0,
        Commentaire: p.parcel_note || '',
        Marchandise: marchandiseExport(p),
        'Quantité': quantiteExport(p),
        Statut: statutLabel(p.statut)
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = Object.keys(data[0]).map((k) => ({
        wch: Math.min(60, Math.max(k.length, ...data.map((r) => String(r[k] ?? '').length)) + 2)
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Colis');
      XLSX.writeFile(wb, `colis_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || "Impossible d'exporter les colis.");
    } finally {
      setExporting(false);
    }
  };

  /**
   * Imprime les étiquettes des colis cochés : récupère les données complètes
   * (adresse, note, zone, expéditeur…), génère le PDF (A4 = 4 étiquettes /
   * page, ou 100 × 100 mm) et l'ouvre dans un nouvel onglet. L'onglet est
   * ouvert pendant le clic pour ne pas être bloqué par le navigateur.
   */
  const printLabels = async (format, rowsToPrint = selectedRows) => {
    if (!rowsToPrint.length || printing) return;
    setPrintOpen(false);
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération des étiquettes…');
    setPrinting(true);
    try {
      const ids = rowsToPrint.map((p) => p.parcel_id).join(',');
      const res = await api.get('/parcels/labels', { params: { ids } });
      const { genererEtiquettesPdf } = await import('../../utils/etiquettes');
      const url = await genererEtiquettesPdf({
        ...res.data,
        logoUrl: config.logo,
        format,
        onProgress: progressionOnglet(win, 'Génération des étiquettes…', 'étiquette')
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      setError('');
    } catch (err) {
      if (win) win.close();
      setError(err.response?.data?.message || 'Impossible de générer les étiquettes.');
    } finally {
      setPrinting(false);
    }
  };

  const rangeLabel = useMemo(() => {
    if (!total) return '0 colis';
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} colis`;
  }, [page, pageSize, total]);

  return (
    <div className="colis-page">
      <div className="colis-actions">
        {!isType6(user) && (
          <Link to="/admin/colis/nouveau" className="btn btn-primary btn-icon">
            <PackagePlus size={16} /> Nouveau colis
          </Link>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={exportExcel}
          disabled={!selectedRows.length || exporting}
          title={selectedRows.length ? 'Exporter les colis sélectionnés' : 'Sélectionnez des colis à exporter'}
        >
          <FileSpreadsheet size={16} /> {exporting ? 'Export…' : 'Exporter Excel'}
          {selectedRows.length > 0 && <span className="selection-count">{selectedRows.length}</span>}
        </button>
        <div className="btn-menu" ref={printRef}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setPrintOpen((v) => !v)}
            disabled={!selectedRows.length || printing}
            title={selectedRows.length ? 'Imprimer les étiquettes des colis sélectionnés' : 'Sélectionnez des colis à imprimer'}
          >
            <Printer size={16} /> {printing ? 'Génération…' : 'Imprimer étiquettes'} <ChevronDown size={14} />
          </button>
          {printOpen && (
            <ul className="btn-menu-pop">
              <li>
                <button type="button" onClick={() => printLabels('a4')}>
                  Étiquette A4 (4 par page)
                </button>
              </li>
              <li>
                <button type="button" onClick={() => printLabels('100')}>
                  Étiquette 100mm × 100mm
                </button>
              </li>
            </ul>
          )}
        </div>
        <button
          type="button"
          className={`btn btn-ghost btn-icon filters-toggle ${filtersOpen ? 'is-open' : ''}`}
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          title={filtersOpen ? 'Masquer les filtres' : 'Afficher les filtres'}
        >
          <SlidersHorizontal size={16} /> Filtres
          {activeFilterCount > 0 && <span className="selection-count">{activeFilterCount}</span>}
          <ChevronDown size={14} className="filters-toggle-arrow" />
        </button>
      </div>

      {filtersOpen && (
        <div className="filters-panel">
          <div className="filters-bar">
            <SearchSelect
              label="Magasin"
              options={options.magasins.map((o) => ({ value: o.id, label: o.label }))}
              value={draft.magasin}
              onChange={setDraftField('magasin')}
            />
            <SearchSelect
              label="Ville de ramassage"
              options={options.pickupCities.map((o) => ({ value: o.id, label: o.label }))}
              value={draft.pickupCity}
              onChange={setDraftField('pickupCity')}
              allLabel="Toutes"
            />
            <SearchSelect
              label="Ville de destination"
              options={options.cities.map((o) => ({ value: o.id, label: o.label }))}
              value={draft.city}
              onChange={setDraftField('city')}
              allLabel="Toutes"
            />
            <SearchSelect
              label="Zone"
              options={(options.zones || []).map((o) => ({ value: o.id, label: o.label }))}
              value={draft.zone}
              onChange={setDraftField('zone')}
              allLabel="Toutes"
            />
            <SearchSelect
              label="Agence"
              options={options.agences.map((o) => ({ value: o.id, label: o.label }))}
              value={draft.agence}
              onChange={setDraftField('agence')}
              allLabel="Toutes"
            />
            <SearchSelect
              label="Livreur"
              options={options.livreurs.map((o) => ({ value: o.id, label: o.label }))}
              value={draft.livreur}
              onChange={setDraftField('livreur')}
            />
            <SearchSelect
              label="Statut"
              options={statuts.map((s) => ({ value: s.code, label: statutLabel(s.code) }))}
              value={draft.status}
              onChange={setDraftField('status')}
            />
            <select
              className="datatable-select"
              value={draft.dateField}
              onChange={(e) => setDraftField('dateField')(e.target.value)}
              title="Date de filtrage"
            >
              {DATE_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <DateRangeSelect value={draft.range} onChange={setDraftField('range')} />
            <button type="button" className="btn-apply" onClick={applyFilters}>
              <SlidersHorizontal size={15} />
              Appliquer filtres
            </button>
          </div>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="datatable-topbar">
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
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, destinataire, téléphone, magasin, ville…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
      </div>

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th className="col-check">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  title="Tout sélectionner"
                />
              </th>
              <th>Code d'envoi</th>
              <th>Destinataire</th>
              <th>Statut</th>
              <th>Ville</th>
              <th>Prix (DH)</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="datatable-empty">
                  Aucun colis trouvé.
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr key={p.parcel_id}>
                  <td className="col-check">
                    <input
                      type="checkbox"
                      checked={Boolean(selected[p.parcel_id])}
                      onChange={() => toggleRow(p)}
                    />
                  </td>
                  <td>
                    <div className="cell-main mono">
                      {p.parcel_code || '—'}
                      {Number(p.parcel_replace) === 1 && (
                        <span className="echange-icon" title="Colis échange">
                          <ArrowLeftRight size={14} />
                        </span>
                      )}
                    </div>
                    <div className="cell-sub">{p.magasin || '—'}</div>
                  </td>
                  <td>
                    <div className="cell-main">{p.parcel_receiver || '—'}</div>
                    <div className="cell-sub">{p.parcel_phone || '—'}</div>
                  </td>
                  <td>
                    <span
                      className="badge"
                      style={p.statut_color ? { background: p.statut_color } : undefined}
                    >
                      {statutLabel(p.statut)}
                    </span>
                    {STATUTS_AVEC_DATE.includes(p.statut) && formatReportDate(p.report_time) && (
                      <div className="cell-sub">{formatReportDate(p.report_time)}</div>
                    )}
                  </td>
                  <td>
                    <div className="cell-main">{p.ville || '—'}</div>
                    <div className="cell-sub">{p.livreur || '—'}</div>
                  </td>
                  <td>{p.parcel_price ?? '—'}</td>
                  <td>
                    <div className="row-actions">
                      {ROW_ACTIONS.filter(
                        ({ key, visible }) =>
                          visible(p, user) && (!isType6(user) || TYPE6_ACTIONS.includes(key))
                      ).map(
                        ({ key, label, icon: Icon, danger }) => (
                        <button
                          key={key}
                          type="button"
                          className={`row-action${danger ? ' row-action-danger' : ''}`}
                          title={label}
                          disabled={key === 'etiquette' && printing}
                          onClick={() => {
                            if (key === 'etiquette') printLabels('100', [p]);
                            else setModal({ type: key, parcel: p });
                          }}
                        >
                          <Icon size={16} />
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">{rangeLabel}</span>
        <div className="datatable-pager">
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage(1)}
            disabled={page <= 1}
            title="Première page"
          >
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

      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'info' && (
        <InfoModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'edit' && (
        <EditModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
      {modal?.type === 'reclamation' && (
        <ReclamationModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'remboursement' && (
        <RemboursementModal
          parcel={modal.parcel}
          onClose={() => setModal(null)}
          onSent={(id) => patchRow(id, { remb_demande: 1 })}
        />
      )}
      {modal?.type === 'statut' && (
        <StatutModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
      {modal?.type === 'livreur' && (
        <ChangerLivreurModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
      {modal?.type === 'nonLivre' && (
        <NonLivreModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
      {modal?.type === 'annulerRamassage' && (
        <AnnulerRamassageModal
          parcel={modal.parcel}
          onClose={() => setModal(null)}
          onSaved={patchRow}
        />
      )}
      {modal?.type === 'delete' && (
        <DeleteModal parcel={modal.parcel} onClose={() => setModal(null)} onDeleted={removeRow} />
      )}
    </div>
  );
}
