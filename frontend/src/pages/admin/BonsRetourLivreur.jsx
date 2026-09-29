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
  SlidersHorizontal,
  Trash2,
  Undo2,
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
 * Bons de retour livreur — un bon regroupe les colis « En cours » d'un livreur
 * à retourner vers l'agence principale. Création via la modale (livreurs ayant
 * des colis retournables), puis gestion depuis le tableau : détail, modifier
 * (masqué si reçu ou si tous les colis sont reçus par scan), bon reçu / non
 * reçu, réception par scan (douchette ou caméra, colis par colis), export PDF
 * (utils/bonRetourLivreurPdf), suppression (bon vide uniquement).
 *
 * Mode « self » (dashboard livreur, page /livreur/bon-retour) : mêmes tableau
 * et actions mais limités aux bons du livreur connecté (endpoints
 * /bons-retour-livreur/livreur), création directe (pas de choix du livreur),
 * sans colonne ni filtre livreur. La réception (bon reçu / non reçu, scan de
 * réception) reste réservée à l'admin : boutons masqués.
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
  if (Number(bon.delivered) === 1) return { label: 'Reçu', badge: 'badge-active' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Filtres appliqués par défaut : bons « Nouveau » des 30 derniers jours. */
function defaultFilters() {
  return { livreur: '', status: 'new', range: defaultRange() };
}

/** Modale « Créer un bon de retour » : livreurs ayant des colis retournables. */
function CreateBonModal({ livreurs, onClose }) {
  const navigate = useNavigate();
  const withRetournable = livreurs.filter((l) => Number(l.retournable) > 0);
  const [livreur, setLivreur] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!livreur) {
      setError('Veuillez sélectionner un livreur.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/bons-retour-livreur', { livreur: Number(livreur) });
      navigate(`/admin/bons-retour/livreur/${res.data.id}`);
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
              <span className="field-label">Livreur</span>
              <SearchableSelect
                value={livreur}
                onChange={(v) => setLivreur(String(v))}
                placeholder="— Sélectionner un livreur —"
                options={withRetournable.map((l) => ({
                  value: l.id,
                  label: `${l.nom}${l.zone ? ` — ${l.zone}` : ''} (${l.retournable} colis)`
                }))}
              />
            </div>
          </div>
          {withRetournable.length === 0 && (
            <div className="field-error">Aucun livreur n'a de colis « En cours » retournable.</div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !livreur}>
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
 * ville / adresse, statut du colis avant son ajout au bon de retour).
 */
function DetailBonModal({ bon, base, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`${base}/${bon.id}`)
      .then((res) => setParcels(res.data.parcels))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id, base]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail du bon {bon.ref}</div>
              <div className="cell-sub">
                {bon.livreur_name || '—'} — {parcels.length} colis
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
                <th>Statut</th>
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
                    <td>{p.statut_avant ? statutLabel(p.statut_avant) : 'En cours'}</td>
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
 * d'un code colis — le colis doit être sur le bon, il passe en « Reçu par
 * l'agence ». La liste des colis du bon montre la progression.
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
      .get(`/bons-retour-livreur/${bon.id}`)
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
      .get('/bons-retour-livreur/sons')
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

  /** Scan (douchette ou caméra) : passe le colis scanné en « Reçu par l'agence ». */
  async function submitScan(rawCode, mode) {
    const code = String(rawCode || '').trim();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    try {
      const res = await api.post(`/bons-retour-livreur/${bon.id}/scan-reception`, {
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
                {bon.livreur_name || '—'} — {recus}/{parcels.length} colis reçu{recus > 1 ? 's' : ''}
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

/** Ligne du tableau des bons : statut + actions (réception masquée en mode self). */
function BonRow({ bon, self, base, onDetail, onScan, onRefresh, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const statut = bonStatut(bon);
  const recu = Number(bon.delivered) === 1;
  const nbColis = Number(bon.nb_colis) || 0;
  const nbRecus = Number(bon.nb_recus) || 0;
  // « Modifier » masqué si le bon est reçu ou si tous ses colis sont déjà
  // reçus par scan.
  const modifiable = !recu && !(nbColis > 0 && nbRecus >= nbColis);

  async function toggleReceived() {
    const question = recu
      ? `Passer le bon « ${bon.ref} » en NON reçu ? Tous ses colis reviendront en « Expédié vers agence principale » (réceptions par scan comprises).`
      : `Confirmer la réception du bon « ${bon.ref} » ? Ses colis passeront en « Reçu par l'agence ».`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      await api.patch(`/bons-retour-livreur/${bon.id}/receive`, { received: recu ? 0 : 1 });
      // Rechargement complet : met à jour date / reçu par / compteurs.
      onRefresh();
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Télécharge le bon en PDF : détail du bon + informations société,
   * génération via utils/bonRetourLivreurPdf puis ouverture dans un nouvel
   * onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`${base}/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonRetourLivreurPdf } = await import('../../utils/bonRetourLivreurPdf');
      const url = await genererBonRetourLivreurPdf({
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
      await api.delete(`${base}/${bon.id}`);
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
        {self && <div className="cell-sub">{bon.zone || '—'}</div>}
      </td>
      {!self && (
        <td>
          <div className="cell-main">{bon.livreur_name || '—'}</div>
          <div className="cell-sub">{bon.zone || '—'}</div>
        </td>
      )}
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
              onClick={() =>
                navigate(self ? `/livreur/bon-retour/${bon.id}` : `/admin/bons-retour/livreur/${bon.id}`)
              }
            >
              <Pencil size={16} />
            </button>
          )}
          {/* Réception (bon reçu / non reçu, scan) : réservée à l'admin. */}
          {!self && (
            <button
              type="button"
              className={`row-action ${recu ? '' : 'row-action-success'}`}
              title={recu ? 'Bon non reçu' : 'Bon bien reçu'}
              onClick={toggleReceived}
              disabled={busy}
            >
              {recu ? <Undo2 size={16} /> : <CheckCircle2 size={16} />}
            </button>
          )}
          {!self && nbColis > 0 && (
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

/** Bons de retour livreur — page principale : création, filtres et tableau. */
export default function BonsRetourLivreur({ self = false }) {
  const navigate = useNavigate();
  const base = self ? '/bons-retour-livreur/livreur' : '/bons-retour-livreur';
  const [bons, setBons] = useState([]);
  const [livreurs, setLivreurs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [scanBon, setScanBon] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    if (self) return;
    api.get('/bons-retour-livreur/livreurs').then((res) => setLivreurs(res.data)).catch(() => {});
  }, [self]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(base, {
        params: {
          livreur: applied.livreur,
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
  }, [applied, base]);

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  /** Mode self : crée directement un bon pour le livreur connecté. */
  async function createSelf() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await api.post(base);
      navigate(`/livreur/bon-retour/${res.data.id}`);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la création du bon.');
      setCreating(false);
    }
  }

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
            <Undo2 size={18} /> {self ? 'Mes bons de retour' : 'Bons de retour livreur'}
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => (self ? createSelf() : setCreateOpen(true))}
            disabled={creating}
          >
            <Plus size={15} /> {creating ? 'Création…' : 'Créer un bon de retour'}
          </button>
        </div>

        <div className="filters-bar">
          {!self && (
            <SearchSelect
              label="Livreur"
              options={livreurs.map((l) => ({ value: l.id, label: l.nom }))}
              value={draft.livreur}
              onChange={setDraftField('livreur')}
              allLabel="Tous"
            />
          )}
          <select
            className="datatable-select"
            value={draft.status}
            onChange={(e) => setDraftField('status')(e.target.value)}
            title="Statut du bon"
          >
            <option value="new">Nouveau</option>
            <option value="received">Reçu</option>
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
                {!self && <th>Livreur</th>}
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
                  <td colSpan={self ? 6 : 7} className="datatable-empty">
                    Aucun bon de retour trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((bon) => (
                  <BonRow
                    key={bon.id}
                    bon={bon}
                    self={self}
                    base={base}
                    onDetail={setDetail}
                    onScan={setScanBon}
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

      {createOpen && !self && <CreateBonModal livreurs={livreurs} onClose={() => setCreateOpen(false)} />}
      {detail && <DetailBonModal bon={detail} base={base} onClose={() => setDetail(null)} />}
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
