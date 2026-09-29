import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  FileDown,
  FileSpreadsheet,
  HandCoins,
  List,
  Pencil,
  Plus,
  ReceiptText,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Wand2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { statutLabel } from '../../utils/statuts';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Facturation clients > Factures — factures des clients (delevery_invoice
 * legacy) : création manuelle (modale magasin) ou génération automatique (une
 * facture brouillon par client ayant des colis facturables), filtres
 * (magasin, statut, date de création ou de paiement), actions par masse
 * (enregistrer / payer les factures cochées), détail en modale, modification
 * (brouillon uniquement, page dédiée), changement de statut (brouillon / enregistrer /
 * payer — le bouton du statut actuel n'est pas affiché), export PDF
 * (utils/factureClientPdf) et export Excel de la liste filtrée (réf. facture
 * + coordonnées bancaires des magasins : magasin, client, banque, RIB + total des frais
 * client « Frais TTC » (hors frais supplémentaires) + montant net
 * « Total »). Même structure que
 * la page Factures livreurs.
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

/* Statuts d'une facture client (codes legacy invoice_statut —
 * différents des codes factures livreurs). */
export const FACTURE_CLIENT_STATUTS = {
  0: { key: 'draft', label: 'Brouillon', badge: 'badge-attente' },
  1: { key: 'saved', label: 'Enregistré', badge: 'badge-mvnt-colis' },
  2: { key: 'paid', label: 'Payé', badge: 'badge-active' }
};

export function factureClientStatut(code) {
  return FACTURE_CLIENT_STATUTS[Number(code)] || { key: '', label: '—', badge: 'badge-neutral' };
}

/** Statut affiché d'une ligne de facture : Livré, ou statut second (Refusé / Annulé). */
export function ligneStatut(parcel) {
  if (parcel.line_statut === 'DELIVERED' || parcel.status === 'DELIVERED') return 'Livré';
  return statutLabel(parcel.status_second || 'REFUSE');
}

/** Libellé d'un client dans les listes déroulantes : magasin (nom). */
function clientLabel(c) {
  if (c.store && c.nom && c.store !== c.nom) return `${c.store} — ${c.nom}`;
  return c.store || c.nom || `Client ${c.id}`;
}

/* Date sur laquelle porte le sélecteur de plage (query dateField). */
const DATE_FIELDS = [
  { value: 'created', label: 'Date création' },
  { value: 'paid', label: 'Date paiement' }
];

/** Filtres appliqués par défaut : toutes les factures créées ces 30 derniers jours. */
function defaultFilters() {
  return { magasin: '', statut: '', dateField: 'created', range: defaultRange() };
}

/** Modale « Créer facture client » : client ayant des colis facturables. */
function CreateFactureModal({ onClose }) {
  const navigate = useNavigate();
  const [payables, setPayables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/factures-clients/payables')
      .then((res) => setPayables(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement des clients.'))
      .finally(() => setLoading(false));
  }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!client) {
      setError('Veuillez sélectionner un magasin.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/factures-clients', { client: Number(client) });
      navigate(`/admin/facturation-clients/factures/${res.data.id}`);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création de la facture.');
      setCreating(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ReceiptText size={18} />
            <div className="cell-main">Créer facture client</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={create}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Magasin</span>
              <SearchableSelect
                value={client}
                onChange={(v) => setClient(String(v))}
                placeholder="— Sélectionner un magasin —"
                options={payables.map((c) => ({
                  value: c.id,
                  label: `${clientLabel(c)} (${c.nb} colis facturables)`
                }))}
              />
            </div>
          </div>
          {!loading && payables.length === 0 && (
            <div className="field-error">Aucun client n'a de colis facturables.</div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !client}>
              <Plus size={15} /> {creating ? 'Création…' : 'Créer la facture'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
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
      .get(`/factures-clients/${facture.id}`)
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
                {facture.store || facture.client_name || '—'} — {parcels.length} colis —{' '}
                {formatMontant(montantNet)}
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

/* Libellés des transitions de statut (message de confirmation). */
const STATUT_ACTIONS = {
  draft: { label: 'Brouillon', icon: Undo2, question: (ref) => `Repasser la facture « ${ref} » en brouillon ? Elle redeviendra modifiable.` },
  saved: { label: 'Enregistrer', icon: CheckCircle2, question: (ref) => `Enregistrer la facture « ${ref} » ? Elle ne sera plus modifiable.` },
  paid: { label: 'Payé', icon: HandCoins, question: (ref) => `Marquer la facture « ${ref} » comme payée ?` }
};

/** Ligne du tableau des factures : sélection, statut et actions. */
function FactureRow({ facture, selected, onToggle, onDetail, onChanged, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const statut = factureClientStatut(facture.statut);
  const brouillon = statut.key === 'draft';

  async function changeStatut(key) {
    const action = STATUT_ACTIONS[key];
    if (!window.confirm(action.question(facture.ref))) return;
    setBusy(true);
    try {
      const res = await api.patch(`/factures-clients/${facture.id}/statut`, { statut: key });
      onChanged(facture.id, {
        statut: res.data.statut,
        paid_time: res.data.paid_time,
        paid_by: res.data.paid_by
      });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour du statut.');
    } finally {
      setBusy(false);
    }
  }

  /** Télécharge la facture en PDF (informations société + colis). */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [factureRes, societeRes] = await Promise.all([
        api.get(`/factures-clients/${facture.id}`),
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

  async function remove() {
    if (!window.confirm(`Supprimer la facture « ${facture.ref} » ?`)) return;
    setBusy(true);
    try {
      await api.delete(`/factures-clients/${facture.id}`);
      onDeleted(facture.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="bon-check-col">
        <input type="checkbox" checked={selected} onChange={() => onToggle(facture.id)} />
      </td>
      <td>
        <div className="cell-main mono">{facture.ref || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{facture.store || '—'}</div>
        <div className="cell-sub">{facture.client_name || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{formatDate(facture.time)}</div>
        <div className="cell-sub">{facture.created_by || '—'}</div>
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
          <button type="button" className="row-action" title="Détail facture" onClick={() => onDetail(facture)}>
            <List size={16} />
          </button>
          {brouillon && (
            <button
              type="button"
              className="row-action"
              title="Modifier la facture"
              onClick={() => navigate(`/admin/facturation-clients/factures/${facture.id}`)}
            >
              <Pencil size={16} />
            </button>
          )}
          {Object.entries(STATUT_ACTIONS)
            .filter(([key]) => key !== statut.key)
            .map(([key, action]) => {
              const Icon = action.icon;
              return (
                <button
                  key={key}
                  type="button"
                  className={`row-action ${key === 'paid' ? 'row-action-success' : ''}`}
                  title={action.label}
                  onClick={() => changeStatut(key)}
                  disabled={busy || (key !== 'draft' && Number(facture.nb_colis) === 0)}
                >
                  <Icon size={16} />
                </button>
              );
            })}
          <button
            type="button"
            className="row-action"
            title="Exporter en PDF"
            onClick={downloadPdf}
            disabled={pdfBusy}
          >
            <FileDown size={16} />
          </button>
          {brouillon && Number(facture.nb_colis) === 0 && (
            <button
              type="button"
              className="row-action row-action-danger"
              title="Supprimer la facture (vide)"
              onClick={remove}
              disabled={busy}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Facturation clients — page principale : création, filtres et tableau. */
export default function FacturesClients() {
  const [factures, setFactures] = useState([]);
  const [filtres, setFiltres] = useState({ clients: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [selection, setSelection] = useState(() => new Set());
  const [massBusy, setMassBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  // Récapitulatif de la génération auto : bandeau non bloquant sur la page.
  const [genMessage, setGenMessage] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const pager = usePagination(factures, 'facture');

  useEffect(() => {
    api.get('/factures-clients/filtres').then((res) => setFiltres(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/factures-clients', {
        params: {
          magasin: applied.magasin,
          statut: applied.statut,
          dateField: applied.dateField,
          dateFrom: applied.range.from,
          dateTo: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setFactures(res.data);
        setSelection(new Set());
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
  }, [applied, reloadKey]);

  const setDraftField = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));

  function handleChanged(id, patch) {
    setFactures((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  function handleDeleted(id) {
    setFactures((prev) => prev.filter((f) => f.id !== id));
    setSelection((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggleSelection(id) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    const ids = pager.pageRows.map((f) => f.id);
    const allChecked = ids.length > 0 && ids.every((id) => selection.has(id));
    setSelection((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (allChecked ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  /**
   * Action par masse (enregistrer / payer les factures cochées) : toutes les
   * factures sélectionnées doivent avoir le même statut actuel.
   */
  async function massAction(key) {
    const selected = factures.filter((f) => selection.has(f.id));
    if (!selected.length || massBusy) return;
    const statuts = new Set(selected.map((f) => Number(f.statut)));
    if (statuts.size > 1) {
      alert('Les factures sélectionnées doivent avoir le même statut.');
      return;
    }
    if (selected.some((f) => factureClientStatut(f.statut).key === key)) {
      alert(`Les factures sélectionnées sont déjà « ${STATUT_ACTIONS[key].label} ».`);
      return;
    }
    const question =
      key === 'paid'
        ? `Marquer ${selected.length} facture(s) comme payées ?`
        : `Enregistrer ${selected.length} facture(s) ? Elles ne seront plus modifiables.`;
    if (!window.confirm(question)) return;
    setMassBusy(true);
    let errorMsg = '';
    for (const facture of selected) {
      try {
        const res = await api.patch(`/factures-clients/${facture.id}/statut`, { statut: key });
        handleChanged(facture.id, {
          statut: res.data.statut,
          paid_time: res.data.paid_time,
          paid_by: res.data.paid_by
        });
      } catch (err) {
        errorMsg = `${facture.ref} : ${err.response?.data?.message || 'erreur lors de la mise à jour.'}`;
        break;
      }
    }
    setSelection(new Set());
    setMassBusy(false);
    if (errorMsg) alert(errorMsg);
  }

  /**
   * Exporte les factures de la liste filtrée (toutes les pages) en fichier
   * .xlsx : une ligne par facture avec sa référence, les coordonnées bancaires
   * du magasin (magasin, client, banque, RIB — ex. pour préparer les
   * virements), le total des frais client de la facture (colonne « Frais TTC » :
   * frais des lignes uniquement, sans les frais supp de livraison ni les frais
   * supplémentaires) et le montant net (colonne « Total »), nombres
   * sommables. Librairie chargée à la demande.
   */
  async function exportExcel() {
    if (!factures.length || exportBusy) return;
    setExportBusy(true);
    try {
      const XLSX = await import('xlsx');
      const data = factures.map((f) => ({
        // Référence de la facture (invoice_ref), même valeur que le tableau.
        'Réf. facture': f.ref || '',
        'Nom de magasin': f.store || '',
        'Nom client': f.client_name || '',
        'Nom banque': f.banque || '',
        // Chaîne (jamais un nombre) : le RIB garde tous ses chiffres dans Excel.
        RIB: String(f.rib || ''),
        // Nombres (2 décimales) : sommables dans Excel. « Frais TTC » = total
        // de la colonne « Frais » du détail (frais client des lignes, hors
        // frais supp) ; « Total » = même montant net que le tableau.
        'Frais TTC': Math.round(Number(f.frais || 0) * 100) / 100,
        Total: Math.round(Number(f.montant || 0) * 100) / 100
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = Object.keys(data[0]).map((k) => ({
        wch: Math.max(k.length, ...data.map((r) => String(r[k]).length)) + 2
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Factures clients');
      XLSX.writeFile(wb, `factures_clients_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      alert("Erreur lors de l'export Excel.");
    } finally {
      setExportBusy(false);
    }
  }

  /** Génération automatique : une facture brouillon par client facturable
   * (la facture brouillon existante du client est complétée le cas échéant). */
  async function generate() {
    if (genBusy) return;
    if (
      !window.confirm(
        'Générer automatiquement les factures ? Pour chaque client ayant des colis livrés non facturés (ou refusés / annulés avec frais) et dont la périodicité de facturation (fiche client) correspond à aujourd’hui : sa facture brouillon existante sera complétée, sinon une nouvelle facture brouillon sera créée.'
      )
    ) {
      return;
    }
    setGenBusy(true);
    setGenMessage(null);
    try {
      // Génération longue (une facture + colis par client) : délai étendu.
      const res = await api.post('/factures-clients/generate', null, { timeout: 300000 });
      const created = res.data.created || [];
      // Factures brouillon existantes complétées (colis ajoutés).
      const updated = res.data.updated || [];
      // Clients facturables ignorés car hors de leur période de facturation.
      const horsPeriode = Number(res.data.horsPeriode) || 0;
      const suffixe = horsPeriode
        ? ` — ${horsPeriode} client(s) facturable(s) ignoré(s) (hors période de facturation).`
        : '';
      if (!created.length && !updated.length) {
        setGenMessage({
          type: 'error',
          text: `${res.data.message || 'Aucune facture à générer.'}${suffixe}`
        });
      } else {
        const detail = (liste) =>
          liste.map((c) => `${c.ref} (${c.client}, ${c.nb} colis)`).join(' — ');
        const parties = [];
        if (created.length) {
          parties.push(`${created.length} facture(s) créée(s) : ${detail(created)}`);
        }
        if (updated.length) {
          parties.push(`${updated.length} facture(s) brouillon complétée(s) : ${detail(updated)}`);
        }
        // Bandeau non bloquant : la liste est rechargée immédiatement.
        setGenMessage({ type: 'success', text: `${parties.join(' • ')}${suffixe}` });
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      setGenMessage({
        type: 'error',
        text: err.response?.data?.message || 'Erreur lors de la génération des factures.'
      });
    } finally {
      setGenBusy(false);
    }
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ReceiptText size={18} /> Factures clients
          </h2>
          <div className="facture-head-actions">
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Créer facture client
            </button>
            <button type="button" className="btn btn-ghost" onClick={generate} disabled={genBusy}>
              <Wand2 size={15} /> {genBusy ? 'Génération…' : 'Génération auto des factures'}
            </button>
          </div>
        </div>

        <div className="filters-bar">
          <SearchSelect
            label="Magasin"
            options={filtres.clients.map((c) => ({ value: c.id, label: clientLabel(c) }))}
            value={draft.magasin}
            onChange={setDraftField('magasin')}
            allLabel="Tous"
          />
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraftField('statut')(e.target.value)}
            title="Statut de la facture"
          >
            <option value="">Tous les statuts</option>
            <option value="draft">Brouillon</option>
            <option value="saved">Enregistré</option>
            <option value="paid">Payé</option>
          </select>
          <select
            className="datatable-select"
            value={draft.dateField}
            onChange={(e) => setDraftField('dateField')(e.target.value)}
            title="Date de filtrage (création ou paiement de la facture)"
          >
            {DATE_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
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
          <button
            type="button"
            className="btn-export"
            onClick={exportExcel}
            disabled={exportBusy || loading || factures.length === 0}
            title={
              factures.length
                ? `Exporter les ${factures.length} facture(s) de la liste (réf. facture, magasin, client, banque, RIB, frais TTC, total)`
                : 'Aucune facture à exporter'
            }
          >
            <FileSpreadsheet size={15} />
            {exportBusy ? 'Export…' : 'Exporter Excel'}
          </button>
        </div>

        {genMessage && (
          <div
            className={`facture-gen-message field-${genMessage.type === 'error' ? 'error' : 'success'}`}
          >
            <span>{genMessage.text}</span>
            <button
              type="button"
              className="row-action"
              title="Fermer"
              onClick={() => setGenMessage(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}

        {selection.size > 0 && (
          <div className="facture-mass-actions">
            <span className="cell-sub">{selection.size} facture(s) sélectionnée(s)</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => massAction('saved')}
              disabled={massBusy}
            >
              <CheckCircle2 size={15} /> Enregistrer la sélection
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => massAction('paid')}
              disabled={massBusy}
            >
              <HandCoins size={15} /> Payer la sélection
            </button>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th className="bon-check-col">
                  <input
                    type="checkbox"
                    checked={pager.pageRows.length > 0 && pager.pageRows.every((f) => selection.has(f.id))}
                    onChange={togglePage}
                    title="Tout cocher / décocher"
                  />
                </th>
                <th>Référence</th>
                <th>Magasin</th>
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
                  <td colSpan={9} className="datatable-empty">
                    Aucune facture client trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((facture) => (
                  <FactureRow
                    key={facture.id}
                    facture={facture}
                    selected={selection.has(facture.id)}
                    onToggle={toggleSelection}
                    onDetail={setDetail}
                    onChanged={handleChanged}
                    onDeleted={handleDeleted}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {createOpen && <CreateFactureModal onClose={() => setCreateOpen(false)} />}
      {detail && <DetailFactureModal facture={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
