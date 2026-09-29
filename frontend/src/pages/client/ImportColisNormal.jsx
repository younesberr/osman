import ImportColisPage from '../admin/ImportColisPage';

/**
 * Page /client/import-colis/normal — import Excel de colis normaux du client
 * connecté (même page que côté admin, sans la liste des clients).
 */
export default function ImportColisNormal() {
  return <ImportColisPage forClient />;
}
