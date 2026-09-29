import ImportColisPage from './ImportColisPage';

/**
 * Page /admin/import-colis/stock — import Excel de colis de stock : la colonne
 * REF PRODUIT (obligatoire) doit correspondre à la réf unique d'un produit du
 * client choisi ; le stock est vérifié puis déduit à la création des colis.
 */
export default function ImportColisStock() {
  return <ImportColisPage fromStock />;
}
