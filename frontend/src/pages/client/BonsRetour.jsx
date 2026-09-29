import { useEffect, useState } from 'react';
import { ArrowLeftRight, FileDown, List, SlidersHorizontal, Undo2, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { statutLabel } from '../../utils/statuts';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bon de retour — dashboard client : les bons de retour du client connecté
 * uniquement. Même structure que la page admin Bons de retour > Client, sans
 * colonne ni filtre client, en lecture seule : filtres (statut, date), détail
 * en modale et export PDF (utils/bonRetourClientPdf). Même modèle que la page
 * Factures du dashboard client.
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

/** Statut affiché d'un bon : Vérifié, Reçu (non vérifié), Expédié ou Nouveau. */
function bonStatut(bon) {
  if (Number(bon.verified) === 1) return { label: 'Vérifié', badge: 'badge-active' };
  if (Number(bon.delivered) === 1) return { label: 'Reçu (non vérifié)', badge: 'badge-non-verifie' };
  if (Number(bon.expedited) === 1) return { label: 'Expédié', badge: 'badge-ram-recue' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Filtres appliqués par défaut : tous les bons des 30 derniers jours. */
function defaultFilters() {
  return { status: '', range: defaultRange() };
}

/**
 * Modale « Détail du bon » : colis du bon (code / magasin, date de réception,
 * ville / adresse, motif de retour — statut du colis avant le circuit retour).
 */
function DetailBonModal({ bon, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/bons-retour-client/client/${bon.id}`)
      .then((res) => setParcels(res.data.parcels))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail du bon {bon.ref}</div>
              <div className="cell-sub">{parcels.length} colis</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code colis</th>
                <th>Date de réception</th>
                <th>Ville</th>
                <th>Statut avant retour</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                parcels.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-main mono">
                        {p.code || '—'}
                        {Number(p.replace_flag) === 1 && (
                          <span className="echange-icon" title="Colis échange">
                            <ArrowLeftRight size={14} />
                          </span>
                        )}
                      </div>
                      <div className="cell-sub">{p.magasin || '—'}</div>
                    </td>
                    <td>{Number(p.received) === 1 ? formatDate(p.received_time) : '—'}</td>
                    <td>
                      <div className="cell-main">{p.ville || '—'}</div>
                      <div className="cell-sub">{p.adresse || '—'}</div>
                    </td>
                    <td>{p.motif ? statutLabel(p.motif) : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Ligne du tableau des bons : détail en modale et export PDF. */
function BonRow({ bon, onDetail }) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const statut = bonStatut(bon);
  const recu = Number(bon.delivered) === 1;
  const nbColis = Number(bon.nb_colis) || 0;
  const nbRecus = Number(bon.nb_recus) || 0;

  /**
   * Télécharge le bon en PDF : détail du bon + informations société,
   * génération via utils/bonRetourClientPdf puis ouverture dans un nouvel
   * onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`/bons-retour-client/client/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonRetourClientPdf } = await import('../../utils/bonRetourClientPdf');
      const url = await genererBonRetourClientPdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        bon: bonRes.data,
        parcels: bonRes.data.parcels,
        societe: societeRes.data
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération du PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main mono">{bon.ref || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{formatDate(bon.time)}</div>
      </td>
      <td>
        <div className="cell-main">{recu ? formatDate(bon.received_time) : '—'}</div>
      </td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
      </td>
      <td>
        <div className="cell-main">{nbColis}</div>
        {!recu && nbRecus > 0 && (
          <div className="cell-sub">
            {nbRecus} reçu{nbRecus > 1 ? 's' : ''} par scan
          </div>
        )}
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Détail du bon" onClick={() => onDetail(bon)}>
            <List size={16} />
          </button>
          {nbColis > 0 && (
            <button
              type="button"
              className="row-action"
              title="Télécharger en PDF"
              onClick={downloadPdf}
              disabled={pdfBusy}
            >
              <FileDown size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Bon de retour — page principale du dashboard client : filtres et tableau. */
export default function BonsRetour() {
  const [bons, setBons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [detail, setDetail] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/bons-retour-client/client', {
        params: {
          status: applied.status,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setBons(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des bons.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied]);

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Undo2 size={18} /> Mes bons de retour
          </h2>
        </div>

        <div className="filters-bar">
          <select
            className="datatable-select"
            value={draft.status}
            onChange={(e) => setDraftField('status')(e.target.value)}
            title="Statut du bon"
          >
            <option value="">Tous les statuts</option>
            <option value="new">Nouveau</option>
            <option value="expedited">Expédié</option>
            <option value="received_unverified">Reçu (non vérifié)</option>
            <option value="verified">Vérifié</option>
          </select>
          <DateRangeSelect value={draft.range} onChange={setDraftField('range')} />
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
                <th>Référence</th>
                <th>Date de création</th>
                <th>Date de réception</th>
                <th>Statut</th>
                <th>Colis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun bon de retour trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((bon) => <BonRow key={bon.id} bon={bon} onDetail={setDetail} />)
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {detail && <DetailBonModal bon={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
