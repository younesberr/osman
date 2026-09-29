import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/** Protège une route : exige un utilisateur connecté avec le bon dashboard. */
export default function ProtectedRoute({ dashboard, children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="page-loader">Chargement…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.dashboard !== dashboard) {
    return <Navigate to={`/${user.dashboard}`} replace />;
  }
  return children;
}
