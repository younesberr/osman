import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Eye,
  FileSpreadsheet,
  Power,
  Search,
  UserPlus,
  X,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import SearchableSelect from './SearchableSelect';
import SearchSelect from './SearchSelect';

const PAGE_SIZES = [10, 25, 50, 100];

const TYPE_LABELS = {
  SUPER_ADMIN: 'Super admin',
  RESPONSABLE_SERVICE: 'Responsable service',
  RESPONSABLE_AGENCE: "Responsable d'agence",
  AGENT_AGENCE: "Agent d'agence",
  RAMASSEUR: 'Ramasseur',
  LIVREUR: 'Livreur'
};

function typeLabel(code) {
  return TYPE_LABELS[code] || code || '—';
}

/** 'AAAA-MM-JJ' → 'JJ/MM/AAAA'. */
function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value || '—';
}

function formatSalaire(value) {
  if (value == null) return null;
  return `${Number(value).toLocaleString('fr-FR')} DH`;
}

/** Nombre entier au format fr-FR ('1 234'). */
function formatCount(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}

/** Taux part/total en pourcentage ('91,2 %'), null si aucun colis affecté. */
function formatTaux(part, total) {
  if (!total) return null;
  return `${((part / total) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
}

/** Type de contrat : dernière ligne de delevery_contrats, sinon statut du compte. */
function contratLabel(u) {
  if (u.type_contrat) return u.type_contrat;
  if (u.is_salarie == null) return null;
  return u.is_salarie === 1 ? 'Salarié' : 'Auto-entrepreneur';
}

/** Avatar : photo si URL complète, sinon initiales (les fichiers legacy ne sont pas servis). */
function Avatar({ user, size = 'md' }) {
  const [imgError, setImgError] = useState(false);
  const pic = user.users_pic || '';
  const showImg = /^https?:\/\//.test(pic) && !imgError;
  const initials = (user.users_name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  return (
    <span className={`avatar avatar-${size}`} title={user.users_name}>
      {showImg ? (
        <img src={pic} alt={user.users_name} onError={() => setImgError(true)} />
      ) : (
        initials
      )}
    </span>
  );
}

/** Badge compteur de documents : vert si 0, orange (manquants) ou rouge (expirés) sinon.
 * `items` null = statut personnel (salarié / auto-entrepreneur) non défini en base :
 * n'arrive plus qu'aux comptes créés avant sql/2026-09-04_statut-personnel-defaut.sql. */
function DocBadge({ items, kind }) {
  if (items == null) return <span className="cell-sub" title="Statut salarié / auto-entrepreneur non défini">Statut non défini</span>;
  const count = items.length;
  const cls = count === 0 ? 'doc-ok' : kind === 'expires' ? 'doc-danger' : 'doc-warn';
  const title =
    count === 0
      ? 'Aucun document'
      : items.map((it) => (typeof it === 'string' ? it : `${it.label} (${formatDate(it.date)})`)).join(', ');
  return (
    <span className={`badge doc-badge ${cls}`} title={title}>
      {count}
    </span>
  );
}

/** Fiche détail affichée par l'action "Voir détail". */
function DetailModal({ user, onClose }) {
  const rows = [
    ['Téléphone', user.users_phone],
    ['Email', user.users_email],
    ['CIN', user.users_cin],
    ['Adresse', user.users_address],
    ['Ville de fonction', user.ville_fonction],
    ['Zone', user.zone],
    ['Agence', user.agence],
    ['Fonction', typeLabel(user.type_code)],
    [
      'Services',
      Number(user.users_type) === 1
        ? 'Tous (super admin)'
        : user.services.length
          ? user.services.join(', ')
          : '—'
    ],
    ['Statut personnel', user.is_salarie == null ? 'Non défini' : user.is_salarie === 1 ? 'Salarié' : 'Auto-entrepreneur'],
    ['Date de recrutement', user.date_recrutement ? formatDate(user.date_recrutement) : '—'],
    [
      'Contrat',
      contratLabel(user)
        ? `${contratLabel(user)}${user.contrat_debut ? ` — du ${formatDate(user.contrat_debut)}` : ''}${user.contrat_fin ? ` au ${formatDate(user.contrat_fin)}` : ''}`
        : '—'
    ],
    [
      'Salaire',
      user.salaire_net != null
        ? `${formatSalaire(user.salaire_net)} net${user.salaire_declare != null ? ` (déclaré : ${formatSalaire(user.salaire_declare)})` : ''}${user.salaire_date ? ` — depuis le ${formatDate(user.salaire_date)}` : ''}`
        : '—'
    ]
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Avatar user={user} size="lg" />
            <div>
              <div className="cell-main">{user.users_name}</div>
              <div className="cell-sub">
                {user.users_active === 1 ? 'Compte actif' : 'Compte désactivé'}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <dl className="detail-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="detail-row">
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>

        <div className="detail-docs">
          <div>
            <h3>Documents manquants</h3>
            {user.docs_manquants == null ? (
              <p className="cell-sub">Statut personnel non défini — documents non suivis.</p>
            ) : user.docs_manquants.length === 0 ? (
              <p className="cell-sub">Aucun document manquant.</p>
            ) : (
              <ul>
                {user.docs_manquants.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Documents expirés</h3>
            {user.docs_expires == null ? (
              <p className="cell-sub">Statut personnel non défini — documents non suivis.</p>
            ) : user.docs_expires.length === 0 ? (
              <p className="cell-sub">Aucun document expiré.</p>
            ) : (
              <ul>
                {user.docs_expires.map((d) => (
                  <li key={d.label}>
                    {d.label} — expiré le {formatDate(d.date)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Modale "Nouvel utilisateur" / "Nouveau livreur" : crée un compte principal
 * (POST endpoint). En mode livreur, la fonction n'est pas affichée : le serveur
 * la force à Livreur (users_type = 5, auto-entrepreneur).
 */
function CreateUserModal({ endpoint, livreur = false, types, villes, onClose, onCreated }) {
  const [form, setForm] = useState({
    nom: '',
    cin: '',
    type: '',
    ville: '',
    email: '',
    phone: '',
    password: '',
    confirm: ''
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.nom.trim()) return setError('Le nom complet est obligatoire.');
    if (!livreur && !form.type) return setError('Veuillez choisir une fonction.');
    if (!form.email.trim()) {
      return setError('Un email est obligatoire pour se connecter.');
    }
    if (form.password.length < 8) {
      return setError('Le mot de passe doit contenir au moins 8 caractères.');
    }
    if (form.password !== form.confirm) {
      return setError('La confirmation ne correspond pas au mot de passe.');
    }
    setSaving(true);
    try {
      await api.post(endpoint, {
        users_name: form.nom.trim(),
        users_cin: form.cin.trim(),
        ...(!livreur && { users_type: form.type }),
        users_ville_id: form.ville,
        users_email: form.email.trim(),
        users_phone: form.phone.trim(),
        password: form.password
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <UserPlus size={18} />
            <div className="cell-main">{livreur ? 'Nouveau livreur' : 'Nouvel utilisateur'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom complet</span>
              <input
                type="text"
                value={form.nom}
                maxLength={250}
                onChange={(e) => setField('nom', e.target.value)}
                required
              />
            </label>
            <label>
              <span className="field-label">CIN</span>
              <input
                type="text"
                value={form.cin}
                maxLength={50}
                onChange={(e) => setField('cin', e.target.value)}
              />
            </label>
            {!livreur && (
              <label>
                <span className="field-label">Fonction</span>
                <select
                  value={form.type}
                  onChange={(e) => setField('type', e.target.value)}
                  required
                >
                  <option value="">— Choisir une fonction —</option>
                  {types.map((t) => (
                    <option key={t.user_types_id} value={t.user_types_id}>
                      {typeLabel(t.user_types_code)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div>
              <span className="field-label">Ville de fonction</span>
              <SearchableSelect
                value={form.ville}
                onChange={(v) => setField('ville', String(v))}
                placeholder="— Aucune —"
                options={villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))}
              />
            </div>
            <label>
              <span className="field-label">Email de connexion</span>
              <input
                type="email"
                value={form.email}
                maxLength={250}
                onChange={(e) => setField('email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone personnel</span>
              <input
                type="text"
                value={form.phone}
                maxLength={50}
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Mot de passe</span>
              <input
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setField('password', e.target.value)}
                required
              />
            </label>
            <label>
              <span className="field-label">Confirmation mot de passe</span>
              <input
                type="password"
                value={form.confirm}
                autoComplete="new-password"
                onChange={(e) => setField('confirm', e.target.value)}
                required
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <UserPlus size={15} /> {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Datatable partagée par les pages Utilisateurs et Livreurs.
 * - endpoint : '/users' ou '/livreurs' (le périmètre est appliqué côté serveur) ;
 * - showType : affiche le filtre et la colonne "Fonctions" (inutile côté livreurs) ;
 * - livreurStats : remplace les colonnes Type contrat / Salaire par zone, forme
 *   juridique et statistiques colis ;
 * - tri serveur sur les colonnes cliquables (nom, agence, fonctions, type
 *   contrat, salaire, zone, forme juridique, stats colis selon la page) ;
 * - unit : mot au singulier pour les compteurs ('utilisateur', 'livreur') ;
 * - detailPath : si fourni, "Voir détail" redirige vers `${detailPath}/:id`
 *   (page fiche) au lieu d'ouvrir la modale ;
 * - allowCreate : affiche le bouton de création ("Nouvel utilisateur" ou
 *   "Ajouter livreur" selon livreurStats) qui ouvre la modale ;
 * - exportPaie : affiche le bouton « Excel paie » (GET `${endpoint}/export-paie`,
 *   mêmes filtres et tri que la liste, toutes les pages) : nom complet, agence,
 *   type de contrat, salaire actuel, banque, RIB.
 */
export default function UsersDatatable({
  endpoint,
  showType = true,
  livreurStats = false,
  unit = 'utilisateur',
  detailPath = '',
  allowCreate = false,
  exportPaie = false
}) {
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [agence, setAgence] = useState('');
  const [type, setType] = useState('');
  const [active, setActive] = useState('1');
  const [zone, setZone] = useState('');
  const [forme, setForme] = useState('');
  const [typeContrat, setTypeContrat] = useState('');
  const [docsManquants, setDocsManquants] = useState('');
  const [docsExpires, setDocsExpires] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [filtres, setFiltres] = useState({ agences: [], types: [], zones: [], formes: [], typesContrat: [], villes: [] });
  const [detail, setDetail] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [togglingId, setTogglingId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Photo, Nom, Agence, Doc x2, Actions = 6 ; + Fonctions ; + stats livreur ou contrat/salaire.
  const colCount = 6 + (showType ? 1 : 0) + (livreurStats ? 6 : 2);

  /** Tri serveur : 1er clic = sens par défaut de la colonne, clics suivants = inversion. */
  function toggleSort(key, defaultDir) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir(defaultDir);
    }
    setPage(1);
  }

  /** defaultDir : 'asc' pour les colonnes texte, 'desc' pour les valeurs numériques. */
  function SortableTh({ sortKey, defaultDir = 'desc', children }) {
    const isActive = sortBy === sortKey;
    return (
      <th
        className={`th-sortable ${isActive ? 'th-sorted' : ''}`}
        onClick={() => toggleSort(sortKey, defaultDir)}
        title="Trier"
      >
        <span className="th-sort-label">
          {children}
          {isActive ? (
            sortDir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
          ) : (
            <ArrowUpDown size={13} className="th-sort-idle" />
          )}
        </span>
      </th>
    );
  }

  // Recherche débouncée : on n'interroge le serveur que 400 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    api
      .get(`${endpoint}/filtres`)
      .then((res) => setFiltres({ zones: [], formes: [], typesContrat: [], villes: [], ...res.data }))
      .catch(() => {});
  }, [endpoint]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(endpoint, {
        params: {
          page,
          pageSize,
          search,
          agence,
          type,
          active,
          docsManquants,
          docsExpires,
          ...(livreurStats && { zone, forme }),
          ...(!livreurStats && { typeContrat }),
          ...(sortBy && { sortBy, sortDir })
        }
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, page, pageSize, search, agence, type, active, zone, forme, typeContrat, docsManquants, docsExpires, livreurStats, sortBy, sortDir, reload]);

  const rangeLabel = useMemo(() => {
    if (!total) return `0 ${unit}`;
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} ${unit}s`;
  }, [page, pageSize, total, unit]);

  async function toggleActive(u) {
    const activer = u.users_active !== 1;
    const verbe = activer ? 'activer' : 'désactiver';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le compte de « ${u.users_name} » ?`)) return;
    setTogglingId(u.users_id);
    try {
      const res = await api.patch(`${endpoint}/${u.users_id}/active`, { active: activer ? 1 : 0 });
      setRows((prev) =>
        prev.map((r) =>
          r.users_id === u.users_id ? { ...r, users_active: res.data.users_active } : r
        )
      );
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setTogglingId(null);
    }
  }

  /**
   * « Excel paie » : exporte en .xlsx (librairie chargée à la demande) toutes
   * les lignes répondant aux filtres courants, dans l'ordre de tri affiché,
   * sans tenir compte de la pagination. Salaire écrit en nombre (sommes
   * possibles dans Excel), RIB en texte (pas de perte de zéros ni de notation
   * scientifique).
   */
  async function exportExcelPaie() {
    if (exporting || !total) return;
    setExporting(true);
    try {
      const [res, XLSX] = await Promise.all([
        api.get(`${endpoint}/export-paie`, {
          params: {
            search,
            agence,
            type,
            active,
            docsManquants,
            docsExpires,
            typeContrat,
            ...(sortBy && { sortBy, sortDir })
          }
        }),
        import('xlsx')
      ]);
      const data = res.data.rows.map((u) => ({
        'Nom complet': u.users_name || '',
        Agence: u.agence || '',
        'Type contrat': u.type_contrat || '',
        'Salaire actuel (DH)': u.salaire_net == null ? '' : Number(u.salaire_net),
        Banque: u.banque || '',
        RIB: u.rib || ''
      }));
      const headers = ['Nom complet', 'Agence', 'Type contrat', 'Salaire actuel (DH)', 'Banque', 'RIB'];
      const ws = XLSX.utils.json_to_sheet(data, { header: headers });
      ws['!cols'] = headers.map((k) => ({
        wch: Math.min(60, Math.max(k.length, ...data.map((r) => String(r[k] ?? '').length)) + 2)
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Paie');
      XLSX.writeFile(wb, `paie_${unit}s_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || "Impossible d'exporter l'Excel paie.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="utilisateurs-page">
      {(allowCreate || exportPaie) && (
        <div className="page-actions">
          {exportPaie && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={exportExcelPaie}
              disabled={exporting || loading || !total}
              title={
                total
                  ? `Exporter les ${total.toLocaleString('fr-FR')} ${unit}${total > 1 ? 's' : ''} du filtre (nom, agence, contrat, salaire, banque, RIB)`
                  : `Aucun ${unit} à exporter`
              }
            >
              <FileSpreadsheet size={16} /> {exporting ? 'Export…' : 'Excel paie'}
            </button>
          )}
          {allowCreate && (
            <button
              type="button"
              className="btn btn-primary btn-icon"
              onClick={() => setCreateOpen(true)}
            >
              <UserPlus size={16} /> {livreurStats ? 'Ajouter livreur' : 'Nouvel utilisateur'}
            </button>
          )}
        </div>
      )}

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : nom, téléphone, email, CIN…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <select
          className="datatable-select"
          value={agence}
          onChange={(e) => {
            setAgence(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Toutes les agences</option>
          {filtres.agences.map((a) => (
            <option key={a.agence_id} value={a.agence_id}>
              {a.agence_name}
            </option>
          ))}
        </select>
        {showType && (
          <select
            className="datatable-select"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Toutes les fonctions</option>
            {filtres.types.map((t) => (
              <option key={t.user_types_id} value={t.user_types_id}>
                {typeLabel(t.user_types_code)}
              </option>
            ))}
          </select>
        )}
        {livreurStats && (
          <>
            <SearchSelect
              label="Zone"
              allLabel="Toutes"
              options={filtres.zones.map((z) => ({ value: z.zone_id, label: z.zone_name }))}
              value={zone}
              onChange={(v) => {
                setZone(v);
                setPage(1);
              }}
            />
            <select
              className="datatable-select"
              value={forme}
              onChange={(e) => {
                setForme(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Toutes les formes juridiques</option>
              {filtres.formes.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}
        {!livreurStats && (
          <select
            className="datatable-select"
            value={typeContrat}
            onChange={(e) => {
              setTypeContrat(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Tous les types de contrat</option>
            {filtres.typesContrat.map((tc) => (
              <option key={tc} value={tc}>
                {tc}
              </option>
            ))}
          </select>
        )}
        <select
          className="datatable-select"
          value={active}
          onChange={(e) => {
            setActive(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Tous les statuts</option>
          <option value="1">Actifs</option>
          <option value="0">Désactivés</option>
        </select>
        <select
          className="datatable-select"
          value={docsManquants}
          onChange={(e) => {
            setDocsManquants(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Doc manquants : tous</option>
          <option value="1">Doc manquants : oui</option>
          <option value="0">Doc manquants : non</option>
        </select>
        <select
          className="datatable-select"
          value={docsExpires}
          onChange={(e) => {
            setDocsExpires(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Doc expirés : tous</option>
          <option value="1">Doc expirés : oui</option>
          <option value="0">Doc expirés : non</option>
        </select>
        <select
          className="datatable-select"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Photo</th>
              <SortableTh sortKey="users_name" defaultDir="asc">Nom complet</SortableTh>
              <SortableTh sortKey="agence" defaultDir="asc">Agence</SortableTh>
              {showType && (
                <SortableTh sortKey="fonction" defaultDir="asc">Fonctions</SortableTh>
              )}
              {livreurStats ? (
                <>
                  <SortableTh sortKey="zone" defaultDir="asc">Zone</SortableTh>
                  <SortableTh sortKey="forme_juridique" defaultDir="asc">Forme juridique</SortableTh>
                  <SortableTh sortKey="colis_affectes">Colis affectés</SortableTh>
                  <SortableTh sortKey="taux_livraison">Colis livrés</SortableTh>
                  <th>Colis en cours</th>
                  <SortableTh sortKey="taux_retour">Colis retournés</SortableTh>
                </>
              ) : (
                <>
                  <SortableTh sortKey="type_contrat" defaultDir="asc">Type contrat</SortableTh>
                  <SortableTh sortKey="salaire">Salaire</SortableTh>
                </>
              )}
              <th>Doc manquants</th>
              <th>Doc expirés</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={colCount} className="datatable-empty">
                  Aucun {unit} trouvé.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
                <tr key={u.users_id} className={u.users_active === 1 ? '' : 'row-inactive'}>
                  <td>
                    <Avatar user={u} />
                  </td>
                  <td>
                    <div className="cell-main">{u.users_name || '—'}</div>
                    <div className="cell-sub">
                      {u.users_phone || u.users_email || '—'}
                      {u.users_active !== 1 && <span className="badge badge-inactive">Désactivé</span>}
                    </div>
                  </td>
                  {/* Zone et agence dérivées de la ville de fonction (users_ville_id). */}
                  <td>
                    <div className="cell-main">{u.agence || '—'}</div>
                    {!livreurStats && u.zone && <div className="cell-sub">{u.zone}</div>}
                  </td>
                  {showType && (
                    <td>
                      <div className="cell-main">{typeLabel(u.type_code)}</div>
                      <div className="cell-sub">
                        {Number(u.users_type) === 1
                          ? 'Tous les services'
                          : u.services.length
                            ? `${u.services.length} service${u.services.length > 1 ? 's' : ''}`
                            : 'Aucun service'}
                      </div>
                    </td>
                  )}
                  {livreurStats ? (
                    <>
                      <td>
                        <div className="cell-main">{u.zone || '—'}</div>
                        {u.ville_fonction && <div className="cell-sub">{u.ville_fonction}</div>}
                      </td>
                      <td>{u.forme_juridique || '—'}</td>
                      <td>
                        <div className="cell-main">{formatCount(u.colis_affectes)}</div>
                      </td>
                      <td>
                        <div className="cell-main">{formatCount(u.colis_livres)}</div>
                        <div className="cell-sub">
                          {formatTaux(u.colis_livres, u.colis_affectes) || '—'}
                        </div>
                      </td>
                      <td>
                        <div className="cell-main">{formatCount(u.colis_en_cours)}</div>
                        <div className="cell-sub">
                          {formatTaux(u.colis_en_cours, u.colis_affectes) || '—'}
                        </div>
                      </td>
                      <td>
                        <div className="cell-main">{formatCount(u.colis_retournes)}</div>
                        <div className="cell-sub">
                          {formatTaux(u.colis_retournes, u.colis_affectes) || '—'}
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      {/* Type contrat = users_type_contrat (saisie à venir, vide pour l'instant). */}
                      <td>
                        <div className="cell-main">{u.users_type_contrat || '—'}</div>
                      </td>
                      <td>
                        <div className="cell-main">{formatSalaire(u.salaire_net) || '—'}</div>
                        {u.salaire_declare != null && (
                          <div className="cell-sub">Déclaré : {formatSalaire(u.salaire_declare)}</div>
                        )}
                      </td>
                    </>
                  )}
                  <td>
                    <DocBadge items={u.docs_manquants} kind="manquants" />
                  </td>
                  <td>
                    <DocBadge items={u.docs_expires} kind="expires" />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title="Voir détail"
                        onClick={() =>
                          detailPath ? navigate(`${detailPath}/${u.users_id}`) : setDetail(u)
                        }
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        type="button"
                        className={`row-action ${u.users_active === 1 ? 'row-action-danger' : 'row-action-success'}`}
                        title={
                          Number(me?.id) === u.users_id
                            ? 'Impossible sur votre propre compte'
                            : u.users_active === 1
                              ? 'Désactiver'
                              : 'Activer'
                        }
                        onClick={() => toggleActive(u)}
                        disabled={togglingId === u.users_id || Number(me?.id) === u.users_id}
                      >
                        <Power size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">{rangeLabel}</span>
        <div className="datatable-pager">
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage(1)}
            disabled={page <= 1}
            title="Première page"
          >
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n - 1)}
            disabled={page <= 1}
            title="Page précédente"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="page-info">
            Page {page.toLocaleString('fr-FR')} / {totalPages.toLocaleString('fr-FR')}
          </span>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n + 1)}
            disabled={page >= totalPages}
            title="Page suivante"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            title="Dernière page"
          >
            <ChevronsRight size={16} />
          </button>
        </div>
      </div>

      {detail && <DetailModal user={detail} onClose={() => setDetail(null)} />}

      {createOpen && (
        <CreateUserModal
          endpoint={endpoint}
          livreur={livreurStats}
          types={filtres.types}
          villes={filtres.villes}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setPage(1);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
