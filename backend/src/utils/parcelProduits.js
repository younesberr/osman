const pool = require('../config/db');

/*
 * Produits de stock des colis (delevery_parcel_content : une ligne par unité
 * → quantités groupées par produit), avec la position de stock du produit
 * (delevery_product.product_rayonnage). Partagé entre les bons de sortie
 * (détail, PDF) et les tickets des colis de stock.
 */

/**
 * Renvoie une Map parcel_id → [{ nom, variante, qty, position }] pour les
 * colis passés en paramètre.
 */
async function getProduitsByParcel(parcelIds) {
  const map = new Map();
  if (!parcelIds.length) return map;
  const [rows] = await pool.query(
    `SELECT pc.parcel_content_parcel_id AS parcelId,
            pc.parcel_content_product_name AS nom,
            COALESCE(NULLIF(pc.parcel_content_variant_name, ''), '') AS variante,
            MAX(pr.product_rayonnage) AS position,
            COUNT(*) AS qty
       FROM delevery_parcel_content pc
       LEFT JOIN delevery_product pr ON pr.product_id = pc.parcel_content_product_id
      WHERE pc.parcel_content_parcel_id IN (?)
      GROUP BY pc.parcel_content_parcel_id, pc.parcel_content_product_id,
               pc.parcel_content_product_name,
               COALESCE(NULLIF(pc.parcel_content_variant_name, ''), '')
      ORDER BY pc.parcel_content_product_name`,
    [parcelIds]
  );
  for (const row of rows) {
    const { parcelId, ...produit } = row;
    if (!map.has(parcelId)) map.set(parcelId, []);
    map.get(parcelId).push(produit);
  }
  return map;
}

/**
 * Attache aux données d'étiquettes (GET /parcels/labels & co) les produits de
 * stock des colis de stock (parcel_from_stock = 1) : champ stock_produits,
 * affiché sur le ticket à la place de la ligne « Marchandise ».
 */
async function attachStockProduits(labels) {
  const stockIds = labels
    .filter((l) => Number(l.parcel_from_stock) === 1)
    .map((l) => l.parcel_id);
  if (!stockIds.length) return;
  const produits = await getProduitsByParcel(stockIds);
  for (const label of labels) {
    if (Number(label.parcel_from_stock) === 1) {
      label.stock_produits = produits.get(label.parcel_id) || [];
    }
  }
}

module.exports = { getProduitsByParcel, attachStockProduits };
