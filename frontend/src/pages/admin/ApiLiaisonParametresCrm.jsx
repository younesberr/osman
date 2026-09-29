import { useEffect, useState } from 'react';
import { Pencil, Plus, Save, SlidersHorizontal, Trash2, X, Zap } from 'lucide-react';
import api from '../../api/client';
import Toggle from '../../components/Toggle';

/*
 * Onglet « Paramètres CRM » de la page API liaison › Configuration :
 *  - paramètres du CRM (GET/PUT /whatsapp/parametres-crm) : automatisations,
 *    heures calmes, accusé de lecture Meta, auto-affectation, réponse
 *    automatique, mots-clés d'opt-out, expiration de la file ;
 *  - réponses rapides du compositeur des discussions (CRUD /whatsapp/reponses-rapides).
 */

function Ligne({ label, hint, children }) {
  return (
    <div className="wa-param-row">
      <div className="wa-param-text">
        <span className="field-label">{label}</span>
        {hint && <span className="wa-field-hint">{hint}</span>}
      </div>
      <div className="wa-param-ctrl">{children}</div>
    </div>
  );
}

function ReponsesRapides() {
  const [rows, setRows] = useState([]);
  const [edit, setEdit] = useState(null); // { id?, titre, texte }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get('/whatsapp/reponses-rapides', { params: { tous: 1 } })
      .then((res) => setRows(res.data.rows || []))
      .catch((err) => setError(err.response?.data?.message || 'Chargement impossible.'));

  useEffect(() => {
    load();
  }, []);

  async function save(e) {
    e.preventDefault();
    if (!edit || busy) return;
    setBusy(true);
    setError('');
    try {
      if (edit.id) await api.put(`/whatsapp/reponses-rapides/${edit.id}`, edit);
      else await api.post('/whatsapp/reponses-rapides', edit);
      setEdit(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "Échec de l'enregistrement.");
    } finally {
      setBusy(false);
    }
  }

  async function supprimer(r) {
    if (!window.confirm(`Supprimer la réponse rapide « ${r.titre} » ?`)) return;
    try {
      await api.delete(`/whatsapp/reponses-rapides/${r.id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Suppression impossible.');
    }
  }

  async function toggleActif(r, actif) {
    try {
      await api.put(`/whatsapp/reponses-rapides/${r.id}`, { ...r, actif });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Modification impossible.');
    }
  }

  return (
    <section className="platform-card wa-crm-card">
      <div className="card-head-actions">
        <h2>
          <Zap size={18} /> Réponses rapides
        </h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEdit({ titre: '', texte: '', ordre: rows.length, actif: true })}>
          <Plus size={14} /> Ajouter
        </button>
      </div>
      <p className="wa-intro">
        Textes prêts à l'emploi proposés dans le compositeur des discussions (éclair ⚡). Balises remplacées à l'insertion :{' '}
        <code>{'{nom}'}</code> (contact), <code>{'{colis}'}</code> (code du colis lié), <code>{'{magasin}'}</code>.
      </p>
      {error && <div className="form-error">{error}</div>}
      {edit && (
        <form className="wa-rr-form" onSubmit={save}>
          <input type="text" value={edit.titre} maxLength={100} placeholder="Titre (ex. Bonjour + suivi)" onChange={(e) => setEdit({ ...edit, titre: e.target.value })} />
          <textarea rows={3} value={edit.texte} placeholder="Texte de la réponse…" onChange={(e) => setEdit({ ...edit, texte: e.target.value })} />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>
              <X size={14} /> Annuler
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              <Save size={14} /> Enregistrer
            </button>
          </div>
        </form>
      )}
      <div className="table-wrap datatable">
        <table>
          <thead>
            <tr>
              <th>Titre</th>
              <th>Texte</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="datatable-empty">
                  Aucune réponse rapide.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="cell-main">{r.titre}</td>
                  <td className="wa-cell-wrap">{r.texte}</td>
                  <td>
                    <Toggle checked={r.actif} onChange={(v) => toggleActif(r, v)} label={`Réponse ${r.titre} active`} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button type="button" className="row-action" title="Modifier" onClick={() => setEdit({ ...r })}>
                        <Pencil size={16} />
                      </button>
                      <button type="button" className="row-action row-action-danger" title="Supprimer" onClick={() => supprimer(r)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ApiLiaisonParametresCrm() {
  const [form, setForm] = useState(null);
  const [motsInput, setMotsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/whatsapp/parametres-crm')
      .then((res) => {
        setForm(res.data);
        setMotsInput((res.data.optOutMots || []).join(', '));
      })
      .catch((err) => setError(err.response?.data?.message || 'Chargement impossible.'));
  }, []);

  function set(patch) {
    setFeedback(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.put('/whatsapp/parametres-crm', {
        ...form,
        optOutMots: motsInput.split(',').map((m) => m.trim()).filter(Boolean),
        expirationHeures: Number(form.expirationHeures)
      });
      setForm(res.data);
      setMotsInput((res.data.optOutMots || []).join(', '));
      setFeedback({ type: 'success', text: res.data.message || 'Paramètres enregistrés.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="form-error">{error}</div>;
  if (!form) return <div className="modal-loading">Chargement…</div>;

  return (
    <>
      <form onSubmit={save}>
        <section className="platform-card">
          <h2>
            <SlidersHorizontal size={18} /> Paramètres du CRM
          </h2>
          <div className="wa-params-list">
            <Ligne label="Automatisations actives" hint="Interrupteur général des actions automatiques (les envois manuels depuis les discussions restent possibles).">
              <Toggle checked={form.automatisationsActif} onChange={(v) => set({ automatisationsActif: v })} label="Automatisations actives" />
            </Ligne>
            <Ligne label="Heures calmes" hint="Les envois automatiques prévus dans cette plage sont reportés à sa fin (ex. 21:00 → 08:00). Les envois manuels ne sont pas concernés.">
              <div className="wa-horaires">
                <Toggle checked={form.calmeActif} onChange={(v) => set({ calmeActif: v })} label="Heures calmes actives" />
                <input type="time" value={form.calmeDebut} disabled={!form.calmeActif} onChange={(e) => set({ calmeDebut: e.target.value })} />
                <span>→</span>
                <input type="time" value={form.calmeFin} disabled={!form.calmeActif} onChange={(e) => set({ calmeFin: e.target.value })} />
              </div>
            </Ligne>
            <Ligne label="Marquer comme lu chez Meta" hint="À l'ouverture d'une discussion, le contact voit les coches bleues sur ses messages.">
              <Toggle checked={form.marquerLu} onChange={(v) => set({ marquerLu: v })} label="Marquer comme lu chez Meta" />
            </Ligne>
            <Ligne label="Auto-affectation" hint="Une discussion non affectée est affectée au premier employé qui l'ouvre.">
              <Toggle checked={form.autoAffectation} onChange={(v) => set({ autoAffectation: v })} label="Auto-affectation" />
            </Ligne>
            <Ligne label="Réponse automatique" hint="Envoyée une fois par 24 h quand un contact écrit et qu'aucun employé n'a répondu dans les 24 dernières heures.">
              <Toggle checked={form.autoReponseActif} onChange={(v) => set({ autoReponseActif: v })} label="Réponse automatique" />
            </Ligne>
            <textarea
              rows={3}
              className="wa-param-full"
              value={form.autoReponseTexte}
              maxLength={1000}
              disabled={!form.autoReponseActif}
              onChange={(e) => set({ autoReponseTexte: e.target.value })}
            />
            <Ligne label="Mots-clés d'opt-out" hint="Un contact qui envoie l'un de ces mots (seul) ne reçoit plus d'envoi automatique. Séparés par des virgules.">
              <input type="text" value={motsInput} onChange={(e) => { setFeedback(null); setMotsInput(e.target.value); }} placeholder="STOP, ARRET, DESABONNER" />
            </Ligne>
            <Ligne label="Expiration de la file (heures)" hint="Un envoi planifié non traité dans ce délai (intégration désactivée, serveur arrêté) est abandonné.">
              <input type="number" min={1} max={720} value={form.expirationHeures} onChange={(e) => set({ expirationHeures: e.target.value })} />
            </Ligne>
          </div>
          <div className="platform-actions wa-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {feedback && <span className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</span>}
          </div>
        </section>
      </form>
      <ReponsesRapides />
    </>
  );
}
