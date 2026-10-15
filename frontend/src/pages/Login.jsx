import { useState } from 'react';
import { BRAND } from '../config/brand';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Brand from '../components/Brand';
import { adminHomePath } from '../config/adminMenu';

export default function Login() {
  const [tab, setTab] = useState('clients');
  const [identifiant, setIdentifiant] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const user = await login(tab, identifiant.trim(), password);
      // Le livreur arrive directement sur sa liste des colis,
      // le ramasseur (type 6, sans Accueil) sur Ramassage par scan.
      let target = `/${user.dashboard}`;
      if (user.dashboard === 'livreur') target = '/livreur/colis';
      else if (user.dashboard === 'admin') target = adminHomePath(user) || '/admin';
      navigate(target, { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Connexion impossible. Vérifiez le serveur.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <Link to="/">
          <Brand className="login-brand" />
        </Link>
        <h1>Connexion</h1>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'clients'}
            className={tab === 'clients' ? 'tab active' : 'tab'}
            onClick={() => { setTab('clients'); setError(''); }}
          >
            Clients
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'employes'}
            className={tab === 'employes' ? 'tab active' : 'tab'}
            onClick={() => { setTab('employes'); setError(''); }}
          >
            Employés
          </button>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          <label htmlFor="identifiant">Email</label>
          <input
            id="identifiant"
            type="email"
            value={identifiant}
            onChange={(e) => setIdentifiant(e.target.value)}
            placeholder={tab === 'clients' ? 'client@exemple.com' : `employe@${BRAND.emailDomain}`}
            maxLength={100}
            required
          />

          <label htmlFor="password">Mot de passe</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            maxLength={200}
            required
          />

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? 'Connexion…' : `Se connecter (${tab === 'clients' ? 'Client' : 'Employé'})`}
          </button>
        </form>

        <Link to="/" className="login-back">
          ← Retour à l'accueil
        </Link>
      </div>
    </div>
  );
}
