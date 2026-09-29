/**
 * Validation partagée des numéros de téléphone des destinataires de colis
 * (création et modification, dashboards admin et client).
 */

/** Retire les séparateurs usuels (espaces, points, tirets) d'un n° de téléphone. */
export function normalizePhone(value) {
  return String(value || '').replace(/[\s.-]/g, '');
}

/** Format marocain attendu : 10 chiffres commençant par 0 (ex. 0600000000). */
export const PHONE_REGEX = /^0\d{9}$/;

/** Message d'erreur commun affiché quand le numéro ne respecte pas le format. */
export const PHONE_ERROR = 'Numéro invalide : 10 chiffres commençant par 0 (ex. 0600000000).';

/** true si le numéro (séparateurs tolérés) respecte le format marocain. */
export function isValidPhone(value) {
  return PHONE_REGEX.test(normalizePhone(value));
}

/**
 * Normalise au format marocain (0XXXXXXXXX) un numéro importé ou saisi, quand
 * c'est possible : ne garde que les chiffres (espaces, points, tirets, « + »,
 * parenthèses… retirés), remplace l'indicatif international (+212, 212, 00212)
 * par 0 et ajoute le 0 initial s'il manque (cellule Excel numérique qui l'a
 * perdu). Le résultat n'est pas forcément valide (mauvais nombre de chiffres) :
 * à contrôler ensuite avec isValidPhone. Chaîne vide si aucun chiffre.
 */
export function autoFixPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00212')) digits = digits.slice(5);
  else if (digits.startsWith('212')) digits = digits.slice(3);
  return digits.startsWith('0') ? digits : `0${digits}`;
}
