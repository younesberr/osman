import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { hasAccess, hasTypeAccess } from '../config/adminMenu';

/** Garde d'accès par service (has_access) et par fonction (`types`) : sinon retour à l'accueil admin. */
export default function ServiceRoute({ service, types, children }) {
  const { user } = useAuth();
  if (!hasAccess(user, service) || !hasTypeAccess(user, types)) {
    return <Navigate to="/admin" replace />;
  }
  return children;
}
