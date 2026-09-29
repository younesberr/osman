/**
 * Validation partagée du code colis saisi par l'utilisateur (pages « Nouveau
 * colis » client / admin, modales « Modifier colis »). Même règle que le
 * serveur (backend/src/utils/parcelCode.js) : vide accepté à la création (code
 * généré), sinon lettres et chiffres uniquement, 5 caractères minimum.
 */

/** Lettres et chiffres uniquement, 5 à 100 caractères. */
export const PARCEL_CODE_REGEX = /^[A-Za-z0-9]{5,100}$/;

/** Message d'erreur commun affiché quand le code saisi ne respecte pas la règle. */
export const PARCEL_CODE_ERROR =
  'Code invalide : lettres et chiffres uniquement (sans espace ni tiret), 5 caractères minimum.';

/** true si le code (déjà trimé) respecte la règle. */
export function isValidParcelCode(value) {
  return PARCEL_CODE_REGEX.test(String(value || ''));
}
