/**
 * Identité de la plateforme : marque, coordonnées, textes légaux, couleurs
 * par défaut. Fichier UNIQUE à modifier pour rebaptiser l'application : tout
 * le frontend importe ces valeurs (pendant côté API : backend/src/config/brand.js).
 *
 * Le logo, le favicon et les couleurs enregistrés dans Admin > Configuration >
 * Plateforme (base de données) priment sur les valeurs ci-dessous à l'exécution.
 * Les champs « À COMPLÉTER » sont à renseigner avant la mise en ligne.
 */
const NAME = 'OSMAN EXPRESS';
const NAME_AR = 'أوسمان إكسبريس'; // À CONFIRMER avec la société
const SLUG = 'osmanexpress';
const DOMAIN = 'osmanexpress.ma';

export const BRAND = {
  name: NAME,
  slug: SLUG,
  nameAr: NAME_AR,
  /** Repli affiché quand aucun logo n'est enregistré (sidebar, connexion). */
  monogram: 'OS',
  /** Repli texte des étiquettes / tickets / bons quand le logo est absent. */
  logoText: { main: 'OSMAN', sub: 'EXPRESS' },
  taglineAr: 'التوصيل في كل مكان بالمغرب',
  metaDescriptionAr:
    `${NAME_AR} الحل الأمثل لشحن وتوصيل الطرود في المغرب. استلام مرن، تتبع فوري، خدمة عملاء احترافية — شريك تجارتك الإلكترونية.`,

  domain: DOMAIN,
  siteUrl: `https://${DOMAIN}`,
  siteWebDisplay: `www.${DOMAIN}`,
  /** URL de base affichée dans la documentation API (production). */
  apiBaseUrl: `https://${DOMAIN}/api`,
  email: `contact@${DOMAIN}`,
  /** Domaine des adresses d'exemple (placeholders des formulaires). */
  emailDomain: DOMAIN,

  /** Logo des pages publiques (frontend/public/home/). */
  logo: { src: '/home/header-logo.png', width: 1200, height: 232, alt: NAME_AR },
  favicon: '/home/favicon.png',

  colorPrimary: '#d80613',
  colorSecondary: '#111111',

  /** Identifiants techniques (sessionStorage). */
  storage: { preloadReload: `${SLUG}:preload-reload` },

  /** Messages pré-remplis des liens « cliquer pour discuter » (wa.me). */
  messages: {
    livreurDefaut:
      `Bonjour {destinataire}, je suis le livreur ${NAME}. J’ai un colis pour vous : {code} ({magasin}), montant à régler : {crbt}. Adresse : {adresse}, {ville}. Merci de me confirmer votre disponibilité.`,
    ramasseurRamassage: `Bonjour, je suis le ramasseur ${NAME}. Je vous contacte au sujet du ramassage de vos colis.`,
    ramasseurRetour: `Bonjour, je suis le ramasseur ${NAME}. Je vous contacte au sujet du retour de vos colis.`
  },

  /** Coordonnées affichées sur le site public (accueil, footer, contact). */
  contact: {
    phone: 'À COMPLÉTER',
    whatsapp: 'À COMPLÉTER',
    adresse: 'À COMPLÉTER',
    horaires: 'الإثنين – السبت، 09:00 – 18:00',
    fb: '#',
    insta: '#',
    yt: '#'
  },

  /** Informations légales (contrat, mentions légales, CGU). */
  legal: {
    raisonSociale: NAME,
    formeJuridique: 'À COMPLÉTER',
    siegeFr: 'À COMPLÉTER',
    rcVille: 'À COMPLÉTER',
    rc: 'À COMPLÉTER',
    ice: 'À COMPLÉTER',
    ifFiscal: 'À COMPLÉTER',
    cnss: 'À COMPLÉTER',
    capital: 'À COMPLÉTER',
    hebergeur: { nom: 'À COMPLÉTER', url: '' }
  }
};

/** Forme plate historique utilisée par les pages publiques et légales. */
export const HOME_INFO = {
  ...BRAND.contact,
  email: BRAND.email,
  ...BRAND.legal,
  siteWeb: BRAND.siteWebDisplay
};

/** Titre de l'onglet : « <Page> - MARQUE », ou le titre arabe complet sans page. */
export function pageTitle(label) {
  return label ? `${label} - ${BRAND.name}` : `${BRAND.nameAr} — ${BRAND.taglineAr}`;
}
