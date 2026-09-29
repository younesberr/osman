import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, ScanLine, X, XCircle } from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';

/*
 * Ramassage par scan : chaque code scanné (douchette USB — validation par
 * Entrée — ou caméra du téléphone) passe le colis en PICKED_UP côté serveur.
 * Un son de validation ou de refus (configurable dans Configuration > Options)
 * est joué à chaque scan ; à défaut, un bip généré par le navigateur.
 */

/* Même code re-détecté par la caméra : ignoré pendant ce délai (anti-doublon). */
const CAM_COOLDOWN_MS = 4000;

export default function RamassageScan() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState('');

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const sonsRef = useRef({ success: null, error: null });
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  // Sons configurés dans Configuration > Options (le plus récent de chaque type).
  useEffect(() => {
    api
      .get('/parcels/ramassage/sons')
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

  function pushResult(entry) {
    setLast({ ...entry, time: new Date().toLocaleTimeString('fr-FR') });
  }

  /** Envoie un code au serveur : succès → PICKED_UP + son de validation, sinon refus. */
  async function submit(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.post('/parcels/ramassage/scan', { code });
      pushResult({ ok: true, code: res.data.parcel.code, message: res.data.message, parcel: res.data.parcel });
      playFeedback(true);
    } catch (err) {
      pushResult({
        ok: false,
        code,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.',
        parcel: err.response?.data?.parcel || null,
        // Étiquette obsolète (prix modifié après impression) : { printed, current }.
        stale: err.response?.data?.stale || null
      });
      playFeedback(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setValue('');
      // Re-focus après le re-rendu : l'utilisateur enchaîne les scans sans cliquer.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    submit(value);
  }

  /** Code lu par la caméra : anti-doublon puis même traitement que la douchette. */
  function handleDetected(code) {
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    submit(code);
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

  // Focus du champ à l'arrivée sur la page et au retour du scan caméra.
  useEffect(() => {
    if (!camOpen) inputRef.current?.focus();
  }, [camOpen]);

  function openCamera() {
    setCamError('');
    setCamOpen(true);
  }

  return (
    <div className="scan-page">
      {/* Section pleine largeur : champ de scan centré + scan par caméra. */}
      <section className="platform-card scan-card">
        <div className="scan-hero">
          <span className="scan-hero-icon">
            <ScanLine size={30} />
          </span>
          <h2 className="scan-hero-title">Scanner un colis</h2>
          <p className="scan-hero-sub">
            Scannez le code du colis avec la douchette (validation par Entrée) ou saisissez-le manuellement.
          </p>
          <form className="scan-form" onSubmit={onSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="scan-input"
              value={value}
              placeholder="Code colis…"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              readOnly={busy}
              onChange={(e) => setValue(e.target.value)}
            />
          </form>
          <button type="button" className="btn btn-ghost scan-cam-btn" onClick={openCamera}>
            <Camera size={17} /> Scanner par caméra
          </button>

          {last && (
            <div className={`scan-result ${last.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
              {last.ok ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
              <div>
                <div className="scan-result-msg">{last.message}</div>
                {last.parcel && (
                  <div className="scan-result-sub">
                    {[last.parcel.magasin, last.parcel.receiver, last.parcel.ville]
                      .filter(Boolean)
                      .join(' — ')}
                  </div>
                )}
                {last.stale && (
                  <div className="scan-result-stale">
                    Ancien prix : {last.stale.printed} DH → Nouveau prix : {last.stale.current} DH
                    — réimprimez l'étiquette.
                  </div>
                )}
              </div>
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
              <div className="scan-cam-hint">Visez le code QR ou le code-barres du colis.</div>
            )}
            {last && (
              <div className={`scan-result scan-result-compact ${last.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
                {last.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div>
                  <div className="scan-result-msg">{last.message}</div>
                  {last.stale && (
                    <div className="scan-result-stale">
                      {last.stale.printed} DH → {last.stale.current} DH — réimprimez l'étiquette.
                    </div>
                  )}
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
