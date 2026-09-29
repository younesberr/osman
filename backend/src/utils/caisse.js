const pool = require('../config/db');
const { userAgenceSql } = require('./agenceScope');

/*
 * Caisse Agence — écritures sur la table legacy delevery_spent (partagée
 * avec l'ancien système ; aucune colonne ajoutée) et règle de rattachement
 * d'une entrée à une agence.
 *
 * Règle : une dépense / recette n'est comptée sur la caisse d'une agence que
 * si son auteur (spent_by) est un responsable d'agence (type 3). Les entrées
 * des autres utilisateurs (admin, sous-admin, agents d'agence, ramasseurs…)
 * sont classées « Sans agence » (caisse hors agence). Même règle pour les
 * entrées automatiques : paiement d'une facture client (dépense), paiement
 * d'une facture livreur (recette) et encaissement des frais de livraison
 * d'un colis montant zéro (recette).
 *
 * Le rattachement est calculé à la lecture (comme le legacy spent.php, qui
 * lisait users_agence_id de l'auteur) : agence de l'auteur (ville de
 * fonction → zone → agence, repli users_agence_id) si type 3, sinon NULL.
 * Les entrées existantes, y compris celles saisies par l'ancien système,
 * suivent donc la même règle sans migration.
 *
 * spent_type : 0 = Dépense, 1 = Recette. spent_amount : entier (DH).
 * spent_time / spent_added_time : timestamps unix stockés en varchar.
 */

const TYPE_RESPONSABLE_AGENCE = 3;

const TYPES_ENTREE = { DEPENSE: 0, RECETTE: 1 };

/**
 * Expression SQL : agence de caisse de l'auteur d'une entrée (`alias` =
 * alias de delevery_users joint sur spent_by), NULL si l'auteur n'est pas
 * un responsable d'agence (type 3). users_type est un varchar legacy.
 */
function caisseAgenceSql(alias = 'u') {
  return `CASE WHEN CAST(${alias}.users_type AS UNSIGNED) = ${TYPE_RESPONSABLE_AGENCE}
    THEN ${userAgenceSql(alias)} ELSE NULL END`;
}

/**
 * Ajoute une entrée de caisse (non validée). `conn` : connexion d'une
 * transaction en cours, ou le pool.
 * { type (TYPES_ENTREE), titre, description, montant (DH, arrondi à
 *   l'entier — schéma legacy), date (unix, défaut maintenant), userId }.
 * Renvoie l'id inséré.
 */
async function ajouterEntreeCaisse(conn, { type, titre, description = '', montant, date, userId }) {
  const now = Math.floor(Date.now() / 1000);
  const [result] = await conn.query(
    `INSERT INTO delevery_spent
       (spent_title, spent_desc, spent_amount, spent_time, spent_added_time,
        spent_by, spent_validated, spent_type)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      String(titre),
      String(description || ''),
      Math.round(Number(montant) || 0),
      String(date || now),
      String(now),
      Number(userId) || 0,
      type === TYPES_ENTREE.RECETTE ? 1 : 0
    ]
  );
  return result.insertId;
}

/*
 * Migration sql/2026-09-19_caisse-agence.sql :
 *  - § 1 colonnes spent_validated_by / spent_validated_time (delevery_spent) ;
 *  - § 2 table delevery_caisse_arret (arrêts de caisse).
 * Présence vérifiée via information_schema, résultat positif gardé en cache
 * pour de bon, négatif re-testé toutes les 60 s (le temps que la migration
 * passe en prod, sans redémarrage). Sans le § 1 : la validation marche mais le
 * validateur n'est pas enregistré (NULL en lecture). Sans le § 2 : état des
 * caisses et arrêts « indisponibles », aucun verrou d'arrêt, le reste marche.
 */
const CAISSE_MIGRATION = 'sql/2026-09-19_caisse-agence.sql';

function detecteur(sql) {
  let ok = false;
  let prochainTest = 0;
  return async () => {
    if (ok) return true;
    const now = Date.now();
    if (now < prochainTest) return false;
    prochainTest = now + 60 * 1000;
    const [[row]] = await pool.query(sql);
    ok = Number(row?.n) > 0;
    return ok;
  };
}

const caisseValidationDisponible = detecteur(
  `SELECT COUNT(*) = 2 AS n
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'delevery_spent'
      AND COLUMN_NAME IN ('spent_validated_by', 'spent_validated_time')`
);

const caisseArretDisponible = detecteur(
  `SELECT COUNT(*) AS n
     FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'delevery_caisse_arret'`
);

module.exports = {
  TYPE_RESPONSABLE_AGENCE,
  TYPES_ENTREE,
  CAISSE_MIGRATION,
  caisseAgenceSql,
  ajouterEntreeCaisse,
  caisseValidationDisponible,
  caisseArretDisponible
};
