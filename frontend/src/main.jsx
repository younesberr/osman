import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { PlatformProvider } from './context/PlatformContext';
// Font Awesome 6 auto-hébergé (icônes de la page d'accueil, des pages
// publiques et de quelques pages admin/livreur) : plus de CSS bloquant depuis
// cdnjs. Seuls les styles utilisés (solid + brands) sont embarqués ; les
// polices sortent hashées dans /assets (cache un an).
import '@fortawesome/fontawesome-free/css/fontawesome.min.css';
import '@fortawesome/fontawesome-free/css/solid.min.css';
import '@fortawesome/fontawesome-free/css/brands.min.css';
import './styles.css';

// Après un déploiement, les chunks de l'ancien build n'existent plus : un
// onglet resté ouvert échoue à charger une page différée (React.lazy).
// On recharge alors la page une fois pour repartir sur le nouveau build.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'ortalog:preload-reload';
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 10000) return; // pas de boucle de rechargements
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage indisponible : on tente un rechargement quand même.
  }
  event.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </PlatformProvider>
    </BrowserRouter>
  </React.StrictMode>
);
