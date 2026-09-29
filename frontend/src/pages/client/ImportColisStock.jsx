import ImportColisPage from '../admin/ImportColisPage';

/**
 * Page /client/import-colis/stock — import Excel de colis de stock du client
 * connecté (même page que côté admin, sans la liste des clients) : la réf de
 * chaque ligne est appariée aux produits du client, le stock vérifié puis
 * déduit à la création.
 */
export default function ImportColisStock() {
  return <ImportColisPage fromStock forClient />;
}
