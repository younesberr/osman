import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { hasClientAccess } from '../config/clientServices';

/**
 * Garde d'accès des pages client pour les membres d'équipe (tâches attribuées
 * sur /client/equipe) : sinon retour à l'accueil client. Le propriétaire
 * passe toujours (miroir de ServiceRoute pour le dashboard admin).
 */
export default function ClientServiceRoute({ service, children }) {
  const { user } = useAuth();
  if (!hasClientAccess(user, service)) {
    return <Navigate to="/client" replace />;
  }
  return children;
}
