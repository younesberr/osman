import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Camera,
  CheckCircle2,
  FileText,
  PackagePlus,
  PackageX,
  Plus,
  Route,
  ScanLine,
  Search,
  Trash2,
  Truck,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';
import { usePagination, Pager } from '../../components/Pagination';
import { SuiviModal } from '../../components/ParcelModals';
import { statutLabel } from '../../utils/statuts';

/*
 * Page de création / modification d'un bon de distribution.
 * Section 1 : informations du bon (référence, date de création, zone,
 * livreur, statut).
 * Section 2 : colis « Reçu en agence » ou « En cours » de la zone du bon
 * (code + magasin, ville + adresse, livreur actuel, statut + date reportée /
 * programmée ou nombre de mises en distribution passées ; tri par colonne,
 * dernière mise à jour décroissante par défaut) — ajout à l'unité, par sélection (cases à cocher), par
 * douchette (validation Entrée) ou par caméra.
 * Section 3 : colis du bon (code + magasin, ville, statut, colonne
 * « Scanner » cochée si ajout par scanner ; tri par colonne) et retrait du bon.
 * Chaque ligne des deux tableaux ouvre la modale « Détail de suivi » de la
 * page Colis.
 * L'ajout passe le colis en DISTRIBUTION chez le livreur du bon, le retrait
 * le remet en RECEIVED (ou IN_PROGRESS s'il a un statut second) chez son
 * ancien livreur. Bon enregistré : lecture seule.
 */

/* Même code re-détecté par la caméra : ignoré pendant ce délai (anti-doublon). */
const CAM_COOLDOWN_MS = 4000;

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

/** Statut affiché d'un bon : Enregistré > Nouveau. */
function bonStatut(bon) {
  if (Number(bon.save) === 1) return { label: 'Enregistré', badge: 'badge-active' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Code statut effectif d'un colis : statut second quand il est « En cours ». */
function colisStatutCode(parcel) {
  if (parcel.status === 'IN_PROGRESS' && parcel.status_second) return parcel.status_second;
  return parcel.status;
}

/** Statut affiché d'un colis (libellé du statut effectif). */
function colisStatut(parcel) {
  return statutLabel(colisStatutCode(parcel));
}

/** Badge du statut affiché d'un colis, à la couleur du statut (statut_color,
 * delevery_parcel_statut) ; gris neutre si le statut n'a pas de couleur. */
function StatutBadge({ parcel }) {
  return (
    <span
      className={`badge ${parcel.statut_color ? '' : 'badge-neutral'}`}
      style={parcel.statut_color ? { background: parcel.statut_color } : undefined}
    >
      {colisStatut(parcel)}
    </span>
  );
}

/** Statuts pour lesquels on affiche la date reportée / programmée sous le badge. */
const STATUTS_AVEC_DATE = ['POSTPONED', 'PROGRAMMER'];

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → affichage "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : String(value).trim();
}

/** Date reportée / programmée d'un colis, vide si son statut ne la prévoit pas. */
function colisReportDate(parcel) {
  return STATUTS_AVEC_DATE.includes(colisStatutCode(parcel)) ? formatReportDate(parcel.report_time) : '';
}

/**
 * Seconde ligne de la colonne « Statut » des colis disponibles : date reportée /
 * programmée pour ces deux statuts, sinon le nombre de mises en distribution
 * passées du colis (nb_distributions, lignes DISTRIBUTION de l'historique).
 */
function colisStatutSub(parcel) {
  if (STATUTS_AVEC_DATE.includes(colisStatutCode(parcel))) return colisReportDate(parcel);
  const nb = Number(parcel.nb_distributions) || 0;
  return nb === 0 ? 'Jamais mis en distribution' : `Mis en distribution ${nb} fois`;
}

/** Bouton « Détail de suivi » d'une ligne (même modale que la page Colis). */
function SuiviButton({ onClick }) {
  return (
    <button type="button" className="row-action" title="Détail de suivi" onClick={onClick}>
      <Route size={16} />
    </button>
  );
}

/** Colonne « Livreur » : « En agence » ou le livreur qui détient le colis. */
function livreurLabel(parcel) {
  if (Number(parcel.en_agence) === 1) return 'En agence';
  return parcel.livreur_actuel || '';
}

/** Valeur de tri d'un colis pour une colonne (code = tri par nom magasin). */
function sortValue(parcel, key) {
  switch (key) {
    case 'magasin':
      return parcel.magasin || '';
    case 'ville':
      return parcel.ville || '';
    case 'livreur':
      return livreurLabel(parcel);
    case 'statut':
      return colisStatut(parcel);
    case 'scan':
      return Number(parcel.scan) === 1 ? 1 : 0;
    case 'last_update':
      return Number(parcel.last_update) || 0;
    default:
      return '';
  }
}

/** Tri stable d'une liste de colis ({ key, dir }) ; sans clé, ordre d'origine. */
function sortRows(rows, sort) {
  if (!sort?.key) return rows;
  const sens = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    let cmp;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), 'fr', { sensitivity: 'base', numeric: true });
    if (cmp === 0) cmp = String(a.code || '').localeCompare(String(b.code || ''), 'fr', { numeric: true });
    return cmp * sens;
  });
}

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Colonne « Scanner » : coche si le colis a été ajouté au bon par scanner. */
function ScanBadge({ scan }) {
  if (Number(scan) === 1) {
    return <CheckCircle2 size={17} className="bon-scan-ok" title="Ajouté par scanner" />;
  }
  return <span className="cell-sub">—</span>;
}

export default function BonDistributionEdit() {
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
  const [selectedDispo, setSelectedDispo] = useState(() => new Set());
  const [selectedBon, setSelectedBon] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // Colis dont la modale « Détail de suivi » est ouverte (ligne de l'un des tableaux).
  const [suiviParcel, setSuiviParcel] = useState(null);
  // Tri des tableaux : disponibles triés par date de dernière mise à jour par
  // défaut (le plus récent en tête) ; colis du bon dans l'ordre d'ajout (le
  // dernier ajouté en tête) tant qu'aucune colonne n'est choisie.
  const [sortDispo, setSortDispo] = useState({ key: 'last_update', dir: 'desc' });
  const [sortBon, setSortBon] = useState({ key: null, dir: 'asc' });

  const [scanValue, setScanValue] = useState('');
  const [removeScanValue, setRemoveScanValue] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [lastRemoveScan, setLastRemoveScan] = useState(null);
  const [camOpen, setCamOpen] = useState(false);
  // Cible du scan caméra : 'add' (section 2) ou 'remove' (section 3).
  const [camMode, setCamMode] = useState('add');
  const [camError, setCamError] = useState('');

  const scanInputRef = useRef(null);
  const removeScanInputRef = useRef(null);
  const camModeRef = useRef('add');
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const sonsRef = useRef({ success: null, error: null });
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  // Miroirs des listes : les scans caméra tournent dans une closure figée
  // (effet dépendant de camOpen seulement) — les refs restent à jour.
  const availableRef = useRef([]);
  availableRef.current = available;
  const bonParcelsRef = useRef([]);
  bonParcelsRef.current = bonParcels;

  const editable = bon && Number(bon.save) !== 1;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get(`/bons-distribution/${id}`), api.get(`/bons-distribution/${id}/available`)])
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

  // Sons de l'étape distribution configurés dans Configuration > Options.
  useEffect(() => {
    api
      .get('/bons-distribution/sons')
      .then((res) => {
        sonsRef.current = { success: res.data.success || null, error: res.data.error || null };
      })
      .catch(() => {});
  }, []);

  /** Bip de secours (WebAudio) quand aucun son n'est configuré ou lisible. */
  function beep(ok) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      const notes = ok
        ? [{ freq: 880, at: 0, dur: 0.12 }, { freq: 1320, at: 0.13, dur: 0.18 }]
        : [{ freq: 220, at: 0, dur: 0.45 }];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = ok ? 'sine' : 'square';
        osc.frequency.value = n.freq;
        gain.gain.setValueAtTime(0.25, ctx.currentTime + n.at);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + n.at + n.dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + n.at);
        osc.stop(ctx.currentTime + n.at + n.dur);
      }
    } catch {
      /* audio indisponible : le retour visuel suffit */
    }
  }

  function playFeedback(ok) {
    const url = sonsRef.current[ok ? 'success' : 'error'];
    if (url) {
      const audio = new Audio(url);
      audio.play().catch(() => beep(ok));
    } else {
      beep(ok);
    }
  }

  /** Colis ajoutés : passent de la liste des disponibles à celle du bon. */
  function moveToBon(added) {
    const byId = new Map(availableRef.current.map((p) => [p.id, p]));
    const enriched = added.map((p) => ({
      ...p,
      magasin: byId.get(p.id)?.magasin || '',
      status: 'DISTRIBUTION',
      status_second: ''
    }));
    const ids = new Set(added.map((p) => p.id));
    setAvailable((prev) => prev.filter((p) => !ids.has(p.id)));
    setBonParcels((prev) => [...enriched, ...prev]);
    setSelectedDispo(new Set());
  }

  /** Ajout de colis au bon (manuel ou sélection) : ids → POST /parcels. */
  async function addByIds(ids) {
    if (!ids.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.post(`/bons-distribution/${id}/parcels`, { ids });
      moveToBon(res.data.added);
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

  /** Scan (douchette ou caméra) : ajoute le colis scanné au bon. */
  async function submitScan(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current || !editable) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-distribution/${id}/scan`, { code });
      moveToBon([res.data.parcel]);
      setLastScan({ ok: true, message: res.data.message });
      playFeedback(true);
    } catch (err) {
      setLastScan({
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      });
      playFeedback(false);
    } finally {
      busyRef.current = false;
      setScanValue('');
      requestAnimationFrame(() => scanInputRef.current?.focus());
    }
  }

  /** Ligne « disponible » d'un colis retiré du bon : colis restauré renvoyé
   * par l'API (statut, statut second, en agence, livreur, adresse, date)
   * complété par les infos connues de la ligne du bon (magasin, adresse). */
  function restoredRow(parcel, bonRow) {
    return {
      id: parcel.id,
      code: parcel.code || bonRow?.code || '',
      ville: parcel.ville || bonRow?.ville || '',
      adresse: parcel.adresse || bonRow?.adresse || '',
      magasin: bonRow?.magasin || '',
      status: parcel.status || 'RECEIVED',
      status_second: parcel.status_second || '',
      statut_color: parcel.statut_color || '',
      en_agence: parcel.en_agence ?? 0,
      livreur_actuel: parcel.livreur_actuel || '',
      report_time: parcel.report_time || '',
      last_update: Number(parcel.last_update) || 0,
      nb_distributions: Number(parcel.nb_distributions) || 0
    };
  }

  /** Colis retiré : repart dans la liste des disponibles avec son statut restauré. */
  function moveToAvailable(parcel, bonRow) {
    setBonParcels((prev) => prev.filter((p) => p.id !== parcel.id));
    setAvailable((prev) => [restoredRow(parcel, bonRow), ...prev]);
    setSelectedBon((prev) => {
      const next = new Set(prev);
      next.delete(parcel.id);
      return next;
    });
  }

  /** Scan de retrait (douchette ou caméra) : retire le colis scanné du bon. */
  async function submitRemoveScan(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current || !editable) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-distribution/${id}/scan-retrait`, { code });
      const parcel = res.data.parcel;
      moveToAvailable(parcel, bonParcelsRef.current.find((p) => p.id === parcel.id));
      setLastRemoveScan({ ok: true, message: res.data.message });
      playFeedback(true);
    } catch (err) {
      setLastRemoveScan({
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      });
      playFeedback(false);
    } finally {
      busyRef.current = false;
      setRemoveScanValue('');
      requestAnimationFrame(() => removeScanInputRef.current?.focus());
    }
  }

  /** Code lu par la caméra : anti-doublon puis ajout ou retrait selon la cible. */
  function handleDetected(code) {
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    if (camModeRef.current === 'remove') submitRemoveScan(code);
    else submitScan(code);
  }

  /** Ouvre le scan caméra pour ajouter ('add') ou retirer ('remove') des colis. */
  function openCamera(mode) {
    camModeRef.current = mode;
    setCamMode(mode);
    setCamError('');
    setCamOpen(true);
  }

  // Caméra : flux vidéo arrière + détection QR / code-barres (API native ou repli ZXing).
  useEffect(() => {
    if (!camOpen) return undefined;
    let cancelled = false;
    let timer = null;

    async function start() {
      let detector;
      try {
        detector = await createCodeDetector();
      } catch {
        setCamError("Le scan par caméra n'est pas disponible sur cet appareil.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      } catch {
        setCamError("Impossible d'accéder à la caméra (autorisation refusée ?).");
        return;
      }

      async function tick() {
        if (cancelled) return;
        try {
          const raw = await detector.detect(videoRef.current);
          if (raw) handleDetected(raw);
        } catch {
          /* frame illisible : on réessaie au tick suivant */
        }
        timer = setTimeout(tick, 300);
      }
      tick();
    }

    start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOpen]);

  /** Retire un colis du bon (statut DISTRIBUTION uniquement). */
  async function removeParcel(parcel) {
    if (busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.delete(`/bons-distribution/${id}/parcels/${parcel.id}`);
      moveToAvailable(res.data, parcel);
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait.' });
    } finally {
      setBusy(false);
    }
  }

  /** Retrait par sélection : un appel par colis (chaque retrait est atomique). */
  async function removeSelection() {
    const parcels = bonParcels.filter((p) => selectedBon.has(p.id) && p.status === 'DISTRIBUTION');
    if (!parcels.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    const removed = [];
    let error = '';
    for (const parcel of parcels) {
      try {
        const res = await api.delete(`/bons-distribution/${id}/parcels/${parcel.id}`);
        removed.push(restoredRow(res.data, parcel));
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

  const dispoFiltres = useMemo(() => {
    const q = normalize(searchDispo.trim());
    const rows = q
      ? available.filter((p) =>
          [p.code, p.ville, p.adresse, p.magasin, livreurLabel(p)].some((v) => normalize(v).includes(q))
        )
      : available;
    return sortRows(rows, sortDispo);
  }, [available, searchDispo, sortDispo]);

  const bonFiltres = useMemo(() => {
    const q = normalize(searchBon.trim());
    const rows = q
      ? bonParcels.filter((p) => [p.code, p.ville, p.magasin].some((v) => normalize(v).includes(q)))
      : bonParcels;
    return sortRows(rows, sortBon);
  }, [bonParcels, searchBon, sortBon]);

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
  function togglePage(setter, selected, rows, filter = () => true) {
    const eligible = rows.filter(filter).map((p) => p.id);
    const allChecked = eligible.length > 0 && eligible.every((pid) => selected.has(pid));
    setter((prev) => {
      const next = new Set(prev);
      eligible.forEach((pid) => (allChecked ? next.delete(pid) : next.add(pid)));
      return next;
    });
  }

  if (loadError) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{loadError}</div>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin/bons-distribution')}>
            <ArrowLeft size={15} /> Retour aux bons de distribution
          </button>
        </section>
      </div>
    );
  }

  const statut = bon ? bonStatut(bon) : null;

  return (
    <div className="platform-page bon-edit-page">
      {/* Section 1 : informations du bon. */}
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <FileText size={18} /> Information du bon
          </h2>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin/bons-distribution')}>
            <ArrowLeft size={15} /> Retour aux bons de distribution
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
            <span className="field-label">Zone</span>
            <span className="cell-main">{bon?.zone || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Livreur</span>
            <span className="cell-main">{bon?.livreur_name || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Statut</span>
            {statut && <span className={`badge ${statut.badge}`}>{statut.label}</span>}
          </div>
        </div>
        {bon && !editable && (
          <div className="form-error">
            Ce bon est enregistré : la modification des colis est désactivée.
          </div>
        )}
      </section>

      {feedback && (
        <div className={`bon-feedback field-${feedback.type === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </div>
      )}

      {/* Section 2 : colis « Reçu en agence » / « En cours » de la zone, à ajouter au bon. */}
      {editable && (
        <section className="platform-card">
          <h2>
            <PackagePlus size={18} /> Colis à distribuer de la zone ({dispoFiltres.length})
          </h2>

          <div className="datatable-toolbar">
            <div className="datatable-search">
              <Search size={16} className="datatable-search-icon" />
              <input
                type="search"
                placeholder="Rechercher : code, ville, magasin…"
                value={searchDispo}
                onChange={(e) => {
                  setSearchDispo(e.target.value);
                  dispoPager.setPage(1);
                }}
              />
            </div>
          </div>

          <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th className="bon-check-col">
                    <input
                      type="checkbox"
                      checked={
                        dispoPager.pageRows.length > 0 &&
                        dispoPager.pageRows.every((p) => selectedDispo.has(p.id))
                      }
                      onChange={() => togglePage(setSelectedDispo, selectedDispo, dispoPager.pageRows)}
                      title="Tout cocher / décocher"
                    />
                  </th>
                  <SortableTh sort={sortDispo} onSort={toggleSort(setSortDispo, dispoPager)} sortKey="magasin">
                    Code de colis
                  </SortableTh>
                  <SortableTh sort={sortDispo} onSort={toggleSort(setSortDispo, dispoPager)} sortKey="ville">
                    Ville
                  </SortableTh>
                  <SortableTh sort={sortDispo} onSort={toggleSort(setSortDispo, dispoPager)} sortKey="livreur">
                    Livreur
                  </SortableTh>
                  <SortableTh sort={sortDispo} onSort={toggleSort(setSortDispo, dispoPager)} sortKey="statut">
                    Statut
                  </SortableTh>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {dispoFiltres.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={6} className="datatable-empty">
                      Aucun colis « Reçu en agence » ou « En cours » dans cette zone.
                    </td>
                  </tr>
                ) : (
                  dispoPager.pageRows.map((p) => (
                    <tr key={p.id}>
                      <td className="bon-check-col">
                        <input
                          type="checkbox"
                          checked={selectedDispo.has(p.id)}
                          onChange={() => toggleSet(setSelectedDispo, p.id)}
                        />
                      </td>
                      <td>
                        <div className="cell-main mono">{p.code || '—'}</div>
                        <div className="cell-sub">{p.magasin || '—'}</div>
                      </td>
                      <td>
                        <div className="cell-main">{p.ville || '—'}</div>
                        {p.adresse && <div className="cell-sub bon-cell-adresse">{p.adresse}</div>}
                      </td>
                      <td>{livreurLabel(p) || '—'}</td>
                      <td>
                        <StatutBadge parcel={p} />
                        {colisStatutSub(p) && <div className="cell-sub">{colisStatutSub(p)}</div>}
                      </td>
                      <td>
                        <div className="bon-row-actions">
                          <SuiviButton onClick={() => setSuiviParcel(p)} />
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => addByIds([p.id])}
                            disabled={busy}
                          >
                            <Plus size={14} /> Ajouter
                          </button>
                        </div>
                      </td>
                    </tr>
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

          {/* Scan douchette + caméra : ajout direct au bon. */}
          <div className="bon-scan-zone">
            <div className="bon-scan-title">
              <ScanLine size={17} /> Scanner un colis
            </div>
            <form
              className="bon-scan-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitScan(scanValue);
              }}
            >
              <input
                ref={scanInputRef}
                type="text"
                className="bon-scan-input"
                value={scanValue}
                placeholder="Code colis (douchette, validation par Entrée)…"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => setScanValue(e.target.value)}
              />
              <button type="button" className="btn btn-ghost" onClick={() => openCamera('add')}>
                <Camera size={16} /> Scanner par caméra
              </button>
            </form>
            {lastScan && (
              <div className={`scan-result scan-result-compact ${lastScan.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
                {lastScan.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div className="scan-result-msg">{lastScan.message}</div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Section 3 : colis du bon. */}
      <section className="platform-card">
        <h2>
          <Truck size={18} /> Colis du bon ({bonFiltres.length})
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, ville, magasin…"
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
              <tr>
                {editable && (
                  <th className="bon-check-col">
                    <input
                      type="checkbox"
                      checked={
                        bonPager.pageRows.filter((p) => p.status === 'DISTRIBUTION').length > 0 &&
                        bonPager.pageRows
                          .filter((p) => p.status === 'DISTRIBUTION')
                          .every((p) => selectedBon.has(p.id))
                      }
                      onChange={() =>
                        togglePage(setSelectedBon, selectedBon, bonPager.pageRows, (p) => p.status === 'DISTRIBUTION')
                      }
                      title="Tout cocher / décocher"
                    />
                  </th>
                )}
                <SortableTh sort={sortBon} onSort={toggleSort(setSortBon, bonPager)} sortKey="magasin">
                  Code de colis
                </SortableTh>
                <SortableTh sort={sortBon} onSort={toggleSort(setSortBon, bonPager)} sortKey="ville">
                  Ville
                </SortableTh>
                <SortableTh sort={sortBon} onSort={toggleSort(setSortBon, bonPager)} sortKey="statut">
                  Statut
                </SortableTh>
                <SortableTh sort={sortBon} onSort={toggleSort(setSortBon, bonPager)} sortKey="scan">
                  Scanner
                </SortableTh>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bonFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={editable ? 6 : 5} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                bonPager.pageRows.map((p) => (
                  <tr key={p.id}>
                    {editable && (
                      <td className="bon-check-col">
                        {p.status === 'DISTRIBUTION' && (
                          <input
                            type="checkbox"
                            checked={selectedBon.has(p.id)}
                            onChange={() => toggleSet(setSelectedBon, p.id)}
                          />
                        )}
                      </td>
                    )}
                    <td>
                      <div className="cell-main mono">{p.code || '—'}</div>
                      <div className="cell-sub">{p.magasin || '—'}</div>
                    </td>
                    <td>{p.ville || '—'}</td>
                    <td>
                      <StatutBadge parcel={p} />
                    </td>
                    <td>
                      <ScanBadge scan={p.scan} />
                    </td>
                    <td>
                      <div className="bon-row-actions">
                        <SuiviButton onClick={() => setSuiviParcel(p)} />
                        {editable && (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm bon-btn-danger"
                            onClick={() => removeParcel(p)}
                            disabled={busy || p.status !== 'DISTRIBUTION'}
                            title={
                              p.status !== 'DISTRIBUTION'
                                ? 'Colis déjà pris en charge : retrait impossible'
                                : 'Retirer du bon'
                            }
                          >
                            <Trash2 size={14} /> Supprimer
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
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

        {/* Scan douchette + caméra : retrait direct du bon. */}
        {editable && (
          <div className="bon-scan-zone">
            <div className="bon-scan-title">
              <ScanLine size={17} /> Scanner des colis à retirer
            </div>
            <form
              className="bon-scan-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitRemoveScan(removeScanValue);
              }}
            >
              <input
                ref={removeScanInputRef}
                type="text"
                className="bon-scan-input"
                value={removeScanValue}
                placeholder="Code colis à retirer (douchette, validation par Entrée)…"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => setRemoveScanValue(e.target.value)}
              />
              <button type="button" className="btn btn-ghost" onClick={() => openCamera('remove')}>
                <Camera size={16} /> Scanner par caméra
              </button>
            </form>
            {lastRemoveScan && (
              <div
                className={`scan-result scan-result-compact ${lastRemoveScan.ok ? 'scan-result-ok' : 'scan-result-err'}`}
              >
                {lastRemoveScan.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div className="scan-result-msg">{lastRemoveScan.message}</div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Modale « Détail de suivi » (composant partagé avec la page Colis). */}
      {suiviParcel && (
        <SuiviModal
          parcel={{ parcel_id: suiviParcel.id, parcel_code: suiviParcel.code }}
          onClose={() => setSuiviParcel(null)}
        />
      )}

      {/* Overlay du scan par caméra (téléphone mobile). */}
      {camOpen && (
        <div className="scan-cam-overlay" role="dialog" aria-label="Scanner par caméra">
          <div className="scan-cam-box">
            <video ref={videoRef} className="scan-cam-video" playsInline muted />
            {camError ? (
              <div className="scan-cam-error">{camError}</div>
            ) : (
              <div className="scan-cam-hint">
                {camMode === 'remove'
                  ? 'Visez le code du colis à RETIRER du bon.'
                  : 'Visez le code du colis à ajouter au bon.'}
              </div>
            )}
            {(camMode === 'remove' ? lastRemoveScan : lastScan) && (
              <div
                className={`scan-result scan-result-compact ${
                  (camMode === 'remove' ? lastRemoveScan : lastScan).ok ? 'scan-result-ok' : 'scan-result-err'
                }`}
              >
                {(camMode === 'remove' ? lastRemoveScan : lastScan).ok ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <XCircle size={18} />
                )}
                <div className="scan-result-msg">
                  {(camMode === 'remove' ? lastRemoveScan : lastScan).message}
                </div>
              </div>
            )}
            <button type="button" className="btn btn-primary scan-cam-close" onClick={() => setCamOpen(false)}>
              <X size={16} /> Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
