import { useEffect, useState } from 'react';
import { Check, HandCoins, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Remboursement (/admin/remboursement) — même structure que la page legacy
 * admin/files/remboursements.php : demandes de remboursement des clients
 * (delevery_remboursement) filtrées par statut (En attente par défaut, avec
 * compteur), tableau Magasin / Code colis / Montant réel / Montant à
 * rembourser / Récupérer colis / Commentaire / Date demande / Statut /
 * Actions. Accepter crée le colis "CODE_REMB" en distribution chez le livreur
 * du colis original (ajouté à son dernier bon de distribution ouvert) ;
 * Refuser marque simplement la demande refusée.
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

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/* Onglets de filtre par statut (PENDING par défaut, comme le legacy). */
const TABS = [
  { value: 'PENDING', label: 'En attente' },
  { value: 'ACCEPTED', label: 'Acceptées' },
  { value: 'REFUSED', label: 'Refusées' },
  { value: 'ALL', label: 'Toutes' }
];

/* Badge de statut d'une demande. */
const STATUT_BADGES = {
  PENDING: { label: 'En attente', badge: 'badge-attente' },
  ACCEPTED: { label: 'Accepté', badge: 'badge-active' },
  REFUSED: { label: 'Refusé', badge: 'badge-refuse' }
};

/** Ligne du tableau : demande + actions Accepter / Refuser si en attente. */
function DemandeRow({ demande, onTreated, onError }) {
  const [busy, setBusy] = useState(false);
  const statut = STATUT_BADGES[demande.statut] || { label: demande.statut, badge: 'badge-neutral' };

  async function accepter() {
    if (
      !window.confirm(
        `Accepter ce remboursement et créer le colis ${demande.parcel_code}_REMB en distribution ?`
      )
    )
      return;
    setBusy(true);
    try {
      const res = await api.post(`/remboursements/${demande.id}/accepter`);
      onTreated(res.data, {
        kind: 'success',
        text: `Remboursement accepté. Colis ${res.data.new_parcel_code} créé en distribution${
          res.data.added_to_bon ? ' et ajouté au dernier bon de distribution ouvert du livreur' : ''
        }.`
      });
    } catch (err) {
      onError(err.response?.data?.message || 'Erreur lors de l’acceptation de la demande.');
      setBusy(false);
    }
  }

  async function refuser() {
    if (!window.confirm('Refuser cette demande ?')) return;
    setBusy(true);
    try {
      const res = await api.post(`/remboursements/${demande.id}/refuser`);
      onTreated(res.data, { kind: 'info', text: 'Demande de remboursement refusée.' });
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
      <td>{formatMontant(demande.montant_reel)}</td>
      <td>
        <b>{formatMontant(demande.montant)}</b>
      </td>
      <td>
        {Number(demande.recuperer) === 1 ? (
          <span className="badge badge-mvnt-colis">Oui</span>
        ) : (
          <span className="badge badge-neutral">Non</span>
        )}
      </td>
      <td className="remb-comment">{demande.commentaire || '—'}</td>
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
              title={`Accepter (colis ${demande.parcel_code}_REMB)`}
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

/** Remboursement — page principale : onglets de statut + tableau des demandes. */
export default function Remboursements() {
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
      .get('/remboursements', { params: { statut } })
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
            <HandCoins size={18} /> Remboursements
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
                <th>Code colis</th>
                <th>Montant réel</th>
                <th>Montant à rembourser</th>
                <th>Récupérer colis</th>
                <th>Commentaire</th>
                <th>Date demande</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} className="datatable-empty">
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
