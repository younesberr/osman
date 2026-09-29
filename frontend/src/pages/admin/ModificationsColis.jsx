import { useEffect, useState } from 'react';
import { Check, PencilLine, X } from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Modifications Colis (/admin/modifications-colis) — demandes de modification
 * de colis déjà ramassés, envoyées depuis la modale "Modifier colis" du
 * dashboard client (delevery_parcel_modif_demande). Onglets par statut
 * (En attente par défaut, avec compteur), tableau Magasin / Colis / Statut
 * colis / Modifications demandées (ancien → nouveau) / Date demande / Statut /
 * Actions. Accepter applique les valeurs au colis (mêmes traces qu'une
 * modification directe du client) ; Refuser laisse le colis intact.
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

/* Onglets de filtre par statut (PENDING par défaut). */
const TABS = [
  { value: 'PENDING', label: 'En attente' },
  { value: 'ACCEPTED', label: 'Acceptées' },
  { value: 'REFUSED', label: 'Refusées' },
  { value: 'ALL', label: 'Toutes' }
];

/* Badge de statut d'une demande. */
const STATUT_BADGES = {
  PENDING: { label: 'En attente', badge: 'badge-attente' },
  ACCEPTED: { label: 'Acceptée', badge: 'badge-active' },
  REFUSED: { label: 'Refusée', badge: 'badge-refuse' }
};

/** Ligne du tableau : demande + actions Accepter / Refuser si en attente. */
function DemandeRow({ demande, onTreated, onError }) {
  const [busy, setBusy] = useState(false);
  const statut = STATUT_BADGES[demande.statut] || { label: demande.statut, badge: 'badge-neutral' };

  async function accepter() {
    if (
      !window.confirm(
        `Appliquer les modifications demandées au colis ${demande.parcel_code} ?`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await api.post(`/modifications-colis/${demande.id}/accepter`);
      onTreated(res.data, {
        kind: 'success',
        text:
          Number(res.data.applied) > 0
            ? `Modifications appliquées au colis ${demande.parcel_code}.`
            : `Demande acceptée : le colis ${demande.parcel_code} portait déjà ces valeurs, rien à appliquer.`
      });
    } catch (err) {
      onError(err.response?.data?.message || 'Erreur lors de l’acceptation de la demande.');
      setBusy(false);
    }
  }

  async function refuser() {
    if (!window.confirm('Refuser cette demande ? Le colis restera inchangé.')) return;
    setBusy(true);
    try {
      const res = await api.post(`/modifications-colis/${demande.id}/refuser`);
      onTreated(res.data, { kind: 'info', text: 'Demande de modification refusée.' });
    } catch (err) {
      onError(err.response?.data?.message || 'Erreur lors du refus de la demande.');
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main">{demande.store || '—'}</div>
        {demande.member && <div className="cell-sub">Par {demande.member}</div>}
      </td>
      <td>
        <div className="cell-main mono">{demande.parcel_code || '—'}</div>
        <div className="cell-sub">
          {demande.receiver || '—'}
          {demande.phone ? ` — ${demande.phone}` : ''}
        </div>
      </td>
      <td>
        {demande.parcel_statut ? (
          <span
            className="badge"
            style={demande.parcel_statut_color ? { background: demande.parcel_statut_color } : undefined}
          >
            {statutLabel(demande.parcel_statut)}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td>
        {demande.changes.length === 0 ? (
          '—'
        ) : (
          <ul className="suivi-changes modif-demande-changes">
            {demande.changes.map((c) => (
              <li key={c.field}>
                {c.label} : <s>{c.old || '—'}</s> → <b>{c.new || '—'}</b>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>{formatDate(demande.time)}</td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
      </td>
      <td>
        {demande.statut === 'PENDING' ? (
          <div className="row-actions">
            <button
              type="button"
              className="row-action row-action-success"
              title="Accepter et appliquer les modifications"
              onClick={accepter}
              disabled={busy}
            >
              <Check size={16} />
            </button>
            <button
              type="button"
              className="row-action row-action-danger"
              title="Refuser la demande"
              onClick={refuser}
              disabled={busy}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <>
            <div className="cell-main">{demande.treated_by || '—'}</div>
            <div className="cell-sub">{formatDate(demande.treated_time)}</div>
          </>
        )}
      </td>
    </tr>
  );
}

/** Modifications Colis — page principale : onglets de statut + tableau des demandes. */
export default function ModificationsColis() {
  const [statut, setStatut] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [pending, setPending] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null); // { kind: 'success' | 'info', text }

  const pager = usePagination(rows, 'demande');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/modifications-colis', { params: { statut } })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setPending(res.data.pending);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des demandes.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statut, reload]);

  /** Après Accepter / Refuser : bannière + rechargement de la liste. */
  function handleTreated(data, message) {
    setFlash(message);
    setError('');
    setReload((n) => n + 1);
  }

  return (
    <div className="platform-page remb-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <PencilLine size={18} /> Modifications Colis
          </h2>
        </div>

        <nav className="fiche-tabs" aria-label="Filtre par statut">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`fiche-tab ${statut === tab.value ? 'active' : ''}`}
              onClick={() => {
                setStatut(tab.value);
                setFlash(null);
                pager.setPage(1);
              }}
            >
              {tab.label}
              {tab.value === 'PENDING' && pending > 0 && (
                <span className="badge badge-attente">{pending}</span>
              )}
            </button>
          ))}
        </nav>

        {flash && (
          <div className={flash.kind === 'success' ? 'form-success' : 'remb-info'}>{flash.text}</div>
        )}
        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Magasin</th>
                <th>Colis</th>
                <th>Statut colis</th>
                <th>Modifications demandées</th>
                <th>Date demande</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucune demande trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((demande) => (
                  <DemandeRow
                    key={demande.id}
                    demande={demande}
                    onTreated={handleTreated}
                    onError={(msg) => {
                      setError(msg);
                      setFlash(null);
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>
    </div>
  );
}
