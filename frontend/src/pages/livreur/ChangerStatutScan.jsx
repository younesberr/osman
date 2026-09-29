import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, CheckCircle2, RefreshCw, ScanLine, Search, XCircle } from 'lucide-react';
import api from '../../api/client';
import { createCodeDetector } from '../../utils/codeDetector';
import ColisCard from '../../components/LivreurColisCard';
import { StatutModal, SuiviModal } from '../../components/ParcelModals';
import { statutLabel } from '../../utils/statuts';

/*
 * Changer statut par scan — dashboard livreur (/livreur/changer-statut).
 * En haut, lecteur de code QR / code-barres par la caméra (démarrée à
 * l'arrivée sur la page ; API native BarcodeDetector ou repli ZXing via
 * createCodeDetector) ; en dessous, champ de scan pour douchette (validation
 * par Entrée) ou saisie manuelle. Les deux mènent au même endroit : le colis
 * lu (GET /livreurs/me/colis/code/:code, restreint aux colis du livreur) est
 * affiché en carte — la même que la liste des colis — avec ses actions
 * (appel, WhatsApp, détail suivi, changer statut). Un bip (WebAudio) et une
 * vibration signalent la lecture réussie ou refusée.
 */

/* Même code re-détecté par la caméra : ignoré pendant ce délai (anti-doublon). */
const CAM_COOLDOWN_MS = 4000;

/** true sur PC (souris / douchette) : le focus du champ ne gêne pas la caméra. */
function pointeurFin() {
  return Boolean(window.matchMedia?.('(pointer: fine)').matches);
}

/** Message d'erreur caméra selon la cause (pas de caméra, refus, contexte non sécurisé…). */
function messageErreurCamera(err) {
  const name = err?.name || '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Aucune caméra détectée sur cet appareil : utilisez la douchette ou la saisie ci-dessous.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Accès à la caméra refusé : autorisez la caméra dans le navigateur, puis réessayez.';
  }
  return "Impossible d'accéder à la caméra (connexion non sécurisée ?).";
}

export default function ChangerStatutScan() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // Colis lu (carte) et message du dernier scan / changement de statut.
  const [parcel, setParcel] = useState(null);
  const [feedback, setFeedback] = useState(null); // { ok, message }
  const [camOn, setCamOn] = useState(true);
  const [camKey, setCamKey] = useState(0); // incrémenté pour relancer la caméra après une erreur
  const [camError, setCamError] = useState('');
  // Modale d'action de la carte : { type: 'suivi' | 'statut', parcel }.
  const [modal, setModal] = useState(null);
  const [waTemplate, setWaTemplate] = useState('');

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const modalRef = useRef(false); // modale ouverte : la caméra ne déclenche rien
  const scannedRef = useRef(''); // code dont la carte est affichée (re-lecture ignorée)
  const lastDetectRef = useRef({ code: '', at: 0 });
  const audioCtxRef = useRef(null);

  useEffect(() => {
    modalRef.current = Boolean(modal);
  }, [modal]);

  /* Modèle du message WhatsApp (Configuration > Options) ; défaut local sinon. */
  useEffect(() => {
    api
      .get('/livreurs/me/colis/message')
      .then((res) => setWaTemplate(res.data.template || ''))
      .catch(() => setWaTemplate(''));
  }, []);

  /* Focus du champ à l'arrivée sur PC seulement : sur mobile, le clavier
   * virtuel masquerait la caméra ; le livreur touche le champ s'il en a besoin. */
  useEffect(() => {
    if (pointeurFin()) inputRef.current?.focus();
  }, []);

  /** Bip de validation (deux notes) ou de refus (note grave), généré par WebAudio. */
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

  /** Retour sonore + vibration (téléphone) selon le résultat du scan. */
  function signaler(ok) {
    beep(ok);
    try {
      navigator.vibrate?.(ok ? 80 : [120, 60, 120]);
    } catch {
      /* vibration indisponible */
    }
  }

  /** Recherche le colis du livreur par code : succès → carte, échec → message. */
  async function lookup(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.get(`/livreurs/me/colis/code/${encodeURIComponent(code)}`);
      scannedRef.current = code;
      setParcel(res.data);
      setFeedback(null);
      signaler(true);
    } catch (err) {
      // Nouveau code refusé : on retire la carte précédente pour ne pas agir sur le mauvais colis.
      scannedRef.current = '';
      setParcel(null);
      setFeedback({
        ok: false,
        message: err.response?.data?.message || 'Erreur lors de la recherche du colis, veuillez réessayer.'
      });
      signaler(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setValue('');
      // Sur PC, le champ reprend le focus : la douchette enchaîne les scans.
      if (pointeurFin()) requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    lookup(value);
  }

  /** Code lu par la caméra : anti-doublon puis même traitement que la douchette. */
  function handleDetected(code) {
    if (modalRef.current || busyRef.current) return;
    if (code === scannedRef.current) return; // colis déjà affiché
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    lookup(code);
  }

  // Caméra : flux vidéo arrière + détection QR / code-barres (API native ou repli ZXing).
  useEffect(() => {
    if (!camOn) return undefined;
    let cancelled = false;
    let timer = null;

    async function start() {
      let detector;
      try {
        detector = await createCodeDetector();
      } catch {
        if (!cancelled) setCamError("Le scan par caméra n'est pas disponible sur cet appareil.");
        return;
      }
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('mediaDevices indisponible');
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
      } catch (err) {
        if (!cancelled) setCamError(messageErreurCamera(err));
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
  }, [camOn, camKey]);

  function relancerCamera() {
    setCamError('');
    setCamOn(true);
    setCamKey((k) => k + 1);
  }

  function arreterCamera() {
    setCamError('');
    setCamOn(false);
  }

  /** Statut changé depuis la carte : badge mis à jour + message de confirmation. */
  const onStatutChange = (id, patch) => {
    setParcel((prev) => (prev && prev.parcel_id === id ? { ...prev, ...patch } : prev));
    setFeedback({ ok: true, message: `Statut du colis mis à jour : ${statutLabel(patch.statut)}.` });
  };

  const openSuivi = (p) => setModal({ type: 'suivi', parcel: p });
  const openStatut = (p) => setModal({ type: 'statut', parcel: p });

  const camActive = camOn && !camError;

  return (
    <div className="platform-page lsc-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ScanLine size={18} /> Changer statut par scan
          </h2>
        </div>

        <div className="lsc-body">
          {/* 1. Lecteur de code QR / code-barres par la caméra. */}
          <div className={`lsc-cam ${camActive ? 'is-on' : ''}`}>
            <video ref={videoRef} className="lsc-cam-video" playsInline muted />
            {camActive && (
              <>
                <div className="lsc-cam-viseur" aria-hidden="true" />
                <div className="lsc-cam-hint">Visez le code QR ou le code-barres du colis.</div>
                <button
                  type="button"
                  className="lsc-cam-toggle"
                  onClick={arreterCamera}
                  title="Arrêter la caméra"
                  aria-label="Arrêter la caméra"
                >
                  <CameraOff size={18} />
                </button>
              </>
            )}
            {camOn && camError && (
              <div className="lsc-cam-off">
                <div className="scan-cam-error">{camError}</div>
                <button type="button" className="btn btn-primary" onClick={relancerCamera}>
                  <RefreshCw size={15} /> Réessayer
                </button>
              </div>
            )}
            {!camOn && (
              <div className="lsc-cam-off">
                <Camera size={30} />
                <span>Caméra arrêtée</span>
                <button type="button" className="btn btn-primary" onClick={relancerCamera}>
                  <Camera size={15} /> Activer la caméra
                </button>
              </div>
            )}
          </div>

          {/* 2. Champ de scan : douchette (validation par Entrée) ou saisie manuelle. */}
          <form className="lsc-form" onSubmit={onSubmit}>
            <div className="lsc-input-wrap">
              <ScanLine size={18} className="lsc-input-icon" />
              <input
                ref={inputRef}
                type="text"
                className="scan-input"
                value={value}
                placeholder="Code colis (douchette ou saisie) puis Entrée"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
                readOnly={busy}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
              <Search size={15} /> Rechercher
            </button>
          </form>

          {feedback && (
            <div className={`scan-result lsc-feedback ${feedback.ok ? 'scan-result-ok' : 'scan-result-err'}`}>
              {feedback.ok ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
              <div className="scan-result-msg">{feedback.message}</div>
            </div>
          )}

          {/* 3. Colis lu : même carte que la liste des colis, avec ses actions. */}
          {parcel ? (
            <div className={`lsc-result ${busy ? 'is-loading' : ''}`}>
              <ColisCard parcel={parcel} onSuivi={openSuivi} onStatut={openStatut} waTemplate={waTemplate} />
            </div>
          ) : (
            !feedback && (
              <p className="lsc-vide">
                {busy ? 'Recherche du colis…' : 'Scannez un colis : ses informations s’afficheront ici.'}
              </p>
            )
          )}
        </div>
      </section>

      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} basePath="/livreurs/me/colis" onClose={() => setModal(null)} />
      )}
      {modal?.type === 'statut' && (
        <StatutModal
          parcel={modal.parcel}
          basePath="/livreurs/me/colis"
          onClose={() => setModal(null)}
          onSaved={onStatutChange}
        />
      )}
    </div>
  );
}
