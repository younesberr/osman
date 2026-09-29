import { useEffect, useState } from 'react';
import { Check, KeyRound, UserRound } from 'lucide-react';
import api from '../../api/client';

/**
 * « Ma fiche » d'un membre d'équipe client (sous-compte, /client/ma-fiche) :
 * un seul onglet "Compte" limité à la section Compte — email de connexion et
 * mot de passe (GET / PUT /clients/me/membre-compte). Le reste de la fiche
 * (informations, facturation) appartient au propriétaire du compte client ;
 * nom, fonction et tâches du membre sont gérés sur /client/equipe.
 */
export default function MaFicheMembre() {
  const [compte, setCompte] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', password2: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/clients/me/membre-compte')
      .then((res) => {
        if (cancelled) return;
        setCompte(res.data);
        setForm((prev) => ({ ...prev, email: res.data.email || '' }));
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

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save() {
    if (form.password && form.password.length < 8) {
      setFeedback({ type: 'error', text: 'Le mot de passe doit contenir au moins 8 caractères.' });
      return;
    }
    if (form.password !== form.password2) {
      setFeedback({ type: 'error', text: 'Les deux mots de passe ne correspondent pas.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const payload = { email: form.email };
      if (form.password) payload.password = form.password;
      const res = await api.put('/clients/me/membre-compte', payload);
      setCompte(res.data);
      setForm({ email: res.data.email || '', password: '', password2: '' });
      setFeedback({ type: 'success', text: 'Compte enregistré.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="cell-sub">Chargement de la fiche…</p>;
  if (error) return <div className="form-error">{error}</div>;
  if (!compte) return null;

  return (
    <div className="fiche-page">
      <nav className="fiche-tabs" aria-label="Onglets de la fiche">
        <button type="button" className="fiche-tab active">
          <KeyRound size={15} /> Compte
        </button>
      </nav>

      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <KeyRound size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Compte — {compte.name}</h2>
            <p className="fiche-head-sub">
              {[compte.fonction, compte.store && `Équipe de ${compte.store}`]
                .filter(Boolean)
                .join(' · ') || 'Membre d’équipe'}
            </p>
          </div>
          <div className="fiche-head-role">
            <span className="fiche-hint">Rôle(s) / mission(s)</span>
            <span className="badge fiche-role-badge">
              <UserRound size={13} /> Membre d’équipe
            </span>
          </div>
        </header>

        <h3 className="fiche-section-title">
          <KeyRound size={15} /> Compte
        </h3>
        <p className="fiche-hint">
          Vous pouvez modifier uniquement votre email de connexion et votre mot de passe. Les
          autres informations (nom, fonction, tâches) sont gérées par le propriétaire du compte.
        </p>
        <div className="fiche-grid">
          <label className="fiche-field span-2">
            <span className="field-label">Adresse électronique (connexion)</span>
            <input type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} />
          </label>
          <label className="fiche-field">
            <span className="field-label">Mot de passe</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Laisser vide pour ne pas changer"
              value={form.password}
              onChange={(e) => setField('password', e.target.value)}
            />
          </label>
          <label className="fiche-field">
            <span className="field-label">Confirmation de mot de passe</span>
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Retaper le mot de passe"
              value={form.password2}
              onChange={(e) => setField('password2', e.target.value)}
            />
          </label>
        </div>

        <div className="fiche-inline-actions">
          {feedback && (
            <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
              {feedback.text}
            </span>
          )}
          <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={save}>
            <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </section>
    </div>
  );
}
