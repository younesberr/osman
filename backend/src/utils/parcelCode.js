/*
 * Validation partagée du code colis saisi par l'utilisateur (création client
 * / admin, modales « Modifier colis »). Même règle que le frontend
 * (frontend/src/utils/parcelCode.js). Un code vide à la création est accepté
 * (code généré) ; un code saisi doit être alphanumérique (lettres A-Z / a-z et
 * chiffres, sans espace ni tiret) et compter au moins 5 caractères (100 max,
 * taille de la colonne parcel_code).
 */

/** Lettres et chiffres uniquement, 5 à 100 caractères. */
const PARCEL_CODE_REGEX = /^[A-Za-z0-9]{5,100}$/;

/** Message d'erreur commun renvoyé quand le code saisi ne respecte pas la règle. */
const PARCEL_CODE_ERROR =
  'Code colis invalide : lettres et chiffres uniquement (sans espace ni tiret), 5 caractères minimum.';

/** true si le code (déjà trimé) respecte la règle. */
function isValidParcelCode(value) {
  return PARCEL_CODE_REGEX.test(String(value || ''));
}

module.exports = { PARCEL_CODE_REGEX, PARCEL_CODE_ERROR, isValidParcelCode };
