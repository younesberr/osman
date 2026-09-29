import { useEffect, useState } from 'react';
import { FileDown, FileSpreadsheet, List, SlidersHorizontal, Truck, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bons de distribution — dashboard livreur : mêmes tableau et détail que la
 * page admin (pages/admin/BonsDistribution.jsx) mais en lecture seule et
 * limités aux bons du livreur connecté (endpoints /bons-distribution/livreur).
 * Actions par bon : détail (modale), téléchargement PDF et Excel.
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

/** Statut affiché d'un bon : Enregistré > Nouveau. */
function bonStatut(bon) {
  if (Number(bon.save) === 1) return { label: 'Enregistré', badge: 'badge-active' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Filtres appliqués par défaut : tous les bons des 30 derniers jours. */
function defaultFilters() {
  return { status: '', range: defaultRange() };
}

/** Modale « Détail du bon » : colis du bon (code / magasin, ville / adresse, commentaire). */
function DetailBonModal({ bon, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/bons-distribution/livreur/${bon.id}`)
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
              <div className="cell-sub">
                {bon.zone || '—'} — {parcels.length} colis
              </div>
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
                <th>Ville</th>
                <th>Commentaire</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={3} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                parcels.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-main mono">{p.code || '—'}</div>
                      <div className="cell-sub">{p.magasin || '—'}</div>
                    </td>
                    <td>
                      <div className="cell-main">{p.ville || '—'}</div>
                      <div className="cell-sub">{p.adresse || '—'}</div>
                    </td>
                    <td className="mvnt-cell-texte">{p.commentaire || '—'}</td>
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

/** Ligne du tableau des bons : statut + actions lecture seule (détail, PDF, Excel). */
function BonRow({ bon, onDetail }) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const [excelBusy, setExcelBusy] = useState(false);
  const statut = bonStatut(bon);

  /**
   * Télécharge le bon en PDF : détail du bon + informations société (en-tête
   * et pied de page), génération via utils/bonDistributionPdf puis ouverture
   * dans un nouvel onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`/bons-distribution/livreur/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonDistributionPdf } = await import('../../utils/bonDistributionPdf');
      const url = await genererBonDistributionPdf({
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

  /**
   * Télécharge les colis du bon en fichier .xlsx (librairie chargée à la
   * demande), une ligne par colis, colonnes du modèle d'import de colis
   * (mêmes colonnes que l'export de la page admin).
   */
  async function downloadExcel() {
    if (excelBusy) return;
    setExcelBusy(true);
    try {
      const [res, XLSX] = await Promise.all([
        api.get(`/bons-distribution/livreur/${bon.id}`),
        import('xlsx')
      ]);
      const ouiNon = (v) => (Number(v) === 1 ? 'OUI' : 'NON');
      const data = res.data.parcels.map((p) => ({
        'CODE SUIVI': p.code || '',
        DESTINATAIRE: p.destinataire || '',
        TELEPHONE: p.telephone || '',
        VILLE: p.ville || '',
        ADRESSE: p.adresse || '',
        PRIX: p.prix ?? '',
        COMMENTAIRE: p.commentaire || '',
        'COLIS A REMPLACER': ouiNon(p.replace_flag),
        'PEUT OUVRIR': ouiNon(p.open_flag),
        'PEUT ESSAYER': ouiNon(p.essayage_flag)
      }));
      if (!data.length) {
        alert('Aucun colis dans ce bon.');
        return;
      }
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = Object.keys(data[0]).map((k) => ({
        wch: Math.max(k.length, ...data.map((r) => String(r[k]).length)) + 2
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Colis');
      XLSX.writeFile(wb, `${bon.ref || `bon_${bon.id}`}.xlsx`);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la génération du fichier Excel.');
    } finally {
      setExcelBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main mono">{bon.ref || '—'}</div>
      </td>
      <td>{formatDate(bon.time)}</td>
      <td>{bon.zone || '—'}</td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
      </td>
      <td>{bon.nb_colis}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Détail du bon" onClick={() => onDetail(bon)}>
            <List size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title="Télécharger en PDF"
            onClick={downloadPdf}
            disabled={pdfBusy}
          >
            <FileDown size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title="Télécharger en Excel"
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

/** Bons de distribution du livreur connecté — filtres et tableau en lecture seule. */
export default function BonsDistributionLivreur() {
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
      .get('/bons-distribution/livreur', {
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
            <Truck size={18} /> Bons de distribution
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
            <option value="saved">Enregistré</option>
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
                <th>Zone</th>
                <th>Statut</th>
                <th>Nombre de colis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun bon de distribution trouvé.
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
