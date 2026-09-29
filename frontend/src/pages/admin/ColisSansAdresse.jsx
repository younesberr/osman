import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Info,
  MapPin,
  MapPinOff,
  MapPinned,
  Pencil,
  Phone,
  RefreshCw,
  Route,
  ScanLine,
  Search,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import { createCodeDetector } from '../../utils/codeDetector';
import {
  ParcelModal,
  SuiviModal,
  InfoModal,
  EditModal,
  StatutModal
} from '../../components/ParcelModals';

/*
 * Sans adresse (/admin/sans-adresse, menu à part sous Bons de distribution,
 * service COLIS_SANS_ADRESSE : case « Colis sans adresse » de Utilisateurs ›
 * Comptes pour le type 2, acquis d'office par les types 3-4 qui ne voient et
 * ne scannent que les colis de leur agence — backend : parcels.routes.js,
 * getAgenceScope) : un colis reçu en agence ou en distribution dont l'adresse
 * n'est pas exploitable est scanné ici (douchette — validation par Entrée —,
 * saisie manuelle ou caméra du téléphone) : il passe en statut second
 * « Attente confirmation » (WAITING_CONFIRMATION), seule voie pour obtenir ce
 * statut (backend : utils/sansAdresse.js). Le scan émet l'événement WhatsApp
 * « Changement de statut » : une règle d'Actions automatiques filtrée sur ce
 * statut prévient le destinataire.
 * Au-dessous, le tableau des colis en attente de confirmation (du plus récent
 * scan au plus ancien), colonnes empilées : magasin sous le code, téléphone
 * sous le destinataire, adresse sous la ville, zone sous le livreur ; actions
 * Autres adresses (colis antérieurs du destinataire retrouvés par téléphone,
 * tous clients : code, ville, adresse, statut, date de livraison — modale
 * AutresAdressesModal ci-dessous) / Détail de suivi / Information colis /
 * Modifier colis (même modale et même verrou facturation que la page Colis) /
 * Appeler (tel:) / Changer statut — le colis sort du tableau dès que son
 * statut change. Recherche + filtre livreur côté frontend, liste complète sans
 * pagination.
 */

/* Même code re-détecté par la caméra : ignoré pendant ce délai (anti-doublon). */
const CAM_COOLDOWN_MS = 4000;

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Lien tel: du destinataire (chiffres et « + » seulement), null sans numéro. */
function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : null;
}

/**
 * Modale « Autres adresses » : colis antérieurs du même destinataire,
 * retrouvés par son numéro de téléphone (tous clients confondus, sans
 * restriction d'agence — GET /parcels/sans-adresse/destinataire, colis courant
 * exclu), du plus récent au plus ancien : code (magasin et date de création
 * dessous), ville, adresse, statut et, pour un colis livré, la date de
 * livraison sous le statut. Aide l'agent à retrouver une adresse exploitable
 * avant d'appeler le destinataire.
 */
function AutresAdressesModal({ parcel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/parcels/sans-adresse/destinataire', {
        params: { phone: parcel.parcel_phone, exclude: parcel.parcel_id }
      })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id, parcel.parcel_phone]);

  return (
    <ParcelModal
      code={parcel.parcel_code}
      subtitle={`Autres adresses — ${parcel.parcel_receiver || 'Destinataire'} · ${parcel.parcel_phone}`}
      onClose={onClose}
      wide
      className="sa-autres-modal"
    >
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <div className="modal-loading">Chargement…</div>}
      {data && (
        <>
          <div className="sa-autres-meta">
            <b>{data.total.toLocaleString('fr-FR')}</b> colis antérieur(s) pour le{' '}
            <span className="mono" dir="ltr">
              {data.phone}
            </span>
            {data.total > data.rows.length && (
              <> — les {data.rows.length} plus récents sont affichés</>
            )}
          </div>
          {data.rows.length === 0 ? (
            <div className="modal-loading">Aucun autre colis pour ce numéro de téléphone.</div>
          ) : (
            <div className="table-wrap sa-autres-table">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Code colis</th>
                    <th>Ville</th>
                    <th>Adresse</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.parcel_id}>
                      <td className="cell-sub">{i + 1}</td>
                      <td>
                        <span className="cell-main mono">{r.parcel_code || '—'}</span>
                        <div className="cell-sub">
                          {r.magasin || '—'} · {formatDate(r.parcel_time)}
                        </div>
                      </td>
                      <td>
                        <span className="rs-ville">
                          <MapPin size={13} /> {r.ville || '—'}
                        </span>
                      </td>
                      <td className="sa-adresse">
                        {String(r.adresse || '').trim() || <i>Aucune adresse</i>}
                      </td>
                      <td>
                        <span
                          className="badge"
                          style={r.statut_color ? { background: r.statut_color } : undefined}
                        >
                          {statutLabel(r.statut)}
                        </span>
                        {r.parcel_status === 'DELIVERED' && (
                          <div className="cell-sub sa-autres-livre">
                            <CheckCircle2 size={12} /> Livré le{' '}
                            {r.livraison_time ? formatDate(r.livraison_time) : '—'}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </ParcelModal>
  );
}

export default function ColisSansAdresse() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [livreur, setLivreur] = useState('');
  // Modale d'action de ligne : { type: 'autres' | 'suivi' | 'info' | 'edit' | 'statut', parcel }.
  const [modal, setModal] = useState(null);

  // Scan : champ, dernier résultat, caméra.
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState('');

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  /** Charge la liste des colis en attente de confirmation. */
  const charger = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/parcels/sans-adresse')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
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
  }, []);

  useEffect(() => charger(), [charger]);

  /** Bip de validation / refus (WebAudio) : retour sonore du scan. */
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

  /** Badge de la sidebar (« Sans adresse ») : recalculé après scan / changement de statut. */
  const rafraichirCompteurs = () => window.dispatchEvent(new Event('ortalog:compteurs'));

  /**
   * Envoie un code au serveur : succès → « Attente confirmation », la ligne du
   * colis rejoint le tableau en tête (sans rechargement) ; sinon refus.
   */
  async function submit(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.post('/parcels/sans-adresse/scan', { code });
      setLast({
        ok: true,
        code: res.data.parcel?.code || code,
        message: res.data.message,
        parcel: res.data.parcel || null,
        time: new Date().toLocaleTimeString('fr-FR')
      });
      if (res.data.row) {
        const row = res.data.row;
        setRows((prev) => [row, ...prev.filter((r) => r.parcel_id !== row.parcel_id)]);
      }
      rafraichirCompteurs();
      beep(true);
    } catch (err) {
      setLast({
        ok: false,
        code,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.',
        parcel: err.response?.data?.parcel || null,
        time: new Date().toLocaleTimeString('fr-FR')
      });
      beep(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setValue('');
      // Re-focus après le re-rendu : l'agent enchaîne les scans sans cliquer.
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

  // Focus du champ au retour du scan caméra (pas à l'arrivée : évite le clavier
  // mobile ; la douchette écrit dans le champ dès le premier clic).
  useEffect(() => {
    if (!camOpen && lastDetectRef.current.at) inputRef.current?.focus();
  }, [camOpen]);

  function openCamera() {
    setCamError('');
    setCamOpen(true);
  }

  /** Livreurs présents dans la liste (options du filtre). */
  const livreurs = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      if (Number(r.parcel_livreur) > 0 && r.livreur) map.set(String(r.parcel_livreur), r.livreur);
    });
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  /** Lignes affichées : filtre livreur + recherche. */
  const filtered = useMemo(() => {
    const q = normalize(searchInput.trim());
    return rows.filter((r) => {
      if (livreur && String(r.parcel_livreur) !== livreur) return false;
      if (!q) return true;
      return normalize(
        [
          r.parcel_code,
          r.magasin,
          r.parcel_receiver,
          r.parcel_phone,
          r.ville,
          r.adresse,
          r.livreur,
          r.zone
        ].join(' ')
      ).includes(q);
    });
  }, [rows, livreur, searchInput]);

  /** Met à jour la ligne modifiée (modale "Modifier colis"). */
  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)));

  /** Après "Changer statut" : le colis n'est plus en attente de confirmation, il sort du tableau. */
  const onStatutSaved = (id) => {
    setRows((prev) => prev.filter((r) => r.parcel_id !== id));
    rafraichirCompteurs();
  };

  return (
    <div className="rs-page">
      <div className="rs-hero rs-hero-2">
        <div className="rs-hero-icon">
          <MapPinOff size={26} />
        </div>
        <div className="rs-hero-body">
          <h1 className="rs-hero-title">Sans adresse</h1>
          <p className="rs-hero-sub">
            Scannez les colis sans adresse exploitable : ils passent en « Attente confirmation »
            jusqu'à la confirmation du destinataire.
          </p>
        </div>
      </div>

      {/* Carte de scan : champ douchette / saisie + scan par caméra. */}
      <section className="platform-card sa-scan-card">
        <div className="scan-hero">
          <span className="scan-hero-icon">
            <ScanLine size={30} />
          </span>
          <h2 className="scan-hero-title">Scanner un colis sans adresse</h2>
          <p className="scan-hero-sub">
            Douchette (validation par Entrée), saisie manuelle ou caméra : le colis passe en
            « Attente confirmation » et rejoint le tableau ci-dessous.
          </p>
          <form className="scan-form" onSubmit={onSubmit}>
            <input
              ref={inputRef}
              type="text"
              className="scan-input"
              value={value}
              placeholder="Code colis…"
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
                <div className="scan-result-sub">{last.time}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, magasin, destinataire, téléphone, ville…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <SearchSelect
          label="Livreur"
          options={livreurs}
          value={livreur}
          onChange={setLivreur}
          allLabel="Tous les livreurs"
        />
        <span className="sa-count">
          <b>{rows.length.toLocaleString('fr-FR')}</b> colis en attente de confirmation
        </span>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Code colis</th>
              <th>Destinataire</th>
              <th>Ville</th>
              <th>Livreur</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} className="datatable-empty">
                  {rows.length === 0
                    ? 'Aucun colis en attente de confirmation — scannez un colis sans adresse ci-dessus.'
                    : 'Aucun colis ne correspond à la recherche.'}
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => {
                const tel = telHref(r.parcel_phone);
                return (
                  <tr key={r.parcel_id} title={`Scanné le ${formatDate(r.parcel_last_update)}`}>
                    <td className="cell-sub">{i + 1}</td>
                    <td>
                      <span className="cell-main mono">{r.parcel_code || '—'}</span>
                      <div className="cell-sub">{r.magasin || '—'}</div>
                    </td>
                    <td>
                      <span className="cell-main">{r.parcel_receiver || '—'}</span>
                      <div className="cell-sub">
                        {tel ? (
                          <a className="sa-phone mono" href={tel} dir="ltr">
                            {r.parcel_phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="rs-ville">
                        <MapPin size={13} /> {r.ville || '—'}
                      </span>
                      <div className="cell-sub sa-adresse">
                        {String(r.adresse || '').trim() || <i>Aucune adresse</i>}
                      </div>
                    </td>
                    <td>
                      <span className="rs-livreur">
                        <span className="rs-avatar">
                          {(r.livreur || '—').trim().charAt(0).toUpperCase()}
                        </span>
                        {r.livreur || '—'}
                      </span>
                      <div className="cell-sub">{r.zone || '—'}</div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title={
                            tel
                              ? 'Autres adresses : colis antérieurs de ce destinataire (recherche par téléphone)'
                              : 'Aucun numéro de téléphone'
                          }
                          disabled={!tel}
                          onClick={() => setModal({ type: 'autres', parcel: r })}
                        >
                          <MapPinned size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Détail de suivi"
                          onClick={() => setModal({ type: 'suivi', parcel: r })}
                        >
                          <Route size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Information colis"
                          onClick={() => setModal({ type: 'info', parcel: r })}
                        >
                          <Info size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Modifier colis"
                          onClick={() => setModal({ type: 'edit', parcel: r })}
                        >
                          <Pencil size={16} />
                        </button>
                        {tel ? (
                          <a
                            className="row-action row-action-tel"
                            href={tel}
                            title={`Appeler le destinataire (${r.parcel_phone})`}
                          >
                            <Phone size={16} />
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="row-action"
                            title="Aucun numéro de téléphone"
                            disabled
                          >
                            <Phone size={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="row-action"
                          title={`Changer statut (actuel : ${statutLabel(r.statut)})`}
                          onClick={() => setModal({ type: 'statut', parcel: r })}
                        >
                          <RefreshCw size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">
          {filtered.length.toLocaleString('fr-FR')} colis affiché(s)
        </span>
      </div>

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
              <div
                className={`scan-result scan-result-compact ${last.ok ? 'scan-result-ok' : 'scan-result-err'}`}
              >
                {last.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div>
                  <div className="scan-result-msg">{last.message}</div>
                </div>
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary scan-cam-close"
              onClick={() => setCamOpen(false)}
            >
              <X size={16} /> Fermer
            </button>
          </div>
        </div>
      )}

      {modal?.type === 'autres' && (
        <AutresAdressesModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'info' && (
        <InfoModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'edit' && (
        <EditModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
      {modal?.type === 'statut' && (
        <StatutModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={onStatutSaved} />
      )}
    </div>
  );
}
