import { useEffect, useState } from 'react';
import { Pencil, Plus, Power, Save, Trash2, Users, X } from 'lucide-react';
import api from '../../api/client';
import { CLIENT_SERVICES, serviceLabels } from '../../config/clientServices';

/*
 * Page /client/equipe — gestion de l'équipe du client (réservée au
 * propriétaire du compte). Chaque membre a ses propres identifiants de
 * connexion (email + mot de passe) et une liste de tâches
 * attribuées (cases à cocher) ; toutes ses actions (saisie de colis,
 * mouvements de stock…) sont ensuite tracées à son nom dans le suivi.
 * API : /clients/me/equipe (contrôleur clientEquipe.controller.js).
 */

const EMPTY_FORM = {
  name: '',
  fonction: '',
  email: '',
  phone: '',
  password: '',
  password2: '',
  services: [],
  active: 1
};

/** "2026-08-23T14:05:00.000Z" (ou DATETIME MySQL) → "23/08/2026 14:05", sinon "—". */
function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  })}`;
}

/** Modale de création / édition d'un membre (formulaire partagé). */
function MembreModal({ membre, onClose, onSaved }) {
  const editing = Boolean(membre);
  const [form, setForm] = useState(
    editing
      ? {
          ...EMPTY_FORM,
          name: membre.name || '',
          fonction: membre.fonction || '',
          email: membre.email || '',
          phone: membre.phone || '',
          services: membre.services || []
        }
      : EMPTY_FORM
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toggleService(code) {
    setForm((prev) => ({
      ...prev,
      services: prev.services.includes(code)
        ? prev.services.filter((c) => c !== code)
        : [...prev.services, code]
    }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Le nom du membre est obligatoire.');
      return;
    }
    if (!form.email.trim()) {
      setError('Un email est obligatoire pour se connecter.');
      return;
    }
    if (!editing && form.password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (editing && form.password && form.password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (form.password !== form.password2) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        fonction: form.fonction.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        services: form.services
      };
      if (form.password) payload.password = form.password;
      let res;
      if (editing) {
        res = await api.put(`/clients/me/equipe/${membre.member_id}`, payload);
      } else {
        res = await api.post('/clients/me/equipe', { ...payload, active: form.active });
      }
      onSaved(res.data, editing);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du membre.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {editing ? <Pencil size={18} /> : <Plus size={18} />}
            <div className="cell-main">
              {editing ? `Modifier ${membre.name}` : 'Ajouter un membre'}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom complet</span>
              <input
                type="text"
                value={form.name}
                maxLength={191}
                placeholder="Nom du membre"
                onChange={(e) => setField('name', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Fonction</span>
              <input
                type="text"
                value={form.fonction}
                maxLength={100}
                placeholder="Caissier, préparateur…"
                onChange={(e) => setField('fonction', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Email de connexion</span>
              <input
                type="text"
                value={form.email}
                maxLength={250}
                placeholder="membre@exemple.com"
                onChange={(e) => setField('email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone</span>
              <input
                type="text"
                value={form.phone}
                maxLength={50}
                placeholder="06 00 00 00 00"
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Mot de passe</span>
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                placeholder={editing ? 'Laisser vide pour ne pas changer' : 'Au moins 8 caractères'}
                onChange={(e) => setField('password', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Confirmation du mot de passe</span>
              <input
                type="password"
                value={form.password2}
                autoComplete="new-password"
                placeholder={editing ? 'Laisser vide pour ne pas changer' : 'Retaper le mot de passe'}
                onChange={(e) => setField('password2', e.target.value)}
              />
            </label>
            {!editing && (
              <label>
                <span className="field-label">Status</span>
                <select value={form.active} onChange={(e) => setField('active', Number(e.target.value))}>
                  <option value={1}>Actif</option>
                  <option value={0}>Désactivé</option>
                </select>
              </label>
            )}
          </div>

          <div className="compte-menus">
            <span className="field-label">Tâches attribuées</span>
            <p className="compte-menus-note">
              Cochez les tâches que ce membre pourra effectuer : son menu sera limité à ces
              tâches et chacune de ses actions sera enregistrée à son nom.
            </p>
            <div className="compte-menus-grid">
              {CLIENT_SERVICES.map((s) => (
                <label key={s.code} className="compte-menu-item">
                  <input
                    type="checkbox"
                    checked={form.services.includes(s.code)}
                    onChange={() => toggleService(s.code)}
                  />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
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

/** Ligne du tableau des membres : édition, activation/désactivation, suppression. */
function MembreRow({ membre, onEdit, onToggled, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const actif = membre.active === 1;
  const taches = serviceLabels(membre.services || []);

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le compte de « ${membre.name} » ?`)) return;
    setBusy(true);
    try {
      const res = await api.patch(`/clients/me/equipe/${membre.member_id}/active`, {
        active: actif ? 0 : 1
      });
      onToggled(membre.member_id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Voulez-vous vraiment supprimer « ${membre.name} » de votre équipe ?\n` +
          'Il ne pourra plus se connecter ; ses actions passées restent enregistrées à son nom.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.delete(`/clients/me/equipe/${membre.member_id}`);
      onDeleted(membre.member_id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusy(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="cell-main">{membre.name}</div>
        {membre.fonction && <div className="cell-sub">{membre.fonction}</div>}
      </td>
      <td>
        <div className="cell-main">{membre.email || '—'}</div>
        <div className="cell-sub">{membre.phone || ''}</div>
      </td>
      <td>
        {taches.length === 0 ? (
          '—'
        ) : (
          <div className="equipe-taches">
            {taches.map((label) => (
              <span key={label} className="badge">
                {label}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>{formatDateTime(membre.last_login_at)}</td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Actif' : 'Désactivé'}
        </span>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Modifier" onClick={() => onEdit(membre)}>
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={toggle}
            disabled={busy}
          >
            <Power size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title="Supprimer"
            onClick={remove}
            disabled={busy}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Page /client/equipe — liste des membres + modale de création / édition. */
export default function Equipe() {
  const [membres, setMembres] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // null | { membre: null | {...} }

  useEffect(() => {
    let cancelled = false;
    api
      .get('/clients/me/equipe')
      .then((res) => {
        if (!cancelled) setMembres(res.data.membres);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || "Erreur de chargement de l'équipe.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(data, editing) {
    setMembres((prev) =>
      editing ? prev.map((m) => (m.member_id === data.member_id ? data : m)) : [...prev, data]
    );
  }

  function handleToggled(id, active) {
    setMembres((prev) => prev.map((m) => (m.member_id === id ? { ...m, active } : m)));
  }

  function handleDeleted(id) {
    setMembres((prev) => prev.filter((m) => m.member_id !== id));
  }

  return (
    <section className="platform-card fiche-card">
      <header className="fiche-head">
        <span className="fiche-head-icon">
          <Users size={22} />
        </span>
        <div className="fiche-head-text">
          <h2>Mon équipe</h2>
          <p className="fiche-head-sub">
            Chaque membre a ses propres identifiants de connexion et n'accède qu'aux tâches que
            vous lui attribuez ; toutes ses actions (colis, stock…) sont enregistrées à son nom.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setModal({ membre: null })}>
          <Plus size={15} /> Ajouter un membre
        </button>
      </header>

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Membre</th>
              <th>Identifiants de connexion</th>
              <th>Tâches attribuées</th>
              <th>Dernière connexion</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {membres.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} className="datatable-empty">
                  Aucun membre : ajoutez votre premier membre d'équipe.
                </td>
              </tr>
            ) : (
              membres.map((m) => (
                <MembreRow
                  key={m.member_id}
                  membre={m}
                  onEdit={(membre) => setModal({ membre })}
                  onToggled={handleToggled}
                  onDeleted={handleDeleted}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal && <MembreModal membre={modal.membre} onClose={() => setModal(null)} onSaved={handleSaved} />}
    </section>
  );
}
