const pool = require('../config/db');

/*
 * Frais supplémentaires automatiques selon le montant du colis (CRBT) :
 * 20 DH par tranche de 2 500 DH entamée au-delà de 2 500 DH.
 *   - montant ≤ 2 500 DH          → 0 DH ;
 *   - 2 500 < montant ≤ 5 000 DH  → 20 DH ;
 *   - 5 000 < montant ≤ 7 500 DH  → 40 DH ;
 *   - 7 500 < montant ≤ 10 000 DH → 60 DH, etc.
 * Le montant est écrit dans parcel_extra_fees (frais supp de livraison du
 * colis : même colonne que le champ « Frais supplémentaires » de la modale
 * admin « Modifier colis », facturée au client avec la ligne du colis, cf.
 * facturesClients.controller). Option par client : customers_frais_montant
 * (delevery_customers, sql/2026-09-28_frais-montant-colis.sql), 1 = activée
 * (défaut), 0 = aucun frais automatique pour ce client. Réglable par l'admin
 * dans /admin/clients › Options (« Frais selon le montant du colis »).
 * Colonne absente (migration pas encore exécutée) → option considérée activée.
 */

/** Seuil (DH) au-delà duquel les frais s'appliquent, et taille des tranches. */
const SEUIL = 2500;
/** Frais (DH) ajoutés par tranche entamée. */
const MONTANT = 20;

const MESSAGE_OPTION_ABSENTE =
  'Option « Frais selon le montant » indisponible : exécutez sql/2026-09-28_frais-montant-colis.sql dans phpMyAdmin.';

/** Nombre de tranches de 2 500 DH entamées au-delà du seuil (0 si montant ≤ seuil). */
function tranchesMontant(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= SEUIL) return 0;
  return Math.ceil(p / SEUIL) - 1;
}

/** Frais supp automatiques (DH) pour un montant de colis, option activée. */
function fraisMontant(price) {
  return tranchesMontant(price) * MONTANT;
}

/**
 * Option du client : { actif: 0|1, disponible: bool }. Client inconnu ou
 * colonne absente (migration non exécutée) → actif = 1 (valeur par défaut).
 * `db` : pool par défaut, ou une connexion de transaction.
 */
async function lireOptionFraisMontant(customerId, db = pool) {
  try {
    const [[row]] = await db.query(
      `SELECT IFNULL(customers_frais_montant, 1) AS actif
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [Number(customerId)]
    );
    return { actif: row && Number(row.actif) === 0 ? 0 : 1, disponible: true };
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return { actif: 1, disponible: false };
    throw err;
  }
}

/** Frais supp automatiques d'un colis du client (0 si son option est désactivée). */
async function fraisMontantClient(customerId, price, db = pool) {
  const { actif } = await lireOptionFraisMontant(customerId, db);
  return actif ? fraisMontant(price) : 0;
}

/**
 * Nouveaux frais supp d'un colis dont le prix change : la part automatique de
 * l'ancien prix est retirée, celle du nouveau ajoutée, le reste (frais posés à
 * la main par l'admin, ex. colis volumineux) est conservé ; jamais négatif.
 * Option désactivée → frais actuels inchangés.
 */
function ajusterFraisMontant(extraActuel, ancienPrix, nouveauPrix, actif) {
  const actuel = Math.max(0, Number(extraActuel) || 0);
  if (!actif) return actuel;
  return Math.max(0, actuel - fraisMontant(ancienPrix) + fraisMontant(nouveauPrix));
}

/**
 * Bloc `frais_montant` renvoyé aux formulaires (nouveau colis, import,
 * modification) : { actif: 0|1, seuil, montant } — le front affiche la
 * notification « frais supp ajoutés » dès que le montant saisi dépasse le seuil.
 */
function infoFraisMontant(actif) {
  return { actif: actif ? 1 : 0, seuil: SEUIL, montant: MONTANT };
}

module.exports = {
  SEUIL,
  MONTANT,
  MESSAGE_OPTION_ABSENTE,
  tranchesMontant,
  fraisMontant,
  lireOptionFraisMontant,
  fraisMontantClient,
  ajusterFraisMontant,
  infoFraisMontant
};
