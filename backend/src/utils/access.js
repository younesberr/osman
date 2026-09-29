const SUPER_ADMIN_TYPE = 1;

/** users_services : liste de codes séparés par des virgules (ex: "RETOUR,COLIS"). */
function parseServices(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * has_access : contrôle l'accès d'un employé à un service (page / entrée de menu).
 * Le superAdmin (users_type = 1) a accès à tout ; sinon le code doit figurer
 * dans users_services. `service` peut être un code ou un tableau de codes
 * (accès si au moins un correspond).
 */
function hasAccess(user, service) {
  if (!service) return true;
  if (!user || user.kind !== 'employee') return false;
  if (Number(user.role) === SUPER_ADMIN_TYPE) return true;
  const granted = Array.isArray(user.services) ? user.services : [];
  const wanted = Array.isArray(service) ? service : [service];
  return wanted.some((code) => granted.includes(code));
}

module.exports = { parseServices, hasAccess, SUPER_ADMIN_TYPE };
