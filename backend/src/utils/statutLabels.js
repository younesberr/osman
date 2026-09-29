const pool = require('../config/db');

/*
 * Libellés français des statuts colis pour les messages d'erreur du backend
 * (scan / ajout-retrait des bons : « non ajoutable (statut actuel : … ) »).
 * Même source que GET /parcels/statuts/libelles : delevery_string
 * (string_ref = parcel_statut_name, lang 'fr'), repli sur parcel_statut_nom
 * (miroir legacy) puis sur le code brut si la traduction manque. Dédoublonné
 * par code, le type le plus prioritaire gagne (comme le frontend).
 */

let cache = null;
let chargement = null;

async function loadLabels() {
  const [rows] = await pool.query(
    `SELECT s.parcel_statut_code AS code,
            COALESCE(st.string_text, s.parcel_statut_nom) AS nom
       FROM delevery_parcel_statut s
       LEFT JOIN (SELECT string_ref, MIN(string_text) AS string_text
                    FROM delevery_string
                   WHERE string_lang = 'fr'
                   GROUP BY string_ref) st
         ON st.string_ref COLLATE utf8mb4_unicode_ci = s.parcel_statut_name
      ORDER BY s.parcel_statut_type, s.parcel_statut_id`
  );
  const labels = {};
  for (const r of rows) {
    if (r.nom && !(r.code in labels)) labels[r.code] = r.nom;
  }
  return labels;
}

/** Libellé français d'un code statut (« SENT » → « Expédié ») ; renvoie le
 * code brut si inconnu ou si le chargement échoue (jamais d'exception). */
async function statutLabel(code) {
  if (!cache) {
    if (!chargement) {
      chargement = loadLabels().finally(() => {
        chargement = null;
      });
    }
    try {
      cache = await chargement;
    } catch {
      return code;
    }
  }
  return cache[code] || code;
}

/** Vide le cache après création / renommage d'un statut (Configuration > Options). */
function invaliderStatutLabels() {
  cache = null;
}

module.exports = { statutLabel, invaliderStatutLabels };
