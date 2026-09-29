import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bus,
  Camera,
  CheckCircle2,
  FileText,
  PackagePlus,
  PackageX,
  Plus,
  ScanLine,
  Search,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Page de modification d'un bon de transport (même structure que la page
 * bon d'envoi).
 * Section 1 : informations du bon (référence, trajet, journée, nb de colis).
 * Section 2 : colis non affectés ajoutables — envois / retours sans bon dont
 * la ville de destination est couverte par ce trajet ou par aucun trajet,
 * scannés pendant la journée du bon ou les 7 jours précédents — ajout à
 * l'unité, par sélection, par douchette (Entrée) ou par caméra.
 * Section 3 : colis du bon — retrait à l'unité, par sélection ou par scan
 * (le colis redevient non affecté). Le bon reste modifiable quelle que soit
 * sa journée. Un colis est identifié par le couple (type envoi | retour, id).
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

/** "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function formatJournee(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-');
  return jj ? `${jj}/${mm}/${aaaa}` : '…';
}

/** Plage horaire de la journée : "06:00 → JJ/MM 06:00" (lendemain). */
function formatPlage(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-').map(Number);
  if (!jj) return '';
  const fin = new Date(Date.UTC(aaaa, mm - 1, jj) + 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `06:00 → ${p(fin.getUTCDate())}/${p(fin.getUTCMonth() + 1)} 06:00`;
}

/** Ville en "REF - Nom". */
function villeLabel(ref, nom) {
  if (!ref && !nom) return '—';
  return [ref, nom].filter(Boolean).join(' - ');
}

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Badge du sens du colis (Envoi / Retour). */
function SensBadge({ type }) {
  return (
    <span className={`badge ${type === 'retour' ? 'badge-neutral' : 'badge-mvnt-colis'}`}>
      {type === 'retour' ? 'Retour' : 'Envoi'}
    </span>
  );
}

export default function TransportBonEdit() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [bon, setBon] = useState(null);
  const [bonColis, setBonColis] = useState([]);
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
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get(`/transport/bons/${id}`), api.get(`/transport/bons/${id}/disponibles`)])
      .then(([bonRes, dispoRes]) => {
        if (cancelled) return;
        const { colis, ...info } = bonRes.data;
        setBon(info);
        setBonColis(colis);
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

  /** Bip : 1200 Hz (succès) / 300 Hz (erreur), comme les pages de scan transport. */
  function beep(ok) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = ok ? 'sine' : 'square';
      osc.frequency.value = ok ? 1200 : 300;
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (ok ? 0.15 : 0.4));
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (ok ? 0.15 : 0.4));
    } catch {
      /* audio indisponible : le retour visuel suffit */
    }
  }

  /** Colis ajoutés : passent de la liste des disponibles à celle du bon. */
  function moveToBon(added) {
    const keys = new Set(added.map((c) => c.key));
    setAvailable((prev) => prev.filter((c) => !keys.has(c.key)));
    setBonColis((prev) => [...added, ...prev.filter((c) => !keys.has(c.key))]);
    setSelectedDispo(new Set());
  }

  /** Colis retirés : passent de la liste du bon à celle des disponibles. */
  function moveToAvailable(removed) {
    const keys = new Set(removed.map((c) => c.key));
    setBonColis((prev) => prev.filter((c) => !keys.has(c.key)));
    setAvailable((prev) => [...removed.map((c) => ({ ...c, bon_id: 0 })), ...prev.filter((c) => !keys.has(c.key))]);
    setSelectedBon((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.delete(k));
      return next;
    });
  }

  /** Ajout de colis au bon (bouton ou sélection) : clés → POST /colis. */
  async function addByKeys(keys) {
    const items = available.filter((c) => keys.includes(c.key)).map((c) => ({ type: c.type, id: c.id }));
    if (!items.length || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.post(`/transport/bons/${id}/colis`, { items });
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

  /** Scan (douchette ou caméra) : ajoute au bon le colis scanné (déjà enregistré). */
  async function submitScan(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/transport/bons/${id}/scan`, { code });
      moveToBon([res.data.colis]);
      setLastScan({ ok: true, message: res.data.message });
      beep(true);
    } catch (err) {
      setLastScan({
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      });
      beep(false);
    } finally {
      busyRef.current = false;
      setScanValue('');
      requestAnimationFrame(() => scanInputRef.current?.focus());
    }
  }

  /** Scan de retrait (douchette ou caméra) : retire le colis scanné du bon. */
  async function submitRemoveScan(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/transport/bons/${id}/scan-retrait`, { code });
      moveToAvailable([res.data.colis]);
      setLastRemoveScan({ ok: true, message: res.data.message });
      beep(true);
    } catch (err) {
      setLastRemoveScan({
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      });
      beep(false);
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

  /** Retire un colis du bon (il redevient non affecté). */
  async function removeColis(colis) {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.delete(`/transport/bons/${id}/colis/${colis.type}/${colis.id}`);
      moveToAvailable([colis]);
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait.' });
    } finally {
      setBusy(false);
    }
  }

  /** Retrait par sélection : un appel par colis (chaque retrait est atomique). */
  async function removeSelection() {
    const liste = bonColis.filter((c) => selectedBon.has(c.key));
    if (!liste.length || busy) return;
    setBusy(true);
    setFeedback(null);
    const removed = [];
    let error = '';
    for (const colis of liste) {
      try {
        await api.delete(`/transport/bons/${id}/colis/${colis.type}/${colis.id}`);
        removed.push(colis);
      } catch (err) {
        error = err.response?.data?.message || 'Erreur lors du retrait.';
        break;
      }
    }
    if (removed.length) moveToAvailable(removed);
    setSelectedBon(new Set());
    if (error) setFeedback({ type: 'error', text: error });
    setBusy(false);
  }

  const filtrer = (liste, q) => {
    const terme = normalize(q.trim());
    if (!terme) return liste;
    return liste.filter((c) =>
      [c.code, c.societe_exp, c.ville, c.ville_ref, c.type_label].some((v) => normalize(v).includes(terme))
    );
  };
  const dispoFiltres = useMemo(() => filtrer(available, searchDispo), [available, searchDispo]);
  const bonFiltres = useMemo(() => filtrer(bonColis, searchBon), [bonColis, searchBon]);

  const dispoPager = usePagination(dispoFiltres, 'colis', 'colis');
  const bonPager = usePagination(bonFiltres, 'colis', 'colis');

  function toggleSet(setter, key) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Coche/décoche tous les colis de la page courante. */
  function togglePage(setter, selected, rows) {
    const keys = rows.map((c) => c.key);
    const allChecked = keys.length > 0 && keys.every((k) => selected.has(k));
    setter((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (allChecked ? next.delete(k) : next.add(k)));
      return next;
    });
  }

  if (loadError) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{loadError}</div>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin/transport/bons')}>
            <ArrowLeft size={15} /> Retour aux bons de transport
          </button>
        </section>
      </div>
    );
  }

  /** Colonnes communes des deux tableaux (code / société, sens, ville, date). */
  const renderColisCells = (c) => (
    <>
      <td>
        <div className="cell-main mono transport-code">{c.code || '—'}</div>
        <div className="cell-sub">{c.societe_exp || '—'}</div>
      </td>
      <td>
        <SensBadge type={c.type} />
      </td>
      <td>{villeLabel(c.ville_ref, c.ville)}</td>
      <td>
        <div className="cell-main">{formatDate(c.created_time)}</div>
        <div className="cell-sub">{c.scanne_par || ''}</div>
      </td>
    </>
  );

  return (
    <div className="platform-page bon-edit-page">
      {/* Section 1 : informations du bon. */}
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <FileText size={18} /> Information du bon
          </h2>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin/transport/bons')}>
            <ArrowLeft size={15} /> Retour aux bons de transport
          </button>
        </div>
        <div className={`bon-infos ${loading ? 'is-loading' : ''}`}>
          <div className="bon-info">
            <span className="field-label">Référence</span>
            <span className="cell-main mono">{bon?.ref || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Trajet</span>
            <span className="cell-main">{bon?.trajet || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Journée</span>
            <span className="cell-main">{bon ? formatJournee(bon.journee) : '…'}</span>
            <span className="cell-sub">{bon ? formatPlage(bon.journee) : ''}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Nombre de colis</span>
            <span className="cell-main">{bon ? bonColis.length : '…'}</span>
          </div>
        </div>
      </section>

      {feedback && (
        <div className={`bon-feedback field-${feedback.type === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </div>
      )}

      {/* Section 2 : colis non affectés ajoutables au bon. */}
      <section className="platform-card">
        <h2>
          <PackagePlus size={18} /> Colis non affectés ({dispoFiltres.length})
        </h2>
        <p className="upload-hint">
          Envois et retours sans bon, dont la ville de destination est couverte par ce trajet ou par
          aucun trajet, scannés pendant la journée du bon ou les 7 jours précédents.
        </p>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, société, ville, sens…"
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
                      dispoPager.pageRows.length > 0 && dispoPager.pageRows.every((c) => selectedDispo.has(c.key))
                    }
                    onChange={() => togglePage(setSelectedDispo, selectedDispo, dispoPager.pageRows)}
                    title="Tout cocher / décocher"
                  />
                </th>
                <th>Code / société expéditeur</th>
                <th>Sens</th>
                <th>Ville de destination</th>
                <th>Scanné le</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {dispoFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun colis non affecté à proposer pour ce bon.
                  </td>
                </tr>
              ) : (
                dispoPager.pageRows.map((c) => (
                  <tr key={c.key}>
                    <td className="bon-check-col">
                      <input
                        type="checkbox"
                        checked={selectedDispo.has(c.key)}
                        onChange={() => toggleSet(setSelectedDispo, c.key)}
                      />
                    </td>
                    {renderColisCells(c)}
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => addByKeys([c.key])}
                        disabled={busy}
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
            onClick={() => addByKeys([...selectedDispo])}
            disabled={busy || selectedDispo.size === 0}
          >
            <PackagePlus size={15} /> Ajouter la sélection ({selectedDispo.size})
          </button>
        </div>

        {/* Scan douchette + caméra : ajout direct au bon. */}
        <div className="bon-scan-zone">
          <div className="bon-scan-title">
            <ScanLine size={17} /> Scanner un colis à ajouter
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
              placeholder="Code ticket déjà enregistré (douchette, validation par Entrée)…"
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

      {/* Section 3 : colis du bon. */}
      <section className="platform-card">
        <h2>
          <Bus size={18} /> Colis du bon ({bonFiltres.length})
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, société, ville, sens…"
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
                <th className="bon-check-col">
                  <input
                    type="checkbox"
                    checked={bonPager.pageRows.length > 0 && bonPager.pageRows.every((c) => selectedBon.has(c.key))}
                    onChange={() => togglePage(setSelectedBon, selectedBon, bonPager.pageRows)}
                    title="Tout cocher / décocher"
                  />
                </th>
                <th>Code / société expéditeur</th>
                <th>Sens</th>
                <th>Ville de destination</th>
                <th>Scanné le</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bonFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                bonPager.pageRows.map((c) => (
                  <tr key={c.key}>
                    <td className="bon-check-col">
                      <input
                        type="checkbox"
                        checked={selectedBon.has(c.key)}
                        onChange={() => toggleSet(setSelectedBon, c.key)}
                      />
                    </td>
                    {renderColisCells(c)}
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm bon-btn-danger"
                        onClick={() => removeColis(c)}
                        disabled={busy}
                        title="Retirer du bon (le colis redevient non affecté)"
                      >
                        <Trash2 size={14} /> Retirer
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={bonPager} />

        <div className="bon-bulk-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={removeSelection}
            disabled={busy || selectedBon.size === 0}
          >
            <PackageX size={15} /> Retirer la sélection ({selectedBon.size})
          </button>
        </div>

        {/* Scan douchette + caméra : retrait direct du bon. */}
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
              placeholder="Code ticket à retirer (douchette, validation par Entrée)…"
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
