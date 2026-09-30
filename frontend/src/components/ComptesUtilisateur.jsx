import { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../config/brand';
import { KeyRound, Pencil, Plus, Power, Save, X } from 'lucide-react';
import api from '../api/client';
import SearchableSelect from './SearchableSelect';
import {
  SERVICE_LABELS,
  TYPE_RULES,
  serviceLabels
} from '../config/typeServices';

/*
 * Fiche utilisateur, onglet "Comptes" : coordonnées d'accès de la personne.
 * Chaque compte correspond à une fonction (users_type) et possède ses propres
 * identifiants de connexion ; le compte principal est la ligne affichée dans
 * la datatable Utilisateurs, les secondaires sont créés depuis cet onglet
 * (API /users/:id/comptes).
 */

const TYPE_LABELS = {
  SUPER_ADMIN: 'Super admin',
  RESPONSABLE_SERVICE: 'Responsable service',
  RESPONSABLE_AGENCE: "Responsable d'agence",
  AGENT_AGENCE: "Agent d'agence",
  RAMASSEUR: 'Ramasseur',
  LIVREUR: 'Livreur'
};

const EMPTY_FORM = {
  users_type: '',
  users_email: '',
  users_phone: '',
  password: '',
  password2: '',
  users_ville_id: '',
  services: [],
  users_active: 1
};

/** Modale de création / édition d'un compte (formulaire partagé). */
function CompteModal({ userId, compte, comptes, filtres, onClose, onSaved }) {
  const editing = Boolean(compte);
  const [form, setForm] = useState(
    editing
      ? {
          ...EMPTY_FORM,
          users_type: String(compte.users_type ?? ''),
          users_email: compte.users_email || '',
          users_phone: compte.users_phone || '',
          users_ville_id: compte.users_ville_id != null ? String(compte.users_ville_id) : '',
          services: compte.services || []
        }
      : EMPTY_FORM
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /* Une fonction ne peut être prise que par un seul compte de la personne. */
  const typesPris = useMemo(
    () =>
      new Set(
        comptes
          .filter((c) => !editing || c.users_id !== compte.users_id)
          .map((c) => Number(c.users_type))
      ),
    [comptes, editing, compte]
  );

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  /* Règles d'accès de la fonction sélectionnée (menus par défaut / cochables). */
  const typeNum = Number(form.users_type);
  const rules = TYPE_RULES[typeNum];

  /* Changer de fonction remet à zéro les menus cochés. */
  function setType(value) {
    setForm((prev) => ({
      ...prev,
      users_type: value,
      services: []
    }));
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
    if (!form.users_type) {
      setError('Choisissez une fonction pour ce compte.');
      return;
    }
    if (!form.users_email.trim()) {
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
        users_type: Number(form.users_type),
        users_email: form.users_email.trim(),
        users_phone: form.users_phone.trim(),
        users_ville_id: form.users_ville_id || '',
        services: form.services
      };
      if (form.password) payload.password = form.password;
      let res;
      if (editing) {
        res = await api.put(`/users/${userId}/comptes/${compte.users_id}`, payload);
      } else {
        res = await api.post(`/users/${userId}/comptes`, {
          ...payload,
          users_active: form.users_active
        });
      }
      onSaved(res.data, editing);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du compte.");
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
              {editing
                ? `Modifier le compte ${TYPE_LABELS[compte.type_code] || compte.type_code || ''}`
                : 'Ajouter un compte'}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Fonction</span>
              <select
                value={form.users_type}
                disabled={editing && compte.principal}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="">— Choisir une fonction —</option>
                {filtres.types.map((t) => (
                  <option
                    key={t.user_types_id}
                    value={t.user_types_id}
                    disabled={typesPris.has(Number(t.user_types_id))}
                  >
                    {TYPE_LABELS[t.user_types_code] || t.user_types_code}
                  </option>
                ))}
              </select>
            </label>
            {/* L'agence n'est plus saisie : dérivée de la ville de fonction (zone → agence). */}
            <div>
              <span className="field-label">Ville de fonction</span>
              <SearchableSelect
                value={form.users_ville_id}
                onChange={(v) => setField('users_ville_id', String(v))}
                placeholder="— Aucune —"
                options={filtres.villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))}
              />
            </div>
            <label>
              <span className="field-label">Email de connexion</span>
              <input
                type="text"
                value={form.users_email}
                maxLength={250}
                placeholder={`compte@${BRAND.emailDomain}`}
                onChange={(e) => setField('users_email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone</span>
              <input
                type="text"
                value={form.users_phone}
                maxLength={50}
                placeholder="06 00 00 00 00"
                onChange={(e) => setField('users_phone', e.target.value)}
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
                <select
                  value={form.users_active}
                  onChange={(e) => setField('users_active', Number(e.target.value))}
                >
                  <option value={1}>Actif</option>
                  <option value={0}>Désactivé</option>
                </select>
              </label>
            )}
          </div>

          {rules && (typeNum === 1 || rules.defaults.length > 0 || rules.optional.length > 0) && (
            <div className="compte-menus">
              <span className="field-label">Menus accessibles</span>
              {typeNum === 1 && (
                <p className="compte-menus-note">
                  Le super admin a accès à toutes les fonctionnalités et à tous les menus.
                </p>
              )}
              {typeNum === 2 && (
                <p className="compte-menus-note">
                  Cochez les menus auxquels ce compte aura accès.
                </p>
              )}
              {rules.defaults.length > 0 && (
                <p className="compte-menus-note">
                  Accès automatique : {serviceLabels(rules.defaults).join(', ')}.
                </p>
              )}
              {rules.optional.length > 0 && (
                <>
                  {typeNum !== 2 && (
                    <p className="compte-menus-note">Menus supplémentaires à accorder :</p>
                  )}
                  <div className="compte-menus-grid">
                    {rules.optional.map((code) => (
                      <label key={code} className="compte-menu-item">
                        <input
                          type="checkbox"
                          checked={form.services.includes(code)}
                          onChange={() => toggleService(code)}
                        />
                        <span>{SERVICE_LABELS[code]}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

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

/**
 * Modale « Ma fiche » : un employé ne modifie que SES identifiants de connexion
 * (email, téléphone, mot de passe) — PUT /users/me/comptes/:compteId.
 */
function CompteSelfModal({ apiBase, compte, onClose, onSaved }) {
  const [form, setForm] = useState({
    users_email: compte.users_email || '',
    users_phone: compte.users_phone || '',
    password: '',
    password2: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.users_email.trim()) {
      setError('Un email est obligatoire pour se connecter.');
      return;
    }
    if (form.password && form.password.length < 8) {
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
        users_email: form.users_email.trim(),
        users_phone: form.users_phone.trim()
      };
      if (form.password) payload.password = form.password;
      const res = await api.put(`${apiBase}/comptes/${compte.users_id}`, payload);
      onSaved(res.data, true);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du compte.");
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
            <div className="cell-main">
              {`Mes identifiants — compte ${TYPE_LABELS[compte.type_code] || compte.type_code || ''}`}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Email de connexion</span>
              <input
                type="text"
                value={form.users_email}
                maxLength={250}
                placeholder={`compte@${BRAND.emailDomain}`}
                onChange={(e) => setField('users_email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone</span>
              <input
                type="text"
                value={form.users_phone}
                maxLength={50}
                placeholder="06 00 00 00 00"
                onChange={(e) => setField('users_phone', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Mot de passe</span>
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                placeholder="Laisser vide pour ne pas changer"
                onChange={(e) => setField('password', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Confirmation du mot de passe</span>
              <input
                type="password"
                value={form.password2}
                autoComplete="new-password"
                placeholder="Laisser vide pour ne pas changer"
                onChange={(e) => setField('password2', e.target.value)}
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

/** Ligne du tableau des comptes : édition (modale) + activation/désactivation (secondaires).
 * `selfEdit` : uniquement le crayon (identifiants), jamais l'activation. */
function CompteRow({ compte, readOnly, selfEdit, onEdit, onToggled }) {
  const [toggling, setToggling] = useState(false);
  const actif = compte.users_active === 1;
  const fonction = TYPE_LABELS[compte.type_code] || compte.type_code || '—';

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le compte « ${fonction} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/users/${compte.parentId}/comptes/${compte.users_id}/active`, {
        active: actif ? 0 : 1
      });
      onToggled(compte.users_id, res.data.users_active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="cell-main">
          {fonction} {compte.principal && <span className="badge">Principal</span>}
        </div>
      </td>
      <td>{compte.users_email || '—'}</td>
      <td>{compte.users_phone || '—'}</td>
      <td>
        <div className="cell-main">{compte.agence || '—'}</div>
        {compte.zone && <div className="cell-sub">{compte.zone}</div>}
      </td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Actif' : 'Désactivé'}
        </span>
      </td>
      {(!readOnly || selfEdit) && (
        <td>
          <div className="row-actions">
            <button
              type="button"
              className="row-action"
              title={selfEdit ? 'Modifier mes identifiants' : 'Modifier'}
              onClick={() => onEdit(compte)}
            >
              <Pencil size={16} />
            </button>
            {!readOnly && !compte.principal && (
              <button
                type="button"
                className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
                title={actif ? 'Désactiver' : 'Activer'}
                onClick={toggle}
                disabled={toggling}
              >
                <Power size={16} />
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

/**
 * Onglet "Comptes" de la fiche utilisateur.
 * `readOnly` (page « Ma fiche ») : pas de création ni d'activation, et pas
 * d'appel à /users/filtres (réservé au service UTILISATEURS). Combiné à
 * `selfEdit`, l'employé peut quand même modifier les identifiants de connexion
 * (email / téléphone / mot de passe) de ses propres comptes.
 * `apiBase` permet d'utiliser les routes /users/me.
 */
export default function ComptesUtilisateur({
  userId,
  apiBase = `/users/${userId}`,
  readOnly = false,
  selfEdit = false
}) {
  const [comptes, setComptes] = useState([]);
  const [filtres, setFiltres] = useState({ types: [], villes: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // null | { compte: null | {...} }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    Promise.all([
      api.get(`${apiBase}/comptes`),
      readOnly ? Promise.resolve(null) : api.get('/users/filtres')
    ])
      .then(([comptesRes, filtresRes]) => {
        if (cancelled) return;
        setComptes(comptesRes.data.comptes);
        if (filtresRes) {
          setFiltres({
            types: filtresRes.data.types,
            villes: filtresRes.data.villes || []
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Erreur de chargement des comptes.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function handleSaved(data, editing) {
    setComptes((prev) =>
      editing ? prev.map((c) => (c.users_id === data.users_id ? data : c)) : [...prev, data]
    );
  }

  function handleToggled(id, active) {
    setComptes((prev) => prev.map((c) => (c.users_id === id ? { ...c, users_active: active } : c)));
  }

  return (
    <section className="platform-card fiche-card">
      <header className="fiche-head">
        <span className="fiche-head-icon">
          <KeyRound size={22} />
        </span>
        <div className="fiche-head-text">
          <h2>Comptes d'accès</h2>
          <p className="fiche-head-sub">
            Chaque compte correspond à une fonction et possède son propre email de connexion,
            unique d'un compte à l'autre ; le téléphone peut être partagé.
          </p>
        </div>
        {!readOnly && (
          <button type="button" className="btn btn-primary" onClick={() => setModal({ compte: null })}>
            <Plus size={15} /> Ajouter un compte
          </button>
        )}
      </header>

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Fonction</th>
              <th>Email de connexion</th>
              <th>Téléphone</th>
              <th>Agence</th>
              <th>Status</th>
              {(!readOnly || selfEdit) && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {comptes.length === 0 && !loading ? (
              <tr>
                <td colSpan={readOnly && !selfEdit ? 5 : 6} className="datatable-empty">
                  Aucun compte trouvé.
                </td>
              </tr>
            ) : (
              comptes.map((c) => (
                <CompteRow
                  key={c.users_id}
                  compte={{ ...c, parentId: userId }}
                  readOnly={readOnly}
                  selfEdit={selfEdit}
                  onEdit={(compte) => setModal({ compte })}
                  onToggled={handleToggled}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal && selfEdit ? (
        <CompteSelfModal
          apiBase={apiBase}
          compte={modal.compte}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : modal ? (
        <CompteModal
          userId={userId}
          compte={modal.compte}
          comptes={comptes}
          filtres={filtres}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : null}
    </section>
  );
}
