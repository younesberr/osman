import { Link } from 'react-router-dom';
import HomeFooter from '../components/HomeFooter';
import { HOME_INFO } from '../config/homeInfo';
import '../home.css';

/**
 * Page publique « Conditions d'utilisation & Politique de confidentialité »
 * — portage de l'ancienne page PHP (orta/files/conditions_utilisation.php) :
 * document français (sommaire à ancres, cartes numérotées, carte contact)
 * dans l'habillage public du nouveau site. C'est la page ouverte par la
 * case de consentement CGU du formulaire /register.
 */
const SOMMAIRE = [
  { id: 'art1', label: '1. Acceptation' },
  { id: 'art2', label: '2. Description du service' },
  { id: 'art3', label: '3. Création de compte' },
  { id: 'art4', label: '4. Obligations' },
  { id: 'art5', label: '5. Confidentialité' },
  { id: 'art6', label: '6. Cookies' },
  { id: 'art7', label: '7. Modifications' },
  { id: 'art8', label: '8. Contact' }
];

export default function ConditionsUtilisation() {
  return (
    <div className="home-ar" dir="rtl" lang="ar">
      <nav className="navbar-custom">
        <div className="container page-nav-inner">
          <Link to="/" className="btn-nav-solid">
            <i className="fa fa-home" /> الرئيسية
          </Link>
          <Link to="/" className="navbar-brand">
            <img className="logo-header" src="/home/header-logo.png" width="780" height="220" alt="أورطالوج" />
          </Link>
        </div>
      </nav>

      <div className="tarifs-hero">
        <div className="container">
          <div className="tarifs-hero-badge">
            <i className="fa fa-shield-halved" /> وثيقة قانونية
          </div>
          <h1>شروط الاستخدام وسياسة الخصوصية</h1>
          <p>Conditions d'utilisation &amp; Politique de confidentialité — ORTALOG</p>
        </div>
      </div>

      <section className="legal-section">
        <div className="container">
          <div className="cond-content" dir="ltr" lang="fr">
            <div className="cond-toc">
              <h2>
                <i className="fa fa-list" /> Sommaire
              </h2>
              <ul className="cond-toc-list">
                {SOMMAIRE.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`}>{s.label}</a>
                  </li>
                ))}
              </ul>
            </div>

            <div className="cond-card" id="art1">
              <div className="cond-card-header">
                <div className="cond-num">1</div>
                <h2>Acceptation des conditions</h2>
              </div>
              <p>
                En créant un compte sur la plateforme <strong>ORTALOG</strong>, vous acceptez
                sans réserve les présentes Conditions d'utilisation. Si vous n'acceptez pas ces
                conditions, veuillez ne pas utiliser nos services.
              </p>
            </div>

            <div className="cond-card" id="art2">
              <div className="cond-card-header">
                <div className="cond-num">2</div>
                <h2>Description du service</h2>
              </div>
              <p>
                ORTALOG est une société de livraison de colis au Maroc. La plateforme permet aux
                clients professionnels de créer et suivre leurs expéditions, de gérer leur
                inventaire et de consulter leurs relevés financiers.
              </p>
            </div>

            <div className="cond-card" id="art3">
              <div className="cond-card-header">
                <div className="cond-num">3</div>
                <h2>Création de compte</h2>
              </div>
              <p>
                Pour accéder aux services, vous devez créer un compte en fournissant des
                informations exactes et à jour. Vous êtes seul responsable de la confidentialité
                de vos identifiants de connexion. Toute activité effectuée depuis votre compte
                est placée sous votre responsabilité.
              </p>
            </div>

            <div className="cond-card" id="art4">
              <div className="cond-card-header">
                <div className="cond-num">4</div>
                <h2>Obligations de l'utilisateur</h2>
              </div>
              <ul>
                <li>
                  Fournir des informations véridiques lors de l'inscription et lors de la
                  création de colis.
                </li>
                <li>Ne pas utiliser la plateforme à des fins illicites ou frauduleuses.</li>
                <li>Ne pas tenter d'accéder aux données d'autres utilisateurs.</li>
                <li>Signaler toute anomalie ou accès non autorisé à votre compte.</li>
              </ul>
            </div>

            <div className="cond-card" id="art5">
              <div className="cond-card-header">
                <div className="cond-num">5</div>
                <h2>Politique de confidentialité</h2>
              </div>

              <h3>5.1 Données collectées</h3>
              <p>
                Dans le cadre de la gestion de votre compte et du traitement de vos expéditions,
                ORTALOG collecte les données suivantes&nbsp;:
              </p>
              <ul>
                <li>Nom complet, CIN / pièce d'identité</li>
                <li>Adresse e-mail et numéro(s) de téléphone</li>
                <li>Adresse postale et ville</li>
                <li>
                  Données bancaires (RIB, banque) — uniquement pour le règlement des prestations
                </li>
                <li>Données relatives aux colis (destinataires, adresses de livraison)</li>
              </ul>

              <h3>5.2 Finalité du traitement</h3>
              <p>Les données personnelles collectées sont utilisées exclusivement pour&nbsp;:</p>
              <ul>
                <li>La gestion de votre compte client</li>
                <li>Le traitement et le suivi de vos expéditions</li>
                <li>La facturation et le règlement financier</li>
                <li>
                  La communication relative à vos opérations (notifications, e-mails de
                  confirmation)
                </li>
                <li>L'amélioration continue de nos services</li>
              </ul>

              <h3>5.3 Partage des données</h3>
              <p>
                ORTALOG ne vend ni ne loue vos données personnelles à des tiers. Vos données
                peuvent être partagées uniquement avec nos sous-traitants opérationnels
                (livreurs, coursiers) dans le strict cadre de l'exécution du service, sous
                accord de confidentialité.
              </p>

              <h3>5.4 Conservation des données</h3>
              <p>
                Vos données sont conservées pendant toute la durée de votre relation commerciale
                avec ORTALOG, et jusqu'à 5 ans après la fin de celle-ci, conformément aux
                obligations légales marocaines.
              </p>

              <h3>5.5 Sécurité</h3>
              <p>
                ORTALOG met en œuvre des mesures techniques et organisationnelles appropriées
                pour protéger vos données contre tout accès non autorisé, perte ou altération.
              </p>

              <h3>5.6 Vos droits</h3>
              <p>
                Conformément à la <strong>loi 09-08</strong> relative à la protection des
                personnes physiques à l'égard du traitement des données à caractère personnel,
                vous disposez des droits suivants&nbsp;:
              </p>
              <ul>
                <li>
                  <strong>Droit d'accès</strong> — obtenir une copie de vos données personnelles
                </li>
                <li>
                  <strong>Droit de rectification</strong> — corriger des données inexactes ou
                  incomplètes
                </li>
                <li>
                  <strong>Droit d'opposition</strong> — vous opposer au traitement de vos
                  données pour un motif légitime
                </li>
              </ul>
              <p>
                Pour exercer ces droits, contactez-nous à&nbsp;:{' '}
                <strong>{HOME_INFO.email}</strong>
              </p>
            </div>

            <div className="cond-card" id="art6">
              <div className="cond-card-header">
                <div className="cond-num">6</div>
                <h2>Cookies</h2>
              </div>
              <p>
                La plateforme utilise des cookies de session nécessaires au bon fonctionnement
                du service (maintien de la connexion, sécurité du formulaire). Aucun cookie de
                traçage publicitaire n'est utilisé.
              </p>
            </div>

            <div className="cond-card" id="art7">
              <div className="cond-card-header">
                <div className="cond-num">7</div>
                <h2>Modification des conditions</h2>
              </div>
              <p>
                ORTALOG se réserve le droit de modifier les présentes conditions à tout moment.
                Toute modification substantielle sera notifiée par e-mail ou par une annonce
                visible lors de votre connexion.
              </p>
            </div>

            <div className="cond-contact" id="art8">
              <h2>
                <i className="fa fa-envelope" /> Contact
              </h2>
              <div className="cond-contact-grid">
                <div className="cond-contact-item">
                  <strong>Société&nbsp;:</strong> {HOME_INFO.raisonSociale} —{' '}
                  {HOME_INFO.rcVille}, Maroc
                </div>
                <div className="cond-contact-item">
                  <strong>E-mail&nbsp;:</strong>{' '}
                  <a href={`mailto:${HOME_INFO.email}`}>{HOME_INFO.email}</a>
                </div>
                <div className="cond-contact-item">
                  <strong>Site&nbsp;:</strong>{' '}
                  <a href="https://www.ortalog.ma" target="_blank" rel="noopener noreferrer">
                    {HOME_INFO.siteWeb}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <HomeFooter />
    </div>
  );
}
