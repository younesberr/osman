import { Link } from 'react-router-dom';
import HomeFooter from '../components/HomeFooter';
import { BRAND, HOME_INFO } from '../config/brand';
import '../home.css';
import PublicLogo from '../components/PublicLogo';

/**
 * Page publique « Mentions légales » — portage de l'ancienne page PHP
 * (ancien site PHP), complétée avec les vraies coordonnées
 * de la société (l'ancienne page contenait des valeurs à remplir du type
 * « ICE : 00XXXXXXXX »), dans l'habillage public du nouveau site.
 */
export default function MentionsLegales() {
  return (
    <div className="home-ar" dir="rtl" lang="ar">
      <nav className="navbar-custom">
        <div className="container page-nav-inner">
          <Link to="/" className="btn-nav-solid">
            <i className="fa fa-home" /> الرئيسية
          </Link>
          <Link to="/" className="navbar-brand">
            <PublicLogo className="logo-header" />
          </Link>
        </div>
      </nav>

      <div className="tarifs-hero">
        <div className="container">
          <div className="tarifs-hero-badge">
            <i className="fa fa-scale-balanced" /> الإشارات القانونية
          </div>
          <h1>الإشارات القانونية</h1>
          <p>Mentions légales — {BRAND.name}</p>
        </div>
      </div>

      <section className="legal-section">
        <div className="container">
          <div className="legal-container" dir="ltr" lang="fr">
            <h2>
              <i className="fa fa-building" /> 1. Présentation du site
            </h2>
            <p>
              <strong>{BRAND.name}</strong> est une société spécialisée dans la livraison de colis
              partout au Maroc.
            </p>
            <p>
              Site officiel : <strong>{HOME_INFO.siteWeb}</strong>
            </p>
            <p>
              <strong>Propriétaire :</strong> {HOME_INFO.raisonSociale}, au capital de{' '}
              {HOME_INFO.capital} dirhams
            </p>
            <p>
              <strong>Siège social :</strong> {HOME_INFO.siegeFr}
            </p>
            <p>
              <strong>RC :</strong> {HOME_INFO.rc} ({HOME_INFO.rcVille})
            </p>
            <p>
              <strong>ICE :</strong> {HOME_INFO.ice}
            </p>
            <p>
              <strong>Email :</strong>{' '}
              <a href={`mailto:${HOME_INFO.email}`}>{HOME_INFO.email}</a>
            </p>
            <p>
              <strong>Téléphone :</strong>{' '}
              <a href={`tel:${HOME_INFO.phone}`}>{HOME_INFO.phone}</a>
            </p>

            <h2>
              <i className="fa fa-server" /> 2. Hébergement
            </h2>
            <p>Le site est hébergé par :</p>
            <p>
              <strong>{HOME_INFO.hebergeur.nom}</strong>
            </p>
            {HOME_INFO.hebergeur.url && (
              <p>
                <a href={HOME_INFO.hebergeur.url} target="_blank" rel="noopener noreferrer">
                  {HOME_INFO.hebergeur.url}
                </a>
              </p>
            )}

            <h2>
              <i className="fa fa-copyright" /> 3. Propriété intellectuelle
            </h2>
            <p>
              Le contenu du site {BRAND.name} (textes, images, logos, design, etc.) est protégé par
              le droit d'auteur. Toute reproduction, distribution ou modification sans
              autorisation écrite est strictement interdite.
            </p>

            <h2>
              <i className="fa fa-user-shield" /> 4. Collecte et protection des données
            </h2>
            <p>
              {BRAND.name} s'engage à protéger les informations personnelles collectées via
              l'inscription clients ou le suivi des colis.
            </p>
            <p>Aucune donnée ne sera vendue ou partagée avec des tiers sans consentement.</p>

            <h2>
              <i className="fa fa-cookie-bite" /> 5. Cookies
            </h2>
            <p>
              Le site utilise des cookies uniquement pour améliorer l'expérience utilisateur et
              analyser la performance du site.
            </p>

            <h2>
              <i className="fa fa-triangle-exclamation" /> 6. Responsabilité
            </h2>
            <p>
              {BRAND.name} s'efforce de fournir des informations exactes mais ne peut garantir
              l'absence totale d'erreurs.
            </p>

            <h2>
              <i className="fa fa-envelope-open-text" /> 7. Contact
            </h2>
            <p>Pour toute question concernant les mentions légales, contactez-nous :</p>
            <p>
              <strong>Email :</strong>{' '}
              <a href={`mailto:${HOME_INFO.email}`}>{HOME_INFO.email}</a>
            </p>
          </div>
        </div>
      </section>

      <HomeFooter />
    </div>
  );
}
