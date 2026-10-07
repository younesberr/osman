/*
 * Statut affiché (« statut effectif ») d'un colis, en SQL, sur l'alias `p`
 * (delevery_parcel) :
 *  - parcel_situation = INVOICED  → INVOICED (type 1) ;
 *  - sinon parcel_status = IN_PROGRESS → parcel_status_second (type 3, si renseigné) ;
 *  - sinon parcel_status = RETURNED + second RETURNED_TO_STOCK (colis de stock
 *    réintégré à la réception de son bon retour client) → RETURNED_TO_STOCK (type 3) ;
 *  - sinon → parcel_status (type 2).
 * (parcel_statut_code, parcel_statut_type) est unique dans delevery_parcel_statut.
 * Défini ici (et non dans un contrôleur) pour être utilisable par les services
 * et les utilitaires sans cycle de require ;
 * parcels.controller.js le ré-exporte pour les contrôleurs existants.
 * Même CASE dans modificationsColis.controller.js.
 */
const STATUT_CODE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 'INVOICED'
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> ''
      THEN p.parcel_status_second
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK'
      THEN 'RETURNED_TO_STOCK'
    ELSE p.parcel_status
  END`;

const STATUT_TYPE_SQL = `CASE
    WHEN p.parcel_situation = 'INVOICED' THEN 1
    WHEN p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') <> '' THEN 3
    WHEN p.parcel_status = 'RETURNED' AND p.parcel_status_second = 'RETURNED_TO_STOCK' THEN 3
    ELSE 2
  END`;

module.exports = { STATUT_CODE_SQL, STATUT_TYPE_SQL };
