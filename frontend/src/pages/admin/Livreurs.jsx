import UsersDatatable from '../../components/UsersDatatable';

/** Livreurs auto-entrepreneurs (users_type = 5 et is_salarie = 0). */
export default function Livreurs() {
  return (
    <UsersDatatable
      endpoint="/livreurs"
      showType={false}
      livreurStats
      unit="livreur"
      detailPath="/admin/livreurs"
      allowCreate
    />
  );
}
