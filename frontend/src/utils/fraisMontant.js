/*
 * Frais supplémentaires automatiques selon le montant du colis (miroir de
 * backend/src/utils/fraisMontant.js) : `montant` DH par tranche de `seuil` DH
 * entamée au-delà de `seuil` DH (2 500 DH → 0 ; 2 501 à 5 000 → 20 DH ;
 * 5 001 à 7 500 → 40 DH…). La règle et l'état de l'option du client viennent
 * du bloc `frais_montant` ({ actif, seuil, montant }) renvoyé par l'API
 * (/parcels/client/new, /parcels/new/client, /parcels/import/data, données des
 * modales de modification) ; le serveur reste la référence à l'enregistrement.
 */

/** Règle par défaut, utilisée tant que l'API n'a pas répondu. */
export const REGLE_DEFAUT = { actif: 1, seuil: 2500, montant: 20 };

/** Nombre de tranches entamées au-delà du seuil (0 si montant ≤ seuil ou invalide). */
export function tranchesMontant(price, regle = REGLE_DEFAUT) {
  const p = Number(price);
  const seuil = Number(regle?.seuil) || REGLE_DEFAUT.seuil;
  if (!Number.isFinite(p) || p <= seuil) return 0;
  return Math.ceil(p / seuil) - 1;
}

/** Frais supp automatiques (DH) pour un montant ; 0 si l'option du client est désactivée. */
export function fraisMontant(price, regle = REGLE_DEFAUT) {
  if (!regle || Number(regle.actif) !== 1) return 0;
  return tranchesMontant(price, regle) * (Number(regle.montant) || REGLE_DEFAUT.montant);
}

/** Montant entier au format fr-FR ('2 500'). */
export function formatDh(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}
