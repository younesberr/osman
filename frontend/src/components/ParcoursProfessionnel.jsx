import { useEffect, useState } from 'react';
import { Banknote, Briefcase, Check, FileText, Info, Pencil, Plus, ScrollText, Trash2, X } from 'lucide-react';
import api from '../api/client';

/*
 * Onglet « Parcours professionnel » de la fiche utilisateur, calqué sur la
 * page RH de l'ancienne plateforme SUIVI : synthèse CNSS / date de recrutement,
 * situation actuelle (dérivée du dernier contrat et du dernier salaire),
 * historiques des contrats (delevery_contrats) et des salaires
 * (delevery_salaires) avec ajout / modification / suppression.
 */

const TYPES_CONTRAT = ['CDI', 'CDD', 'Stage', 'Interim', 'Anapec'];

/** 'AAAA-MM-JJ' → 'JJ/MM/AAAA' (— si vide). */
export function fmtDate(d) {
  if (!d) return '—';
  const [y, m, j] = d.split('-');
  return `${j}/${m}/${y}`;
}

/** Montant → '1 234,56 DH' (— si vide). */
function fmtMoney(v) {
  if (v == null || v === '') return '—';
  return `${Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`;
}

/** Fin de contrat vs aujourd'hui : badge « expiré » / « expire bientôt » (< 1 mois). */
function finContratBadge(dateFin) {
  if (!dateFin) return null;
  const fin = new Date(`${dateFin}T23:59:59`);
  const now = new Date();
  if (fin < now) return <span className="badge parcours-badge-expire">Expiré</span>;
  const dansUnMois = new Date(now);
  dansUnMois.setMonth(dansUnMois.getMonth() + 1);
  if (fin <= dansUnMois) return <span className="badge parcours-badge-bientot">Expire bientôt</span>;
  return null;
}

/** Lien vers un fichier servi par la plateforme (— sinon). */
function FichierLink({ value }) {
  if (!value) return '—';
  if (value.startsWith('/uploads/')) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="fiche-file-link">
        <FileText size={14} /> Voir
      </a>
    );
  }
  return <span className="fiche-file-empty" title={value}>Fichier (ancien système)</span>;
}

/** Tuile en lecture seule de la section « Situation actuelle ». */
function SituationTile({ label, children }) {
  return (
    <div className="situation-tile">
      <span className="situation-tile-label">{label}</span>
      <span className="situation-tile-value">{children}</span>
    </div>
  );
}

/** Champ fichier PDF des modals (réutilise le style des fichiers de la fiche). */
function FichierField({ label, current, file, onChange }) {
  return (
    <label className="modal-form-full fiche-field">
      <span className="field-label">
        {label} <span className="fiche-hint">(PDF, max 5 Mo)</span>
      </span>
      <span className="fiche-file">
        <span className="fiche-file-btn">Choisir un fichier</span>
        <span className="fiche-file-name">
          {file ? file.name : <FichierLink value={current} />}
        </span>
        <input type="file" accept=".pdf" hidden onChange={(e) => onChange(e.target.files?.[0] || null)} />
      </span>
    </label>
  );
}

/** Modal « Nouveau contrat » / « Modifier contrat ». */
function ContratModal({ apiBase, contrat, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    type: contrat?.type || 'CDI',
    date_debut: contrat?.date_debut || '',
    date_fin: contrat?.date_fin || '',
    observation: contrat?.observation || ''
  }));
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const data = new FormData();
      data.append('type', form.type);
      data.append('date_debut', form.date_debut);
      data.append('date_fin', form.date_fin);
      data.append('observation', form.observation);
      if (file) data.append('fichier', file);
      const config = { headers: { 'Content-Type': 'multipart/form-data' } };
      const res = contrat
        ? await api.put(`${apiBase}/contrats/${contrat.contrat_id}`, data, config)
        : await api.post(`${apiBase}/contrats`, data, config);
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du contrat.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ScrollText size={18} />
            <div className="cell-main">{contrat ? 'Modifier contrat' : 'Nouveau contrat'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Type de contrat</span>
              <select value={form.type} onChange={setField('type')} required>
                {TYPES_CONTRAT.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Date de début</span>
              <input type="date" value={form.date_debut} onChange={setField('date_debut')} />
            </label>
            <label>
              <span className="field-label">Date de fin</span>
              <input type="date" value={form.date_fin} onChange={setField('date_fin')} />
            </label>
            <FichierField label="Fichier contrat" current={contrat?.fichier} file={file} onChange={setFile} />
            <label className="modal-form-full">
              <span className="field-label">Observation</span>
              <textarea rows={3} value={form.observation} onChange={setField('observation')} maxLength={1000} />
            </label>
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

/** Modal « Nouveau salaire » / « Modifier salaire ». */
function SalaireModal({ apiBase, salaire, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    declare: salaire?.declare != null ? String(salaire.declare) : '',
    net: salaire?.net != null ? String(salaire.net) : '',
    date_application: salaire?.date_application || '',
    observation: salaire?.observation || ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = salaire
        ? await api.put(`${apiBase}/salaires/${salaire.salaire_id}`, form)
        : await api.post(`${apiBase}/salaires`, form);
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du salaire.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Banknote size={18} />
            <div className="cell-main">{salaire ? 'Modifier salaire' : 'Nouveau salaire'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Salaire déclaré (DH)</span>
              <input type="number" min="0" step="0.01" value={form.declare} onChange={setField('declare')} />
            </label>
            <label>
              <span className="field-label">Salaire net (DH)</span>
              <input type="number" min="0" step="0.01" value={form.net} onChange={setField('net')} />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Date d'application</span>
              <input type="date" value={form.date_application} onChange={setField('date_application')} />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Observation</span>
              <textarea rows={3} value={form.observation} onChange={setField('observation')} maxLength={1000} />
            </label>
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

/* `apiBase` : /users/:id (admin) ou /users/me (« Ma fiche », readOnly —
 * seules les routes GET self existent côté backend). `summaryOnly`
 * (« Ma fiche ») : première section uniquement (synthèse + situation
 * actuelle), sans les historiques des contrats et des salaires. */
export default function ParcoursProfessionnel({
  apiBase,
  userName,
  readOnly = false,
  summaryOnly = false
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /* Formulaire CNSS / date de recrutement. */
  const [sync, setSync] = useState({ users_cnss: '', users_date_recrutement: '' });
  const [savingSync, setSavingSync] = useState(false);
  const [feedback, setFeedback] = useState(null);

  /* Modals : { mode: 'contrat'|'salaire', row: null|ligne } */
  const [modal, setModal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`${apiBase}/parcours`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setSync({
          users_cnss: res.data.users_cnss || '',
          users_date_recrutement: res.data.users_date_recrutement || ''
        });
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du parcours.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  async function saveSync() {
    setSavingSync(true);
    setFeedback(null);
    try {
      const res = await api.put(`${apiBase}/parcours`, sync);
      setData(res.data);
      setFeedback({ type: 'success', text: 'Informations enregistrées.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSavingSync(false);
    }
  }

  function onModalSaved(fresh) {
    setData(fresh);
    setModal(null);
  }

  async function removeContrat(c) {
    if (!window.confirm(`Supprimer le contrat « ${c.type} (${fmtDate(c.date_debut)}) » ?`)) return;
    try {
      const res = await api.delete(`${apiBase}/contrats/${c.contrat_id}`);
      setData(res.data);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  async function removeSalaire(s) {
    if (!window.confirm(`Supprimer le salaire du ${fmtDate(s.date_application)} ?`)) return;
    try {
      const res = await api.delete(`${apiBase}/salaires/${s.salaire_id}`);
      setData(res.data);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  if (loading) return <p className="cell-sub">Chargement du parcours…</p>;
  if (error) return <div className="form-error">{error}</div>;
  if (!data) return null;

  const dernierContrat = data.contrats[0] || null;
  const dernierSalaire = data.salaires[0] || null;

  return (
    <>
      {/* ============ Synthèse + situation actuelle ============ */}
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <Briefcase size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Parcours professionnel — {userName}</h2>
            <p className="fiche-head-sub">
              Synthèse (contrat &amp; salaire les plus récents), CNSS et date de recrutement
            </p>
          </div>
        </header>

        <div className="parcours-sync">
          <label className="fiche-field">
            <span className="field-label">N° CNSS</span>
            <input
              type="text"
              maxLength={50}
              value={sync.users_cnss}
              disabled={readOnly}
              onChange={(e) => setSync((f) => ({ ...f, users_cnss: e.target.value }))}
            />
          </label>
          <label className="fiche-field">
            <span className="field-label">Date de recrutement</span>
            <input
              type="date"
              value={sync.users_date_recrutement}
              disabled={readOnly}
              onChange={(e) => setSync((f) => ({ ...f, users_date_recrutement: e.target.value }))}
            />
          </label>
          {!readOnly && (
            <button
              type="button"
              className="btn btn-primary parcours-sync-save"
              disabled={savingSync}
              onClick={saveSync}
            >
              <Check size={15} /> {savingSync ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          )}
        </div>
        {feedback && (
          <p className={feedback.type === 'error' ? 'field-error' : 'field-success'}>{feedback.text}</p>
        )}

        <h3 className="fiche-section-title situation-title">
          <Info size={15} /> Situation actuelle{' '}
          <span className="fiche-hint">(non modifiable — issue du dernier contrat / salaire)</span>
        </h3>
        <div className="situation-grid">
          <SituationTile label="Type de contrat">{dernierContrat?.type || '—'}</SituationTile>
          <SituationTile label="Début contrat">{fmtDate(dernierContrat?.date_debut)}</SituationTile>
          <SituationTile label="Fin contrat">
            {fmtDate(dernierContrat?.date_fin)} {finContratBadge(dernierContrat?.date_fin)}
          </SituationTile>
          <SituationTile label="Contrat">
            <FichierLink value={dernierContrat?.fichier} />
          </SituationTile>
          <SituationTile label="Salaire déclaré">{fmtMoney(dernierSalaire?.declare)}</SituationTile>
          <SituationTile label="Salaire net">{fmtMoney(dernierSalaire?.net)}</SituationTile>
        </div>
      </section>

      {/* ============ Historique des contrats ============ */}
      {!summaryOnly && (
      <section className="platform-card fiche-card">
        <div className="fiche-table-head">
          <h3 className="fiche-section-title">
            <ScrollText size={15} /> Historique des contrats
          </h3>
          {!readOnly && (
            <button type="button" className="btn btn-primary" onClick={() => setModal({ mode: 'contrat', row: null })}>
              <Plus size={15} /> Nouveau contrat
            </button>
          )}
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Début</th>
                <th>Fin</th>
                <th>Contrat</th>
                <th>Observation</th>
                {!readOnly && <th className="col-actions">Action</th>}
              </tr>
            </thead>
            <tbody>
              {data.contrats.length === 0 ? (
                <tr>
                  <td colSpan={readOnly ? 5 : 6} className="datatable-empty">
                    Aucun contrat enregistré.
                  </td>
                </tr>
              ) : (
                data.contrats.map((c) => (
                  <tr key={c.contrat_id}>
                    <td className="cell-main">{c.type}</td>
                    <td>{fmtDate(c.date_debut)}</td>
                    <td>
                      {fmtDate(c.date_fin)} {finContratBadge(c.date_fin)}
                    </td>
                    <td>
                      <FichierLink value={c.fichier} />
                    </td>
                    <td className="cell-sub parcours-obs" title={c.observation || ''}>
                      {c.observation || '—'}
                    </td>
                    {!readOnly && (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="Modifier"
                            onClick={() => setModal({ mode: 'contrat', row: c })}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer"
                            onClick={() => removeContrat(c)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {/* ============ Historique des salaires ============ */}
      {!summaryOnly && (
      <section className="platform-card fiche-card">
        <div className="fiche-table-head">
          <h3 className="fiche-section-title">
            <Banknote size={15} /> Historique des salaires
          </h3>
          {!readOnly && (
            <button type="button" className="btn btn-primary" onClick={() => setModal({ mode: 'salaire', row: null })}>
              <Plus size={15} /> Nouveau salaire
            </button>
          )}
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Salaire déclaré</th>
                <th>Salaire net</th>
                <th>Date d'application</th>
                <th>Observation</th>
                {!readOnly && <th className="col-actions">Action</th>}
              </tr>
            </thead>
            <tbody>
              {data.salaires.length === 0 ? (
                <tr>
                  <td colSpan={readOnly ? 4 : 5} className="datatable-empty">
                    Aucun salaire enregistré.
                  </td>
                </tr>
              ) : (
                data.salaires.map((s) => (
                  <tr key={s.salaire_id}>
                    <td className="cell-main">{fmtMoney(s.declare)}</td>
                    <td className="cell-main">{fmtMoney(s.net)}</td>
                    <td>{fmtDate(s.date_application)}</td>
                    <td className="cell-sub parcours-obs" title={s.observation || ''}>
                      {s.observation || '—'}
                    </td>
                    {!readOnly && (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="Modifier"
                            onClick={() => setModal({ mode: 'salaire', row: s })}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer"
                            onClick={() => removeSalaire(s)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {modal?.mode === 'contrat' && (
        <ContratModal apiBase={apiBase} contrat={modal.row} onClose={() => setModal(null)} onSaved={onModalSaved} />
      )}
      {modal?.mode === 'salaire' && (
        <SalaireModal apiBase={apiBase} salaire={modal.row} onClose={() => setModal(null)} onSaved={onModalSaved} />
      )}
    </>
  );
}
