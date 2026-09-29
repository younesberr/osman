import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCheck,
  Eye,
  Flag,
  Hourglass,
  Layers,
  MessageSquareWarning,
  Play,
  Route,
  SlidersHorizontal
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import DateRangeSelect from '../../components/DateRangeSelect';
import { ParcelModal, SuiviModal } from '../../components/ParcelModals';

/*
 * Réclamations à suivre — reprise de la page legacy « reclamations-suivre » :
 * compteurs (total / en cours / traitées), onglets de statut, filtres livreur /
 * suivi par / plage de dates, datatable triable et modale « Traiter » (note de
 * traitement facultative). Une réclamation est déclenchée depuis la page Colis
 * du dashboard admin et désormais aussi depuis celle du dashboard client
 * (lignes marquées « Client », avec le membre d'équipe auteur le cas échéant).
 * « Suivi par » est par défaut sur l'employé connecté : ses réclamations + les
 * réclamations clients pas encore lancées, visibles de tous. « Lancer » (avant
 * « Traiter ») affecte une réclamation client à l'employé connecté.
 */

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

/** Initiales d'un nom (1 à 2 lettres), pour l'avatar. */
function initiales(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  let ini = parts[0][0].toUpperCase();
  if (parts.length > 1) ini += parts[parts.length - 1][0].toUpperCase();
  return ini;
}

/* Couleur d'avatar stable par nom (même palette que la page legacy). */
const AVATAR_PALETTE = [
  '#4361ee',
  '#7209b7',
  '#f72585',
  '#06d6a0',
  '#118ab2',
  '#ef476f',
  '#3a86ff',
  '#fb8500',
  '#8338ec',
  '#2a9d8f'
];
function couleurAvatar(seed) {
  const str = String(seed || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

/** Avatar initiales + nom (colonnes Nom Magasin et Suivi par). */
function UserCell({ name, sub }) {
  return (
    <div className="rec-user">
      <span className="rec-avatar" style={{ background: couleurAvatar(name) }}>
        {initiales(name)}
      </span>
      <div>
        <div className="cell-main">{name || '—'}</div>
        {sub && <div className="cell-sub">{sub}</div>}
      </div>
    </div>
  );
}

/** « Suivi par » d'une réclamation : employé créateur, ou magasin pour une
 * réclamation créée par le client (avec le membre d'équipe auteur). */
function suiviLabel(rec) {
  if (!rec.client) return rec.suivi_par || '—';
  return rec.membre ? `Client — ${rec.membre}` : 'Client';
}

/**
 * Modale « Détails de la réclamation » : toutes les informations de la ligne
 * (colis, magasin, zone, livreur, créée par / suivi par, statut, traitement),
 * texte complet et note de traitement, en lecture seule.
 */
function DetailsModal({ rec, onClose }) {
  return (
    <ParcelModal code={rec.code} subtitle="Détails de la réclamation" onClose={onClose}>
      <div className="modal-recap">
        <div className="modal-recap-row">
          <span>Magasin</span>
          <b>{rec.magasin || '—'}</b>
        </div>
        <div className="modal-recap-row">
          <span>Zone</span>
          <b>{rec.zone || '—'}</b>
        </div>
        <div className="modal-recap-row">
          <span>Livreur</span>
          <b>{rec.livreur || '—'}</b>
        </div>
        <div className="modal-recap-row">
          <span>{rec.client ? 'Créée par' : 'Suivi par'}</span>
          <b>
            {rec.client
              ? `${rec.magasin || 'Client'}${rec.membre ? ` — ${rec.membre}` : ''} (client)`
              : rec.suivi_par || '—'}
          </b>
        </div>
        {rec.client && rec.suivi_par && (
          <div className="modal-recap-row">
            <span>Suivi par</span>
            <b>{rec.suivi_par}</b>
          </div>
        )}
        <div className="modal-recap-row">
          <span>Date réclamation</span>
          <b>{formatDate(rec.time)}</b>
        </div>
        <div className="modal-recap-row">
          <span>Statut</span>
          <b>
            <span className={`badge ${rec.statut === 'TRAITE' ? 'badge-active' : 'badge-attente'}`}>
              {rec.statut === 'TRAITE' ? 'Traitée' : 'En cours'}
            </span>
          </b>
        </div>
        {rec.statut === 'TRAITE' && (
          <div className="modal-recap-row">
            <span>Traitée par</span>
            <b>
              {rec.traite_par || '—'}
              {rec.traite_time ? ` — ${formatDate(rec.traite_time)}` : ''}
            </b>
          </div>
        )}
      </div>
      <div className="rec-traiter-texte">
        {rec.client && rec.titre && <b>{rec.titre}</b>}
        <p>{rec.texte || '—'}</p>
      </div>
      {rec.statut === 'TRAITE' && rec.traite_note && (
        <div className="rec-traiter-texte">
          <b>Note de traitement</b>
          <p>{rec.traite_note}</p>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
      </div>
    </ParcelModal>
  );
}

/**
 * Modale « Traiter la réclamation » : récapitulatif (colis, magasin, texte,
 * suivi par) + note de traitement facultative → statut TRAITE.
 */
function TraiterModal({ rec, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function traiter(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/reclamations/${rec.id}/traiter`, { note });
      onDone();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du traitement de la réclamation.');
      setSaving(false);
    }
  }

  return (
    <ParcelModal code={rec.code} subtitle="Traiter la réclamation" onClose={onClose}>
      <form onSubmit={traiter}>
        <div className="modal-recap">
          <div className="modal-recap-row">
            <span>Magasin</span>
            <b>{rec.magasin || '—'}</b>
          </div>
          <div className="modal-recap-row">
            <span>{rec.client ? 'Créée par' : 'Suivi par'}</span>
            <b>
              {rec.client
                ? `${rec.magasin || 'Client'}${rec.membre ? ` — ${rec.membre}` : ''} (client)`
                : rec.suivi_par || '—'}
            </b>
          </div>
          {rec.client && rec.suivi_par && (
            <div className="modal-recap-row">
              <span>Suivi par</span>
              <b>{rec.suivi_par}</b>
            </div>
          )}
          <div className="modal-recap-row">
            <span>Date réclamation</span>
            <b>{formatDate(rec.time)}</b>
          </div>
        </div>
        <div className="rec-traiter-texte">
          {rec.client && rec.titre && <b>{rec.titre}</b>}
          <p>{rec.texte || '—'}</p>
        </div>
        <label>
          Note de traitement (facultatif)
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            placeholder="Note…"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <Check size={15} /> {saving ? 'Traitement…' : 'Marquer comme traitée'}
          </button>
        </div>
      </form>
    </ParcelModal>
  );
}

/** Entête de colonne triable (tri côté client, comme la page legacy). */
function SortTh({ label, k, sort, onSort }) {
  const active = sort.key === k;
  return (
    <th className="th-sort" onClick={() => onSort(k)} title="Trier">
      <span>
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : (
          <ArrowUpDown size={12} />
        )}
      </span>
    </th>
  );
}

const EMPTY_COUNTS = { total: 0, enCours: 0, traites: 0 };

/** Filtres par défaut : « Suivi par » sur l'employé connecté (ses réclamations
 * + les réclamations clients pas encore lancées, renvoyées pour tout employé). */
function defaultFilters(userId) {
  return {
    livreur: '',
    user: userId ? String(userId) : '',
    dates: { from: '', to: '', preset: 'all' }
  };
}

/** Réclamations à suivre — page principale. */
export default function Reclamations() {
  const { user: me } = useAuth();
  const [filtres, setFiltres] = useState({ livreurs: [], users: [] });
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Onglet de statut ('' = tous), appliqué immédiatement ; les compteurs des
  // onglets ne dépendent que des autres filtres (comme le legacy).
  const [statut, setStatut] = useState('');
  const [draft, setDraft] = useState(() => defaultFilters(me?.id));
  const [applied, setApplied] = useState(() => defaultFilters(me?.id));
  const [sort, setSort] = useState({ key: 'time', dir: 'desc' });
  // Modale : { type: 'details' | 'suivi' | 'traiter', rec }.
  const [modal, setModal] = useState(null);
  // Id de la réclamation en cours de lancement (bouton « Lancer » désactivé).
  const [lancerBusy, setLancerBusy] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api
      .get('/reclamations/filtres')
      .then((res) => setFiltres(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/reclamations', {
        params: {
          statut,
          livreur: applied.livreur,
          user: applied.user,
          dateFrom: applied.dates.from,
          dateTo: applied.dates.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setCounts(res.data.counts || EMPTY_COUNTS);
        setRows(res.data.rows || []);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Erreur de chargement des réclamations.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statut, applied, reloadKey]);

  const livreurOptions = useMemo(
    () => filtres.livreurs.map((l) => ({ value: l.id, label: l.label })),
    [filtres.livreurs]
  );
  // « Suivi par » : réclamations créées par les clients, puis employés type 1 / 2
  // (+ l'employé connecté s'il n'y figure pas, pour afficher le filtre par défaut).
  const userOptions = useMemo(() => {
    const users = filtres.users.map((u) => ({ value: u.id, label: u.label }));
    if (me?.id && !users.some((u) => String(u.value) === String(me.id))) {
      users.unshift({ value: String(me.id), label: me.name || `Utilisateur ${me.id}` });
    }
    return [{ value: 'client', label: 'Réclamations clients' }, ...users];
  }, [filtres.users, me]);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === 'time') return (a.time - b.time) * dir;
      const va = String(a[sort.key] || '');
      const vb = String(b[sort.key] || '');
      return va.localeCompare(vb, 'fr', { sensitivity: 'base' }) * dir;
    });
    return list;
  }, [rows, sort]);

  const pager = usePagination(sortedRows, 'réclamation');

  function toggleSort(key) {
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
    pager.setPage(1);
  }

  function changeStatut(value) {
    setStatut(value);
    pager.setPage(1);
  }

  function handleTraite() {
    setModal(null);
    setReloadKey((k) => k + 1);
  }

  /** « Lancer » : affecte la réclamation client à l'employé connecté, puis
   * recharge — la ligne affiche alors « Traiter ». */
  async function lancer(rec) {
    if (lancerBusy) return;
    setLancerBusy(rec.id);
    try {
      await api.post(`/reclamations/${rec.id}/lancer`);
      setError('');
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du lancement de la réclamation.');
    } finally {
      setLancerBusy(0);
    }
  }

  return (
    <div className="platform-page reclamations-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <MessageSquareWarning size={18} /> Réclamations à suivre
          </h2>
        </div>

        <div className="rec-stats">
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-all">
              <Flag size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.total}</div>
              <div className="rec-stat-lbl">Total réclamations</div>
            </div>
          </div>
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-enc">
              <Hourglass size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.enCours}</div>
              <div className="rec-stat-lbl">En cours</div>
            </div>
          </div>
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-trt">
              <CheckCheck size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.traites}</div>
              <div className="rec-stat-lbl">Traitées</div>
            </div>
          </div>
        </div>

        <nav className="fiche-tabs" aria-label="Filtre par statut">
          <button
            type="button"
            className={`fiche-tab ${statut === '' ? 'active' : ''}`}
            onClick={() => changeStatut('')}
          >
            <Layers size={14} /> Tous <span className="badge badge-neutral">{counts.total}</span>
          </button>
          <button
            type="button"
            className={`fiche-tab ${statut === 'EN_COURS' ? 'active' : ''}`}
            onClick={() => changeStatut('EN_COURS')}
          >
            <Hourglass size={14} /> En cours{' '}
            <span className="badge badge-attente">{counts.enCours}</span>
          </button>
          <button
            type="button"
            className={`fiche-tab ${statut === 'TRAITE' ? 'active' : ''}`}
            onClick={() => changeStatut('TRAITE')}
          >
            <CheckCheck size={14} /> Traitées{' '}
            <span className="badge badge-active">{counts.traites}</span>
          </button>
        </nav>

        <div className="filters-bar">
          <SearchSelect
            label="Livreur"
            options={livreurOptions}
            value={draft.livreur}
            onChange={(v) => setDraft((d) => ({ ...d, livreur: v }))}
            allLabel="Livreur (tous)"
          />
          <SearchSelect
            label="Suivi par"
            options={userOptions}
            value={draft.user}
            onChange={(v) => setDraft((d) => ({ ...d, user: v }))}
            allLabel="Suivi par (tous)"
          />
          <DateRangeSelect
            value={draft.dates}
            onChange={(dates) => setDraft((d) => ({ ...d, dates }))}
          />
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
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code Colis</th>
                <SortTh label="Nom Magasin" k="magasin" sort={sort} onSort={toggleSort} />
                <SortTh label="Zone" k="zone" sort={sort} onSort={toggleSort} />
                <SortTh label="Livreur" k="livreur" sort={sort} onSort={toggleSort} />
                <th>Réclamation</th>
                <SortTh label="Date réclamation" k="time" sort={sort} onSort={toggleSort} />
                <th>Statut</th>
                <th>Suivi par</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} className="datatable-empty">
                    Aucune réclamation ne correspond aux filtres sélectionnés.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((rec) => (
                  <tr key={rec.id}>
                    <td>
                      <span className="cell-main mono">{rec.code || '—'}</span>
                    </td>
                    <td>
                      <UserCell name={rec.magasin} />
                    </td>
                    <td>{rec.zone ? <span className="badge badge-neutral">{rec.zone}</span> : '—'}</td>
                    <td>{rec.livreur || '—'}</td>
                    <td>
                      <div className="rec-texte" title={rec.texte}>
                        {rec.client && rec.titre && <b>{rec.titre} — </b>}
                        {rec.texte || '—'}
                      </div>
                    </td>
                    <td>{formatDate(rec.time)}</td>
                    <td>
                      <span
                        className={`badge ${rec.statut === 'TRAITE' ? 'badge-active' : 'badge-attente'}`}
                        title={rec.traite_note || undefined}
                      >
                        {rec.statut === 'TRAITE' ? 'Traitée' : 'En cours'}
                      </span>
                      {rec.statut === 'TRAITE' && rec.traite_par && (
                        <div className="cell-sub">
                          par {rec.traite_par}
                          {rec.traite_time ? ` — ${formatDate(rec.traite_time)}` : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {rec.client ? (
                        // Réclamation client lancée : l'employé qui la suit,
                        // avec l'origine (Client — membre) en sous-titre.
                        rec.affectee && rec.suivi_par ? (
                          <UserCell name={rec.suivi_par} sub={suiviLabel(rec)} />
                        ) : (
                          <UserCell name={rec.magasin} sub={suiviLabel(rec)} />
                        )
                      ) : (
                        <UserCell name={rec.suivi_par} />
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Détails de la réclamation"
                          onClick={() => setModal({ type: 'details', rec })}
                        >
                          <Eye size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Suivi du colis"
                          onClick={() => setModal({ type: 'suivi', rec })}
                        >
                          <Route size={16} />
                        </button>
                        {rec.statut !== 'TRAITE' &&
                          (rec.client && !rec.affectee ? (
                            <button
                              type="button"
                              className="btn-traiter btn-lancer"
                              title="Lancer la réclamation (me l'affecter)"
                              onClick={() => lancer(rec)}
                              disabled={lancerBusy === rec.id}
                            >
                              <Play size={14} /> {lancerBusy === rec.id ? 'Lancement…' : 'Lancer'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-traiter"
                              title="Traiter la réclamation"
                              onClick={() => setModal({ type: 'traiter', rec })}
                            >
                              <Check size={14} /> Traiter
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {modal?.type === 'details' && (
        <DetailsModal rec={modal.rec} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'suivi' && (
        <SuiviModal
          parcel={{ parcel_id: modal.rec.parcel_id, parcel_code: modal.rec.code }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'traiter' && (
        <TraiterModal rec={modal.rec} onClose={() => setModal(null)} onDone={handleTraite} />
      )}
    </div>
  );
}
