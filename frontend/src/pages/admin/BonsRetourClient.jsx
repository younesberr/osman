import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftRight,
  Camera,
  CheckCircle2,
  FileDown,
  List,
  Pencil,
  Plus,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
  Trash2,
  Truck,
  Undo2,
  UserRoundPlus,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { statutLabel } from '../../utils/statuts';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bons de retour client — même structure que les bons de retour livreur
 * (BonsRetourLivreur.jsx) : un bon regroupe les colis d'un client reçus par
 * l'agence (via un bon de retour livreur « Reçu ») à lui rendre.
 *
 * Cycle d'un bon : Nouveau → Expédié (modale « Expédier au client » : choix
 * du ramasseur + scan du ticket ; colis → « Retourné au client ») → Reçu
 * (« Marquer comme retourné » par le ramasseur : non vérifié ; ou « Bon bien
 * reçu » par un admin : aussi vérifié) → Vérifié (action « Vérifier » ou
 * modale « Vérifier par scan » — un bon expédié vérifié est aussi marqué
 * reçu). L'ajout d'un colis au bon ne change plus son statut : c'est
 * l'expédition qui bascule les colis.
 *
 * Depuis le tableau : détail, modifier (masqué si expédié / reçu ou si tous
 * les colis sont reçus par scan), réaffecter (bon expédié pas encore reçu :
 * seul le ramasseur change), bon reçu / non reçu, vérifier, réception par
 * scan (douchette ou caméra, colis par colis), ticket 100 × 100
 * (utils/bonRetourClientTicket), export PDF (utils/bonRetourClientPdf),
 * suppression (bon vide uniquement). Filtres : client, affecté à
 * (ramasseur), statut, période.
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

/** Statut affiché d'un bon : Vérifié, Reçu (non vérifié), Expédié ou Nouveau. */
function bonStatut(bon) {
  if (Number(bon.verified) === 1) return { label: 'Vérifié', badge: 'badge-active' };
  if (Number(bon.delivered) === 1) return { label: 'Reçu (non vérifié)', badge: 'badge-non-verifie' };
  if (Number(bon.expedited) === 1) return { label: 'Expédié', badge: 'badge-ram-recue' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Libellé d'un client : magasin (+ nom si différent). */
function clientLabel(client) {
  const store = client.store || '';
  const nom = client.nom || '';
  if (store && nom && store !== nom) return `${store} — ${nom}`;
  return store || nom || '—';
}

/** Filtres appliqués par défaut : bons « Nouveau » des 30 derniers jours. */
function defaultFilters() {
  return { client: '', ramasseur: '', status: 'new', range: defaultRange() };
}

/**
 * Modale « Réaffecter le bon » : bon expédié pas encore reçu — choix d'un
 * autre ramasseur (type 6), rien d'autre ne change (expédition et colis
 * conservés). La liste est rechargée ensuite (filtre « Affecté à »).
 */
function AffecterRamasseurModal({ bon, ramasseurs, onClose, onRefresh }) {
  const [userId, setUserId] = useState(bon.affected_to ? String(bon.affected_to) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inchange = userId && String(userId) === String(bon.affected_to || '');

  async function affecter(e) {
    e.preventDefault();
    setError('');
    if (!userId) {
      setError('Veuillez sélectionner un ramasseur.');
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/bons-retour-client/${bon.id}/affecter`, { userId: Number(userId) });
      onRefresh();
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
              <div className="cell-main">Réaffecter le bon {bon.ref}</div>
              <div className="cell-sub">
                {bon.ramasseur_nom
                  ? `Actuellement affecté à ${bon.ramasseur_nom}`
                  : 'Aucun ramasseur affecté'}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={affecter}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Nouveau ramasseur</span>
              <SearchableSelect
                value={userId}
                onChange={(v) => setUserId(String(v))}
                placeholder="— Sélectionner un ramasseur —"
                options={ramasseurs.map((r) => ({ value: String(r.id), label: r.nom }))}
              />
            </div>
          </div>
          <p className="upload-hint">
            Seul le ramasseur change : l'expédition et les colis du bon restent en l'état.
          </p>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !userId || inchange}>
              <UserRoundPlus size={15} /> {busy ? 'Affectation…' : 'Réaffecter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Créer un bon de retour » : clients ayant des colis retournables. */
function CreateBonModal({ clients, onClose }) {
  const navigate = useNavigate();
  const withRetournable = clients.filter((c) => Number(c.retournable) > 0);
  const [client, setClient] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!client) {
      setError('Veuillez sélectionner un client.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/bons-retour-client', { client: Number(client) });
      navigate(`/admin/bons-retour/client/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création du bon.');
      setCreating(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Undo2 size={18} />
            <div className="cell-main">Créer un bon de retour</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={create}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Client</span>
              <SearchableSelect
                value={client}
                onChange={(v) => setClient(String(v))}
                placeholder="— Sélectionner un client —"
                options={withRetournable.map((c) => ({
                  value: c.id,
                  label: `${clientLabel(c)} (${c.retournable} colis)`
                }))}
              />
            </div>
          </div>
          {withRetournable.length === 0 && (
            <div className="field-error">
              Aucun client n'a de colis « Reçu par l'agence » retournable.
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !client}>
              <Plus size={15} /> {creating ? 'Création…' : 'Créer le bon'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modale « Détail du bon » : colis du bon (code / magasin, date de réception,
 * ville / adresse, motif de retour — statut du colis avant le circuit retour).
 */
function DetailBonModal({ bon, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/bons-retour-client/${bon.id}`)
      .then((res) => setParcels(res.data.parcels))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail du bon {bon.ref}</div>
              <div className="cell-sub">
                {bon.store || bon.client_name || '—'} — {parcels.length} colis
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code colis</th>
                <th>Date de réception</th>
                <th>Ville</th>
                <th>Statut avant retour</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                parcels.map((p) => (
                  <tr key={p.id}>
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
                    <td>{Number(p.received) === 1 ? formatDate(p.received_time) : '—'}</td>
                    <td>
                      <div className="cell-main">{p.ville || '—'}</div>
                      <div className="cell-sub">{p.adresse || '—'}</div>
                    </td>
                    <td>{p.motif ? statutLabel(p.motif) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * Modale « Réception par scan » : scan douchette (validation Entrée) ou caméra
 * d'un code colis — le colis doit être sur le bon, il passe en « Reçu par le
 * client ». La liste des colis du bon montre la progression.
 */
function ScanReceptionModal({ bon, onClose, onChanged }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState('');

  const scanInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const sonsRef = useRef({ success: null, error: null });
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  const recus = parcels.filter((p) => Number(p.received) === 1).length;

  useEffect(() => {
    api
      .get(`/bons-retour-client/${bon.id}`)
      .then((res) => setParcels(res.data.parcels))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => {
        setLoading(false);
        requestAnimationFrame(() => scanInputRef.current?.focus());
      });
  }, [bon.id]);

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

  /** Scan (douchette ou caméra) : passe le colis scanné en « Reçu par le client ». */
  async function submitScan(rawCode, mode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-retour-client/${bon.id}/scan-reception`, {
        code,
        scan: mode
      });
      const parcel = res.data.parcel;
      setParcels((prev) =>
        prev.map((p) =>
          p.id === parcel.id ? { ...p, received: 1, received_time: parcel.received_time } : p
        )
      );
      onChanged(bon.id, { nb_recus: res.data.recus });
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

  /** Code lu par la caméra : anti-doublon puis réception. */
  function handleDetected(code) {
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    submitScan(code, 'camera');
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ScanLine size={18} />
            <div>
              <div className="cell-main">Réception par scan — {bon.ref}</div>
              <div className="cell-sub">
                {bon.store || bon.client_name || '—'} — {recus}/{parcels.length} colis reçu
                {recus > 1 ? 's' : ''}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="bon-scan-zone">
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
            <button type="button" className="btn btn-ghost" onClick={() => { setCamError(''); setCamOpen(true); }}>
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

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code colis</th>
                <th>Ville</th>
                <th>Réception</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={3} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                parcels.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-main mono">{p.code || '—'}</div>
                      <div className="cell-sub">{p.magasin || '—'}</div>
                    </td>
                    <td>{p.ville || '—'}</td>
                    <td>
                      {Number(p.received) === 1 ? (
                        <span className="badge badge-active">Reçu</span>
                      ) : (
                        <span className="badge badge-attente">En attente</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Overlay du scan par caméra (téléphone mobile). */}
      {camOpen && (
        <div
          className="scan-cam-overlay"
          role="dialog"
          aria-label="Scanner par caméra"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="scan-cam-box">
            <video ref={videoRef} className="scan-cam-video" playsInline muted />
            {camError ? (
              <div className="scan-cam-error">{camError}</div>
            ) : (
              <div className="scan-cam-hint">Visez le code du colis à réceptionner.</div>
            )}
            {lastScan && (
              <div className={`scan-result scan-result-compact ${lastScan.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
                {lastScan.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div className="scan-result-msg">{lastScan.message}</div>
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

/**
 * Zone de scan réutilisable (douchette + caméra) des modales « Expédier au
 * client » et « Vérifier par scan » : saisie douchette (validation Entrée),
 * overlay caméra (détecteur partagé, anti-doublon) et retour sonore (sons de
 * l'étape retour, bip WebAudio en secours). `onScan(code, mode)` fait l'appel
 * API et renvoie { ok, message } pour l'affichage et le son.
 */
function ScanZone({ onScan, disabled, placeholder, camHint }) {
  const [scanValue, setScanValue] = useState('');
  const [lastScan, setLastScan] = useState(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState('');

  const scanInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const sonsRef = useRef({ success: null, error: null });
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  // Miroirs des props : les scans caméra tournent dans une closure figée
  // (effet dépendant de camOpen seulement) — les refs restent à jour (ex.
  // changement de ramasseur pendant que la caméra est ouverte).
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Sons de l'étape retour configurés dans Configuration > Options.
  useEffect(() => {
    api
      .get('/bons-retour-client/sons')
      .then((res) => {
        sonsRef.current = { success: res.data.success || null, error: res.data.error || null };
      })
      .catch(() => {});
    requestAnimationFrame(() => scanInputRef.current?.focus());
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

  async function submitScan(rawCode, mode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current || disabledRef.current) return;
    busyRef.current = true;
    try {
      const result = await onScanRef.current(code, mode);
      setLastScan(result);
      playFeedback(result.ok);
    } finally {
      busyRef.current = false;
      setScanValue('');
      requestAnimationFrame(() => scanInputRef.current?.focus());
    }
  }

  /** Code lu par la caméra : anti-doublon puis soumission. */
  function handleDetected(code) {
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    submitScan(code, 'camera');
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
          // Overlay fermé pendant le detect() : ne pas soumettre une lecture
          // en vol (un scan d'expédition partirait après l'annulation).
          if (cancelled) return;
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

  return (
    <div className="bon-scan-zone">
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
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          disabled={disabled}
          onChange={(e) => setScanValue(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          onClick={() => {
            setCamError('');
            setCamOpen(true);
          }}
        >
          <Camera size={16} /> Scanner par caméra
        </button>
      </form>
      {lastScan && (
        <div className={`scan-result scan-result-compact ${lastScan.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
          {lastScan.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div className="scan-result-msg">{lastScan.message}</div>
        </div>
      )}

      {/* Overlay du scan par caméra (téléphone mobile). */}
      {camOpen && (
        <div
          className="scan-cam-overlay"
          role="dialog"
          aria-label="Scanner par caméra"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="scan-cam-box">
            <video ref={videoRef} className="scan-cam-video" playsInline muted />
            {camError ? (
              <div className="scan-cam-error">{camError}</div>
            ) : (
              <div className="scan-cam-hint">{camHint}</div>
            )}
            {lastScan && (
              <div className={`scan-result scan-result-compact ${lastScan.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
                {lastScan.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div className="scan-result-msg">{lastScan.message}</div>
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

/**
 * Modale « Expédier au client » : choix du ramasseur (type 6) puis scans
 * enchaînés des tickets de bons — chaque bon scanné passe en « Expédié »,
 * est affecté au ramasseur et ses colis basculent en « Retourné au client ».
 */
function ExpeditionModal({ onClose, onRefresh }) {
  const [ramasseurs, setRamasseurs] = useState([]);
  const [userId, setUserId] = useState('');
  const [scanned, setScanned] = useState([]);

  useEffect(() => {
    api
      .get('/bons-retour-client/ramasseurs')
      .then((res) => setRamasseurs(res.data))
      .catch(() => {});
  }, []);

  async function handleScan(code, mode) {
    try {
      const res = await api.post('/bons-retour-client/expedition/scan', {
        code,
        userId: Number(userId),
        scan: mode
      });
      setScanned((prev) => [res.data.bon, ...prev]);
      onRefresh();
      return { ok: true, message: res.data.message };
    } catch (err) {
      return {
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      };
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Truck size={18} />
            <div>
              <div className="cell-main">Expédier au client</div>
              <div className="cell-sub">
                Sélectionnez le ramasseur puis scannez les tickets des bons.
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="modal-form-full">
            <span className="field-label">Ramasseur</span>
            <SearchableSelect
              value={userId}
              onChange={(v) => setUserId(String(v))}
              placeholder="— Sélectionner un ramasseur —"
              options={ramasseurs.map((r) => ({ value: String(r.id), label: r.nom }))}
            />
          </div>
        </div>

        <ScanZone
          onScan={handleScan}
          disabled={!userId}
          placeholder={
            userId
              ? 'Référence du bon (douchette, validation par Entrée)…'
              : "Sélectionnez d'abord un ramasseur…"
          }
          camHint="Visez le QR du ticket du bon à expédier."
        />

        {scanned.length > 0 && (
          <div className="table-wrap datatable">
            <table>
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Client</th>
                  <th>Colis</th>
                </tr>
              </thead>
              <tbody>
                {scanned.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="cell-main mono">{b.ref}</div>
                    </td>
                    <td>
                      <div className="cell-main">{b.store || '—'}</div>
                      <div className="cell-sub">{b.client_name || '—'}</div>
                    </td>
                    <td>{b.nb_colis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Modale « Vérifier par scan » : scans enchaînés des tickets de bons — un bon
 * « Expédié » ou « Reçu (non vérifié) » passe en « Vérifié » (un bon
 * seulement expédié est aussi marqué reçu).
 */
function VerificationScanModal({ onClose, onRefresh }) {
  const [scanned, setScanned] = useState([]);

  async function handleScan(code, mode) {
    try {
      const res = await api.post('/bons-retour-client/verification/scan', { code, scan: mode });
      setScanned((prev) => [res.data.bon, ...prev]);
      onRefresh();
      return { ok: true, message: res.data.message };
    } catch (err) {
      return {
        ok: false,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.'
      };
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ShieldCheck size={18} />
            <div>
              <div className="cell-main">Vérifier par scan</div>
              <div className="cell-sub">
                Scannez les tickets des bons expédiés ou retournés à vérifier.
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <ScanZone
          onScan={handleScan}
          placeholder="Référence du bon (douchette, validation par Entrée)…"
          camHint="Visez le QR du ticket du bon à vérifier."
        />

        {scanned.length > 0 && (
          <div className="table-wrap datatable">
            <table>
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Client</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {scanned.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="cell-main mono">{b.ref}</div>
                    </td>
                    <td>
                      <div className="cell-main">{b.store || '—'}</div>
                      <div className="cell-sub">{b.client_name || '—'}</div>
                    </td>
                    <td>
                      <span className="badge badge-active">Vérifié</span>
                      {b.marked_received && <div className="cell-sub">également marqué reçu</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ligne du tableau des bons : statut + actions. */
function BonRow({ bon, onDetail, onScan, onAffecter, onRefresh, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const statut = bonStatut(bon);
  const recu = Number(bon.delivered) === 1;
  const expedie = Number(bon.expedited) === 1;
  const verifie = Number(bon.verified) === 1;
  const nbColis = Number(bon.nb_colis) || 0;
  const nbRecus = Number(bon.nb_recus) || 0;
  // « Modifier » masqué si le bon est expédié ou reçu, ou si tous ses colis
  // sont déjà reçus par scan.
  const modifiable = !recu && !expedie && !(nbColis > 0 && nbRecus >= nbColis);

  async function toggleReceived() {
    const question = recu
      ? `Passer le bon « ${bon.ref} » en NON reçu ? La vérification sera annulée et ses colis reviendront à leur état d'avant réception (réceptions par scan comprises). Les colis de stock déjà « Retourné au stock » ne changent pas.`
      : `Confirmer la réception du bon « ${bon.ref} » ? Il sera aussi marqué vérifié et ses colis passeront en « Reçu par le client » (colis de stock : « Retourné au stock », produits réintégrés au stock).`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await api.patch(`/bons-retour-client/${bon.id}/receive`, { received: recu ? 0 : 1 });
      // Rechargement complet : met à jour date / reçu par / compteurs.
      onRefresh();
      const avertissements = res.data?.avertissements || [];
      if (avertissements.length) alert(avertissements.join('\n'));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

  /** Action « Vérifier » (bon expédié ou reçu non vérifié). */
  async function verifier() {
    const question = recu
      ? `Marquer le bon « ${bon.ref} » comme vérifié ?`
      : `Vérifier le bon « ${bon.ref} » ? Il sera aussi marqué reçu et ses colis passeront en « Reçu par le client » (colis de stock : « Retourné au stock », produits réintégrés au stock).`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await api.patch(`/bons-retour-client/${bon.id}/verifier`);
      onRefresh();
      const avertissements = res.data?.avertissements || [];
      if (avertissements.length) alert(avertissements.join('\n'));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la vérification.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Imprime le ticket 100 × 100 du bon (référence + QR / Code128, client,
   * nombre de colis) : génération via utils/bonRetourClientTicket puis
   * ouverture dans un nouvel onglet (ouvert pendant le clic).
   */
  async function downloadTicket() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du ticket…');
    setPdfBusy(true);
    try {
      const bonRes = await api.get(`/bons-retour-client/${bon.id}`);
      const { genererTicketBonRetourClient } = await import('../../utils/bonRetourClientTicket');
      const url = await genererTicketBonRetourClient({ bon: bonRes.data });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération du ticket.');
    } finally {
      setPdfBusy(false);
    }
  }

  /**
   * Télécharge le bon en PDF : détail du bon + informations société,
   * génération via utils/bonRetourClientPdf puis ouverture dans un nouvel
   * onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`/bons-retour-client/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonRetourClientPdf } = await import('../../utils/bonRetourClientPdf');
      const url = await genererBonRetourClientPdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        bon: bonRes.data,
        parcels: bonRes.data.parcels,
        societe: societeRes.data
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération du PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Supprimer le bon « ${bon.ref} » ?`)) return;
    setBusy(true);
    try {
      await api.delete(`/bons-retour-client/${bon.id}`);
      onDeleted(bon.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main mono">{bon.ref || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{bon.store || '—'}</div>
        <div className="cell-sub">{bon.client_name || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{formatDate(bon.time)}</div>
        <div className="cell-sub">{bon.created_by || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{recu ? formatDate(bon.received_time) : '—'}</div>
        <div className="cell-sub">{recu ? bon.received_by || '—' : '—'}</div>
      </td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
        {expedie && bon.ramasseur_nom && <div className="cell-sub">{bon.ramasseur_nom}</div>}
      </td>
      <td>
        <div className="cell-main">{nbColis}</div>
        {!recu && nbRecus > 0 && (
          <div className="cell-sub">
            {nbRecus} reçu{nbRecus > 1 ? 's' : ''} par scan
          </div>
        )}
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Détail du bon" onClick={() => onDetail(bon)}>
            <List size={16} />
          </button>
          {modifiable && (
            <button
              type="button"
              className="row-action"
              title="Modifier le bon"
              onClick={() => navigate(`/admin/bons-retour/client/${bon.id}`)}
            >
              <Pencil size={16} />
            </button>
          )}
          {expedie && !recu && (
            <button
              type="button"
              className="row-action"
              title="Réaffecter à un autre ramasseur"
              onClick={() => onAffecter(bon)}
              disabled={busy}
            >
              <UserRoundPlus size={16} />
            </button>
          )}
          <button
            type="button"
            className={`row-action ${recu ? '' : 'row-action-success'}`}
            title={recu ? 'Bon non reçu' : 'Bon bien reçu'}
            onClick={toggleReceived}
            disabled={busy}
          >
            {recu ? <Undo2 size={16} /> : <CheckCircle2 size={16} />}
          </button>
          {((expedie && !recu) || (recu && !verifie)) && (
            <button
              type="button"
              className="row-action row-action-success"
              title="Vérifier le bon"
              onClick={verifier}
              disabled={busy}
            >
              <ShieldCheck size={16} />
            </button>
          )}
          {nbColis > 0 && (
            <button
              type="button"
              className="row-action"
              title="Réception par scan"
              onClick={() => onScan(bon)}
            >
              <ScanLine size={16} />
            </button>
          )}
          {nbColis > 0 && (
            <button
              type="button"
              className="row-action"
              title="Imprimer le ticket"
              onClick={downloadTicket}
              disabled={pdfBusy}
            >
              <Ticket size={16} />
            </button>
          )}
          {nbColis > 0 && (
            <button
              type="button"
              className="row-action"
              title="Télécharger en PDF"
              onClick={downloadPdf}
              disabled={pdfBusy}
            >
              <FileDown size={16} />
            </button>
          )}
          {nbColis === 0 && (
            <button
              type="button"
              className="row-action row-action-danger"
              title="Supprimer le bon"
              onClick={remove}
              disabled={busy}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Bons de retour client — page principale : création, filtres et tableau. */
export default function BonsRetourClient() {
  const [bons, setBons] = useState([]);
  const [clients, setClients] = useState([]);
  const [ramasseurs, setRamasseurs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [expedierOpen, setExpedierOpen] = useState(false);
  const [verifierOpen, setVerifierOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [scanBon, setScanBon] = useState(null);
  const [affecter, setAffecter] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    api.get('/bons-retour-client/clients').then((res) => setClients(res.data)).catch(() => {});
    // Ramasseurs actifs (filtre « Affecté à » + modale de réaffectation).
    api.get('/bons-retour-client/ramasseurs').then((res) => setRamasseurs(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/bons-retour-client', {
        params: {
          client: applied.client,
          ramasseur: applied.ramasseur,
          status: applied.status,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setBons(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des bons.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  function handleChanged(id, patch) {
    setBons((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function handleDeleted(id) {
    setBons((prev) => prev.filter((b) => b.id !== id));
  }

  /** Recharge la liste avec les filtres appliqués (après reçu / non reçu). */
  function handleRefresh() {
    setApplied((prev) => ({ ...prev }));
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Undo2 size={18} /> Bons de retour client
          </h2>
          <div className="bons-head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Créer un bon de retour
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setExpedierOpen(true)}>
              <Truck size={15} /> Expédier au client
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setVerifierOpen(true)}>
              <ShieldCheck size={15} /> Vérifier par scan
            </button>
          </div>
        </div>

        <div className="filters-bar">
          <SearchSelect
            label="Client"
            options={clients.map((c) => ({ value: c.id, label: clientLabel(c) }))}
            value={draft.client}
            onChange={setDraftField('client')}
            allLabel="Tous"
          />
          <SearchSelect
            label="Affecté à"
            options={ramasseurs.map((r) => ({ value: r.id, label: r.nom }))}
            value={draft.ramasseur}
            onChange={setDraftField('ramasseur')}
            allLabel="Tous"
          />
          <select
            className="datatable-select"
            value={draft.status}
            onChange={(e) => setDraftField('status')(e.target.value)}
            title="Statut du bon"
          >
            <option value="new">Nouveau</option>
            <option value="expedited">Expédié</option>
            <option value="received_unverified">Reçu (non vérifié)</option>
            <option value="verified">Vérifié</option>
            <option value="">Tous les statuts</option>
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

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Référence</th>
                <th>Client</th>
                <th>Date de création</th>
                <th>Date de réception</th>
                <th>Statut</th>
                <th>Colis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun bon de retour trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((bon) => (
                  <BonRow
                    key={bon.id}
                    bon={bon}
                    onDetail={setDetail}
                    onScan={setScanBon}
                    onAffecter={setAffecter}
                    onRefresh={handleRefresh}
                    onDeleted={handleDeleted}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {createOpen && <CreateBonModal clients={clients} onClose={() => setCreateOpen(false)} />}
      {expedierOpen && (
        <ExpeditionModal onClose={() => setExpedierOpen(false)} onRefresh={handleRefresh} />
      )}
      {verifierOpen && (
        <VerificationScanModal onClose={() => setVerifierOpen(false)} onRefresh={handleRefresh} />
      )}
      {detail && <DetailBonModal bon={detail} onClose={() => setDetail(null)} />}
      {affecter && (
        <AffecterRamasseurModal
          bon={affecter}
          ramasseurs={ramasseurs}
          onClose={() => setAffecter(null)}
          onRefresh={handleRefresh}
        />
      )}
      {scanBon && (
        <ScanReceptionModal
          bon={scanBon}
          onClose={() => setScanBon(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}
