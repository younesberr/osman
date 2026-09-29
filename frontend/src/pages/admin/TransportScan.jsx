import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bus,
  Camera,
  CheckCircle2,
  Pencil,
  PenLine,
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
import { useAuth } from '../../context/AuthContext';
import { useServerPagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect from '../../components/DateRangeSelect';

/*
 * Transport > Envoi / Retour — même page pour les deux sens (portage du
 * legacy transport_envoi.php / transport_retour.php, identiques à 95 %) :
 * scan des tickets transport (douchette — validation par Entrée — ou caméra
 * du téléphone), tarification automatique côté serveur, tuiles de synthèse,
 * filtres (période — toutes les dates par défaut —, société, statut — non
 * facturé par défaut —, recherche) et datatable des colis paginée côté
 * serveur (GET renvoie { rows, total, page, pageSize, totalPages }).
 *
 * À l'envoi le préfixe du code est la société expéditrice (facturée) ; au
 * retour, la société chez qui on ramasse (la facturée est le suffixe).
 * Édition du prix / suppression : types 1 et 2, colis non facturé seulement.
 */

/* Même code re-détecté par la caméra : ignoré pendant ce délai (anti-doublon). */
const CAM_COOLDOWN_MS = 4000;

const DIRECTIONS = {
  envoi: {
    apiBase: '/transport/envois',
    titre: 'Transport — Envoi (Ramassage)',
    tuileJour: "Ramassés aujourd'hui",
    colSociete: 'Société expéditrice',
    colVille: "Ville d'envoi",
    placeholder: 'Ex. LIV1752741234001ORT',
    manuel: {
      titre: 'Enregistrer un envoi manuellement',
      prefixe: { key: 'exp', label: 'Société expéditrice (facturée)' },
      suffixe: { key: 'dest', label: 'Société destinataire' }
    }
  },
  retour: {
    apiBase: '/transport/retours',
    titre: 'Transport — Retour',
    tuileJour: "Scannés aujourd'hui",
    colSociete: 'Société cliente',
    colVille: 'Ville de ramassage',
    placeholder: 'Ex. ORT1752741234001LIV',
    manuel: {
      titre: 'Enregistrer un retour manuellement',
      prefixe: { key: 'ram', label: 'Société de ramassage' },
      suffixe: { key: 'client', label: 'Société cliente (facturée)' }
    }
  }
};

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

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/** Ville en "REF - Nom" comme le legacy. */
function villeLabel(ref, nom) {
  if (!ref && !nom) return '—';
  return [ref, nom].filter(Boolean).join(' - ');
}

/** Statut d'un colis : dérivé de sa facture (badge 3 états). */
function colisStatut(colis) {
  if (!colis.facture_id) return { label: 'Non facturé', badge: 'badge-attente' };
  if (Number(colis.facture_statut) === 1) return { label: 'Payé', badge: 'badge-active' };
  return { label: 'Facturé', badge: 'badge-mvnt-colis' };
}

/** Modale « Modifier le prix » (le tarif passe en « manuel »). */
function TarifModal({ dir, colis, onClose, onSaved }) {
  const [tarif, setTarif] = useState(String(colis.tarif));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.patch(`${dir.apiBase}/${colis.id}`, { tarif });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la modification du prix.');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Pencil size={18} />
            <div className="cell-main">Modifier le prix</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Code</span>
              <input type="text" value={colis.code} disabled />
            </label>
            <label className="modal-form-full">
              <span className="field-label">{dir.colSociete}</span>
              <input type="text" value={colis.societe || '—'} disabled />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Prix (DH)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={tarif}
                onChange={(e) => setTarif(e.target.value)}
                required
                autoFocus
              />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale de saisie manuelle (ticket illisible) : les deux sociétés. */
function ManuelModal({ dir, societes, onClose, onSaved }) {
  const [form, setForm] = useState({ prefixe: '', suffixe: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const options = societes.map((s) => ({
    value: s.id,
    label: `${s.nom}${s.ville ? ` (${s.ville})` : ''}${s.code ? ` [${s.code}]` : ''}`
  }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.prefixe || !form.suffixe) {
      setError('Veuillez sélectionner les deux sociétés.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post(dir.apiBase, {
        [dir.manuel.prefixe.key]: Number(form.prefixe),
        [dir.manuel.suffixe.key]: Number(form.suffixe)
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du colis.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <PenLine size={18} />
            <div className="cell-main">{dir.manuel.titre}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">{dir.manuel.prefixe.label}</span>
              <SearchableSelect
                value={form.prefixe}
                onChange={(v) => setForm((f) => ({ ...f, prefixe: String(v) }))}
                placeholder="— Sélectionner une société —"
                options={options}
              />
            </div>
            <div className="modal-form-full">
              <span className="field-label">{dir.manuel.suffixe.label}</span>
              <SearchableSelect
                value={form.suffixe}
                onChange={(v) => setForm((f) => ({ ...f, suffixe: String(v) }))}
                placeholder="— Sélectionner une société —"
                options={options}
              />
            </div>
          </div>
          <p className="cell-sub">
            Un code interne est généré automatiquement et le tarif est calculé comme pour un scan.
          </p>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Filtres par défaut : toutes les dates, colis non facturés. */
function defaultFilters() {
  return { range: { from: '', to: '', preset: 'all' }, societe: '', statut: 'non-facture', q: '' };
}

/** Page Envoi ou Retour selon la direction. */
function TransportScanPage({ direction }) {
  const dir = DIRECTIONS[direction];
  const { user } = useAuth();
  const isAdmin = [1, 2].includes(Number(user?.role));

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [societes, setSocietes] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(null); // null | 'manuel' | colis (édition prix)

  // Scan.
  const [scanValue, setScanValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [session, setSession] = useState([]);
  const [camOpen, setCamOpen] = useState(false);
  const [camError, setCamError] = useState('');

  const inputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const audioCtxRef = useRef(null);
  const lastDetectRef = useRef({ code: '', at: 0 });

  const pager = useServerPagination(total, 'colis', 'colis');
  const { page, pageSize, setPage } = pager;

  useEffect(() => {
    api
      .get('/transport/filtres')
      .then((res) => setSocietes(res.data.societes))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get('/transport/stats')
      .then((res) => setStats(res.data))
      .catch(() => {});
  }, [reloadKey, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(dir.apiBase, {
        params: {
          page,
          pageSize,
          debut: applied.range.from,
          fin: applied.range.to,
          societe: applied.societe,
          statut: applied.statut,
          q: applied.q
        }
      })
      .then((res) => {
        if (cancelled) return;
        // Page devenue vide (suppressions, filtre) : on recule sur la dernière page.
        if (page > res.data.totalPages) {
          setPage(res.data.totalPages);
          return;
        }
        setRows(res.data.rows);
        setTotal(res.data.total);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des colis.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir.apiBase, applied, reloadKey, page, pageSize, setPage]);

  /** Bip legacy : 1200 Hz (succès) / 300 Hz (doublon ou erreur). */
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

  /** Envoie un code scanné au serveur (statut success | duplicate | error). */
  async function submit(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await api.post(`${dir.apiBase}/scan`, { code });
      const entry = {
        status: res.data.status,
        code,
        message: res.data.message,
        time: new Date().toLocaleTimeString('fr-FR')
      };
      setLast(entry);
      setSession((s) => [entry, ...s].slice(0, 8));
      beep(res.data.status === 'success');
      if (res.data.status === 'success') setReloadKey((k) => k + 1);
    } catch (err) {
      const entry = {
        status: 'error',
        code,
        message: err.response?.data?.message || 'Erreur lors du scan, veuillez réessayer.',
        time: new Date().toLocaleTimeString('fr-FR')
      };
      setLast(entry);
      setSession((s) => [entry, ...s].slice(0, 8));
      beep(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setScanValue('');
      // Re-focus après le re-rendu : l'utilisateur enchaîne les scans sans cliquer.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  /** Code lu par la caméra : anti-doublon puis même traitement que la douchette. */
  function handleDetected(code) {
    const now = Date.now();
    const prev = lastDetectRef.current;
    if (code === prev.code && now - prev.at < CAM_COOLDOWN_MS) return;
    lastDetectRef.current = { code, at: now };
    submit(code);
  }

  // Caméra : flux vidéo arrière + détection QR (API native ou repli ZXing).
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

  async function remove(colis) {
    if (!window.confirm(`Supprimer le colis ${colis.code} ?`)) return;
    try {
      await api.delete(`${dir.apiBase}/${colis.id}`);
      setRows((prev) => prev.filter((r) => r.id !== colis.id));
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  function handleSaved() {
    setModal(null);
    setReloadKey((k) => k + 1);
  }

  const societeOptions = useMemo(
    () => societes.map((s) => ({ value: s.id, label: `${s.nom}${s.code ? ` [${s.code}]` : ''}` })),
    [societes]
  );

  const statutIcons = {
    success: <CheckCircle2 size={22} />,
    duplicate: <AlertTriangle size={22} />,
    error: <XCircle size={22} />
  };
  const statutClass = {
    success: 'scan-result-ok',
    duplicate: 'scan-result-dup',
    error: 'scan-result-err'
  };

  return (
    <div className="platform-page bons-envoi-page">
      {isAdmin && stats && (
        <div className="stats-grid transport-stats">
          <div className="stat-card tone-primary">
            <div className="stat-value">
              {direction === 'envoi' ? stats.envoisJour : stats.retoursJour}
            </div>
            <div className="stat-label">{dir.tuileJour}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {direction === 'envoi' ? stats.envoisNonFactures : stats.retoursNonFactures}
            </div>
            <div className="stat-label">Colis non facturés</div>
          </div>
          <div className="stat-card tone-danger">
            <div className="stat-value">{formatMontant(stats.encoursMontant)}</div>
            <div className="stat-label">Encours non facturé (envois + retours)</div>
          </div>
        </div>
      )}

      <section className="platform-card transport-scan-card">
        <div className="bons-head">
          <h2>
            <ScanLine size={18} /> Scanner un ticket
          </h2>
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setCamError('');
                setCamOpen(true);
              }}
            >
              <Camera size={16} /> Caméra
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setModal('manuel')}>
              <PenLine size={15} /> Saisie manuelle
            </button>
          </div>
        </div>
        <form
          className="scan-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(scanValue);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            className="scan-input transport-scan-input"
            value={scanValue}
            placeholder={dir.placeholder}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="done"
            readOnly={busy}
            onChange={(e) => setScanValue(e.target.value.toUpperCase())}
          />
        </form>
        {last && (
          <div className={`scan-result ${statutClass[last.status]}`}>
            {statutIcons[last.status]}
            <div>
              <div className="scan-result-msg">{last.message}</div>
              <div className="scan-result-sub">
                {last.code} — {last.time}
              </div>
            </div>
          </div>
        )}
        {session.length > 1 && (
          <div className="transport-session">
            {session.map((s, i) => (
              <span key={`${s.code}-${s.time}-${i}`} className={`transport-session-chip ${s.status}`}>
                {s.code}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            {direction === 'envoi' ? <Bus size={18} /> : <Undo2 size={18} />} Colis scannés
          </h2>
        </div>

        <div className="filters-bar">
          <DateRangeSelect
            value={draft.range}
            onChange={(range) => setDraft((d) => ({ ...d, range }))}
          />
          <SearchSelect
            label="Société"
            options={societeOptions}
            value={draft.societe}
            onChange={(v) => setDraft((d) => ({ ...d, societe: v }))}
            allLabel="Toutes"
          />
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraft((d) => ({ ...d, statut: e.target.value }))}
            title="Statut"
          >
            <option value="">Tous les statuts</option>
            <option value="non-facture">Non facturé</option>
            <option value="facture">Facturé (non payé)</option>
            <option value="paye">Payé</option>
          </select>
          <div className="datatable-search">
            <input
              type="search"
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
              placeholder="Code, société, ville…"
              style={{ paddingLeft: 14 }}
            />
          </div>
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
                <th>Code</th>
                <th>{dir.colSociete}</th>
                <th>{dir.colVille}</th>
                <th>Ville destinataire</th>
                <th>Prix</th>
                <th>Statut</th>
                <th>Date scan</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={isAdmin ? 8 : 7} className="datatable-empty">
                    Aucun colis trouvé.
                  </td>
                </tr>
              ) : (
                rows.map((colis) => {
                  const statut = colisStatut(colis);
                  const verrou = colis.facture_id
                    ? 'Colis rattaché à une facture'
                    : null;
                  return (
                    <tr key={colis.id}>
                      <td>
                        <div className="cell-main transport-code">{colis.code}</div>
                        <div className="cell-sub">{colis.autre_societe || ''}</div>
                      </td>
                      <td>{colis.societe || '—'}</td>
                      <td>{villeLabel(colis.ville_ref, colis.ville)}</td>
                      <td>{villeLabel(colis.ville_dest_ref, colis.ville_dest)}</td>
                      <td>
                        <div className="cell-main">{formatMontant(colis.tarif)}</div>
                        {colis.tarif_type !== 'standard' && (
                          <div className="cell-sub">
                            {colis.tarif_type === 'personnalise' ? 'Tarif personnalisé' : 'Tarif manuel'}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${statut.badge}`}>{statut.label}</span>
                        {colis.facture_ref && <div className="cell-sub">{colis.facture_ref}</div>}
                      </td>
                      <td>
                        <div className="cell-main">{formatDate(colis.created_time)}</div>
                        <div className="cell-sub">{colis.scanne_par || ''}</div>
                      </td>
                      {isAdmin && (
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="row-action"
                              title={verrou ? `${verrou} : modification impossible` : 'Modifier le prix'}
                              disabled={!!verrou}
                              onClick={() => setModal(colis)}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              type="button"
                              className="row-action row-action-danger"
                              title={verrou ? `${verrou} : suppression impossible` : 'Supprimer le colis'}
                              disabled={!!verrou}
                              onClick={() => remove(colis)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {/* Overlay du scan par caméra (téléphone mobile). */}
      {camOpen && (
        <div className="scan-cam-overlay" role="dialog" aria-label="Scanner par caméra">
          <div className="scan-cam-box">
            <video ref={videoRef} className="scan-cam-video" playsInline muted />
            {camError ? (
              <div className="scan-cam-error">{camError}</div>
            ) : (
              <div className="scan-cam-hint">Visez le code QR du ticket transport.</div>
            )}
            {last && (
              <div className={`scan-result scan-result-compact ${statutClass[last.status]}`}>
                {statutIcons[last.status]}
                <div>
                  <div className="scan-result-msg">{last.message}</div>
                </div>
              </div>
            )}
            <button type="button" className="btn btn-primary scan-cam-close" onClick={() => setCamOpen(false)}>
              <X size={16} /> Fermer
            </button>
          </div>
        </div>
      )}

      {modal === 'manuel' && (
        <ManuelModal
          dir={dir}
          societes={societes}
          onClose={() => setModal(null)}
          onSaved={() => handleSaved()}
        />
      )}
      {modal && modal !== 'manuel' && (
        <TarifModal dir={dir} colis={modal} onClose={() => setModal(null)} onSaved={handleSaved} />
      )}
    </div>
  );
}

export function TransportEnvoi() {
  return <TransportScanPage direction="envoi" />;
}

export function TransportRetour() {
  return <TransportScanPage direction="retour" />;
}
