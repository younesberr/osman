import { useEffect, useState } from 'react';
import { Building2, Pencil, Plus, Power, Save, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Configuration > Gestion agences — page en sections.
 * Section 1 : création d'une agence (delevery_agences).
 * Section 2 : liste des agences.
 */

const EMPTY_FORM = {
  nom: '',
  code: '',
  email: '',
  phone: '',
  phoneFixe: '',
  ville: '',
  adresse: '',
  active: 1
};

/** Modale d'édition d'une agence (le statut se gère via l'action activer/désactiver). */
function EditAgenceModal({ agence, onClose, onSaved }) {
  const [form, setForm] = useState({
    nom: agence.nom || '',
    code: agence.code || '',
    email: agence.email || '',
    phone: agence.phone || '',
    phoneFixe: agence.phoneFixe || '',
    ville: agence.ville || '',
    adresse: agence.adresse || ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.nom.trim() || !form.code.trim()) {
      setError("Le nom et le code de l'agence sont obligatoires.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/agences/${agence.id}`, {
        nom: form.nom.trim(),
        code: form.code.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        phoneFixe: form.phoneFixe.trim(),
        ville: form.ville.trim(),
        adresse: form.adresse.trim()
      });
      onSaved(agence.id, res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Pencil size={18} />
            <div className="cell-main">Modifier l'agence « {agence.nom} »</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom d'agence</span>
              <input
                type="text"
                value={form.nom}
                maxLength={255}
                onChange={(e) => setField('nom', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Code agence</span>
              <input
                type="text"
                value={form.code}
                maxLength={50}
                onChange={(e) => setField('code', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Email</span>
              <input
                type="text"
                value={form.email}
                maxLength={255}
                onChange={(e) => setField('email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Ville</span>
              <input
                type="text"
                value={form.ville}
                maxLength={255}
                onChange={(e) => setField('ville', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone mobile</span>
              <input
                type="text"
                value={form.phone}
                maxLength={20}
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone fixe</span>
              <input
                type="text"
                value={form.phoneFixe}
                maxLength={20}
                onChange={(e) => setField('phoneFixe', e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse</span>
              <input
                type="text"
                value={form.adresse}
                onChange={(e) => setField('adresse', e.target.value)}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau des agences : affichage, édition (modale) + activation/désactivation. */
function AgenceRow({ agence, onEdit, onToggled }) {
  const [toggling, setToggling] = useState(false);
  const actif = agence.active === 1;

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} l'agence « ${agence.nom} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/agences/${agence.id}/active`, { active: actif ? 0 : 1 });
      onToggled(agence.id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="cell-main">{agence.nom}</div>
      </td>
      <td>{agence.code}</td>
      <td>{agence.email || '—'}</td>
      <td>{agence.phone || '—'}</td>
      <td>{agence.phoneFixe || '—'}</td>
      <td>{agence.ville || '—'}</td>
      <td>{agence.adresse || '—'}</td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Active' : 'Désactivé'}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Modifier" onClick={() => onEdit(agence)}>
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={toggle}
            disabled={toggling}
          >
            <Power size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ---------- Section 1 : Gestion Agences ---------- */

function GestionAgencesSection() {
  const [agences, setAgences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [editing, setEditing] = useState(null);

  const pager = usePagination(agences, 'agence');

  useEffect(() => {
    api
      .get('/config/agences')
      .then((res) => setAgences(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des agences.'))
      .finally(() => setLoading(false));
  }, []);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function addAgence(e) {
    e.preventDefault();
    setFeedback(null);
    if (!form.nom.trim() || !form.code.trim()) {
      setFeedback({ type: 'error', text: "Le nom et le code de l'agence sont obligatoires." });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post('/config/agences', {
        ...form,
        nom: form.nom.trim(),
        code: form.code.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        phoneFixe: form.phoneFixe.trim(),
        ville: form.ville.trim(),
        adresse: form.adresse.trim()
      });
      setAgences((prev) =>
        [...prev, res.data].sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }))
      );
      setForm(EMPTY_FORM);
      setFeedback({ type: 'success', text: `Agence « ${res.data.nom} » ajoutée.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout de l'agence." });
    } finally {
      setAdding(false);
    }
  }

  function handleToggled(id, active) {
    setAgences((prev) => prev.map((a) => (a.id === id ? { ...a, active } : a)));
  }

  function handleEdited(id, data) {
    setAgences((prev) =>
      prev
        .map((a) => (a.id === id ? { ...a, ...data } : a))
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }))
    );
  }

  return (
    <>
      <section className="platform-card">
        <h2>
          <Plus size={18} /> Ajouter une agence
        </h2>

        <form className="statut-form agence-form" onSubmit={addAgence}>
          <label>
            <span className="field-label">Nom d'agence</span>
            <input
              type="text"
              value={form.nom}
              maxLength={255}
              placeholder="Agence Casa"
              onChange={(e) => setField('nom', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Code agence</span>
            <input
              type="text"
              value={form.code}
              maxLength={50}
              placeholder="OrtaCasa001"
              onChange={(e) => setField('code', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Email</span>
            <input
              type="text"
              value={form.email}
              maxLength={255}
              placeholder="agence@ortalog.ma"
              onChange={(e) => setField('email', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Téléphone mobile</span>
            <input
              type="text"
              value={form.phone}
              maxLength={20}
              placeholder="06 00 00 00 00"
              onChange={(e) => setField('phone', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Téléphone fixe</span>
            <input
              type="text"
              value={form.phoneFixe}
              maxLength={20}
              placeholder="05 00 00 00 00"
              onChange={(e) => setField('phoneFixe', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Ville</span>
            <input
              type="text"
              value={form.ville}
              maxLength={255}
              placeholder="Casablanca"
              onChange={(e) => setField('ville', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Adresse</span>
            <input
              type="text"
              value={form.adresse}
              placeholder="Adresse de l'agence"
              onChange={(e) => setField('adresse', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Status</span>
            <select value={form.active} onChange={(e) => setField('active', Number(e.target.value))}>
              <option value={1}>Active</option>
              <option value={0}>Désactivé</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding}>
            <Plus size={15} /> {adding ? 'Ajout…' : 'Ajouter'}
          </button>
        </form>
        {feedback && (
          <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
        )}
      </section>

      <section className="platform-card">
        <h2>
          <Building2 size={18} /> Liste des agences
        </h2>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Nom d'agence</th>
                <th>Code agence</th>
                <th>Email</th>
                <th>Tél. mobile</th>
                <th>Tél. fixe</th>
                <th>Ville</th>
                <th>Adresse</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {agences.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} className="datatable-empty">
                    Aucune agence trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((a) => (
                  <AgenceRow key={a.id} agence={a} onEdit={setEditing} onToggled={handleToggled} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />

        {editing && (
          <EditAgenceModal agence={editing} onClose={() => setEditing(null)} onSaved={handleEdited} />
        )}
      </section>
    </>
  );
}

/** Configuration > Gestion agences — page en sections. */
export default function Agences() {
  return (
    <div className="platform-page agences-page">
      <GestionAgencesSection />
    </div>
  );
}
