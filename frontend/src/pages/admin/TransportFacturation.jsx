import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  FileDown,
  FolderOpen,
  Plus,
  ReceiptText,
  SlidersHorizontal,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { useServerPagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect from '../../components/DateRangeSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Transport > Facturation — factures des sociétés partenaires (portage de
 * transport_facturation.php, types 1/2) : tuiles, filtres (factures non
 * payées par défaut), datatable paginée côté serveur (GET renvoie { rows,
 * total, page, pageSize, totalPages }) et modale de création avec option
 * « tout ajouter » (tous les colis non
 * facturés de la société, période facultative) — fini l'ajout colis par
 * colis du legacy. Le détail (composition de la facture) est sur
 * /admin/transport/facturation/:id.
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

/**
 * Modale « Créer une facture » : société (avec encours non facturé) +
 * option d'ajout automatique de tous ses colis (période facultative).
 */
function CreationModal({ onClose, onCreated }) {
  const [societes, setSocietes] = useState([]);
  const [form, setForm] = useState({ societe: '', auto: true, debut: '', fin: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/transport/factures/societes')
      .then((res) => setSocietes(res.data))
      .catch(() => {});
  }, []);

  const options = societes.map((s) => ({
    value: s.id,
    label: `${s.nom} — ${s.nb_colis} colis (${formatMontant(s.montant)})`
  }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.societe) {
      setError('Veuillez sélectionner une société.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/transport/factures', {
        societe: Number(form.societe),
        auto: form.auto,
        debut: form.auto ? form.debut : undefined,
        fin: form.auto ? form.fin : undefined
      });
      onCreated(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création de la facture.');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ReceiptText size={18} />
            <div className="cell-main">Créer une facture transport</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Société facturée</span>
              <SearchableSelect
                value={form.societe}
                onChange={(v) => setForm((f) => ({ ...f, societe: String(v) }))}
                placeholder="— Sélectionner une société —"
                options={options}
              />
            </div>
            <label className="modal-form-full transport-check">
              <input
                type="checkbox"
                checked={form.auto}
                onChange={(e) => setForm((f) => ({ ...f, auto: e.target.checked }))}
              />
              <span>Ajouter automatiquement tous les colis non facturés</span>
            </label>
            {form.auto && (
              <>
                <label>
                  <span className="field-label">Du (facultatif)</span>
                  <input
                    type="date"
                    value={form.debut}
                    onChange={(e) => setForm((f) => ({ ...f, debut: e.target.value }))}
                  />
                </label>
                <label>
                  <span className="field-label">Au (facultatif)</span>
                  <input
                    type="date"
                    value={form.fin}
                    onChange={(e) => setForm((f) => ({ ...f, fin: e.target.value }))}
                  />
                </label>
              </>
            )}
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Création…' : 'Créer la facture'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Filtres par défaut : toutes les dates, factures non payées. */
function defaultFilters() {
  return { range: { from: '', to: '', preset: 'all' }, societe: '', statut: 'impayee' };
}

/** Transport > Facturation — page principale : liste des factures. */
export default function TransportFacturation() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [societes, setSocietes] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(false);

  const pager = useServerPagination(total, 'facture');
  const { page, pageSize, setPage } = pager;

  useEffect(() => {
    api
      .get('/transport/filtres')
      .then((res) => setSocietes(res.data.societes))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get('/transport/stats')
      .then((res) => setStats(res.data))
      .catch(() => {});
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/transport/factures', {
        params: {
          page,
          pageSize,
          societe: applied.societe,
          statut: applied.statut,
          debut: applied.range.from,
          fin: applied.range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        // Page devenue vide (suppressions, filtre) : on recule sur la dernière page.
        if (page > res.data.totalPages) {
          setPage(res.data.totalPages);
          return;
        }
        setRows(res.data.rows);
        setTotal(res.data.total);
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
  }, [applied, reloadKey, page, pageSize, setPage]);

  const societeOptions = useMemo(
    () => societes.map((s) => ({ value: s.id, label: s.nom })),
    [societes]
  );

  async function toggleStatut(facture) {
    const versPayee = Number(facture.statut) === 0;
    const question = versPayee
      ? `Marquer la facture ${facture.reference} comme PAYÉE ?\nSon total (${formatMontant(
          facture.total
        )}) et sa date de paiement seront figés.`
      : `Repasser la facture ${facture.reference} en NON PAYÉE ?`;
    if (!window.confirm(question)) return;
    try {
      await api.patch(`/transport/factures/${facture.id}/statut`, { statut: versPayee ? 1 : 0 });
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors du changement de statut.');
    }
  }

  async function remove(facture) {
    if (!window.confirm(`Supprimer la facture ${facture.reference} (sans colis) ?`)) return;
    try {
      await api.delete(`/transport/factures/${facture.id}`);
      setRows((prev) => prev.filter((f) => f.id !== facture.id));
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  /**
   * PDF depuis la liste : mêmes données que la page de détail, ouvert dans
   * un nouvel onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function exportPdf(facture) {
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    try {
      const [factureRes, societeRes] = await Promise.all([
        api.get(`/transport/factures/${facture.id}`),
        api.get('/platform/societe')
      ]);
      const { genererFactureTransportPdf } = await import('../../utils/factureTransportPdf');
      const url = await genererFactureTransportPdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        ...factureRes.data,
        societePlateforme: societeRes.data
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération du PDF.');
    }
  }

  return (
    <div className="platform-page bons-envoi-page">
      {stats && (
        <div className="stats-grid transport-stats">
          <div className="stat-card tone-primary">
            <div className="stat-value">{stats.envoisNonFactures + stats.retoursNonFactures}</div>
            <div className="stat-label">Colis non facturés</div>
          </div>
          <div className="stat-card tone-danger">
            <div className="stat-value">{formatMontant(stats.encoursMontant)}</div>
            <div className="stat-label">Encours non facturé</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{stats.facturesImpayees}</div>
            <div className="stat-label">Factures non payées</div>
          </div>
        </div>
      )}

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ReceiptText size={18} /> Facturation transport
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal(true)}>
            <Plus size={15} /> Créer une facture
          </button>
        </div>

        <div className="filters-bar">
          <DateRangeSelect
            value={draft.range}
            onChange={(range) => setDraft((d) => ({ ...d, range }))}
          />
          <SearchSelect
            label="Société"
            options={societeOptions}
            value={draft.societe}
            onChange={(v) => setDraft((d) => ({ ...d, societe: v }))}
            allLabel="Toutes"
          />
          <select
            className="datatable-select"
            value={draft.statut}
            onChange={(e) => setDraft((d) => ({ ...d, statut: e.target.value }))}
            title="Statut"
          >
            <option value="">Tous les statuts</option>
            <option value="impayee">Non payée</option>
            <option value="payee">Payée</option>
          </select>
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
                <th>Société facturée</th>
                <th>Nb colis</th>
                <th>Total</th>
                <th>Statut</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucune facture trouvée.
                  </td>
                </tr>
              ) : (
                rows.map((facture) => (
                  <tr key={facture.id}>
                    <td>
                      <Link className="cell-main transport-code" to={`/admin/transport/facturation/${facture.id}`}>
                        {facture.reference}
                      </Link>
                    </td>
                    <td>{facture.societe || '—'}</td>
                    <td>{facture.nb_colis}</td>
                    <td>{formatMontant(facture.total)}</td>
                    <td>
                      <span className={`badge ${facture.statut === 1 ? 'badge-active' : 'badge-attente'}`}>
                        {facture.statut === 1 ? 'Payée' : 'Non payée'}
                      </span>
                      {facture.paid_time > 0 && (
                        <div className="cell-sub">le {formatDate(facture.paid_time)}</div>
                      )}
                    </td>
                    <td>
                      <div className="cell-main">{formatDate(facture.created_time)}</div>
                      <div className="cell-sub">{facture.created_by || ''}</div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Ouvrir la facture"
                          onClick={() => navigate(`/admin/transport/facturation/${facture.id}`)}
                        >
                          <FolderOpen size={16} />
                        </button>
                        <button
                          type="button"
                          className={`row-action ${facture.statut === 1 ? '' : 'row-action-success'}`}
                          title={facture.statut === 1 ? 'Repasser en non payée' : 'Marquer comme payée'}
                          onClick={() => toggleStatut(facture)}
                        >
                          {facture.statut === 1 ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Exporter le PDF"
                          onClick={() => exportPdf(facture)}
                        >
                          <FileDown size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          title={
                            facture.nb_colis > 0
                              ? 'Retirez les colis avant de supprimer'
                              : 'Supprimer la facture'
                          }
                          disabled={facture.nb_colis > 0 || facture.statut === 1}
                          onClick={() => remove(facture)}
                        >
                          <Trash2 size={16} />
                        </button>
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

      {modal && (
        <CreationModal
          onClose={() => setModal(false)}
          onCreated={(data) => navigate(`/admin/transport/facturation/${data.id}`)}
        />
      )}
    </div>
  );
}
