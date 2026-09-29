import { useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, Circle, Info, Link2, ListChecks } from 'lucide-react';
import { Code } from '../../components/ApiDocBlocks';
import { formatDateHeure, urlWebhook } from '../../utils/whatsapp';

/*
 * Onglet « Guide pas à pas » de la page API liaison › Configuration : écrit
 * pour un débutant. Checklist calculée depuis la configuration enregistrée,
 * valeurs à copier chez Meta (URL de rappel, jeton de vérification), les
 * étapes côté Meta une par une, vocabulaire et points d'attention.
 */

const URL_DEVELOPERS = 'https://developers.facebook.com/apps';
const URL_BUSINESS = 'https://business.facebook.com/';

/** Lien externe ouvert dans un nouvel onglet. */
function Lien({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const VOCABULAIRE = [
  ['Meta', "La société propriétaire de WhatsApp, Facebook et Instagram. L'API WhatsApp s'utilise depuis ses sites."],
  ['Compte Meta Business', 'Le « compte entreprise » qui possède tout le reste. Se crée sur business.facebook.com.'],
  [
    'App Meta',
    'Une « application » créée sur developers.facebook.com. C’est elle qui porte le produit WhatsApp : identifiants, jeton, webhook.'
  ],
  ['WABA', 'WhatsApp Business Account : le compte WhatsApp Business rattaché à l’app. Son identifiant numérique est le WABA ID.'],
  [
    'Phone Number ID',
    'Identifiant numérique donné par Meta au numéro qui enverra les messages (ce n’est PAS le numéro lui-même). Au début, Meta prête un numéro de test gratuit.'
  ],
  [
    'Jeton d’accès (Access Token)',
    'Un long mot de passe qui prouve à Meta que c’est bien ORTALOG qui envoie. Le jeton temporaire expire au bout de 24 h ; le jeton permanent (« utilisateur système ») ne périme pas.'
  ],
  ['Clé secrète de l’app (App Secret)', 'Second secret qui sert à vérifier que ce que reçoit le webhook vient bien de Meta (signature).'],
  [
    'Webhook',
    'Une adresse web d’ORTALOG que Meta appelle pour dire « message remis », « message lu » ou « le destinataire a répondu ».'
  ],
  ['Jeton de vérification (Verify Token)', 'Un mot de passe que VOUS inventez ; Meta le renvoie une fois pour vérifier que l’adresse du webhook est bien la vôtre.'],
  [
    'Modèle de message (Template)',
    'Pour écrire le premier à quelqu’un, WhatsApp impose un texte pré-approuvé par Meta (ex. « Bonjour {{1}}, votre colis {{2}} est en cours de livraison »). Le modèle hello_world est fourni d’office pour tester.'
  ],
  ['Fenêtre de 24 h', 'Quand un destinataire vous écrit, vous pouvez lui répondre en texte libre pendant 24 h. Au-delà, il faut un modèle.'],
  ['Catégorie de modèle', 'Utilitaire (notifications de service : statut de colis, facture…) ou Marketing (promotions, plus cher et plus limité). Choisissez Utilitaire pour ORTALOG.'],
  ['Qualité du modèle', 'Note donnée par Meta selon les signalements des destinataires (vert / jaune / rouge). Un modèle trop signalé est mis en pause puis désactivé.'],
  ['Opt-out', 'Un contact qui répond STOP (ou un autre mot-clé configuré) ne reçoit plus aucun envoi automatique jusqu’à réactivation dans la discussion.'],
  [
    'Préférences du client',
    'Le client expéditeur choisit, dans son dashboard (Configuration › Notifications WhatsApp) ou via Clients › Options côté administration, s’il accepte les messages automatiques : bon de retour expédié, réclamation traitée, remboursement, modification de colis, facture enregistrée / payée. Une notification désactivée n’est pas envoyée à ce client (les autres destinataires de la règle la reçoivent).'
  ],
  ['Réponse par bouton', 'Un modèle peut proposer des boutons (ex. « Confirmer », « Reporter »). La réponse arrive dans la discussion avec une étiquette ; le statut du colis n’est jamais modifié automatiquement.']
];

const A_SAVOIR = [
  'Le jeton temporaire de l’espace développeur expire au bout de 24 h : l’erreur « jeton invalide ou expiré (190) » apparaît alors. Passez au jeton permanent (étape 6) avant la production.',
  'Le numéro de test ne peut écrire qu’à 5 destinataires maximum, préalablement ajoutés et confirmés par code, et seul le modèle hello_world est disponible.',
  'Tant que l’app est en « mode développement », elle n’envoie qu’aux testeurs. Le passage en production demande un vrai numéro, la vérification de l’entreprise et un moyen de paiement.',
  'Pour écrire en premier à quelqu’un, seul un modèle approuvé par Meta est accepté. Le texte libre n’est possible que dans les 24 h qui suivent un message du destinataire.',
  'Les conversations sont facturées par Meta au-delà du quota gratuit ; sans vérification de l’entreprise, la limite de départ est de 250 destinataires uniques par 24 h.',
  'Une seule URL de rappel est possible à la fois côté Meta : en local (tunnel) OU en production (ortalog.ma), pas les deux.',
  'Le format attendu par Meta pour les numéros est international sans « + » : 0612345678 devient 212612345678 (conversion automatique).',
  'Un modèle en pause ou désactivé par Meta n’est plus envoyé : les règles qui l’utilisent journalisent un échec (voir Statistiques › Erreurs) jusqu’à correction.',
  'Le nom d’un modèle ne peut plus être modifié après création chez Meta ; les variables doivent être numérotées {{1}}, {{2}}… (les paramètres nommés et les en-têtes image ne sont pas pris en charge par ORTALOG).',
  'Les envois automatiques respectent les heures calmes (Configuration › Paramètres CRM) : un colis livré à 23 h est notifié le lendemain matin.'
];

export default function ApiLiaisonGuide({ config }) {
  const [origine, setOrigine] = useState(window.location.origin);
  const callbackUrl = urlWebhook(origine);
  const testOk = Boolean(config.dernierTest && config.dernierTest.ok !== false);
  const jetonOk = config.accessToken.defini && config.accessToken.dechiffrable;
  const appSecretOk = config.appSecret.defini && config.appSecret.dechiffrable;

  const checklist = [
    { ok: config.secretKeyConfigured, label: 'Clé de chiffrement du serveur (WHATSAPP_SECRET_KEY)' },
    { ok: Boolean(config.phoneNumberId), label: 'Phone Number ID renseigné' },
    { ok: Boolean(config.wabaId), label: 'WhatsApp Business Account ID renseigné' },
    { ok: jetonOk, label: "Jeton d'accès enregistré" },
    { ok: Boolean(config.testPhone), label: 'Numéro de test renseigné' },
    { ok: testOk, label: 'Connexion testée avec succès' },
    { ok: Boolean(config.verifyToken), label: 'Jeton de vérification généré et enregistré' },
    {
      ok: Boolean(config.webhookVerifieLe),
      label: `Webhook vérifié par Meta${config.webhookVerifieLe ? ` (${formatDateHeure(config.webhookVerifieLe)})` : ''}`
    },
    { ok: appSecretOk, label: "Clé secrète de l'app enregistrée (signature du webhook)" },
    { ok: config.actif, label: 'Intégration activée' },
    { ok: Number(config.nbModelesUtilisables) > 0, label: `Au moins un modèle approuvé synchronisé${config.nbModelesUtilisables ? ` (${config.nbModelesUtilisables})` : ''}` },
    { ok: Number(config.nbReglesActives) > 0, label: `Au moins une action automatique active${config.nbReglesActives ? ` (${config.nbReglesActives})` : ''}` }
  ];

  const etapes = [
    {
      titre: 'Créer un compte Meta Business',
      done: null,
      contenu: (
        <>
          <p>C'est le « compte entreprise » de Meta : il possédera votre app et votre numéro WhatsApp. Gratuit, 5 minutes.</p>
          <ul>
            <li>
              Allez sur <Lien href={URL_BUSINESS}>business.facebook.com</Lien> et connectez-vous avec un compte Facebook personnel.
            </li>
            <li>Créez un « portefeuille d'entreprise » au nom de votre société (nom, adresse, email professionnel).</li>
          </ul>
        </>
      )
    },
    {
      titre: 'Créer une app Meta pour développeurs',
      done: null,
      contenu: (
        <ul>
          <li>
            Allez sur <Lien href={URL_DEVELOPERS}>developers.facebook.com › Mes apps</Lien> › « Créer une app ».
          </li>
          <li>Cas d'usage : choisissez « Entreprise » (Business). Donnez-lui un nom, par exemple « ORTALOG WhatsApp ».</li>
          <li>Rattachez l'app au compte Business créé à l'étape 1.</li>
        </ul>
      )
    },
    {
      titre: "Ajouter le produit WhatsApp à l'app",
      done: null,
      contenu: (
        <ul>
          <li>Dans le tableau de bord de l'app, trouvez la carte « WhatsApp » et cliquez sur « Configurer ».</li>
          <li>Meta crée automatiquement un compte WhatsApp Business (WABA) de test et vous prête un numéro de test gratuit.</li>
        </ul>
      )
    },
    {
      titre: 'Récupérer les identifiants et les coller dans ORTALOG',
      done: Boolean(config.phoneNumberId && config.wabaId && jetonOk),
      contenu: (
        <ul>
          <li>Menu de gauche : WhatsApp › « Démarrage rapide » (API Setup).</li>
          <li>
            Copiez « Identifiant du numéro de téléphone » (<strong>Phone Number ID</strong>) et « Identifiant du compte WhatsApp
            Business » (<strong>WABA ID</strong>).
          </li>
          <li>Copiez le « Jeton d'accès temporaire » (valable 24 h : suffisant pour les premiers essais).</li>
          <li>
            Dans la zone « À » (To), ajoutez votre propre numéro comme destinataire de test et saisissez le code reçu sur
            WhatsApp.
          </li>
          <li>
            Onglet Configuration d'ORTALOG : collez les trois valeurs, renseignez votre numéro comme « Numéro de test », puis
            « Enregistrer ».
          </li>
        </ul>
      )
    },
    {
      titre: 'Tester depuis ORTALOG',
      done: testOk,
      contenu: (
        <ul>
          <li>
            Onglet Configuration › « Tester la connexion » : le nom vérifié (« Test Number ») et le numéro de test s'affichent,
            le bandeau passe à « Connecté ».
          </li>
          <li>« Envoyer le message de test » : vous recevez « Hello World » sur WhatsApp. Le Journal garde la trace.</li>
          <li>En cas d'erreur, le message affiché explique quoi corriger (jeton expiré, numéro non autorisé, etc.).</li>
        </ul>
      )
    },
    {
      titre: 'Remplacer le jeton temporaire par un jeton permanent',
      done: null,
      contenu: (
        <>
          <p>
            Le jeton temporaire s'arrête au bout de 24 h. Pour un fonctionnement durable, créez un « utilisateur système » qui
            aura un jeton sans expiration.
          </p>
          <ul>
            <li>
              <Lien href={URL_BUSINESS}>business.facebook.com</Lien> › Paramètres de l'entreprise › Utilisateurs › « Utilisateurs
              système » › Ajouter (rôle : Admin).
            </li>
            <li>« Attribuer des actifs » › Apps › cochez votre app › « Contrôle total ».</li>
            <li>
              « Générer un nouveau jeton » › choisissez l'app › Expiration : <strong>Jamais</strong> › cochez{' '}
              <code>whatsapp_business_messaging</code>, <code>whatsapp_business_management</code> et{' '}
              <code>business_management</code>.
            </li>
            <li>
              Copiez le jeton (il ne sera plus affiché ensuite) et collez-le dans Configuration › « Jeton d'accès » ›
              Enregistrer.
            </li>
          </ul>
        </>
      )
    },
    {
      titre: 'Brancher le webhook (accusés de réception et réponses)',
      done: Boolean(config.webhookVerifieLe && appSecretOk),
      contenu: (
        <>
          <p>
            Le webhook permet à Meta de prévenir ORTALOG quand un message est remis, lu, ou quand quelqu'un répond. Il faut
            donner à Meta une adresse publique en https.
          </p>
          <ul>
            <li>Onglet Configuration : « Générer » un jeton de vérification, puis Enregistrer.</li>
            <li>
              <Lien href={URL_DEVELOPERS}>developers.facebook.com</Lien> › votre app › WhatsApp › Configuration › Webhook ›
              « Modifier ».
            </li>
            <li>URL de rappel : copiez la valeur affichée dans « Valeurs à copier chez Meta » ci-dessus.</li>
            <li>Jeton de vérification : copiez la valeur affichée ci-dessus.</li>
            <li>
              « Vérifier et enregistrer » : Meta appelle votre serveur ; la ligne « Webhook vérifié par Meta » de la checklist
              passe au vert (rechargez la page).
            </li>
            <li>
              Puis « Gérer » (champs du webhook) › abonnez-vous aux champs <code>messages</code>,{' '}
              <code>message_template_status_update</code> (approbation des modèles) et, si proposés,{' '}
              <code>message_template_quality_update</code> et <code>phone_number_quality_update</code>.
            </li>
            <li>
              Enfin : Paramètres de l'app › Général › « Clé secrète » › Afficher → collez-la dans Configuration › « Clé secrète
              de l'app » › Enregistrer.
            </li>
          </ul>
          <p>
            <strong>En local, avant le déploiement :</strong> votre ordinateur n'est pas joignable depuis Internet. Un tunnel
            crée une adresse https publique temporaire qui redirige vers le backend (port 5000, pas 5173). Lancez l'une des
            deux commandes, puis collez l'adresse obtenue dans « URL publique de votre serveur » ci-dessus.
          </p>
          <Code label="Tunnel ngrok (compte gratuit sur ngrok.com)">ngrok http 5000</Code>
          <Code label="Tunnel Cloudflare (sans compte)">cloudflared tunnel --url http://localhost:5000</Code>
        </>
      )
    },
    {
      titre: 'Passer en production avec votre vrai numéro',
      done: null,
      contenu: (
        <ul>
          <li>
            WhatsApp › Démarrage rapide › « Ajouter un numéro de téléphone » : un numéro qui n'est <strong>pas</strong> déjà
            utilisé dans l'application WhatsApp (sinon supprimez d'abord le compte WhatsApp de ce numéro).
          </li>
          <li>Vérification du numéro par SMS ou appel, puis choix du nom d'affichage.</li>
          <li>Business Manager › Centre de sécurité › « Vérification de l'entreprise » (documents officiels de la société).</li>
          <li>
            WhatsApp Manager › Paramètres › « Moyens de paiement » : ajoutez une carte (les conversations sont facturées par Meta
            au-delà du quota gratuit).
          </li>
          <li>Dans ORTALOG › Configuration, remplacez le Phone Number ID par celui du vrai numéro, puis testez de nouveau.</li>
        </ul>
      )
    },
    {
      titre: 'Créer vos modèles de message, puis les synchroniser',
      done: Number(config.nbModelesUtilisables) > 0,
      contenu: (
        <>
          <p>Pour écrire en premier à quelqu'un, WhatsApp impose un texte approuvé par Meta. Les modèles se créent chez Meta, puis ORTALOG les importe.</p>
          <ul>
            <li>WhatsApp Manager › Outils du compte › « Modèles de message » › Créer un modèle.</li>
            <li>
              Catégorie « Utilitaire » (notifications de service), langue Français (ou Arabe), variables <code>{'{{1}}'}</code>,{' '}
              <code>{'{{2}}'}</code>… numérotées dans l'ordre, avec un exemple pour chacune (Meta l'exige). Pas d'en-tête image ni de
              paramètre nommé. Boutons « Réponse rapide » possibles (ex. Confirmer / Reporter).
            </li>
            <li>
              Modèles conseillés — destinataires : colis expédié, en cours de livraison, livré, reporté, retourné ; clients
              expéditeurs : colis importés, colis livré, facture disponible, ramassage effectué ; livreurs : bon de distribution
              enregistré, facture payée ; employés : message WhatsApp reçu.
            </li>
            <li>Approbation par Meta en quelques minutes à 24 h (statut visible après synchronisation ou via le webhook).</li>
            <li>
              Dans ORTALOG › API liaison › <strong>Modèles de message</strong> › « Synchroniser depuis Meta », puis réglez pour chaque modèle
              les variables par défaut (envoi manuel depuis un colis).
            </li>
          </ul>
        </>
      )
    },
    {
      titre: 'Configurer les actions automatiques',
      done: Number(config.nbReglesActives) > 0,
      contenu: (
        <ul>
          <li>
            API liaison › <strong>Actions automatiques</strong> › « Nouvelle règle » : choisissez l'événement (colis créé, changement de
            statut, ramassage, facture…), l'audience (destinataire, client expéditeur, livreur, employés), le modèle et la
            correspondance de chaque variable. Le client expéditeur est joint sur son <strong>téléphone personnel</strong> (celui du
            magasin seulement s'il n'en a pas).
          </li>
          <li>« Tester » avec un code colis réel affiche le rendu et permet un envoi au numéro de test.</li>
          <li>Configuration › Paramètres CRM : heures calmes, réponse automatique, mots-clés d'opt-out, réponses rapides.</li>
          <li>
            Le client expéditeur peut refuser certaines notifications (bon de retour expédié, réclamation traitée, remboursement,
            modification de colis, factures) depuis son dashboard › Configuration ; l'administration a les mêmes choix dans
            Clients › <strong>Options</strong> › Notifications WhatsApp. « Tester » signale un client qui a désactivé la notification.
          </li>
          <li>Les réponses des contacts arrivent dans API liaison › <strong>Discussions</strong> (badge rouge = messages non lus). Une discussion n’y apparaît qu’à partir de la première réponse du contact : les envois restés sans réponse se consultent dans le <strong>Journal</strong>.</li>
          <li>
            Dans la fenêtre de 24 h qui suit le dernier message du contact, on répond par texte, image ou message vocal
            (bouton micro : le navigateur doit autoriser le micro ; Chrome, Edge, Firefox et Safari récents). Fenêtre fermée :
            seul un modèle approuvé peut partir.
          </li>
        </ul>
      )
    },
    {
      titre: "Activer l'intégration",
      done: config.actif,
      contenu: (
        <ul>
          <li>Onglet Configuration › interrupteur « Intégration activée » › Enregistrer.</li>
          <li>Tant que l'interrupteur est éteint, aucun envoi automatique ne partira ; les tests restent possibles.</li>
        </ul>
      )
    }
  ];

  return (
    <div className="wa-guide">
      <section className="platform-card">
        <h2>
          <ListChecks size={18} /> Où en êtes-vous ?
        </h2>
        <ul className="wa-checklist">
          {checklist.map((item) => (
            <li key={item.label}>
              {item.ok ? (
                <CheckCircle2 size={17} className="wa-check-ok" />
              ) : (
                <Circle size={17} className="wa-check-ko" />
              )}
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="platform-card">
        <h2>
          <Link2 size={18} /> Valeurs à copier chez Meta
        </h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <label>
            <span className="field-label">URL publique de votre serveur</span>
            <input
              type="url"
              value={origine}
              placeholder="https://ortalog.ma"
              onChange={(e) => setOrigine(e.target.value)}
            />
          </label>
          <span className="wa-field-hint">
            En production : https://ortalog.ma. En local : l'adresse https de votre tunnel (ngrok / cloudflared), car Meta
            doit pouvoir joindre votre ordinateur depuis Internet.
          </span>
        </form>
        <Code label="URL de rappel (Callback URL)">{callbackUrl}</Code>
        <Code label="Jeton de vérification (Verify Token)">
          {config.verifyToken || "— générez-le dans l'onglet Configuration puis enregistrez —"}
        </Code>
      </section>

      <section className="platform-card">
        <h2>
          <BookOpen size={18} /> Les étapes, une par une
        </h2>
        <div className="wa-steps">
          {etapes.map((etape, i) => (
            <div key={etape.titre} className={`cfg-row ${etape.done ? 'wa-step-done' : ''}`}>
              <div className="cfg-row-icon">
                {etape.done ? <CheckCircle2 size={18} /> : <span className="wa-step-num">{i + 1}</span>}
              </div>
              <div className="cfg-row-text">
                <h3>
                  {i + 1}. {etape.titre}
                  {etape.done && <span className="badge badge-active">fait</span>}
                </h3>
                {etape.contenu}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="platform-card">
        <h2>
          <Info size={18} /> Vocabulaire
        </h2>
        <div className="table-wrap wa-vocab">
          <table>
            <tbody>
              {VOCABULAIRE.map(([mot, definition]) => (
                <tr key={mot}>
                  <td>{mot}</td>
                  <td>{definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="platform-card">
        <h2>
          <AlertTriangle size={18} /> À savoir
        </h2>
        <ul className="wa-astuces">
          {A_SAVOIR.map((texte) => (
            <li key={texte}>{texte}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
