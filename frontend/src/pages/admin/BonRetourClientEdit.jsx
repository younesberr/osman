import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowLeftRight,
  Camera,
  CheckCircle2,
  FileText,
  PackagePlus,
  PackageX,
  Plus,
  ScanLine,
  Search,
  Trash2,
  Undo2,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';
import { usePagination, Pager } from '../../components/Pagination';
import { statutLabel } from '../../utils/statuts';

/*
 * Page de création / modification d'un bon de retour client — même structure
 * que BonRetourLivreurEdit.jsx.
 * Section 1 : informations du bon (référence, date de création, client,
 * statut).
 * Section 2 : colis du client reçus par l'agence — seuls les colis déjà sur
 * un bon de retour livreur « Reçu » (statut « Reçu par l'agence ») sont
 * listés, tous ajoutables ; les colis échange livrés y figurent avec l'icône
 * échange et le motif « Livré ». Ajout à l'unité, par sélection, par
 * douchette (validation Entrée) ou par caméra.
 * Section 3 : colis du bon — motif de retour (statut d'avant le circuit
 * retour), colonne « Scanner » (douchette / caméra / vide si ajout manuel) et
 * retrait du bon.
 * L'ajout ne change plus le statut du colis (il reste « Reçu par l'agence » :
 * c'est l'expédition du bon qui le passera en « Retourné au client ») ; le
 * retrait supprime simplement la ligne. Bon expédié ou reçu (ou tous les
 * colis reçus par scan) : lecture seule.
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

/** Statut affiché d'un bon : Reçu ou Nouveau. */
function bonStatut(bon) {
  if (Number(bon.verified) === 1) return { label: 'Vérifié', badge: 'badge-active' };
  if (Number(bon.delivered) === 1) return { label: 'Reçu (non vérifié)', badge: 'badge-non-verifie' };
  if (Number(bon.expedited) === 1) return { label: 'Expédié', badge: 'badge-ram-recue' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Colonne « Scanner » : mode d'ajout du colis au bon. */
function ScanBadge({ scan }) {
  if (scan === 'douchette') {
    return <CheckCircle2 size={17} className="bon-scan-ok" title="Scanné à la douchette" />;
  }
  if (scan === 'camera') {
    return <Camera size={17} className="bon-scan-cam" title="Scanné par caméra" />;
  }
  return <span className="cell-sub">—</span>;
}

export default function BonRetourClientEdit() {
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

  // Lecture seule si le bon est expédié ou reçu, ou si tous ses colis sont
  // déjà reçus par scan.
  const tousRecus =
    bonParcels.length > 0 && bonParcels.every((p) => Number(p.received) === 1);
  const editable =
    bon && Number(bon.delivered) !== 1 && Number(bon.expedited) !== 1 && !tousRecus;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get(`/bons-retour-client/${id}`),
      api.get(`/bons-retour-client/${id}/available`)
    ])
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

  // Sons de l'étape retour configurés dans Configuration > Options.
  useEffect(() => {
    api
      .get('/bons-retour-client/sons')
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
    const enriched = added.map((p) => ({
      ...p,
      received: 0,
      received_time: 0
    }));
    const ids = new Set(added.map((p) => p.id));
    setAvailable((prev) => prev.filter((p) => !ids.has(p.id)));
    setBonParcels((prev) => [...enriched, ...prev]);
    setSelectedDispo(new Set());
  }

  /** Colis retiré du bon : revient dans la liste des disponibles. */
  function moveToAvailable(parcel) {
    const known = bonParcelsRef.current.find((p) => p.id === parcel.id);
    const magasin = parcel.magasin || known?.magasin || '';
    const motif = parcel.motif || known?.motif || '';
    setBonParcels((prev) => prev.filter((p) => p.id !== parcel.id));
    setAvailable((prev) => [
      {
        id: parcel.id,
        code: parcel.code,
        ville: parcel.ville,
        magasin,
        replace_flag: parcel.replace_flag ?? known?.replace_flag,
        motif
      },
      ...prev
    ]);
    setSelectedBon((prev) => {
      const next = new Set(prev);
      next.delete(parcel.id);
      return next;
    });
  }

  /** Ajout de colis au bon (manuel ou sélection) : ids → POST /parcels. */
  async function addByIds(ids) {
    if (!ids.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.post(`/bons-retour-client/${id}/parcels`, { ids });
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
  async function submitScan(rawCode, mode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current || !editable) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-retour-client/${id}/scan`, { code, scan: mode });
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

  /** Scan de retrait (douchette ou caméra) : retire le colis scanné du bon. */
  async function submitRemoveScan(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current || !editable) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-retour-client/${id}/scan-retrait`, { code });
      moveToAvailable(res.data.parcel);
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
    else submitScan(code, 'camera');
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

  /** Retire un colis du bon : le statut « Reçu par l'agence » est restauré. */
  async function removeParcel(parcel) {
    if (busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.delete(`/bons-retour-client/${id}/parcels/${parcel.id}`);
      moveToAvailable({ ...parcel, motif: res.data.motif });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait.' });
    } finally {
      setBusy(false);
    }
  }

  /** Retrait par sélection : un appel par colis (chaque retrait est atomique). */
  async function removeSelection() {
    const parcels = bonParcels.filter((p) => selectedBon.has(p.id) && Number(p.received) !== 1);
    if (!parcels.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    let error = '';
    for (const parcel of parcels) {
      try {
        const res = await api.delete(`/bons-retour-client/${id}/parcels/${parcel.id}`);
        moveToAvailable({ ...parcel, motif: res.data.motif });
      } catch (err) {
        error = err.response?.data?.message || 'Erreur lors du retrait.';
        break;
      }
    }
    setSelectedBon(new Set());
    if (error) setFeedback({ type: 'error', text: error });
    setBusy(false);
  }

  const dispoFiltres = useMemo(() => {
    const q = normalize(searchDispo.trim());
    if (!q) return available;
    return available.filter((p) =>
      [p.code, p.ville, p.magasin].some((v) => normalize(v).includes(q))
    );
  }, [available, searchDispo]);

  const bonFiltres = useMemo(() => {
    const q = normalize(searchBon.trim());
    if (!q) return bonParcels;
    return bonParcels.filter((p) =>
      [p.code, p.ville, p.magasin].some((v) => normalize(v).includes(q))
    );
  }, [bonParcels, searchBon]);

  const dispoPager = usePagination(dispoFiltres, 'colis', 'colis');
  const bonPager = usePagination(bonFiltres, 'colis', 'colis');

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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/bons-retour/client')}
          >
            <ArrowLeft size={15} /> Retour aux bons de retour
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/bons-retour/client')}
          >
            <ArrowLeft size={15} /> Retour aux bons de retour
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
            <span className="field-label">Client</span>
            <span className="cell-main">{bon?.store || bon?.client_name || '…'}</span>
            {bon?.store && bon?.client_name && bon.store !== bon.client_name && (
              <span className="cell-sub">{bon.client_name}</span>
            )}
          </div>
          <div className="bon-info">
            <span className="field-label">Statut</span>
            {statut && <span className={`badge ${statut.badge}`}>{statut.label}</span>}
          </div>
        </div>
        {bon && !editable && (
          <div className="form-error">
            {Number(bon.delivered) === 1
              ? 'Ce bon est reçu : la modification des colis est désactivée.'
              : Number(bon.expedited) === 1
                ? 'Ce bon est expédié au client : la modification des colis est désactivée.'
                : 'Tous les colis de ce bon sont reçus par scan : la modification est désactivée.'}
          </div>
        )}
      </section>

      {feedback && (
        <div className={`bon-feedback field-${feedback.type === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </div>
      )}

      {/* Section 2 : colis du client reçus par l'agence, à ajouter au bon. */}
      {editable && (
        <section className="platform-card">
          <h2>
            <PackagePlus size={18} /> Colis reçus par l'agence ({dispoFiltres.length})
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
                  <th>Code de colis</th>
                  <th>Ville</th>
                  <th>Statut avant retour</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {dispoFiltres.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="datatable-empty">
                      Aucun colis « Reçu par l'agence » pour ce client.
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
                        <div className="cell-main mono">
                          {p.code || '—'}
                          {Number(p.replace_flag) === 1 && (
                            <span className="echange-icon" title="Colis échange">
                              <ArrowLeftRight size={14} />
                            </span>
                          )}
                        </div>
                        <div className="cell-sub">{p.magasin || '—'}</div>
                      </td>
                      <td>{p.ville || '—'}</td>
                      <td>{p.motif ? statutLabel(p.motif) : '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => addByIds([p.id])}
                          disabled={busy}
                          title="Ajouter au bon"
                        >
                          <Plus size={14} /> Ajouter
                        </button>
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
                submitScan(scanValue, 'douchette');
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
          <Undo2 size={18} /> Colis du bon ({bonFiltres.length})
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
                        bonPager.pageRows.filter((p) => Number(p.received) !== 1).length > 0 &&
                        bonPager.pageRows
                          .filter((p) => Number(p.received) !== 1)
                          .every((p) => selectedBon.has(p.id))
                      }
                      onChange={() =>
                        togglePage(setSelectedBon, selectedBon, bonPager.pageRows, (p) => Number(p.received) !== 1)
                      }
                      title="Tout cocher / décocher"
                    />
                  </th>
                )}
                <th>Code de colis</th>
                <th>Ville</th>
                <th>Statut avant retour</th>
                <th>Scanner</th>
                {editable && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {bonFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={editable ? 6 : 4} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                bonPager.pageRows.map((p) => (
                  <tr key={p.id}>
                    {editable && (
                      <td className="bon-check-col">
                        {Number(p.received) !== 1 && (
                          <input
                            type="checkbox"
                            checked={selectedBon.has(p.id)}
                            onChange={() => toggleSet(setSelectedBon, p.id)}
                          />
                        )}
                      </td>
                    )}
                    <td>
                      <div className="cell-main mono">
                        {p.code || '—'}
                        {Number(p.replace_flag) === 1 && (
                          <span className="echange-icon" title="Colis échange">
                            <ArrowLeftRight size={14} />
                          </span>
                        )}
                      </div>
                      <div className="cell-sub">{p.magasin || '—'}</div>
                    </td>
                    <td>
                      {p.ville || '—'}
                      {Number(p.received) === 1 && (
                        <div>
                          <span className="badge badge-active">Reçu</span>
                        </div>
                      )}
                    </td>
                    <td>{p.motif ? statutLabel(p.motif) : '—'}</td>
                    <td>
                      <ScanBadge scan={p.scan} />
                    </td>
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm bon-btn-danger"
                          onClick={() => removeParcel(p)}
                          disabled={busy || Number(p.received) === 1}
                          title={
                            Number(p.received) === 1
                              ? 'Colis déjà reçu : retrait impossible'
                              : 'Retirer du bon'
                          }
                        >
                          <Trash2 size={14} /> Supprimer
                        </button>
                      </td>
                    )}
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
