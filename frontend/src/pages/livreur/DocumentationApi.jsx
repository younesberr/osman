import { BASE_URL, CopyBtn, Code, Endpoint, Params, Section, ApiToc } from '../../components/ApiDocBlocks';
import { BRAND } from '../../config/brand';

/*
 * Documentation API du dashboard livreur (/livreur/api) : page statique
 * décrivant les endpoints ouverts aux comptes livreur (fonction Livreur,
 * users_type 5) pour connecter une plateforme externe à la plateforme.
 * Seuls les endpoints les plus utilisés sont documentés ici (connexion,
 * statuts actifs, changement de statut par code colis) : les autres
 * endpoints livreur restent disponibles côté backend mais ne sont pas
 * exposés dans cette page.
 * Les exemples reflètent les réponses réelles des contrôleurs backend.
 * Briques (bouton copier, endpoint, code…) : components/ApiDocBlocks.jsx,
 * partagées avec la documentation du dashboard client.
 */

const SECTIONS = [
  { id: 'api-demarrage', label: 'Démarrage' },
  { id: 'api-auth', label: 'Authentification' },
  { id: 'api-statut', label: 'Changement de statut' },
  { id: 'api-erreurs', label: 'Codes d’erreur' },
  { id: 'api-exemple', label: 'Exemple complet' }
];

export default function DocumentationApi() {
  return (
    <div className="api-doc">
      <div className="welcome-banner">
        <h1>Documentation API {BRAND.name}</h1>
        <p>
          Connectez votre propre plateforme à {BRAND.name} : changez le statut de vos colis en tournée
          depuis votre système.
        </p>
      </div>

      <ApiToc sections={SECTIONS} />

      {/* ---------- Démarrage ---------- */}
      <Section
        id="api-demarrage"
        title="Démarrage"
        intro="L’API est une API REST : les requêtes et réponses sont au format JSON (UTF-8). Seule exception : le changement de statut accompagné d’une photo preuve, envoyé en multipart/form-data."
      >
        <div className="api-baseurl">
          <span>URL de base</span>
          <code className="mono">{BASE_URL}</code>
          <CopyBtn text={BASE_URL} />
        </div>
        <ul className="api-list">
          <li>
            Les endpoints documentés ici sont réservés aux <strong>comptes livreur</strong> (vos
            identifiants habituels du dashboard livreur). Chaque livreur ne peut agir que sur ses
            propres colis.
          </li>
          <li>
            Envoyez l’en-tête <code className="mono">Content-Type: application/json</code> sur les
            requêtes <span className="api-method api-method-post api-method-inline">POST</span>,
            sauf pour joindre une photo preuve à un changement de statut : la requête passe alors
            en <code className="mono">multipart/form-data</code> (voir « Changement de statut »).
          </li>
          <li>
            Les dates s’écrivent au format <code className="mono">AAAA-MM-JJ</code> (ex.
            2026-08-30).
          </li>
        </ul>
      </Section>

      {/* ---------- Authentification ---------- */}
      <Section
        id="api-auth"
        title="Authentification"
        intro="L’API utilise un jeton JWT. Connectez-vous avec vos identifiants livreur pour obtenir un jeton, puis envoyez-le sur chaque requête dans l’en-tête Authorization."
      >
        <Endpoint
          method="POST"
          path="/auth/login/employee"
          desc="Connexion avec les identifiants du compte livreur."
        >
          <Params
            rows={[
              ['identifiant', 'corps', 'Adresse e-mail du compte livreur.', true],
              ['password', 'corps', 'Mot de passe du compte livreur.', true]
            ]}
          />
          <Code label="Exemple de requête">{`curl -X POST ${BASE_URL}/auth/login/employee \\
  -H "Content-Type: application/json" \\
  -d '{ "identifiant": "livreur@exemple.com", "password": "••••••••" }'`}</Code>
          <Code label="Réponse 200">{`{
  "user": {
    "id": 27,
    "kind": "employee",
    "role": 5,
    "name": "Nom du livreur",
    "services": [],
    "pic": null,
    "dashboard": "livreur"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}`}</Code>
          <ul className="api-list">
            <li>
              Le jeton est valable <strong>8 heures</strong>. À expiration, les appels renvoient
              401 : reconnectez-vous pour obtenir un nouveau jeton.
            </li>
            <li>
              Limite : <strong>10 tentatives de connexion par 15 minutes</strong> et par adresse IP
              (réponse 429 au-delà). Conservez le jeton plutôt que de vous reconnecter à chaque
              appel.
            </li>
          </ul>
        </Endpoint>

        <div className="api-note">
          <strong>Sur tous les appels suivants</strong>, envoyez le jeton dans l’en-tête :
          <code className="mono api-note-code">Authorization: Bearer &lt;votre jeton&gt;</code>
        </div>

        
      </Section>

      {/* ---------- Changement de statut ---------- */}
      <Section
        id="api-statut"
        title="Changement de statut"
      >
        <Endpoint
          method="GET"
          path="/livreurs/me/colis/statuts/actifs"
          desc="Code des Statuts utilisables pour le changement de statut (mêmes choix que la modale « Changer statut » du dashboard), avec leur libellé français « nom » pour l’affichage dans votre plateforme."
        >
          <Code label="Réponse 200">{`[
  { "code": "DELIVERED", "type": 3, "color": "#28a745", "nom": "Livré" },
  { "code": "REFUSE", "type": 3, "color": "#dc3545", "nom": "Refusé" },
  { "code": "POSTPONED", "type": 3, "color": "#fd7e14", "nom": "Reporté" }
]`}</Code>
        </Endpoint>

        <Endpoint
          method="POST"
          path="/livreurs/me/colis/code/{code}/statut"
          desc="Change le statut d’un colis de votre tournée, désigné par son code ({code} = code du colis imprimé sur l’étiquette). Mêmes règles que le dashboard livreur."
        >
          <Params
            rows={[
              ['code', 'chemin', `Code du colis (code client ou code interne ${BRAND.name} imprimé sur l’étiquette). Encodez-le dans l’URL (encodeURIComponent).`, true],
              ['statut', 'corps', 'Code du nouveau statut (un code renvoyé par /livreurs/me/colis/statuts/actifs).', true],
              ['commentaire', 'corps', 'Commentaire du livreur. Obligatoire pour REFUSE et CANCELED.'],
              ['date', 'corps', 'Date au format AAAA-MM-JJ. Obligatoire pour PROGRAMMER et POSTPONED (date programmée / reportée).'],
              ['preuve', 'fichier', `Photo preuve du changement de statut (JPG, PNG ou WEBP, 8 Mo max), facultative. Envoyez alors la requête en multipart/form-data (champ fichier « preuve », les autres paramètres en champs texte). La photo est visible dans le détail de suivi ${BRAND.name}, côté admin et côté client.`]
            ]}
          />
          <Code label="Exemple de requête (JSON, sans photo)">{`curl -X POST ${BASE_URL}/livreurs/me/colis/code/OSM0926100001AB/statut \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{ "statut": "POSTPONED", "commentaire": "Client absent", "date": "2026-09-02" }'`}</Code>
          <Code label="Réponse 200">{`{
  "parcel_id": 4512,
  "parcel_code": "OSM0926100001AB",
  "parcel_status": "IN_PROGRESS",
  "statut": "POSTPONED",
  "statut_color": "#fd7e14",
  "report_time": "02/09/2026",
  "preuve": null
}`}</Code>
          <Code label="Exemple avec photo preuve (multipart/form-data)">{`curl -X POST ${BASE_URL}/livreurs/me/colis/code/OSM0926100001AB/statut \\
  -H "Authorization: Bearer <votre jeton>" \\
  -F "statut=DELIVERED" \\
  -F "commentaire=Remis au gardien" \\
  -F "preuve=@/chemin/photo-livraison.jpg"
# Ne posez pas d'en-tête Content-Type : votre client HTTP le génère avec la frontière multipart.`}</Code>
          <Code label="Réponse 200 (avec photo preuve)">{`{
  "parcel_id": 4512,
  "parcel_code": "OSM0926100001AB",
  "parcel_status": "DELIVERED",
  "statut": "DELIVERED",
  "statut_color": "#28a745",
  "report_time": null,
  "preuve": "/uploads/preuves/preuve-1756800000000-123456789.jpg"
}`}</Code>
          <ul className="api-list">
            <li>
              Photo preuve : un seul fichier par changement de statut, dans le champ{' '}
              <code className="mono">preuve</code> (JPG, PNG ou WEBP, 8 Mo max) ; les paramètres{' '}
              <code className="mono">statut</code>, <code className="mono">commentaire</code> et{' '}
              <code className="mono">date</code> s’envoient en champs texte du même formulaire. 400
              si le fichier n’est pas une image acceptée ou dépasse 8 Mo.
            </li>
            <li>
              Si la requête est refusée (400, 404 ou 409), la photo n’est pas conservée : renvoyez-la
              avec la requête corrigée.
            </li>
            <li>
              404 si aucun colis de votre tournée ne porte ce code ; 409 si le colis figure déjà sur
              un bon de paiement (statut verrouillé).
            </li>
            <li>
              403 si le colis est en statut <code className="mono">WAITING_RESHIP</code> (« Attente
              réexpédition », posé par l’administration) : son statut est verrouillé jusqu’à sa
              remise à l’agence et son ajout à un bon d’envoi. Ce statut n’est jamais renvoyé par{' '}
              <code className="mono">/livreurs/me/colis/statuts/actifs</code> et ne peut pas être
              posé par un livreur.
            </li>
          </ul>
        </Endpoint>
      </Section>

      {/* ---------- Codes d'erreur ---------- */}
      <Section
        id="api-erreurs"
        title="Codes d’erreur"
        intro="En cas d’erreur, la réponse contient un objet JSON { « message » } avec un texte en français prêt à afficher."
      >
        <div className="table-wrap api-table">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Signification</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="mono">400</span></td>
                <td className="api-cell-wrap">Requête invalide : paramètre manquant ou incorrect, ou photo preuve refusée (format autre que JPG / PNG / WEBP, plus de 8 Mo, plusieurs fichiers) ; le message précise la cause.</td>
              </tr>
              <tr>
                <td><span className="mono">401</span></td>
                <td className="api-cell-wrap">Jeton manquant, invalide ou expiré : reconnectez-vous.</td>
              </tr>
              <tr>
                <td><span className="mono">403</span></td>
                <td className="api-cell-wrap">Accès refusé : le compte n’est pas un compte livreur, ou il est désactivé.</td>
              </tr>
              <tr>
                <td><span className="mono">404</span></td>
                <td className="api-cell-wrap">Ressource introuvable, ou colis n’appartenant pas à la tournée du livreur connecté.</td>
              </tr>
              <tr>
                <td><span className="mono">409</span></td>
                <td className="api-cell-wrap">Conflit : l’action est verrouillée (ex. colis déjà sur un bon de paiement).</td>
              </tr>
              <tr>
                <td><span className="mono">422</span></td>
                <td className="api-cell-wrap">Champs de connexion manquants ou invalides.</td>
              </tr>
              <tr>
                <td><span className="mono">429</span></td>
                <td className="api-cell-wrap">Trop de requêtes : patientez 1 minute.</td>
              </tr>
              <tr>
                <td><span className="mono">500</span></td>
                <td className="api-cell-wrap">Erreur interne : réessayez, puis contactez {BRAND.name} si l’erreur persiste.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---------- Exemple complet ---------- */}
      <Section
        id="api-exemple"
        title="Exemple complet"
        intro="Le déroulé type d’une intégration : connexion, puis mise à jour du statut d’un colis par son code, avec ou sans photo preuve."
      >
        <Code label="1. Connexion — récupérer le jeton">{`curl -X POST ${BASE_URL}/auth/login/employee \\
  -H "Content-Type: application/json" \\
  -d '{ "identifiant": "livreur@exemple.com", "password": "••••••••" }'
# → conservez la valeur "token" de la réponse (valable 8 h)`}</Code>
        <Code label="2. Marquer un colis livré (par code colis)">{`curl -X POST ${BASE_URL}/livreurs/me/colis/code/OSM0926100001AB/statut \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{ "statut": "DELIVERED" }'`}</Code>
        <Code label="3. Marquer un colis livré avec photo preuve (par code colis)">{`curl -X POST ${BASE_URL}/livreurs/me/colis/code/OSM0926100001AB/statut \\
  -H "Authorization: Bearer <votre jeton>" \\
  -F "statut=DELIVERED" \\
  -F "preuve=@/chemin/photo-livraison.jpg"
# → la réponse contient "preuve": "/uploads/preuves/…", photo visible dans le suivi du colis`}</Code>
        
      </Section>
    </div>
  );
}
