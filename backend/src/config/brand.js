/**
 * Identité de la plateforme côté API. Fichier UNIQUE à modifier pour
 * rebaptiser l'application (pendant côté interface : frontend/src/config/brand.js).
 *
 * - jwtIssuer / jwtAudience / cookieName : identifiants de session. Les changer
 *   invalide toutes les sessions en cours (comportement attendu).
 * - configPrefix : préfixe des clés propres à cette application dans
 *   delevery_configs (ex. app_company_name). Les clés historiques du système
 *   PHP (config_*, ws_config_*) ne sont jamais touchées.
 */
const NAME = 'OSMAN EXPRESS';
const SLUG = 'osmanexpress';

const BRAND = {
  name: NAME,
  slug: SLUG,
  jwtIssuer: SLUG,
  jwtAudience: `${SLUG}-app`,
  cookieName: `${SLUG}_token`,
  configPrefix: 'app_',
  colorPrimary: '#d80613',
  colorSecondary: '#111111',
  messages: {
    compteDesactive: `Compte désactivé. Contactez ${NAME}.`,
    /** Modèle par défaut du message WhatsApp (lien wa.me) envoyé par le livreur. */
    livreurDefaut:
      `Bonjour {destinataire}, je suis le livreur ${NAME}. J’ai un colis pour vous : {code} ({magasin}), montant à régler : {crbt}. Adresse : {adresse}, {ville}. Merci de me confirmer votre disponibilité.`
  }
};

/** Clé delevery_configs propre à l'application : cfgKey('company_name') → 'app_company_name'. */
function cfgKey(name) {
  return `${BRAND.configPrefix}${name}`;
}

module.exports = { BRAND, cfgKey };
