import { useEffect, useMemo, useState } from 'react';
import { FileDown, List, ReceiptText, SlidersHorizontal, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { factureClientStatut, ligneStatut } from '../admin/FacturesClients';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Factures — dashboard client : les factures du client connecté uniquement
 * (finalisées : Enregistré / Payé, les brouillons restent internes à
 * l'admin). Même structure que la page admin Facturation clients > Factures,
 * sans colonne ni filtre magasin, en lecture seule : filtres (statut, date),
 * détail en modale et export PDF (utils/factureClientPdf).
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

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/** Filtres appliqués par défaut : toutes les factures des 30 derniers jours. */
function defaultFilters() {
  return { statut: '', range: defaultRange() };
}

/** Modale « Détail facture » : informations de la facture + colis (montants)
 * + frais rattachés et remise (déduits du montant net). */
function DetailFactureModal({ facture, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [frais, setFrais] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/factures-clients/client/${facture.id}`)
      .then((res) => {
        setParcels(res.data.parcels);
        setFrais(res.data.frais || []);
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement de la facture.'))
      .finally(() => setLoading(false));
  }, [facture.id]);

  const totaux = useMemo(
    () =>
      parcels.reduce(
        (acc, p) => ({
          crbt: acc.crbt + Number(p.crbt || 0),
          frais: acc.frais + Number(p.frais || 0),
          fraisSupp: acc.fraisSupp + Number(p.frais_supp || 0),
          prix: acc.prix + Number(p.prix || 0)
        }),
        { crbt: 0, frais: 0, fraisSupp: 0, prix: 0 }
      ),
    [parcels]
  );
  const totalFrais = useMemo(
    () => frais.reduce((acc, f) => acc + Number(f.montant || 0), 0),
    [frais]
  );
  const remise = Number(facture.remise) || 0;
  const montantNet = totaux.prix - totalFrais - remise;
  const statut = factureClientStatut(facture.statut);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock modal-facture" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail de la facture {facture.ref}</div>
              <div className="cell-sub">
                {parcels.length} colis — {formatMontant(montantNet)}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="facture-detail-infos">
          <div className="bon-info">
            <span className="field-label">Date de création</span>
            <span className="cell-main">{formatDate(facture.time)}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Statut</span>
            <span className={`badge ${statut.badge}`}>{statut.label}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Date de paiement</span>
            <span className="cell-main">{formatDate(facture.paid_time)}</span>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>N° ordre</th>
                <th>Code d'envoi</th>
                <th>Statut</th>
                <th>Date livraison</th>
                <th>Ville</th>
                <th>COD</th>
                <th>Frais</th>
                <th title="Frais supp de livraison (portés par le colis)">Frais supp</th>
                <th>Prix</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} className="datatable-empty">
                    Aucun colis dans cette facture.
                  </td>
                </tr>
              ) : (
                <>
                  {parcels.map((p, idx) => (
                    <tr key={p.id}>
                      <td>{parcels.length - idx}</td>
                      <td>
                        <div className="cell-main mono">{p.code || '—'}</div>
                        <div className="cell-sub">{p.destinataire || '—'}</div>
                      </td>
                      <td>
                        <span className="badge badge-neutral">{ligneStatut(p)}</span>
                      </td>
                      <td>{formatDate(p.statut_time)}</td>
                      <td>{p.ville || '—'}</td>
                      <td>{formatMontant(p.crbt)}</td>
                      <td>{formatMontant(p.frais)}</td>
                      <td>{formatMontant(p.frais_supp)}</td>
                      <td className={Number(p.prix) < 0 ? 'facture-negatif' : ''}>{formatMontant(p.prix)}</td>
                    </tr>
                  ))}
                  <tr className="facture-total-row">
                    <td colSpan={5}>Total</td>
                    <td>{formatMontant(totaux.crbt)}</td>
                    <td>{formatMontant(totaux.frais)}</td>
                    <td>{formatMontant(totaux.fraisSupp)}</td>
                    <td>{formatMontant(totaux.prix)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {(frais.length > 0 || remise > 0) && (
          <div className="table-wrap datatable">
            <table>
              <thead>
                <tr>
                  <th>Frais supplémentaire</th>
                  <th>Date frais</th>
                  <th>Montant</th>
                </tr>
              </thead>
              <tbody>
                {frais.map((f) => (
                  <tr key={f.id}>
                    <td>{f.titre}</td>
                    <td>{formatJour(f.date_frais)}</td>
                    <td>{formatMontant(f.montant)}</td>
                  </tr>
                ))}
                {frais.length > 0 && (
                  <tr className="facture-total-row">
                    <td colSpan={2}>Total frais supplémentaires</td>
                    <td>{formatMontant(totalFrais)}</td>
                  </tr>
                )}
                {remise > 0 && (
                  <tr>
                    <td colSpan={2}>Remise</td>
                    <td>- {formatMontant(remise)}</td>
                  </tr>
                )}
                <tr className="facture-total-row">
                  <td colSpan={2}>Montant net</td>
                  <td className={montantNet < 0 ? 'facture-negatif' : ''}>
                    {formatMontant(montantNet)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ligne du tableau des factures : détail en modale et export PDF. */
function FactureRow({ facture, onDetail }) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const statut = factureClientStatut(facture.statut);

  /** Télécharge la facture en PDF (informations société + colis). */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [factureRes, societeRes] = await Promise.all([
        api.get(`/factures-clients/client/${facture.id}`),
        api.get('/platform/societe')
      ]);
      const { genererFactureClientPdf } = await import('../../utils/factureClientPdf');
      const url = await genererFactureClientPdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        facture: factureRes.data,
        parcels: factureRes.data.parcels,
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
        <div className="cell-main mono">{facture.ref || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{formatDate(facture.time)}</div>
      </td>
      <td>
        <div className="cell-main">{formatDate(facture.paid_time)}</div>
      </td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
      </td>
      <td>{facture.nb_colis}</td>
      <td className={Number(facture.montant) < 0 ? 'facture-negatif' : ''}>
        {formatMontant(facture.montant)}
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Détail facture" onClick={() => onDetail(facture)}>
            <List size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title="Exporter en PDF"
            onClick={downloadPdf}
            disabled={pdfBusy}
          >
            <FileDown size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Factures — page principale du dashboard client : filtres et tableau. */
export default function Factures() {
  const [factures, setFactures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [detail, setDetail] = useState(null);

  const pager = usePagination(factures, 'facture');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/factures-clients/client', {
        params: {
          statut: applied.statut,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setFactures(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des factures.');
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
            <ReceiptText size={18} /> Mes factures
          </h2>
        </div>

        <div className="filters-bar">
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraftField('statut')(e.target.value)}
            title="Statut de la facture"
          >
            <option value="">Tous les statuts</option>
            <option value="saved">Enregistré</option>
            <option value="paid">Payé</option>
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
                <th>Date création</th>
                <th>Date paiement</th>
                <th>Statut</th>
                <th>Colis</th>
                <th>Total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {factures.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucune facture trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((facture) => (
                  <FactureRow key={facture.id} facture={facture} onDetail={setDetail} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {detail && <DetailFactureModal facture={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
