/*
 * Validation partagée des numéros de téléphone des destinataires de colis
 * (création, import et modification, endpoints admin et client). Même règle
 * que le frontend (frontend/src/utils/phone.js).
 */

/** Retire les séparateurs usuels (espaces, points, tirets) d'un n° de téléphone. */
function normalizePhone(value) {
  return String(value || '').replace(/[\s.-]/g, '');
}

/** Format marocain attendu : 10 chiffres commençant par 0 (ex. 0600000000). */
const PHONE_REGEX = /^0\d{9}$/;

/** Message d'erreur commun renvoyé quand le numéro ne respecte pas le format. */
const PHONE_ERROR = 'Numéro de téléphone invalide : 10 chiffres commençant par 0 (ex. 0600000000).';

/** true si le numéro (séparateurs tolérés) respecte le format marocain. */
function isValidPhone(value) {
  return PHONE_REGEX.test(normalizePhone(value));
}

/**
 * Formes sous lesquelles un même numéro marocain peut être stocké dans
 * parcel_phone / customers_phone / users_phone (legacy : « 650272696 » sans
 * le 0, indicatif +212 / 00212…) : la comparaison se fait sur les 9 derniers
 * chiffres, via une liste IN exploitable par l'index idx_parcel_phone
 * (sql/2026-09-07_index-parcel-phone.sql). Les rares numéros saisis avec des
 * espaces (< 0,1 % des colis) sont ignorés.
 */
function phoneVariants(phone) {
  const d9 = normalizePhone(phone).replace(/^\+/, '').slice(-9);
  return [`0${d9}`, d9, `212${d9}`, `+212${d9}`, `00212${d9}`];
}

/** Affichage d'un numéro (« 212612345678 » ou « 0612345678 » → « 06 12 34 56 78 »). */
function formatPhoneAffichage(value) {
  let d = normalizePhone(value).replace(/^\+/, '');
  if (d.startsWith('00212')) d = d.slice(5);
  else if (d.startsWith('212') && d.length === 12) d = d.slice(3);
  if (d.length === 9) d = `0${d}`;
  if (!/^0\d{9}$/.test(d)) return String(value || '').trim();
  return d.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
}

module.exports = { normalizePhone, isValidPhone, PHONE_ERROR, phoneVariants, formatPhoneAffichage };
