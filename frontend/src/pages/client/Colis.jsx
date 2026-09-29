import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeftRight,
  Ban,
  Plus,
  FileSpreadsheet,
  LockOpen,
  Printer,
  Route,
  Info,
  Pencil,
  HandCoins,
  MessageSquareWarning,
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Send,
  Trash2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePlatform } from '../../context/PlatformContext';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
// Modales partagées avec la page Sans adresse (squelette, suivi, information,
// modification) et condition d'affichage de « Modifier colis ».
import {
  ParcelModal,
  SuiviModal,
  InfoModal,
  EditModal,
  editVisible
} from '../../components/ClientParcelModals';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

const PAGE_SIZES = [10, 25, 50, 100];

/** Statuts pour lesquels on affiche la date programmée sous le badge. */
const STATUTS_AVEC_DATE = ['POSTPONED', 'PROGRAMMER'];

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → affichage "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value.trim();
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA" pour l'export Excel. */
function formatUnixDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('fr-FR');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM" (vide si 0 / null). */
function formatUnixDateTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  return `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  })}`;
}

/**
 * Auteur de la création affiché au client (colonne « Membre », sous-ligne
 * « Créé par » et export Excel) : nom du membre de l'équipe, « Administration »
 * pour un colis saisi depuis le dashboard admin (le nom de l'utilisateur admin
 * n'est jamais montré), sinon le propriétaire du compte.
 */
function creePar(p) {
  if (p.cree_par_membre) return p.cree_par_membre;
  return Number(p.cree_par_admin) === 1 ? 'Administration' : 'Propriétaire';
}

/**
 * Colonnes optionnelles du tableau (bouton « Colonnes à afficher »), dans
 * l'ordre d'affichage ; Code colis et Actions sont toujours visibles. Le choix
 * est mémorisé dans le navigateur (localStorage).
 */
const COLONNES = [
  { key: 'destinataire', label: 'Destinataire', defaut: true },
  { key: 'date_creation', label: 'Date création', defaut: false },
  { key: 'membre', label: 'Membre', defaut: false },
  { key: 'statut', label: 'Statut', defaut: true },
  { key: 'date_ramassage', label: 'Date ramassage', defaut: false },
  { key: 'date_livraison', label: 'Date livraison', defaut: false },
  { key: 'ville', label: 'Ville', defaut: true },
  { key: 'prix', label: 'Prix (DH)', defaut: true }
];
const COLONNES_STORAGE_KEY = 'client-colis-colonnes';

/** Colonnes visibles mémorisées ; valeurs par défaut si absentes ou invalides. */
function chargerColonnes() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(COLONNES_STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  return Object.fromEntries(
    COLONNES.map((c) => [
      c.key,
      saved && typeof saved[c.key] === 'boolean' ? saved[c.key] : c.defaut
    ])
  );
}

/** Filtres appliqués par défaut : 30 derniers jours de dernière mise à jour. */
function defaultFilters() {
  return { status: '', city: '', range: defaultRange() };
}

/**
 * Actions d'une ligne. `visible` contrôle l'affichage selon le statut brut
 * du colis (parcel_status).
 */
const ROW_ACTIONS = [
  { key: 'etiquette', label: 'Imprimer étiquette (100 × 100 mm)', icon: Printer, visible: () => true },
  { key: 'suivi', label: 'Détail de suivi', icon: Route, visible: () => true },
  { key: 'info', label: 'Information colis', icon: Info, visible: () => true },
  {
    // WAITING_PICKUP : modification directe ; tout autre statut sauf DELIVERED /
    // RETURNED : demande de modification à valider par l'admin
    // (/admin/modifications-colis).
    key: 'edit',
    label: 'Modifier colis',
    icon: Pencil,
    visible: editVisible
  },
  {
    // Blocage du ramassage et de l'expédition tant que le colis n'est pas
    // expédié : refusé au scan admin (« Bloqué par le client, à ne pas envoyer »).
    key: 'blocage',
    label: 'Bloquer l’expédition',
    icon: Ban,
    visible: (p) =>
      ['WAITING_PICKUP', 'PICKED_UP'].includes(p.parcel_status) &&
      Number(p.parcel_client_block) !== 1
  },
  {
    key: 'deblocage',
    label: 'Débloquer l’expédition',
    icon: LockOpen,
    visible: (p) =>
      ['WAITING_PICKUP', 'PICKED_UP'].includes(p.parcel_status) &&
      Number(p.parcel_client_block) === 1
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
    key: 'reclamation',
    label: 'Réclamation',
    icon: MessageSquareWarning,
    visible: (p) => p.parcel_status !== 'WAITING_PICKUP'
  },
  {
    // Suppression définitive tant que le colis n'est pas ramassé (même action
    // que « Supprimer colis » de la page Colis admin).
    key: 'delete',
    label: 'Supprimer colis',
    icon: Trash2,
    visible: (p) => p.parcel_status === 'WAITING_PICKUP',
    danger: true
  }
];

/** Bloc récapitulatif du colis en tête des modales remboursement / réclamation. */
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
 * Modale "Demande remboursement" : montant à rembourser, récupération du colis
 * (le livreur récupère le colis chez le destinataire) et commentaire. La demande
 * est enregistrée (delevery_remboursement) et traitée sur la page Remboursements
 * du dashboard admin.
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
      .get(`/parcels/client/${parcel.parcel_id}/details`)
      .then((res) => setDetails(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  async function send(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/parcels/client/${parcel.parcel_id}/remboursement`, {
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
              max={details.crbt}
              step="0.01"
              required
              value={montant}
              onChange={(e) => setMontant(e.target.value)}
              placeholder={`Maximum ${details.crbt} DH`}
            />
          </label>
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
 * Modale "Réclamation" : titre + texte, enregistrés dans
 * delevery_reclamation_suivre et traités sur la page Réclamations admin.
 */
function ReclamationModal({ parcel, onClose }) {
  const [details, setDetails] = useState(null);
  const [titre, setTitre] = useState('');
  const [texte, setTexte] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/client/${parcel.parcel_id}/details`)
      .then((res) => setDetails(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  async function send(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/parcels/client/${parcel.parcel_id}/reclamation`, { titre, texte });
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de l’envoi de la réclamation.');
      setSending(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Réclamation" onClose={onClose}>
      {!details && !error && <div className="modal-loading">Chargement…</div>}
      {sent ? (
        <>
          <div className="form-success">
            Votre réclamation a bien été envoyée. Elle sera traitée dans les plus brefs délais.
          </div>
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
                ['Destinataire', details.parcel_receiver],
                ['N° téléphone', details.parcel_phone],
                [
                  'Statut actuel',
                  <span
                    key="statut"
                    className="badge"
                    style={parcel.statut_color ? { background: parcel.statut_color } : undefined}
                  >
                    {statutLabel(parcel.statut)}
                  </span>
                ],
                ['Montant CRBT', `${details.crbt} DH`]
              ]}
            />
            <label>
              Titre de la réclamation
              <input
                type="text"
                required
                maxLength={255}
                value={titre}
                onChange={(e) => setTitre(e.target.value)}
                placeholder="Ex. : colis livré mais montant non conforme"
              />
            </label>
            <label>
              Texte de la réclamation
              <textarea
                rows={4}
                required
                value={texte}
                onChange={(e) => setTexte(e.target.value)}
                placeholder="Décrivez votre réclamation…"
              />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={sending}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={sending}>
                <Send size={15} /> {sending ? 'Envoi…' : 'Envoyer réclamation'}
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
 * Modale de confirmation « Bloquer / Débloquer l'expédition » : tant que le
 * colis est bloqué (parcel_client_block = 1), il est refusé au scan admin
 * (ramassage et bon d'envoi) avec le message « Bloqué par le client, à ne pas
 * envoyer ». Le client peut le débloquer à tout moment depuis la même page.
 */
function BlocageModal({ parcel, onClose, onDone }) {
  const bloquer = Number(parcel.parcel_client_block) !== 1;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/parcels/client/${parcel.parcel_id}/blocage`, { bloquer: bloquer ? 1 : 0 });
      onDone(parcel.parcel_id, bloquer ? 1 : 0);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de l’enregistrement.');
      setBusy(false);
    }
  }

  return (
    <ParcelModal
      code={parcel.parcel_code}
      subtitle={bloquer ? 'Bloquer l’expédition' : 'Débloquer l’expédition'}
      onClose={onClose}
    >
      <p className="modal-confirm-txt">
        {bloquer ? (
          <>
            Bloquer le ramassage et l’expédition de ce colis ? Tant qu’il est bloqué, il sera
            refusé au scan par l’administration avec le message «&nbsp;Bloqué par le client, à ne
            pas envoyer&nbsp;». Vous pourrez le débloquer à tout moment.
          </>
        ) : (
          <>Débloquer ce colis ? Il pourra de nouveau être ramassé et expédié normalement.</>
        )}
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button
          type="button"
          className={`btn ${bloquer ? 'btn-danger' : 'btn-primary'}`}
          onClick={confirmer}
          disabled={busy}
        >
          {bloquer ? <Ban size={15} /> : <LockOpen size={15} />}
          {busy
            ? ' Enregistrement…'
            : bloquer
              ? ' Bloquer l’expédition'
              : ' Débloquer l’expédition'}
        </button>
      </div>
    </ParcelModal>
  );
}

/**
 * Modale « Supprimer colis » : confirmation avant suppression définitive d'un
 * colis en attente de ramassage (le stock d'un colis de stock est restauré).
 * Même action que sur la page Colis admin.
 */
function DeleteModal({ parcel, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function confirmer() {
    if (deleting) return;
    setDeleting(true);
    setError('');
    try {
      await api.delete(`/parcels/client/${parcel.parcel_id}`);
      onDeleted(parcel.parcel_id);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la suppression.');
      setDeleting(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Supprimer colis" onClose={onClose}>
      <p className="modal-confirm-txt">
        Voulez-vous vraiment supprimer le colis <b className="mono">{parcel.parcel_code}</b> ?
        <br />
        Cette action est définitive : le colis et son historique seront supprimés
        (le stock d’un colis de stock est restauré).
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

export default function Colis() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState({ cities: [], statuts: [] });
  // Brouillon (édité librement) vs filtres appliqués (utilisés pour la requête).
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  // Colis cochés (id → ligne), conservés lors des changements de page.
  const [selected, setSelected] = useState({});
  const [printOpen, setPrintOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Colonnes affichées (bouton « Colonnes à afficher »), mémorisées par navigateur.
  const [colonnes, setColonnes] = useState(chargerColonnes);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef(null);
  // Modale d'action de ligne : { type: 'suivi'|'info'|'edit'|'blocage'|'deblocage'|
  //   'remboursement'|'reclamation'|'delete', parcel }.
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
    api.get('/parcels/client/filters').then((res) => setOptions(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/parcels/client', {
        params: {
          page,
          pageSize,
          search,
          status: applied.status,
          city: applied.city,
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

  // Fermeture des menus « Imprimer étiquettes » / « Colonnes à afficher » au
  // clic hors zone / Échap.
  useEffect(() => {
    if (!printOpen && !colsOpen) return undefined;
    const onDocClick = (e) => {
      if (printRef.current && !printRef.current.contains(e.target)) setPrintOpen(false);
      if (colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPrintOpen(false);
        setColsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [printOpen, colsOpen]);

  // Mémorise le choix des colonnes (ignoré si le stockage est indisponible).
  useEffect(() => {
    try {
      localStorage.setItem(COLONNES_STORAGE_KEY, JSON.stringify(colonnes));
    } catch {
      /* stockage indisponible : choix non mémorisé */
    }
  }, [colonnes]);

  const toggleColonne = (key) => setColonnes((prev) => ({ ...prev, [key]: !prev[key] }));
  // Case à cocher + Code colis + Actions + colonnes optionnelles visibles.
  const nbColonnes = 3 + COLONNES.filter((c) => colonnes[c.key]).length;

  const applyFilters = () => {
    // Nouvelle référence : recharge même si les filtres n'ont pas changé.
    setApplied({ ...draft });
    setPage(1);
  };

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  /** Retire la ligne d'un colis supprimé (modale « Supprimer colis »). */
  const removeRow = (id) => {
    setRows((prev) => prev.filter((r) => r.parcel_id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setSelected((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

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

  /** Exporte les colis cochés en fichier .xlsx (librairie chargée à la demande). */
  const exportExcel = async () => {
    if (!selectedRows.length) return;
    const XLSX = await import('xlsx');
    const data = selectedRows.map((p) => ({
      'Code colis': p.parcel_code || '',
      Type: Number(p.parcel_from_stock) === 1 ? 'Stock' : 'Normale',
      Destinataire: p.parcel_receiver || '',
      'Téléphone': p.parcel_phone || '',
      Ville: p.ville || '',
      Statut: statutLabel(p.statut),
      'Prix (DH)': p.parcel_price ?? '',
      'Date de création': formatUnixDate(p.parcel_time),
      'Créé par': creePar(p),
      'Date de ramassage': formatUnixDate(p.parcel_pickup_time),
      'Date de livraison': formatUnixDate(p.parcel_delivery_time)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0]).map((k) => ({
      wch: Math.max(k.length, ...data.map((r) => String(r[k]).length)) + 2
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Colis');
    XLSX.writeFile(wb, `colis_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  /**
   * Imprime les étiquettes des colis cochés : récupère les données complètes
   * (adresse, note, zone…), génère le PDF (A4 = 4 étiquettes / page, ou
   * 100 × 100 mm) et l'ouvre dans un nouvel onglet. L'onglet est ouvert
   * pendant le clic pour ne pas être bloqué par le navigateur.
   */
  const printLabels = async (format, rowsToPrint = selectedRows) => {
    if (!rowsToPrint.length || printing) return;
    setPrintOpen(false);
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération des étiquettes…');
    setPrinting(true);
    try {
      const ids = rowsToPrint.map((p) => p.parcel_id).join(',');
      const res = await api.get('/parcels/client/labels', { params: { ids } });
      const { genererEtiquettesPdf } = await import('../../utils/etiquettes');
      const url = await genererEtiquettesPdf({
        ...res.data,
        logoUrl: config.logo,
        format,
        onProgress: progressionOnglet(win, 'Génération des étiquettes…', 'étiquette')
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      // L'impression enregistre le CRBT courant : les étiquettes réimprimées
      // ne sont plus obsolètes → retrait immédiat du badge.
      const printedIds = new Set(res.data.labels.map((l) => l.parcel_id));
      setRows((prev) =>
        prev.map((r) => (printedIds.has(r.parcel_id) ? { ...r, label_stale: 0 } : r))
      );
      setSelected((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (printedIds.has(next[id].parcel_id)) next[id] = { ...next[id], label_stale: 0 };
        }
        return next;
      });
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
        <Link to="/client/nouveau-colis" className="btn btn-primary btn-icon">
          <Plus size={16} /> Ajouter colis
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={exportExcel}
          disabled={!selectedRows.length}
          title={selectedRows.length ? 'Exporter les colis sélectionnés' : 'Sélectionnez des colis à exporter'}
        >
          <FileSpreadsheet size={16} /> Exporter Excel
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
      </div>

      <div className="filters-bar">
        <SearchSelect
          label="Ville de destination"
          options={options.cities.map((o) => ({ value: o.id, label: o.label }))}
          value={draft.city}
          onChange={setDraftField('city')}
          allLabel="Toutes"
        />
        <SearchSelect
          label="Statut"
          options={options.statuts.map((s) => ({ value: s.code, label: statutLabel(s.code) }))}
          value={draft.status}
          onChange={setDraftField('status')}
        />
        <DateRangeSelect value={draft.range} onChange={setDraftField('range')} />
        <button type="button" className="btn-apply" onClick={applyFilters}>
          <SlidersHorizontal size={15} />
          Appliquer filtres
        </button>
      </div>

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
        <div className="btn-menu colonnes-menu" ref={colsRef}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setColsOpen((v) => !v)}
            aria-expanded={colsOpen}
            title="Choisir les colonnes affichées dans le tableau"
          >
            <Columns3 size={16} /> Colonnes à afficher <ChevronDown size={14} />
          </button>
          {colsOpen && (
            <ul className="btn-menu-pop colonnes-pop">
              {COLONNES.map((c) => (
                <li key={c.key}>
                  <label className="colonnes-item">
                    <input
                      type="checkbox"
                      checked={colonnes[c.key]}
                      onChange={() => toggleColonne(c.key)}
                    />
                    {c.label}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, destinataire, téléphone, ville…"
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
              <th>Code colis</th>
              {colonnes.destinataire && <th>Destinataire</th>}
              {colonnes.date_creation && <th>Date création</th>}
              {colonnes.membre && <th>Membre</th>}
              {colonnes.statut && <th>Statut</th>}
              {colonnes.date_ramassage && <th>Date ramassage</th>}
              {colonnes.date_livraison && <th>Date livraison</th>}
              {colonnes.ville && <th>Ville</th>}
              {colonnes.prix && <th>Prix (DH)</th>}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={nbColonnes} className="datatable-empty">
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
                    <span
                      className={`badge badge-type ${
                        Number(p.parcel_from_stock) === 1 ? 'badge-stock' : 'badge-normale'
                      }`}
                    >
                      {Number(p.parcel_from_stock) === 1 ? 'Stock' : 'Normale'}
                    </span>
                    {Number(p.label_stale) === 1 &&
                      ['NEW_PARCEL', 'WAITING_PICKUP'].includes(p.parcel_status) && (
                        <span
                          className="badge badge-type badge-etq-stale"
                          title="Le prix a changé après l'impression de l'étiquette : réimprimez-la, l'ancienne sera refusée au ramassage."
                        >
                          Étiquette à réimprimer
                        </span>
                      )}
                    {Number(p.parcel_client_block) === 1 && (
                      <span
                        className="badge badge-type badge-blocage"
                        title="Expédition bloquée à votre demande : ce colis sera refusé au scan ramassage / envoi tant que vous ne le débloquez pas."
                      >
                        Expédition bloquée
                      </span>
                    )}
                  </td>
                  {colonnes.destinataire && (
                    <td>
                      <div className="cell-main">{p.parcel_receiver || '—'}</div>
                      <div className="cell-sub">{p.parcel_phone || '—'}</div>
                    </td>
                  )}
                  {colonnes.date_creation && (
                    <td>
                      <div className="cell-main colis-date">
                        {formatUnixDateTime(p.parcel_time) || '—'}
                      </div>
                      <div className="cell-sub">Créé par : {creePar(p)}</div>
                    </td>
                  )}
                  {colonnes.membre && <td>{creePar(p)}</td>}
                  {colonnes.statut && (
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
                  )}
                  {colonnes.date_ramassage && (
                    <td className="colis-date">{formatUnixDateTime(p.parcel_pickup_time) || '—'}</td>
                  )}
                  {colonnes.date_livraison && (
                    <td className="colis-date">{formatUnixDateTime(p.parcel_delivery_time) || '—'}</td>
                  )}
                  {colonnes.ville && <td>{p.ville || '—'}</td>}
                  {colonnes.prix && <td>{p.parcel_price ?? '—'}</td>}
                  <td>
                    <div className="row-actions">
                      {ROW_ACTIONS.filter(({ visible }) => visible(p)).map(
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
                        )
                      )}
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

      {modal?.type === 'edit' && (
        <EditModal
          parcel={modal.parcel}
          onClose={() => setModal(null)}
          onSaved={(id, patch) =>
            setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)))
          }
        />
      )}
      {(modal?.type === 'blocage' || modal?.type === 'deblocage') && (
        <BlocageModal
          parcel={modal.parcel}
          onClose={() => setModal(null)}
          onDone={(id, block) =>
            setRows((prev) =>
              prev.map((r) => (r.parcel_id === id ? { ...r, parcel_client_block: block } : r))
            )
          }
        />
      )}
      {modal?.type === 'delete' && (
        <DeleteModal parcel={modal.parcel} onClose={() => setModal(null)} onDeleted={removeRow} />
      )}
      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'info' && (
        <InfoModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'remboursement' && (
        <RemboursementModal
          parcel={modal.parcel}
          onClose={() => setModal(null)}
          onSent={(id) =>
            setRows((prev) =>
              prev.map((r) => (r.parcel_id === id ? { ...r, remb_demande: 1 } : r))
            )
          }
        />
      )}
      {modal?.type === 'reclamation' && (
        <ReclamationModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
