import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowDownCircle,
  ArrowUp,
  ArrowUpCircle,
  ArrowUpDown,
  Check,
  CheckCircle2,
  History,
  Landmark,
  Lock,
  OctagonPause,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';

/*
 * Caisse Agence — reprise de la page legacy « Dépenses & Recettes »
 * (spent.php) : totaux de la période (dépenses, recettes, solde), ajout
 * d'une dépense / recette en modale, filtres (dates, type, validation,
 * agence, ajouté par, validé par) et datatable avec sélection en masse.
 * Types 1/2 : tout voir, valider (ligne ou sélection), état des caisses et
 * arrêts ; type 1 seul : supprimer (entrée hors arrêt, dernier arrêt) ;
 * type 3 : caisse de son agence uniquement, ajout seul.
 *
 * Colonne Validation : badge + nom du validateur et horodatage sous le
 * badge (sql/2026-09-19_caisse-agence.sql § 1 ; « — » pour les lignes
 * validées avant la migration).
 *
 * Arrêts de caisse (§ 2, table delevery_caisse_arret) : bloc « État des
 * caisses » (types 1/2) — une carte par caisse (agences + Sans agence) :
 * dernier arrêt, mouvements depuis, solde courant = solde d'arrêt + toutes
 * les lignes (validées ou non) datées après l'arrêt. « Arrêter la caisse »
 * (une caisse ou toutes, date ≤ hier) : refusé s'il reste une ligne non
 * validée jusqu'à cette date. Une ligne validée incluse dans un arrêt est
 * verrouillée (cadenas, non supprimable) ; aucune ligne ne peut être ajoutée
 * à une date ≤ dernier arrêt de sa caisse.
 *
 * Rattachement (règle serveur, utils/caisse) : seules les entrées saisies
 * par un responsable d'agence (type 3) comptent sur la caisse de son
 * agence ; celles des autres utilisateurs — y compris leurs paiements de
 * factures clients / livreurs — sont « Sans agence » (caisse à part entière).
 */

/** Timestamp unix (secondes) → "JJ/MM/AAAA". */
function formatJour(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function jourFr(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

/** Montant entier (DH legacy, sans décimales) → "1 234 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} DH`;
}

/** Date du jour au format "AAAA-MM-JJ" (heure locale). */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** Modale « Ajouter une entrée » : type (dépense / recette), titre,
 * description, montant, date. */
function EntreeModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    type: 0,
    titre: '',
    description: '',
    montant: '',
    date: todayStr()
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/caisse-agence', {
        type: form.type,
        titre: form.titre,
        description: form.description,
        montant: Number(form.montant),
        date: form.date
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de l'entrée.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Landmark size={18} />
            <div className="cell-main">Ajouter une entrée de caisse</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Type d'entrée</span>
              <div className="np-type-switch caisse-type-switch">
                <button
                  type="button"
                  className={`np-type-btn caisse-type-depense ${form.type === 0 ? 'np-type-active' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, type: 0 }))}
                >
                  <ArrowDownCircle size={15} /> Dépense
                </button>
                <button
                  type="button"
                  className={`np-type-btn caisse-type-recette ${form.type === 1 ? 'np-type-active' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, type: 1 }))}
                >
                  <ArrowUpCircle size={15} /> Recette
                </button>
              </div>
            </div>
            <label className="modal-form-full">
              <span className="field-label">Titre</span>
              <input
                type="text"
                value={form.titre}
                onChange={setField('titre')}
                maxLength={255}
                placeholder="Ex. : loyer, fournitures, encaissement…"
                required
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Description (facultatif)</span>
              <textarea
                rows={3}
                value={form.description}
                onChange={setField('description')}
                maxLength={2000}
                placeholder="Description…"
              />
            </label>
            <label>
              <span className="field-label">Montant (DH)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={form.montant}
                onChange={setField('montant')}
                placeholder="0"
                required
              />
            </label>
            <label>
              <span className="field-label">Date de l'opération</span>
              <input type="date" value={form.date} onChange={setField('date')} required />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modale « Arrêter la caisse » : caisse (une agence, Sans agence ou toutes)
 * et date d'arrêt (au plus tard hier = `dateMax`). Le serveur refuse s'il
 * reste une ligne non validée jusqu'à cette date (message détaillé par
 * caisse) ; tout ou rien pour « Toutes les caisses ».
 */
function ArretModal({ caisses, dateMax, onClose, onSaved }) {
  const [agence, setAgence] = useState('all');
  const [date, setDate] = useState(dateMax || '');
  const [saving, setSaving] = useState(false);
  const [erreurs, setErreurs] = useState([]);

  const cible = agence === 'all' ? null : caisses.find((c) => String(c.agence_id) === agence);
  const aValider =
    agence === 'all'
      ? caisses.reduce((n, c) => n + (c.nb_non_validees || 0), 0)
      : cible?.nb_non_validees || 0;

  async function save(e) {
    e.preventDefault();
    setErreurs([]);
    const libelle = agence === 'all' ? 'toutes les caisses' : `la caisse « ${cible?.nom || ''} »`;
    if (!window.confirm(`Arrêter ${libelle} au ${jourFr(date)} ? Les lignes validées jusqu'à cette date seront figées.`)) {
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/caisse-agence/arrets', {
        agence: agence === 'all' ? 'all' : agence === '0' ? 'none' : agence,
        date
      });
      onSaved(res.data.arrets || []);
    } catch (err) {
      const data = err.response?.data;
      setErreurs(
        Array.isArray(data?.erreurs) && data.erreurs.length
          ? data.erreurs
          : [data?.message || "Erreur lors de l'arrêt de caisse."]
      );
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <OctagonPause size={18} />
            <div className="cell-main">Arrêter la caisse</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <p className="caisse-hint caisse-arret-hint">
            L'arrêt fige le solde de la caisse à la date choisie (jour inclus) : solde de l'arrêt
            précédent + recettes validées − dépenses validées de la période. Toutes les lignes
            datées jusqu'à cette date doivent être validées ; ensuite, plus aucune ligne ne peut
            être ajoutée ou supprimée sur cette période.
          </p>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Caisse</span>
              <select value={agence} onChange={(e) => setAgence(e.target.value)}>
                <option value="all">Toutes les caisses</option>
                {caisses.map((c) => (
                  <option key={c.agence_id} value={String(c.agence_id)}>
                    {c.nom}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Date d'arrêt (au plus tard hier)</span>
              <input
                type="date"
                value={date}
                max={dateMax || undefined}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </label>
          </div>

          {agence !== 'all' && cible && (
            <div className="caisse-arret-resume">
              <div>
                Dernier arrêt :{' '}
                <strong>
                  {cible.dernier_arret
                    ? `${jourFr(cible.dernier_arret.date)} · ${formatMontant(cible.dernier_arret.solde)}`
                    : 'aucun'}
                </strong>
              </div>
              <div>
                Lignes encore à valider depuis : <strong>{cible.nb_non_validees}</strong>
              </div>
            </div>
          )}
          {aValider > 0 && (
            <div className="caisse-arret-warn">
              {aValider} ligne(s) encore à valider depuis le dernier arrêt : l'arrêt sera refusé si
              l'une d'elles est datée jusqu'au {jourFr(date)}.
            </div>
          )}

          {erreurs.length > 0 && (
            <div className="form-error">
              {erreurs.map((m, i) => (
                <div key={i}>{m}</div>
              ))}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !date}>
              <OctagonPause size={15} /> {saving ? 'Arrêt en cours…' : 'Arrêter la caisse'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Filtres par défaut : 30 derniers jours, tous types, toutes validations,
 * toutes agences, tous auteurs, tous validateurs. */
function defaultFilters() {
  return { range: defaultRange(), type: '', validation: '', agence: '', auteur: '', validateur: '' };
}

/** Caisse Agence — page principale : totaux, état des caisses, ajout,
 * filtres et tableau. */
export default function CaisseAgence() {
  const { user } = useAuth();
  // Types 1/2 : validation (ligne / masse), filtres validation, agence et
  // validateur, état des caisses et arrêts (le type 3 ajoute seulement) ;
  // type 1 seul : suppression (entrée hors arrêt, dernier arrêt).
  const canManage = user?.kind === 'employee' && [1, 2].includes(Number(user.role));
  const isAdmin = user?.kind === 'employee' && Number(user.role) === 1;

  const [rows, setRows] = useState([]);
  const [totaux, setTotaux] = useState({ depenses: 0, recettes: 0, solde: 0 });
  const [filtres, setFiltres] = useState({ agences: [], auteurs: [], validateurs: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [modal, setModal] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [selection, setSelection] = useState(() => new Set());
  const [massBusy, setMassBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Listes des filtres rechargées après une validation / un ajout (un
  // nouvel auteur ou validateur peut apparaître).
  const [filtresKey, setFiltresKey] = useState(0);

  // État des caisses et arrêts (types 1/2).
  const [caisses, setCaisses] = useState([]);
  const [dateMax, setDateMax] = useState('');
  const [caissesError, setCaissesError] = useState('');
  const [caissesKey, setCaissesKey] = useState(0);
  const [arretModal, setArretModal] = useState(false);
  const [arretMessage, setArretMessage] = useState('');
  const [showArrets, setShowArrets] = useState(false);
  const [arrets, setArrets] = useState([]);
  const [arretsLoading, setArretsLoading] = useState(false);
  const [arretBusyId, setArretBusyId] = useState(null);

  useEffect(() => {
    api
      .get('/caisse-agence/filtres')
      .then((res) =>
        setFiltres({
          agences: res.data.agences || [],
          auteurs: res.data.auteurs || [],
          validateurs: res.data.validateurs || []
        })
      )
      .catch(() => {});
  }, [filtresKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/caisse-agence', {
        params: {
          from: applied.range.from,
          to: applied.range.to,
          type: applied.type,
          validation: applied.validation,
          agence: applied.agence,
          auteur: applied.auteur,
          validateur: applied.validateur
        }
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setTotaux(res.data.totaux);
        setSelection(new Set());
        setError('');
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Erreur de chargement de la caisse.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, reloadKey]);

  // État des caisses (types 1/2) : rechargé après un arrêt, une validation,
  // un ajout ou une suppression (le solde courant et les lignes à valider
  // bougent).
  useEffect(() => {
    if (!canManage) return undefined;
    let cancelled = false;
    api
      .get('/caisse-agence/caisses')
      .then((res) => {
        if (cancelled) return;
        setCaisses(res.data.caisses || []);
        setDateMax(res.data.date_max || '');
        setCaissesError('');
      })
      .catch((err) => {
        if (!cancelled) {
          setCaissesError(err.response?.data?.message || "Erreur de chargement de l'état des caisses.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, caissesKey]);

  // Historique des arrêts : chargé à l'ouverture de la section, puis à chaque
  // changement (arrêt créé / supprimé).
  useEffect(() => {
    if (!canManage || !showArrets) return undefined;
    let cancelled = false;
    setArretsLoading(true);
    api
      .get('/caisse-agence/arrets')
      .then((res) => {
        if (!cancelled) setArrets(res.data.rows || []);
      })
      .catch(() => {
        if (!cancelled) setArrets([]);
      })
      .finally(() => {
        if (!cancelled) setArretsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, showArrets, caissesKey]);

  const agenceOptions = useMemo(
    () => [
      { value: 'none', label: 'Sans agence' },
      ...filtres.agences.map((a) => ({ value: String(a.id), label: a.nom }))
    ],
    [filtres.agences]
  );
  const auteurOptions = useMemo(
    () => filtres.auteurs.map((u) => ({ value: String(u.id), label: u.nom })),
    [filtres.auteurs]
  );
  const validateurOptions = useMemo(
    () => filtres.validateurs.map((u) => ({ value: String(u.id), label: u.nom })),
    [filtres.validateurs]
  );

  // Recherche locale (titre, description, montant, auteur, validateur) puis
  // tri par colonne sur les entrées chargées. Sans tri choisi : ordre
  // serveur (plus récentes en tête).
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtrees = !q
      ? rows
      : rows.filter(
          (r) =>
            String(r.titre || '').toLowerCase().includes(q) ||
            String(r.description || '').toLowerCase().includes(q) ||
            String(r.montant).includes(q) ||
            String(r.added_by || '').toLowerCase().includes(q) ||
            String(r.validated_by || '').toLowerCase().includes(q)
        );
    if (!sortBy) return filtrees;
    const sens = sortDir === 'desc' ? -1 : 1;
    // Colonnes numériques (montant, type 0/1, timestamps unix, validation 0/1).
    const numeriques = ['montant', 'type', 'date_operation', 'added_time', 'validated'];
    return [...filtrees].sort((a, b) => {
      if (numeriques.includes(sortBy)) {
        return sens * ((Number(a[sortBy]) || 0) - (Number(b[sortBy]) || 0));
      }
      return (
        sens *
        String(a[sortBy] || '').localeCompare(String(b[sortBy] || ''), 'fr', {
          sensitivity: 'base',
          numeric: true
        })
      );
    });
  }, [rows, search, sortBy, sortDir]);

  const pager = usePagination(filteredRows, 'entrée');

  /** Tri : 1er clic = sens par défaut de la colonne, 2e clic = sens inverse. */
  function toggleSort(key, defaultDir) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir(defaultDir);
    }
    pager.setPage(1);
  }

  /** En-tête de colonne triable (texte : croissant d'abord ; nombres et
   * dates : décroissant d'abord). */
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

  /* ---- Sélection en masse (types 1/2) ---- */

  function toggleSelection(id) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Coche / décoche toutes les lignes de la page affichée. */
  function togglePage() {
    const ids = pager.pageRows.map((r) => r.id);
    const allChecked = ids.length > 0 && ids.every((id) => selection.has(id));
    setSelection((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (allChecked ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  /** Applique la réponse de validation (validateur + horodatage) aux lignes `ids`. */
  function marquerValidees(ids, done) {
    const set = new Set(ids);
    setRows((prev) =>
      prev.map((r) =>
        set.has(r.id) && r.validated !== 1
          ? {
              ...r,
              validated: 1,
              validated_by: done.validated_by ?? null,
              validated_time: done.validated_time ?? null
            }
          : r
      )
    );
    setFiltresKey((k) => k + 1);
    setCaissesKey((k) => k + 1);
  }

  async function valider(entree) {
    setBusyId(entree.id);
    try {
      const res = await api.patch(`/caisse-agence/${entree.id}/valider`);
      marquerValidees([entree.id], res.data);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la validation.');
    } finally {
      setBusyId(null);
    }
  }

  /** Validation en masse des lignes cochées encore non validées. */
  async function validerSelection() {
    const ids = rows.filter((r) => selection.has(r.id) && r.validated !== 1).map((r) => r.id);
    if (massBusy) return;
    if (!ids.length) {
      alert('Les entrées sélectionnées sont déjà validées.');
      return;
    }
    if (!window.confirm(`Valider ${ids.length} entrée(s) de caisse ?`)) return;
    setMassBusy(true);
    try {
      const res = await api.patch('/caisse-agence/valider', { ids });
      marquerValidees(ids, res.data);
      setSelection(new Set());
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la validation en masse.');
    } finally {
      setMassBusy(false);
    }
  }

  async function supprimer(entree) {
    if (!window.confirm(`Supprimer l'entrée « ${entree.titre} » (${formatMontant(entree.montant)}) ?`)) {
      return;
    }
    setBusyId(entree.id);
    try {
      await api.delete(`/caisse-agence/${entree.id}`);
      // Rechargement : les totaux de la période et l'état des caisses doivent suivre.
      setReloadKey((k) => k + 1);
      setCaissesKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusyId(null);
    }
  }

  function handleSaved() {
    setModal(false);
    setReloadKey((k) => k + 1);
    setFiltresKey((k) => k + 1);
    setCaissesKey((k) => k + 1);
  }

  /* ---- Arrêts de caisse (types 1/2) ---- */

  function handleArretSaved(nouveaux) {
    setArretModal(false);
    setArretMessage(
      nouveaux.length
        ? `Arrêt enregistré : ${nouveaux
            .map((a) => `${a.agence} au ${jourFr(a.date)} → ${formatMontant(a.solde)}`)
            .join(' · ')}`
        : 'Arrêt enregistré.'
    );
    // Verrous (cadenas) et état des caisses à rafraîchir.
    setReloadKey((k) => k + 1);
    setCaissesKey((k) => k + 1);
  }

  async function supprimerArret(arret) {
    if (
      !window.confirm(
        `Supprimer l'arrêt de « ${arret.agence} » au ${jourFr(arret.date)} (${formatMontant(arret.solde)}) ? L'arrêt précédent redevient la référence du solde.`
      )
    ) {
      return;
    }
    setArretBusyId(arret.id);
    try {
      await api.delete(`/caisse-agence/arrets/${arret.id}`);
      setArretMessage('');
      setReloadKey((k) => k + 1);
      setCaissesKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de la suppression de l'arrêt.");
    } finally {
      setArretBusyId(null);
    }
  }

  const selectionNonValidee = useMemo(
    () => rows.filter((r) => selection.has(r.id) && r.validated !== 1).length,
    [rows, selection]
  );

  // Colonnes : [case] + 6 colonnes + [actions].
  const colSpan = 6 + (canManage ? 2 : 0);

  return (
    <div className="platform-page bons-envoi-page">
      <div className="stats-grid caisse-stats">
        <div className="stat-card tone-danger">
          <div className="stat-value">{formatMontant(totaux.depenses)}</div>
          <div className="stat-label">Total Dépenses</div>
        </div>
        <div className="stat-card tone-success">
          <div className="stat-value">{formatMontant(totaux.recettes)}</div>
          <div className="stat-label">Total Recettes</div>
        </div>
        <div className={`stat-card ${totaux.solde < 0 ? 'tone-danger' : 'tone-primary'}`}>
          <div className="stat-value">{formatMontant(totaux.solde)}</div>
          <div className="stat-label">Solde</div>
        </div>
      </div>

      {canManage && (
        <section className="platform-card caisse-etat">
          <div className="bons-head">
            <h2>
              <OctagonPause size={18} /> État des caisses
            </h2>
            <div className="caisse-etat-actions">
              <button
                type="button"
                className={`btn btn-sm ${showArrets ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setShowArrets((v) => !v)}
              >
                <History size={15} /> Historique des arrêts
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setArretModal(true)}
                disabled={Boolean(caissesError) || caisses.length === 0}
              >
                <OctagonPause size={15} /> Arrêter la caisse
              </button>
            </div>
          </div>
          <p className="caisse-hint">
            Solde courant = solde du dernier arrêt + toutes les lignes (validées ou non) datées
            après l'arrêt. Un arrêt fige les lignes validées jusqu'à sa date : il est refusé s'il en
            reste une à valider.
          </p>

          {caissesError && <div className="form-error">{caissesError}</div>}
          {arretMessage && (
            <div className="caisse-arret-ok">
              <CheckCircle2 size={15} />
              <span>{arretMessage}</span>
              <button
                type="button"
                className="row-action"
                title="Fermer"
                onClick={() => setArretMessage('')}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {!caissesError && (
            <div className="caisse-etat-grid">
              {caisses.map((c) => (
                <div key={c.agence_id} className="caisse-etat-card">
                  <div className="caisse-etat-nom">{c.nom}</div>
                  <div className={`caisse-etat-solde ${c.solde_courant < 0 ? 'is-negatif' : ''}`}>
                    {formatMontant(c.solde_courant)}
                  </div>
                  <div className="caisse-etat-label">Solde courant</div>
                  <div className="caisse-etat-meta">
                    <div>
                      <span>Dernier arrêt</span>
                      <strong>
                        {c.dernier_arret
                          ? `${jourFr(c.dernier_arret.date)} · ${formatMontant(c.dernier_arret.solde)}`
                          : 'Aucun'}
                      </strong>
                      {c.dernier_arret && (
                        <small>
                          par {c.dernier_arret.by_name || '—'}
                          {c.dernier_arret.created_time
                            ? ` le ${formatDate(c.dernier_arret.created_time)}`
                            : ''}
                        </small>
                      )}
                    </div>
                    <div>
                      <span>{c.dernier_arret ? "Depuis l'arrêt" : "Depuis l'origine"}</span>
                      <strong>
                        <em className="caisse-etat-plus">+{formatMontant(c.recettes)}</em>
                        {' / '}
                        <em className="caisse-etat-moins">−{formatMontant(c.depenses)}</em>
                      </strong>
                      <small>{c.nb_lignes} ligne(s)</small>
                    </div>
                  </div>
                  {c.nb_non_validees > 0 ? (
                    <div className="caisse-etat-warn">{c.nb_non_validees} ligne(s) à valider</div>
                  ) : (
                    <div className="caisse-etat-ok">Toutes les lignes sont validées</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {showArrets && (
            <div className="caisse-arrets">
              <h3 className="caisse-arrets-title">
                <History size={16} /> Historique des arrêts
              </h3>
              <div className={`table-wrap datatable ${arretsLoading ? 'is-loading' : ''}`}>
                <table>
                  <thead>
                    <tr>
                      <th>Caisse</th>
                      <th>Date d'arrêt</th>
                      <th>Solde précédent</th>
                      <th>Recettes</th>
                      <th>Dépenses</th>
                      <th>Solde d'arrêt</th>
                      <th>Lignes</th>
                      <th>Arrêté par</th>
                      {isAdmin && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {arrets.length === 0 && !arretsLoading ? (
                      <tr>
                        <td colSpan={isAdmin ? 9 : 8} className="datatable-empty">
                          Aucun arrêt de caisse enregistré.
                        </td>
                      </tr>
                    ) : (
                      arrets.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <div className="cell-main">{a.agence}</div>
                          </td>
                          <td>{jourFr(a.date)}</td>
                          <td>{formatMontant(a.solde_precedent)}</td>
                          <td className="caisse-etat-plus">+{formatMontant(a.recettes)}</td>
                          <td className="caisse-etat-moins">−{formatMontant(a.depenses)}</td>
                          <td>
                            <strong>{formatMontant(a.solde)}</strong>
                          </td>
                          <td>{a.nb_lignes}</td>
                          <td>
                            <div className="cell-main">{a.by_name || '—'}</div>
                            <div className="cell-sub">{formatDate(a.created_time)}</div>
                          </td>
                          {isAdmin && (
                            <td>
                              {a.dernier === 1 && (
                                <div className="row-actions">
                                  <button
                                    type="button"
                                    className="row-action row-action-danger"
                                    title="Supprimer cet arrêt (dernier de sa caisse)"
                                    disabled={arretBusyId === a.id}
                                    onClick={() => supprimerArret(a)}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Landmark size={18} /> Caisse Agence
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal(true)}>
            <Plus size={15} /> Ajouter une entrée
          </button>
        </div>
        {canManage && (
          <p className="caisse-hint">
            Seules les entrées saisies par un responsable d'agence (type 3) sont comptées sur la
            caisse de son agence — y compris les paiements de factures clients / livreurs. Celles
            des autres utilisateurs sont classées « Sans agence ».
          </p>
        )}

        <div className="filters-bar">
          <DateRangeSelect
            value={draft.range}
            onChange={(range) => setDraft((d) => ({ ...d, range }))}
          />
          <select
            className="datatable-select"
            value={draft.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
            title="Type d'entrée"
          >
            <option value="">Tous types</option>
            <option value="depense">Dépenses</option>
            <option value="recette">Recettes</option>
          </select>
          {canManage && (
            <select
              className="datatable-select"
              value={draft.validation}
              onChange={(e) => setDraft((d) => ({ ...d, validation: e.target.value }))}
              title="Validation"
            >
              <option value="">Toutes validations</option>
              <option value="validated">Validé</option>
              <option value="not_validated">Non validé</option>
            </select>
          )}
          {canManage && (
            <SearchSelect
              label="Agence"
              options={agenceOptions}
              value={draft.agence}
              onChange={(v) => setDraft((d) => ({ ...d, agence: v }))}
              allLabel="Toutes"
            />
          )}
          <SearchSelect
            label="Ajouté par"
            options={auteurOptions}
            value={draft.auteur}
            onChange={(v) => setDraft((d) => ({ ...d, auteur: v }))}
            allLabel="Tous"
          />
          {canManage && (
            <SearchSelect
              label="Validé par"
              options={validateurOptions}
              value={draft.validateur}
              onChange={(v) => setDraft((d) => ({ ...d, validateur: v }))}
              allLabel="Tous"
            />
          )}
          <button
            type="button"
            className="btn-apply"
            onClick={() => {
              // Nouvelle référence : recharge même si les filtres n'ont pas changé.
              setApplied({ ...draft });
              pager.setPage(1);
            }}
          >
            <SlidersHorizontal size={15} />
            Appliquer filtres
          </button>
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : titre, description, montant, utilisateur…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {canManage && selection.size > 0 && (
          <div className="facture-mass-actions">
            <span className="cell-sub">
              {selection.size} entrée(s) sélectionnée(s)
              {selectionNonValidee !== selection.size && ` · ${selectionNonValidee} à valider`}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={validerSelection}
              disabled={massBusy || selectionNonValidee === 0}
            >
              <CheckCircle2 size={15} /> Valider la sélection
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelection(new Set())}
              disabled={massBusy}
            >
              Tout décocher
            </button>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                {canManage && (
                  <th className="bon-check-col">
                    <input
                      type="checkbox"
                      checked={
                        pager.pageRows.length > 0 && pager.pageRows.every((r) => selection.has(r.id))
                      }
                      onChange={togglePage}
                      title="Tout cocher / décocher (page affichée)"
                    />
                  </th>
                )}
                <SortableTh sortKey="titre" defaultDir="asc">Titre</SortableTh>
                <SortableTh sortKey="montant">Montant</SortableTh>
                <SortableTh sortKey="type" defaultDir="asc">Type</SortableTh>
                <SortableTh sortKey="date_operation">Date opération</SortableTh>
                <SortableTh sortKey="added_time">Ajoutée le</SortableTh>
                <SortableTh sortKey="validated" defaultDir="asc">Validation</SortableTh>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={colSpan} className="datatable-empty">
                    Aucune entrée de caisse trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((entree) => (
                  <tr key={entree.id} className={selection.has(entree.id) ? 'caisse-row-selected' : ''}>
                    {canManage && (
                      <td className="bon-check-col">
                        <input
                          type="checkbox"
                          checked={selection.has(entree.id)}
                          onChange={() => toggleSelection(entree.id)}
                        />
                      </td>
                    )}
                    <td>
                      <div className="cell-main">{entree.titre}</div>
                      {entree.description && <div className="cell-sub">{entree.description}</div>}
                    </td>
                    <td>{formatMontant(entree.montant)}</td>
                    <td>
                      <span
                        className={`badge ${entree.type === 1 ? 'badge-mvnt-entree' : 'badge-mvnt-sortie'}`}
                      >
                        {entree.type === 1 ? 'Recette' : 'Dépense'}
                      </span>
                    </td>
                    <td>{formatJour(entree.date_operation)}</td>
                    <td>
                      <div className="cell-main">{formatDate(entree.added_time)}</div>
                      <div className="cell-sub">
                        {entree.added_by || '—'}
                        {` · ${entree.agence || 'Sans agence'}`}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${entree.validated === 1 ? 'badge-active' : 'badge-attente'}`}>
                        {entree.validated === 1 ? 'Validé' : 'Non validé'}
                      </span>
                      {entree.validated === 1 && (
                        <div className="cell-sub caisse-validateur">
                          {entree.validated_by || '—'}
                          {entree.validated_time ? ` · ${formatDate(entree.validated_time)}` : ''}
                        </div>
                      )}
                    </td>
                    {canManage && (
                      <td>
                        <div className="row-actions">
                          {entree.validated !== 1 && (
                            <button
                              type="button"
                              className="row-action"
                              title="Valider l'entrée"
                              disabled={busyId === entree.id || massBusy}
                              onClick={() => valider(entree)}
                            >
                              <Check size={16} />
                            </button>
                          )}
                          {entree.locked === 1 ? (
                            <span
                              className="row-action caisse-lock"
                              title="Incluse dans un arrêt de caisse : non supprimable"
                            >
                              <Lock size={15} />
                            </span>
                          ) : (
                            isAdmin && (
                              <button
                                type="button"
                                className="row-action row-action-danger"
                                title="Supprimer l'entrée"
                                disabled={busyId === entree.id || massBusy}
                                onClick={() => supprimer(entree)}
                              >
                                <Trash2 size={16} />
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {modal && <EntreeModal onClose={() => setModal(false)} onSaved={handleSaved} />}
      {arretModal && (
        <ArretModal
          caisses={caisses}
          dateMax={dateMax}
          onClose={() => setArretModal(false)}
          onSaved={handleArretSaved}
        />
      )}
    </div>
  );
}
