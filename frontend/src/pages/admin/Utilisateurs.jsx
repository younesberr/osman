import UsersDatatable from '../../components/UsersDatatable';

/** Tous les comptes, sauf les livreurs auto-entrepreneurs (page Livreurs).
 * Bouton « Excel paie » : export des lignes du filtre (nom, agence, contrat,
 * salaire actuel, banque, RIB). */
export default function Utilisateurs() {
  return (
    <UsersDatatable
      endpoint="/users"
      showType
      unit="utilisateur"
      detailPath="/admin/utilisateurs"
      allowCreate
      exportPaie
    />
  );
}
