import { BASE_URL, CopyBtn, Code, Endpoint, Params, Section, ApiToc } from '../../components/ApiDocBlocks';
import { BRAND } from '../../config/brand';

/*
 * Documentation API du dashboard client (/client/api/documentation, menu
 * « API liaison » → Documentation) : page statique décrivant les endpoints
 * ouverts aux comptes client (delevery_customers, et membres d'équipe selon
 * leurs tâches) pour connecter une boutique ou un système externe à la plateforme :
 * connexion, villes / tarifs, création de colis, liste et suivi, modification /
 * blocage / suppression, demandes de ramassage, suivi public.
 * Seuls les endpoints utiles à une intégration sont documentés ici (les autres
 * endpoints client — import Excel, étiquettes, remboursements, réclamations,
 * stock, factures… — restent disponibles côté backend mais ne sont pas exposés
 * dans cette page). Les exemples reflètent les réponses réelles des
 * contrôleurs backend (parcels, demandesRamassage, auth, public).
 */

const SECTIONS = [
  { id: 'api-demarrage', label: 'Démarrage' },
  { id: 'api-auth', label: 'Authentification' },
  { id: 'api-villes', label: 'Villes et tarifs' },
  { id: 'api-creation', label: 'Création de colis' },
  { id: 'api-liste', label: 'Liste et suivi' },
  { id: 'api-modification', label: 'Modification' },
  { id: 'api-ramassage', label: 'Ramassage' },
  { id: 'api-public', label: 'Suivi public' },
  { id: 'api-erreurs', label: 'Codes d’erreur' },
  { id: 'api-exemple', label: 'Exemple complet' }
];

export default function DocumentationApi() {
  return (
    <div className="api-doc">
      <div className="welcome-banner">
        <h1>Documentation API {BRAND.name}</h1>
        <p>
          Connectez votre boutique ou votre système à {BRAND.name} : créez vos colis, suivez leurs
          statuts et demandez vos ramassages depuis votre propre plateforme.
        </p>
      </div>

      <ApiToc sections={SECTIONS} />

      {/* ---------- Démarrage ---------- */}
      <Section
        id="api-demarrage"
        title="Démarrage"
        intro="L’API est une API REST : les requêtes et réponses sont au format JSON (UTF-8)."
      >
        <div className="api-baseurl">
          <span>URL de base</span>
          <code className="mono">{BASE_URL}</code>
          <CopyBtn text={BASE_URL} />
        </div>
        <ul className="api-list">
          <li>
            Les endpoints documentés ici sont réservés aux <strong>comptes client</strong> (vos
            identifiants habituels du dashboard client). Un compte ne voit et ne modifie que ses
            propres colis.
          </li>
          <li>
            Un <strong>membre d’équipe</strong> (page Gestion d’équipe) peut aussi se connecter à
            l’API avec ses propres identifiants : il n’accède qu’aux tâches qui lui sont attribuées
            (403 sinon). La tâche requise est indiquée sur chaque endpoint.
          </li>
          <li>
            Envoyez l’en-tête <code className="mono">Content-Type: application/json</code> sur les
            requêtes <span className="api-method api-method-post api-method-inline">POST</span> et{' '}
            <span className="api-method api-method-put api-method-inline">PUT</span>.
          </li>
          <li>
            Les dates s’écrivent au format <code className="mono">AAAA-MM-JJ</code> (ex.
            2026-09-04). Les horodatages renvoyés (<code className="mono">parcel_time</code>,{' '}
            <code className="mono">time</code>) sont des timestamps Unix en secondes.
          </li>
          <li>
            Les téléphones sont au format marocain : <strong>10 chiffres commençant par 0</strong>{' '}
            (ex. 0612345678, séparateurs tolérés).
          </li>
          <li>
            Un colis est désigné par son identifiant numérique{' '}
            <code className="mono">parcel_id</code> dans les URL (renvoyé à la création et dans la
            liste), et par son code <code className="mono">parcel_code</code> imprimé sur
            l’étiquette.
          </li>
        </ul>
      </Section>

      {/* ---------- Authentification ---------- */}
      <Section
        id="api-auth"
        title="Authentification"
        intro="L’API utilise un jeton JWT. Connectez-vous avec vos identifiants client pour obtenir un jeton, puis envoyez-le sur chaque requête dans l’en-tête Authorization."
      >
        <Endpoint
          method="POST"
          path="/auth/login/client"
          desc="Connexion avec les identifiants du compte client (propriétaire ou membre d’équipe)."
        >
          <Params
            rows={[
              ['identifiant', 'corps', 'Adresse e-mail du compte client.', true],
              ['password', 'corps', 'Mot de passe du compte client.', true]
            ]}
          />
          <Code label="Exemple de requête">{`curl -X POST ${BASE_URL}/auth/login/client \\
  -H "Content-Type: application/json" \\
  -d '{ "identifiant": "boutique@exemple.com", "password": "••••••••" }'`}</Code>
          <Code label="Réponse 200">{`{
  "user": {
    "id": 128,
    "kind": "customer",
    "role": "client",
    "name": "Nom du client",
    "store": "Nom de la boutique",
    "dashboard": "client"
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
            <li>
              Pour un membre d’équipe, <code className="mono">user</code> contient en plus{' '}
              <code className="mono">memberId</code>, <code className="mono">fonction</code> et{' '}
              <code className="mono">services</code> (liste de ses tâches, ex.{' '}
              <code className="mono">["COLIS_CONSULTATION", "COLIS_SAISIE"]</code>).
            </li>
          </ul>
        </Endpoint>

        <div className="api-note">
          <strong>Sur tous les appels suivants</strong>, envoyez le jeton dans l’en-tête :
          <code className="mono api-note-code">Authorization: Bearer &lt;votre jeton&gt;</code>
        </div>
      </Section>

      {/* ---------- Villes et tarifs ---------- */}
      <Section
        id="api-villes"
        title="Villes et tarifs"
        intro="Avant de créer un colis, récupérez la liste des villes de destination (l’identifiant de la ville est obligatoire à la création) et, si besoin, les frais applicables à votre compte."
      >
        <Endpoint
          method="GET"
          path="/parcels/client/new"
          desc="Villes de destination actives, options par défaut de votre compte (ouverture / essayage). Tâche : COLIS_SAISIE."
        >
          <Code label="Réponse 200">{`{
  "cities": [
    { "id": 12, "label": "Casablanca" },
    { "id": 27, "label": "Rabat" },
    { "id": 45, "label": "Tanger" }
  ],
  "default_open": 1,
  "default_essayage": 0
}`}</Code>
          <p className="api-hint">
            Mettez la liste en cache et rafraîchissez-la régulièrement : les villes évoluent rarement.
          </p>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/client/tarif?city={id}"
          desc="Frais de livraison / retour / refusé (en DH) appliqués à votre compte pour une ville de destination, et délai de livraison indicatif. Tâche : COLIS_SAISIE."
        >
          <Params
            rows={[['city', 'query', 'Identifiant de la ville de destination (id de /parcels/client/new).', true]]}
          />
          <Code label="Exemple de requête">{`curl "${BASE_URL}/parcels/client/tarif?city=12" \\
  -H "Authorization: Bearer <votre jeton>"`}</Code>
          <Code label="Réponse 200">{`{
  "livraison": 35,
  "retour": 15,
  "refuse": 15,
  "delai": "24h - 48h"
}`}</Code>
          <ul className="api-list">
            <li>
              <code className="mono">delai</code> vaut <code className="mono">null</code> si aucun
              délai n’est renseigné pour la ville.
            </li>
            <li>404 si aucun tarif n’existe pour cette ville.</li>
          </ul>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/client/destinataire?phone={numéro}"
          desc="Taux de livraison d’un destinataire d’après l’historique de tous les colis créés pour ce numéro de téléphone (les colis encore « En attente de ramassage » ne comptent pas). Tâche : COLIS_SAISIE."
        >
          <Params
            rows={[['phone', 'query', 'Téléphone du destinataire : 10 chiffres commençant par 0 (séparateurs tolérés).', true]]}
          />
          <Code label="Exemple de requête">{`curl "${BASE_URL}/parcels/client/destinataire?phone=0612345678" \\
  -H "Authorization: Bearer <votre jeton>"`}</Code>
          <Code label="Réponse 200">{`{
  "total": 25,
  "livres": 20,
  "taux": 80,
  "niveau": "bon"
}`}</Code>
          <ul className="api-list">
            <li>
              <code className="mono">total</code> = colis créés pour ce numéro hors attente de
              ramassage (tous statuts : livrés, retournés, en cours) ;{' '}
              <code className="mono">livres</code> = colis livrés ;{' '}
              <code className="mono">taux</code> = livrés / total, en %.
            </li>
            <li>
              <code className="mono">niveau</code> : <code className="mono">bon</code> (taux ≥ 80 %),{' '}
              <code className="mono">moyen</code> (50 à 79 %), <code className="mono">mauvais</code>{' '}
              (&lt; 50 %). Aucun colis : <code className="mono">total</code> à 0,{' '}
              <code className="mono">taux</code> et <code className="mono">niveau</code> à{' '}
              <code className="mono">null</code>.
            </li>
            <li>400 si le numéro est invalide.</li>
          </ul>
        </Endpoint>
      </Section>

      {/* ---------- Création de colis ---------- */}
      <Section
        id="api-creation"
        title="Création de colis"
        intro="Créez un colis depuis votre plateforme, exactement comme depuis le formulaire « Nouveau colis » du dashboard. Le colis est créé « En attente de ramassage » avec les frais de votre compte pour la ville choisie."
      >
        <Endpoint
          method="POST"
          path="/parcels/client"
          desc={`Création d’un colis normal (marchandise chez vous, à ramasser) ou d’un colis de stock (marchandise déjà en agence ${BRAND.name}). Tâche : COLIS_SAISIE.`}
        >
          <Params
            rows={[
              ['receiver', 'corps', 'Nom du destinataire (250 caractères max).', true],
              ['phone', 'corps', 'Téléphone du destinataire : 10 chiffres commençant par 0.', true],
              ['city', 'corps', 'Identifiant de la ville de destination (id de /parcels/client/new).', true],
              ['address', 'corps', 'Adresse de livraison (2000 caractères max).', true],
              ['price', 'corps', 'Montant CRBT à encaisser, en DH (nombre ≥ 0 ; 0 = colis sans encaissement).', true],
              ['code', 'corps', `Code colis personnalisé (100 caractères max, ex. numéro de commande). Doit être unique (409 sinon). Sans code, ${BRAND.name} en génère un.`],
              ['product', 'corps', 'Marchandise (colis normal uniquement, 250 caractères max).'],
              ['qty', 'corps', 'Quantité de marchandise (colis normal uniquement, 1 par défaut, 9999 max).'],
              ['note', 'corps', 'Commentaire pour le livreur (2000 caractères max).'],
              ['open', 'corps', '1 = ouverture du colis autorisée, 0 = interdite (0 par défaut ; voir default_open).'],
              ['essayage', 'corps', '1 = essayage autorisé, 0 = interdit (0 par défaut ; forcé à 0 si open = 0).'],
              ['replace', 'corps', '1 = colis à remplacer (échange : le livreur récupère l’ancien colis), 0 par défaut.'],
              ['fromStock', 'corps', '1 = colis de stock (produits de votre stock en agence), 0 = colis normal (par défaut).'],
              ['products', 'corps', 'Colis de stock uniquement : liste [{ "id", "qty" }] des produits à envoyer (au moins un). id = identifiant du produit dans votre stock (voir /stock/client/produits).']
            ]}
          />
          <Code label="Exemple de requête (colis normal)">{`curl -X POST ${BASE_URL}/parcels/client \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "code": "CMD-2026-1045",
    "receiver": "Nom du destinataire",
    "phone": "0612345678",
    "city": 12,
    "address": "12 rue Exemple, quartier Maarif",
    "price": 250,
    "product": "Chaussures",
    "qty": 1,
    "note": "Appeler avant livraison",
    "open": 1,
    "essayage": 0,
    "replace": 0
  }'`}</Code>
          <Code label="Réponse 201">{`{
  "parcel_id": 4512,
  "parcel_code": "CMD-2026-1045"
}`}</Code>
          <Code label="Exemple de requête (colis de stock)">{`curl -X POST ${BASE_URL}/parcels/client \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "receiver": "Nom du destinataire",
    "phone": "0612345678",
    "city": 12,
    "address": "12 rue Exemple, quartier Maarif",
    "price": 480,
    "fromStock": 1,
    "products": [ { "id": 87, "qty": 2 }, { "id": 91, "qty": 1 } ]
  }'`}</Code>
          <ul className="api-list">
            <li>
              Conservez <code className="mono">parcel_id</code> : c’est lui qui désigne le colis
              dans les endpoints de suivi et de modification. Sans{' '}
              <code className="mono">code</code>, le code généré (ex.{' '}
              <code className="mono">DRG0926264512TO</code>) est renvoyé dans{' '}
              <code className="mono">parcel_code</code>.
            </li>
            <li>
              Colis normal : une demande de ramassage est ouverte automatiquement chez vous (une
              seule demande ouverte à la fois, quel que soit le nombre de colis créés).
            </li>
            <li>
              Colis de stock : les quantités sont déduites de votre stock en agence ; 400 si un
              produit est introuvable ou si le stock est insuffisant (le message précise le
              produit). Aucun ramassage n’est déclenché.
            </li>
            <li>
              400 si un champ obligatoire manque ou est invalide, 409 si le code personnalisé est
              déjà utilisé.
            </li>
          </ul>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/stock/client/produits"
          desc="Liste des produits de votre stock en agence (pour renseigner products à la création d’un colis de stock). Tâche : STOCK_PRODUITS."
        >
          <Code label="Réponse 200">{`[
  {
    "id": 87,
    "clientId": 128,
    "magasin": "Nom de la boutique",
    "clientNom": "Nom du client",
    "nom": "T-shirt blanc taille M",
    "ref": "TSH-M-BLC",
    "stock": 24,
    "stockAttente": 0,
    "position": "A-12",
    "active": 1
  }
]`}</Code>
          <p className="api-hint">
            <code className="mono">stock</code> = quantité disponible en agence ; seuls les produits{' '}
            <code className="mono">active = 1</code> peuvent être envoyés.
          </p>
        </Endpoint>
      </Section>

      {/* ---------- Liste et suivi ---------- */}
      <Section
        id="api-liste"
        title="Liste et suivi des colis"
        intro="Consultez vos colis (avec recherche, filtres et pagination), le statut courant de chacun et l’historique détaillé de suivi. Tâche : COLIS_CONSULTATION."
      >
        <Endpoint
          method="GET"
          path="/parcels/client"
          desc="Liste paginée de vos colis, du plus récent au plus ancien, avec le statut courant de chacun."
        >
          <Params
            rows={[
              ['page', 'query', 'Numéro de page (1 par défaut).'],
              ['pageSize', 'query', 'Colis par page : 25 par défaut, 5 min, 100 max.'],
              ['search', 'query', 'Recherche sur le code colis, le destinataire, le téléphone ou la ville.'],
              ['status', 'query', 'Code de statut (ex. DELIVERED) : voir /parcels/client/filters.'],
              ['city', 'query', 'Identifiant de la ville de destination.'],
              ['dateFrom', 'query', 'Date de dernière mise à jour ≥ (AAAA-MM-JJ).'],
              ['dateTo', 'query', 'Date de dernière mise à jour ≤ (AAAA-MM-JJ).']
            ]}
          />
          <Code label="Exemple de requête">{`curl "${BASE_URL}/parcels/client?search=CMD-2026-1045&pageSize=25" \\
  -H "Authorization: Bearer <votre jeton>"`}</Code>
          <Code label="Réponse 200">{`{
  "rows": [
    {
      "parcel_id": 4512,
      "parcel_code": "CMD-2026-1045",
      "parcel_receiver": "Nom du destinataire",
      "parcel_phone": "0612345678",
      "parcel_price": "250",
      "parcel_time": 1756800000,
      "parcel_status": "IN_PROGRESS",
      "parcel_replace": 0,
      "parcel_is_remb": 0,
      "parcel_from_stock": "0",
      "remb_demande": null,
      "statut": "POSTPONED",
      "statut_color": "#fd7e14",
      "report_time": "05/09/2026",
      "ville": "Casablanca",
      "parcel_client_block": 0,
      "label_stale": 0
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 25,
  "totalPages": 1
}`}</Code>
          <ul className="api-list">
            <li>
              <code className="mono">statut</code> est le <strong>statut affiché</strong> du colis
              (le même que dans le dashboard) ; <code className="mono">parcel_status</code> est le
              statut brut d’avancement : <code className="mono">WAITING_PICKUP</code> (en attente
              de ramassage), <code className="mono">PICKED_UP</code> (ramassé),{' '}
              <code className="mono">IN_PROGRESS</code> (en cours de livraison — le détail est
              alors dans <code className="mono">statut</code>, ex. POSTPONED, REFUSE…),{' '}
              <code className="mono">DELIVERED</code> (livré),{' '}
              <code className="mono">RETURNED</code> (retourné).
            </li>
            <li>
              <code className="mono">report_time</code> : date de report / programmation
              (JJ/MM/AAAA) quand le statut est reporté ou programmé, sinon{' '}
              <code className="mono">null</code>. <code className="mono">parcel_client_block</code>{' '}
              = 1 si vous avez bloqué l’expédition.
            </li>
            <li>
              Pour retrouver un colis par son code, utilisez{' '}
              <code className="mono">search=&lt;code&gt;</code>.
            </li>
          </ul>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/statuts/libelles"
          desc="Libellés français des codes de statut (objet { CODE: libellé }), pour l’affichage dans votre plateforme. Ouvert à tout compte connecté."
        >
          <Code label="Réponse 200 (extrait)">{`{
  "WAITING_PICKUP": "En attente de ramassage",
  "PICKED_UP": "Ramassé",
  "IN_PROGRESS": "En cours",
  "DELIVERED": "Livré",
  "POSTPONED": "Reporté",
  "REFUSE": "Refusé",
  "RETURNED": "Retourné"
}`}</Code>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/client/filters"
          desc="Options des filtres de la liste : villes de destination et codes de statut (avec couleur) utilisables dans le paramètre status."
        >
          <Code label="Réponse 200">{`{
  "cities": [ { "id": 12, "label": "Casablanca" }, { "id": 27, "label": "Rabat" } ],
  "statuts": [
    { "code": "WAITING_PICKUP", "color": "#6c757d" },
    { "code": "DELIVERED", "color": "#28a745" },
    { "code": "POSTPONED", "color": "#fd7e14" }
  ]
}`}</Code>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/client/{id}/suivi"
          desc="Historique de suivi d’un colis ({id} = parcel_id), du plus ancien au plus récent, avec le livreur affecté le cas échéant."
        >
          <Code label="Exemple de requête">{`curl ${BASE_URL}/parcels/client/4512/suivi \\
  -H "Authorization: Bearer <votre jeton>"`}</Code>
          <Code label="Réponse 200">{`{
  "code": "CMD-2026-1045",
  "livreur": { "name": "Nom du livreur", "phone": "0661234567" },
  "entries": [
    {
      "id": 90211,
      "status": "WAITING_PICKUP",
      "situation": "NOT_PAID",
      "data": null,
      "comment": null,
      "time": 1756800000,
      "preuve": null,
      "status_color": "#6c757d",
      "member": null
    },
    {
      "id": 90340,
      "status": "DELIVERED",
      "situation": "NOT_PAID",
      "data": null,
      "comment": "Remis au gardien",
      "time": 1756972800,
      "preuve": "/uploads/preuves/preuve-1756972800000-123456789.jpg",
      "status_color": "#28a745",
      "member": null
    }
  ]
}`}</Code>
          <ul className="api-list">
            <li>
              <code className="mono">livreur</code> vaut <code className="mono">null</code> tant
              qu’aucun livreur n’est affecté.
            </li>
            <li>
              <code className="mono">preuve</code> : chemin de la photo jointe par le livreur au
              changement de statut, à préfixer par <code className="mono">{BRAND.siteUrl}</code>{' '}
              ; <code className="mono">member</code> : nom du membre de votre équipe à l’origine de
              l’étape, le cas échéant.
            </li>
            <li>404 si le colis n’existe pas ou n’appartient pas à votre compte.</li>
          </ul>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/parcels/client/{id}/details"
          desc="Informations d’un colis ({id} = parcel_id) : destinataire, adresse, montant, marchandise (ou produits de stock envoyés)."
        >
          <Code label="Réponse 200">{`{
  "parcel_code": "CMD-2026-1045",
  "parcel_receiver": "Nom du destinataire",
  "parcel_phone": "0612345678",
  "ville": "Casablanca",
  "parcel_address": "12 rue Exemple, quartier Maarif",
  "parcel_price": "250",
  "crbt": 250,
  "parcel_note": "Appeler avant livraison",
  "parcel_from_stock": 0,
  "parcel_product_name": "Chaussures",
  "parcel_product_qty": 1,
  "produits": []
}`}</Code>
          <p className="api-hint">
            Colis de stock : <code className="mono">produits</code> liste les produits envoyés{' '}
            <code className="mono">[{'{'} "produit", "variante", "qty" {'}'}]</code>.{' '}
            <code className="mono">crbt</code> = montant effectivement à encaisser (0 si le CRBT a
            été annulé par {BRAND.name}).
          </p>
        </Endpoint>
      </Section>

      {/* ---------- Modification ---------- */}
      <Section
        id="api-modification"
        title="Modification, blocage et suppression"
        intro={`Mêmes règles que le dashboard : un colis en attente de ramassage se modifie et se supprime librement ; après ramassage, la modification devient une demande validée par ${BRAND.name}. Tâche : COLIS_MODIFICATION.`}
      >
        <Endpoint
          method="GET"
          path="/parcels/client/{id}/edit"
          desc="Valeurs actuelles d’un colis modifiable ({id} = parcel_id) et villes disponibles. Indique si la modification passera par une validation."
        >
          <Code label="Réponse 200">{`{
  "requires_validation": 0,
  "pending_demande": 0,
  "parcel_code": "CMD-2026-1045",
  "receiver": "Nom du destinataire",
  "phone": "0612345678",
  "city": 12,
  "address": "12 rue Exemple, quartier Maarif",
  "note": "Appeler avant livraison",
  "price": 250,
  "product": "Chaussures",
  "qty": 1,
  "from_stock": 0,
  "open": 1,
  "essayage": 0,
  "replace": 0,
  "cities": [ { "id": 12, "label": "Casablanca" }, { "id": 27, "label": "Rabat" } ]
}`}</Code>
          <ul className="api-list">
            <li>
              <code className="mono">requires_validation</code> = 1 dès que le colis n’est plus en
              attente de ramassage ; <code className="mono">pending_demande</code> = 1 si une demande
              de modification est déjà en attente (nouvelle demande refusée).
            </li>
            <li>409 si le colis est livré ou retourné (plus modifiable).</li>
          </ul>
        </Endpoint>

        <Endpoint
          method="PUT"
          path="/parcels/client/{id}"
          desc="Modifie un colis ({id} = parcel_id). Envoyez toutes les valeurs (modifiées ou non) : le corps décrit l’état complet souhaité."
        >
          <Params
            rows={[
              ['receiver', 'corps', 'Nom du destinataire.', true],
              ['phone', 'corps', 'Téléphone du destinataire (10 chiffres commençant par 0).', true],
              ['city', 'corps', 'Identifiant de la ville de destination. Un changement de ville recalcule les frais.', true],
              ['address', 'corps', 'Adresse de livraison.', true],
              ['price', 'corps', 'Montant CRBT en DH (≥ 0).', true],
              ['note', 'corps', 'Commentaire.'],
              ['product', 'corps', 'Marchandise (ignoré pour un colis de stock).'],
              ['qty', 'corps', 'Quantité (ignoré pour un colis de stock).'],
              ['open', 'corps', '1 / 0 : ouverture autorisée.'],
              ['essayage', 'corps', '1 / 0 : essayage autorisé (forcé à 0 si open = 0).'],
              ['replace', 'corps', '1 / 0 : colis à remplacer.']
            ]}
          />
          <Code label="Exemple de requête">{`curl -X PUT ${BASE_URL}/parcels/client/4512 \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "receiver": "Nom du destinataire",
    "phone": "0612345678",
    "city": 12,
    "address": "15 rue Exemple, quartier Maarif",
    "price": 250,
    "note": "Appeler avant livraison",
    "product": "Chaussures",
    "qty": 1,
    "open": 1,
    "essayage": 0,
    "replace": 0
  }'`}</Code>
          <Code label="Réponse 200 (colis en attente de ramassage : modification appliquée)">{`{
  "parcel_id": 4512,
  "parcel_receiver": "Nom du destinataire",
  "parcel_phone": "0612345678",
  "parcel_price": "250",
  "parcel_replace": 0,
  "ville": "Casablanca",
  "label_stale": 0
}`}</Code>
          <Code label="Réponse 201 (colis déjà ramassé : demande de modification enregistrée)">{`{
  "parcel_id": 4512,
  "pending_validation": 1
}`}</Code>
          <ul className="api-list">
            <li>
              Après ramassage, rien n’est modifié immédiatement : la demande est validée (ou
              refusée) par {BRAND.name}, puis visible dans le suivi du colis.
            </li>
            <li>
              400 « Aucune modification détectée » si toutes les valeurs sont identiques ; 409 si
              le colis est livré / retourné, ramassé entre-temps, ou si une demande est déjà en
              attente.
            </li>
            <li>
              <code className="mono">label_stale</code> = 1 si l’étiquette déjà imprimée doit être
              réimprimée (montant CRBT modifié).
            </li>
          </ul>
        </Endpoint>

        <Endpoint
          method="POST"
          path="/parcels/client/{id}/blocage"
          desc="Bloque ou débloque l’expédition d’un colis ({id} = parcel_id) : un colis bloqué est refusé au ramassage et à l’envoi tant qu’il n’est pas débloqué."
        >
          <Params
            rows={[['bloquer', 'corps', '1 = bloquer l’expédition (par défaut), 0 = débloquer.']]}
          />
          <Code label="Exemple de requête">{`curl -X POST ${BASE_URL}/parcels/client/4512/blocage \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{ "bloquer": 1 }'`}</Code>
          <Code label="Réponse 200">{`{
  "parcel_id": 4512,
  "parcel_client_block": 1
}`}</Code>
          <p className="api-hint">
            Possible uniquement tant que le colis est en attente de ramassage ou ramassé (409
            au-delà : déjà expédié ou traité).
          </p>
        </Endpoint>

        <Endpoint
          method="DELETE"
          path="/parcels/client/{id}"
          desc="Supprime un colis encore en attente de ramassage ({id} = parcel_id). Pour un colis de stock, les quantités sont restituées à votre stock."
        >
          <Code label="Exemple de requête">{`curl -X DELETE ${BASE_URL}/parcels/client/4512 \\
  -H "Authorization: Bearer <votre jeton>"`}</Code>
          <Code label="Réponse 200">{`{
  "parcel_id": 4512,
  "deleted": true
}`}</Code>
          <p className="api-hint">
            409 si le colis n’est plus en attente de ramassage : la suppression est définitive et
            n’est plus possible une fois le colis ramassé.
          </p>
        </Endpoint>
      </Section>

      {/* ---------- Ramassage ---------- */}
      <Section
        id="api-ramassage"
        title="Demandes de ramassage"
        intro="Une demande de ramassage est ouverte automatiquement à la création d’un colis normal. Ces endpoints permettent d’en créer manuellement (ex. ramassage de stock) et de suivre leur état. Tâche : RAMASSAGE."
      >
        <Endpoint
          method="GET"
          path="/demandes-ramassage/client/new"
          desc="Valeurs par défaut d’une nouvelle demande (téléphone et adresse de votre fiche) et nombre de demandes manuelles encore en attente."
        >
          <Code label="Réponse 200">{`{
  "phone": "0522123456",
  "address": "Adresse de votre boutique",
  "enAttente": 1,
  "max": 3
}`}</Code>
        </Endpoint>

        <Endpoint
          method="POST"
          path="/demandes-ramassage/client"
          desc="Crée une demande de ramassage. Maximum 3 demandes manuelles en attente simultanément."
        >
          <Params
            rows={[
              ['type', 'corps', 'SIMPLE_PARCEL (colis normaux) ou STOCK (marchandise à mettre en stock en agence).', true],
              ['phone', 'corps', 'Téléphone de contact sur place (10 chiffres commençant par 0).', true],
              ['address', 'corps', 'Adresse de ramassage (500 caractères max).', true],
              ['note', 'corps', 'Remarque pour le ramasseur (500 caractères max), ex. nombre de colis, horaires.', true]
            ]}
          />
          <Code label="Exemple de requête">{`curl -X POST ${BASE_URL}/demandes-ramassage/client \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "SIMPLE_PARCEL",
    "phone": "0522123456",
    "address": "Adresse de votre boutique",
    "note": "5 colis prêts, disponible de 10h à 18h"
  }'`}</Code>
          <Code label="Réponse 201">{`{
  "id": 3120,
  "type": "SIMPLE_PARCEL",
  "phone": "0522123456",
  "address": "Adresse de votre boutique",
  "note": "5 colis prêts, disponible de 10h à 18h",
  "time": 1756800000,
  "statut": "new"
}`}</Code>
          <p className="api-hint">
            400 si un champ manque, si le téléphone est invalide ou si 3 demandes sont déjà en
            attente.
          </p>
        </Endpoint>

        <Endpoint
          method="GET"
          path="/demandes-ramassage/client"
          desc="Vos demandes de ramassage, les plus récentes d’abord."
        >
          <Params
            rows={[
              ['statut', 'query', 'new (en attente), received (affectée à un ramasseur) ou treated (ramassée). Vide = toutes.'],
              ['type', 'query', 'SIMPLE_PARCEL ou STOCK. Vide = tous.'],
              ['dateFrom', 'query', 'Date de la demande ≥ (AAAA-MM-JJ).'],
              ['dateTo', 'query', 'Date de la demande ≤ (AAAA-MM-JJ).']
            ]}
          />
          <Code label="Réponse 200">{`[
  {
    "id": 3120,
    "type": "SIMPLE_PARCEL",
    "phone": "0522123456",
    "address": "Adresse de votre boutique",
    "note": "5 colis prêts, disponible de 10h à 18h",
    "time": 1756800000,
    "statut": "received"
  }
]`}</Code>
        </Endpoint>
      </Section>

      {/* ---------- Suivi public ---------- */}
      <Section
        id="api-public"
        title="Suivi public (sans jeton)"
        intro="Le suivi par code colis est ouvert sans authentification : idéal pour afficher l’avancement d’une livraison sur votre site ou dans un e-mail à vos clients."
      >
        <Endpoint
          method="GET"
          path="/public/track?num={code}"
          desc="Étapes de suivi d’un colis désigné par son code (parcel_code), avec libellé, couleur et date de chaque étape. Sans jeton ; limité à 30 requêtes par minute et par adresse IP."
        >
          <Params rows={[['num', 'query', 'Code du colis (parcel_code).', true]]} />
          <Code label="Exemple de requête">{`curl "${BASE_URL}/public/track?num=CMD-2026-1045"`}</Code>
          <Code label="Réponse 200">{`{
  "success": true,
  "code": "CMD-2026-1045",
  "history": [
    { "name": "En attente de ramassage", "color": "#6c757d", "date": "2026-09-02" },
    { "name": "Ramassé", "color": "#17a2b8", "date": "2026-09-02" },
    { "name": "Livré", "color": "#28a745", "date": "2026-09-04" }
  ]
}`}</Code>
          <Code label="Réponse 200 (code inconnu)">{`{
  "success": false,
  "message": "لم يتم العثور على أي طرد بهذا الرقم."
}`}</Code>
          <p className="api-hint">
            La réponse est toujours en 200 : testez <code className="mono">success</code>. Le
            message d’échec est celui de la page de suivi publique (en arabe) ; affichez votre
            propre texte si besoin.
          </p>
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
                <td className="api-cell-wrap">Requête invalide : paramètre manquant ou incorrect (destinataire, téléphone, ville, adresse, montant, produits de stock, quota de ramassages…) ; le message précise la cause.</td>
              </tr>
              <tr>
                <td><span className="mono">401</span></td>
                <td className="api-cell-wrap">Jeton manquant, invalide ou expiré : reconnectez-vous.</td>
              </tr>
              <tr>
                <td><span className="mono">403</span></td>
                <td className="api-cell-wrap">Accès refusé : le compte n’est pas un compte client, il est désactivé, ou le membre d’équipe n’a pas la tâche requise par l’endpoint.</td>
              </tr>
              <tr>
                <td><span className="mono">404</span></td>
                <td className="api-cell-wrap">Ressource introuvable : colis n’appartenant pas à votre compte, ou aucun tarif pour la ville demandée.</td>
              </tr>
              <tr>
                <td><span className="mono">409</span></td>
                <td className="api-cell-wrap">Conflit : code colis déjà utilisé, colis plus modifiable / supprimable / blocable (statut avancé), ou demande de modification déjà en attente.</td>
              </tr>
              <tr>
                <td><span className="mono">422</span></td>
                <td className="api-cell-wrap">Champs de connexion manquants ou invalides.</td>
              </tr>
              <tr>
                <td><span className="mono">429</span></td>
                <td className="api-cell-wrap">Trop de requêtes (patientez 1 minute).</td>
              </tr>
              <tr>
                <td><span className="mono">503</span></td>
                <td className="api-cell-wrap">Fonction temporairement indisponible : réessayez plus tard.</td>
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
        intro="Le déroulé type d’une intégration boutique : connexion, choix de la ville, création du colis à la commande, puis suivi de la livraison."
      >
        <Code label="1. Connexion — récupérer le jeton">{`curl -X POST ${BASE_URL}/auth/login/client \\
  -H "Content-Type: application/json" \\
  -d '{ "identifiant": "boutique@exemple.com", "password": "••••••••" }'
# → conservez la valeur "token" de la réponse (valable 8 h)`}</Code>
        <Code label="2. Villes de destination — retrouver l’id de la ville du client">{`curl ${BASE_URL}/parcels/client/new \\
  -H "Authorization: Bearer <votre jeton>"
# → "cities": [ { "id": 12, "label": "Casablanca" }, … ]`}</Code>
        <Code label="3. Créer le colis à la validation de la commande">{`curl -X POST ${BASE_URL}/parcels/client \\
  -H "Authorization: Bearer <votre jeton>" \\
  -H "Content-Type: application/json" \\
  -d '{ "code": "CMD-2026-1045", "receiver": "Nom du destinataire", "phone": "0612345678",
        "city": 12, "address": "12 rue Exemple, quartier Maarif", "price": 250,
        "product": "Chaussures", "qty": 1, "open": 1 }'
# → { "parcel_id": 4512, "parcel_code": "CMD-2026-1045" } : conservez parcel_id`}</Code>
        <Code label="4. Suivre la livraison (statut courant + historique)">{`curl "${BASE_URL}/parcels/client?search=CMD-2026-1045" \\
  -H "Authorization: Bearer <votre jeton>"
# → rows[0].statut = code du statut courant (libellés : /parcels/statuts/libelles)

curl ${BASE_URL}/parcels/client/4512/suivi \\
  -H "Authorization: Bearer <votre jeton>"
# → "entries": toutes les étapes, avec livreur affecté et photo preuve éventuelle`}</Code>
        <Code label="5. Afficher le suivi à votre client (sans jeton)">{`curl "${BASE_URL}/public/track?num=CMD-2026-1045"
# → "history": [ { "name": "Livré", "color": "#28a745", "date": "2026-09-04" }, … ]`}</Code>
      </Section>
    </div>
  );
}
