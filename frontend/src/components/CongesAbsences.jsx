import { useEffect, useMemo, useState } from 'react';
import {
  CalendarX2,
  Check,
  FileImage,
  FileText,
  Filter,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import api from '../api/client';
import { fmtDate } from './ParcoursProfessionnel';

/*
 * Onglet « Congés & absences » de la fiche utilisateur, calqué sur la page RH
 * de l'ancienne plateforme SUIVI : synthèse du nombre de jours par type
 * d'indisponibilité (filtrable par période, recalcul côté client) et
 * historique des indisponibilités (delevery_indisponibilites) avec fichiers
 * joints (PDF / images).
 */

/* Clé stockée en base → libellé + couleur (mêmes types que l'ancien SUIVI). */
const INDISPO_TYPES = [
  { key: 'conge', label: 'Congé', color: '#0d6efd' },
  { key: 'absence_autorisee', label: 'Absence autorisée', color: '#198754' },
  { key: 'absence_non_autorisee', label: 'Absence non autorisée', color: '#dc3545' },
  { key: 'retard', label: 'Retard', color: '#fd7e14' },
  { key: 'autre', label: 'Autre', color: '#6c757d' }
];

const TYPE_BY_KEY = Object.fromEntries(INDISPO_TYPES.map((t) => [t.key, t]));
const MAX_FICHIERS = 10;

/** 'AAAA-MM-JJ' → timestamp UTC (sans DST : différences de jours exactes). */
function toUTC(s) {
  if (!s) return NaN;
  const [y, m, j] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, j);
}

/** Jours inclus (début et fin compris), bornés par la période filtrée. */
function dayCount(debut, fin, du, au) {
  let d = toUTC(debut);
  let f = toUTC(fin);
  if (!Number.isFinite(d) || !Number.isFinite(f) || f < d) return 0;
  if (du) d = Math.max(d, toUTC(du));
  if (au) f = Math.min(f, toUTC(au));
  if (f < d) return 0;
  return Math.round((f - d) / 86400000) + 1;
}

/** Icône-lien d'un fichier joint (PDF rouge / image bleue, comme SUIVI). */
function FichierIcone({ value }) {
  const isPdf = value.toLowerCase().endsWith('.pdf');
  const Icon = isPdf ? FileText : FileImage;
  return (
    <a
      href={value}
      target="_blank"
      rel="noreferrer"
      className={`indispo-file ${isPdf ? 'indispo-file-pdf' : 'indispo-file-img'}`}
      title={value.split('/').pop()}
    >
      <Icon size={16} />
    </a>
  );
}

/** Modal « Ajouter indisponibilité » / « Modifier indisponibilité ». */
function IndispoModal({ apiBase, indispo, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    type: indispo?.type || 'conge',
    date_debut: indispo?.date_debut || '',
    date_fin: indispo?.date_fin || '',
    remarque: indispo?.remarque || ''
  }));
  /* Fichiers déjà enregistrés encore conservés + nouveaux fichiers à envoyer. */
  const [conserves, setConserves] = useState(() => indispo?.fichiers || []);
  const [nouveaux, setNouveaux] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const nbJours = dayCount(form.date_debut, form.date_fin, null, null);

  function addFiles(e) {
    const list = Array.from(e.target.files || []);
    setNouveaux((prev) => [...prev, ...list].slice(0, MAX_FICHIERS - conserves.length));
    e.target.value = '';
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const data = new FormData();
      data.append('type', form.type);
      data.append('date_debut', form.date_debut);
      data.append('date_fin', form.date_fin);
      data.append('remarque', form.remarque);
      for (const f of nouveaux) data.append('fichiers', f);
      if (indispo) {
        for (const f of indispo.fichiers.filter((x) => !conserves.includes(x))) {
          data.append('fichiers_remove', f);
        }
      }
      const config = { headers: { 'Content-Type': 'multipart/form-data' } };
      const res = indispo
        ? await api.put(`${apiBase}/indisponibilites/${indispo.indispo_id}`, data, config)
        : await api.post(`${apiBase}/indisponibilites`, data, config);
      onSaved(res.data.rows);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de l'indisponibilité.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <CalendarX2 size={18} />
            <div className="cell-main">{indispo ? 'Modifier indisponibilité' : 'Ajouter indisponibilité'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Type d'indisponibilité</span>
              <select value={form.type} onChange={setField('type')} required>
                {INDISPO_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Date de début</span>
              <input type="date" value={form.date_debut} onChange={setField('date_debut')} required />
            </label>
            <label>
              <span className="field-label">Date de fin</span>
              <input type="date" value={form.date_fin} onChange={setField('date_fin')} required />
            </label>
            {nbJours > 0 && (
              <p className="modal-form-full indispo-nb-jours">
                Durée : <strong>{nbJours}</strong> jour{nbJours > 1 ? 's' : ''} (début et fin compris)
              </p>
            )}
            <label className="modal-form-full">
              <span className="field-label">Remarque</span>
              <textarea rows={3} value={form.remarque} onChange={setField('remarque')} maxLength={1000} />
            </label>
            <div className="modal-form-full fiche-field">
              <span className="field-label">
                Fichiers joints <span className="fiche-hint">(PDF ou image, max 5 Mo chacun)</span>
              </span>
              {(conserves.length > 0 || nouveaux.length > 0) && (
                <ul className="indispo-file-list">
                  {conserves.map((f) => (
                    <li key={f}>
                      <FichierIcone value={f} />
                      <span className="indispo-file-name">{f.split('/').pop()}</span>
                      <button
                        type="button"
                        className="row-action row-action-danger"
                        title="Retirer ce fichier"
                        onClick={() => setConserves((prev) => prev.filter((x) => x !== f))}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                  {nouveaux.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      <span className="indispo-file-name">{f.name}</span>
                      <button
                        type="button"
                        className="row-action row-action-danger"
                        title="Retirer ce fichier"
                        onClick={() => setNouveaux((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {conserves.length + nouveaux.length < MAX_FICHIERS && (
                <label className="fiche-file">
                  <span className="fiche-file-btn">Ajouter des fichiers</span>
                  <span className="fiche-file-name">
                    {conserves.length + nouveaux.length === 0 ? 'Aucun fichier sélectionné' : ''}
                  </span>
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple hidden onChange={addFiles} />
                </label>
              )}
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Filtre par défaut des statistiques : année civile en cours ou aucun. */
function filtreParDefaut(anneeEnCours) {
  if (!anneeEnCours) return { du: '', au: '' };
  const annee = new Date().getFullYear();
  return { du: `${annee}-01-01`, au: `${annee}-12-31` };
}

/* `apiBase` : /users/:id (admin) ou /users/me (« Ma fiche », readOnly —
 * seules les routes GET self existent côté backend). `filtreAnneeEnCours`
 * (« Ma fiche ») : statistiques filtrées sur l'année en cours par défaut
 * (le bouton de réinitialisation y revient). */
export default function CongesAbsences({
  apiBase,
  userName,
  readOnly = false,
  filtreAnneeEnCours = false
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtre, setFiltre] = useState(() => filtreParDefaut(filtreAnneeEnCours));
  /* Modal : null (fermé), { row: null } (ajout) ou { row: ligne } (édition). */
  const [modal, setModal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`${apiBase}/indisponibilites`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des indisponibilités.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  /* Nombre de jours par type sur la période filtrée (bornage inclusif). */
  const stats = useMemo(() => {
    const totals = Object.fromEntries(INDISPO_TYPES.map((t) => [t.key, 0]));
    let total = 0;
    for (const r of rows) {
      const n = dayCount(r.date_debut, r.date_fin, filtre.du || null, filtre.au || null);
      if (totals[r.type] !== undefined) totals[r.type] += n;
      total += n;
    }
    return { totals, total };
  }, [rows, filtre]);

  async function removeIndispo(r) {
    const label = TYPE_BY_KEY[r.type]?.label || r.type;
    if (!window.confirm(`Supprimer l'indisponibilité « ${label} (${fmtDate(r.date_debut)}) » ?`)) return;
    try {
      const res = await api.delete(`${apiBase}/indisponibilites/${r.indispo_id}`);
      setRows(res.data.rows);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  if (loading) return <p className="cell-sub">Chargement des indisponibilités…</p>;
  if (error) return <div className="form-error">{error}</div>;

  return (
    <>
      {/* ============ Ajout + statistiques ============ */}
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <CalendarX2 size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Congés &amp; absences — {userName}</h2>
            <p className="fiche-head-sub">
              {readOnly
                ? 'Synthèse du nombre de jours par type (consultation)'
                : "Ajout d'une indisponibilité et synthèse du nombre de jours par type"}
            </p>
          </div>
          {!readOnly && (
            <button type="button" className="btn btn-primary" onClick={() => setModal({ row: null })}>
              <Plus size={15} /> Ajouter indisponibilité
            </button>
          )}
        </header>

        <div className="conges-filtre">
          <span className="field-label conges-filtre-label">
            <Filter size={13} /> Filtrer les statistiques
          </span>
          <div className="conges-filtre-champs">
            <label className="fiche-field">
              <span className="field-label">Du</span>
              <input
                type="date"
                value={filtre.du}
                onChange={(e) => setFiltre((f) => ({ ...f, du: e.target.value }))}
              />
            </label>
            <label className="fiche-field">
              <span className="field-label">Au</span>
              <input
                type="date"
                value={filtre.au}
                onChange={(e) => setFiltre((f) => ({ ...f, au: e.target.value }))}
              />
            </label>
            <button
              type="button"
              className="btn btn-ghost conges-filtre-reset"
              title="Réinitialiser le filtre"
              onClick={() => setFiltre(filtreParDefaut(filtreAnneeEnCours))}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </div>

        <div className="conges-stats">
          {INDISPO_TYPES.map((t) => (
            <div key={t.key} className="conges-stat-tile" style={{ borderLeftColor: t.color }}>
              <span className="conges-stat-label" title={t.label}>
                {t.label}
              </span>
              <span className="conges-stat-value" style={{ color: t.color }}>
                {stats.totals[t.key]}
                <small> j</small>
              </span>
            </div>
          ))}
          <div className="conges-stat-tile conges-stat-total">
            <span className="conges-stat-label">Total</span>
            <span className="conges-stat-value">
              {stats.total}
              <small> j</small>
            </span>
          </div>
        </div>
      </section>

      {/* ============ Historique ============ */}
      <section className="platform-card fiche-card">
        <div className="fiche-table-head">
          <h3 className="fiche-section-title">
            <CalendarX2 size={15} /> Historique des indisponibilités
          </h3>
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Début</th>
                <th>Fin</th>
                <th>Nb jours</th>
                <th>Remarque</th>
                <th>Fichiers</th>
                {!readOnly && <th className="col-actions">Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={readOnly ? 6 : 7} className="datatable-empty">
                    Aucune indisponibilité enregistrée.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const type = TYPE_BY_KEY[r.type] || { label: r.type, color: '#6c757d' };
                  return (
                    <tr key={r.indispo_id}>
                      <td>
                        <span
                          className="badge indispo-pill"
                          style={{ background: `${type.color}1a`, color: type.color }}
                        >
                          {type.label}
                        </span>
                      </td>
                      <td>{fmtDate(r.date_debut)}</td>
                      <td>{fmtDate(r.date_fin)}</td>
                      <td className="cell-main">{dayCount(r.date_debut, r.date_fin, null, null)}</td>
                      <td className="cell-sub parcours-obs" title={r.remarque || ''}>
                        {r.remarque || '—'}
                      </td>
                      <td>
                        {r.fichiers.length === 0
                          ? '—'
                          : r.fichiers.map((f) => <FichierIcone key={f} value={f} />)}
                      </td>
                      {!readOnly && (
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="row-action"
                              title="Modifier"
                              onClick={() => setModal({ row: r })}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              type="button"
                              className="row-action row-action-danger"
                              title="Supprimer"
                              onClick={() => removeIndispo(r)}
                            >
                              <Trash2 size={15} />
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
      </section>

      {modal && (
        <IndispoModal
          apiBase={apiBase}
          indispo={modal.row}
          onClose={() => setModal(null)}
          onSaved={(fresh) => {
            setRows(fresh);
            setModal(null);
          }}
        />
      )}
    </>
  );
}
