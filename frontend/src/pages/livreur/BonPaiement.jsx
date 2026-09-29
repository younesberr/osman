import { useEffect, useMemo, useState } from 'react';
import { Eye, FileDown, FileSpreadsheet, HandCoins, List, SlidersHorizontal, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { factureStatut, ligneStatut } from '../admin/FacturesLivreurs';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bon paiement — dashboard livreur : les factures (bons de paiement) du
 * livreur connecté uniquement (finalisées : Enregistré / Payé, les brouillons
 * restent internes à l'admin). Même structure que la page admin Facturation
 * livreurs > Factures, sans colonne ni filtre livreur, en lecture seule :
 * filtres (statut, date), preuve de paiement (consultation), détail en modale,
 * export PDF (utils/factureLivreurPdf) et export Excel des colis de la facture.
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

/** Modale « Voir détail » : informations de la facture + colis (montants)
 * + frais supplémentaires rattachés (déduits du montant net). */
function DetailFactureModal({ facture, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [frais, setFrais] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/factures-livreurs/livreur/${facture.id}`)
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
          prix: acc.prix + Number(p.prix || 0)
        }),
        { crbt: 0, frais: 0, prix: 0 }
      ),
    [parcels]
  );
  const totalFraisSupp = useMemo(
    () => frais.reduce((acc, f) => acc + Number(f.montant || 0), 0),
    [frais]
  );
  const montantNet = totaux.prix - totalFraisSupp;
  const statut = factureStatut(facture.statut);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock modal-facture" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail de la facture {facture.ref}</div>
              <div className="cell-sub">
                {facture.zone || '—'} — {parcels.length} colis — {formatMontant(montantNet)}
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
                <th>CRBT</th>
                <th>Frais</th>
                <th>Prix</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
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
                        <div className="cell-sub">{p.magasin || '—'}</div>
                      </td>
                      <td>
                        <span className="badge badge-neutral">{ligneStatut(p)}</span>
                      </td>
                      <td>{formatDate(p.statut_time)}</td>
                      <td>{p.ville || '—'}</td>
                      <td>{formatMontant(p.crbt)}</td>
                      <td>{formatMontant(p.frais)}</td>
                      <td className={Number(p.prix) < 0 ? 'facture-negatif' : ''}>{formatMontant(p.prix)}</td>
                    </tr>
                  ))}
                  <tr className="facture-total-row">
                    <td colSpan={5}>Total</td>
                    <td>{formatMontant(totaux.crbt)}</td>
                    <td>{formatMontant(totaux.frais)}</td>
                    <td>{formatMontant(totaux.prix)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {frais.length > 0 && (
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
                <tr className="facture-total-row">
                  <td colSpan={2}>Total frais supplémentaires</td>
                  <td>{formatMontant(totalFraisSupp)}</td>
                </tr>
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

/** Ligne du tableau des factures : preuve (consultation), détail, export PDF et Excel. */
function FactureRow({ facture, onDetail }) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [excelBusy, setExcelBusy] = useState(false);
  const statut = factureStatut(facture.statut);

  /** Télécharge la facture en PDF (informations société + colis). */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [factureRes, societeRes] = await Promise.all([
        api.get(`/factures-livreurs/livreur/${facture.id}`),
        api.get('/platform/societe')
      ]);
      const { genererFactureLivreurPdf } = await import('../../utils/factureLivreurPdf');
      const url = await genererFactureLivreurPdf({
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

  /**
   * Télécharge les colis de la facture en fichier .xlsx (librairie chargée à
   * la demande) : en-tête de colonnes, une ligne par colis (N° ordre, code
   * d'envoi, statut, date de livraison, ville, CRBT, frais, prix = CRBT −
   * frais) numérotés dans l'ordre d'ajout comme sur le PDF, puis une ligne
   * de totaux. Les montants sont des nombres (2 décimales), sommables dans
   * Excel.
   */
  async function downloadExcel() {
    if (excelBusy) return;
    setExcelBusy(true);
    try {
      const [res, XLSX] = await Promise.all([
        api.get(`/factures-livreurs/livreur/${facture.id}`),
        import('xlsx')
      ]);
      // L'API renvoie les colis du plus récent au plus ancien : N° 1 = premier ajouté.
      const parcels = [...(res.data.parcels || [])].reverse();
      if (!parcels.length) {
        alert('Aucun colis dans cette facture.');
        return;
      }
      const montant = (v) => Math.round(Number(v || 0) * 100) / 100;
      const data = parcels.map((p, idx) => ({
        'N° ordre': idx + 1,
        "Code d'envoi": p.code || '',
        Statut: ligneStatut(p),
        'Date livraison': formatDate(p.statut_time),
        Ville: p.ville || '',
        CRBT: montant(p.crbt),
        Frais: montant(p.frais),
        Prix: montant(p.prix)
      }));
      const totaux = data.reduce(
        (acc, r) => ({ crbt: acc.crbt + r.CRBT, frais: acc.frais + r.Frais, prix: acc.prix + r.Prix }),
        { crbt: 0, frais: 0, prix: 0 }
      );
      const ws = XLSX.utils.json_to_sheet(data);
      // Ligne des totaux sous la dernière ligne de colis.
      XLSX.utils.sheet_add_aoa(
        ws,
        [['Total', '', '', '', '', montant(totaux.crbt), montant(totaux.frais), montant(totaux.prix)]],
        { origin: -1 }
      );
      // Montants (colonnes F à H) affichés avec 2 décimales, ligne des totaux comprise.
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let r = 1; r <= range.e.r; r += 1) {
        for (let c = 5; c <= 7; c += 1) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
        }
      }
      ws['!cols'] = Object.keys(data[0]).map((k) => ({
        wch: Math.max(k.length, ...data.map((row) => String(row[k]).length)) + 2
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Colis');
      XLSX.writeFile(wb, `${facture.ref || `facture_${facture.id}`}.xlsx`);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la génération du fichier Excel.');
    } finally {
      setExcelBusy(false);
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
        {facture.preuve?.url ? (
          <a
            className="row-action"
            href={facture.preuve.url}
            target="_blank"
            rel="noreferrer"
            title="Voir la preuve de paiement"
          >
            <Eye size={16} />
          </a>
        ) : facture.preuve?.legacy ? (
          <span className="cell-sub" title="Preuve enregistrée depuis l'ancien système">
            Ancien système
          </span>
        ) : (
          '—'
        )}
      </td>
      <td>
        <div className="cell-main">{formatDate(facture.paid_time)}</div>
        <div className="cell-sub">{facture.paid_by || '—'}</div>
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
          <button type="button" className="row-action" title="Voir détail" onClick={() => onDetail(facture)}>
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
          <button
            type="button"
            className="row-action"
            title="Exporter Excel"
            onClick={downloadExcel}
            disabled={excelBusy}
          >
            <FileSpreadsheet size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Bon paiement — page principale du dashboard livreur : filtres et tableau. */
export default function BonPaiement() {
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
      .get('/factures-livreurs/livreur', {
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
            <HandCoins size={18} /> Mes bons de paiement
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
                <th>Preuve</th>
                <th>Date paiement</th>
                <th>Statut</th>
                <th>Nombre colis</th>
                <th>Montant total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {factures.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucun bon de paiement trouvé.
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
