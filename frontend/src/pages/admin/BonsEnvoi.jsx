import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  FileDown,
  FileSpreadsheet,
  List,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Send,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bons d'envoi — un bon regroupe des colis ramassés (ou en attente de
 * réexpédition) d'une même zone de destination. Création via la modale
 * (zones ayant des colis « Ramassé » ou « Attente réexpédition »),
 * puis gestion depuis le tableau : détail, reçu / non reçu, fermer / ouvrir,
 * modifier (page dédiée), supprimer (bon vide uniquement), téléchargement du
 * bon en PDF (utils/bonEnvoiPdf) ou en Excel (colis du bon, colonnes du
 * modèle d'import : CODE SUIVI, DESTINATAIRE, TELEPHONE, VILLE, ADRESSE,
 * PRIX, COMMENTAIRE, COLIS A REMPLACER, PEUT OUVRIR, PEUT ESSAYER).
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

/** Statut affiché d'un bon : Reçu > Fermé > Nouveau. */
function bonStatut(bon) {
  if (Number(bon.delivered) === 1) return { label: 'Reçu', badge: 'badge-active' };
  if (Number(bon.closed) === 1) return { label: 'Fermé', badge: 'badge-neutral' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Filtres appliqués par défaut : bons « Nouveau » des 30 derniers jours. */
function defaultFilters() {
  return { zone: '', status: 'new', range: defaultRange() };
}

/** Modale « Créer un bon d'envoi » : zones ayant des colis à expédier
 * (statut Ramassé ou Attente réexpédition — compteur `picked` du serveur). */
function CreateBonModal({ zones, onClose }) {
  const navigate = useNavigate();
  const withPicked = zones.filter((z) => Number(z.picked) > 0);
  const [zone, setZone] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!zone) {
      setError('Veuillez sélectionner une zone.');
      return;
    }
    setCreating(true);
    try {
      // Un bon ouvert existe déjà pour la zone (existing: true) : le serveur
      // renvoie ce bon au lieu d'en créer un doublon → redirection dessus.
      const res = await api.post('/bons-envoi', { zone: Number(zone) });
      navigate(`/admin/bons-envoi/${res.data.id}`, {
        state: res.data.existing ? { existingBon: true } : null
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création du bon.');
      setCreating(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Send size={18} />
            <div className="cell-main">Créer un bon d'envoi</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={create}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Zone de destination</span>
              <SearchableSelect
                value={zone}
                onChange={(v) => setZone(String(v))}
                placeholder="— Sélectionner une zone —"
                options={withPicked.map((z) => ({
                  value: z.id,
                  label: `${z.label} (${z.picked} colis à expédier)`
                }))}
              />
            </div>
          </div>
          {withPicked.length === 0 && (
            <div className="field-error">
              Aucune zone n'a de colis en statut « Ramassé » ou « Attente réexpédition ».
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !zone}>
              <Plus size={15} /> {creating ? 'Création…' : 'Créer le bon'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Détail du bon » : colis du bon (code / magasin, ville / adresse, commentaire). */
function DetailBonModal({ bon, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/bons-envoi/${bon.id}`)
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

/** Ligne du tableau des bons : statut + actions. */
function BonRow({ bon, onDetail, onChanged, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [excelBusy, setExcelBusy] = useState(false);
  const statut = bonStatut(bon);
  const recu = Number(bon.delivered) === 1;
  const ferme = Number(bon.closed) === 1;
  const modifiable = !recu && !ferme;

  async function toggleReceived() {
    const question = recu
      ? `Passer le bon « ${bon.ref} » en NON reçu ? Il redeviendra modifiable (les colis déjà reçus gardent leur statut).`
      : `Confirmer la réception du bon « ${bon.ref} » ? Ses colis expédiés passeront en « Reçu en agence » et le bon sera fermé.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await api.patch(`/bons-envoi/${bon.id}/receive`, { received: recu ? 0 : 1 });
      onChanged(bon.id, { delivered: res.data.delivered, closed: res.data.closed });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleClosed() {
    setBusy(true);
    try {
      const res = await api.patch(`/bons-envoi/${bon.id}/close`, { closed: ferme ? 0 : 1 });
      onChanged(bon.id, { closed: res.data.closed });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Télécharge le bon en PDF : détail du bon + informations société (en-tête
   * et pied de page), génération via utils/bonEnvoiPdf puis ouverture dans un
   * nouvel onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`/bons-envoi/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonEnvoiPdf } = await import('../../utils/bonEnvoiPdf');
      const url = await genererBonEnvoiPdf({
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
   * demande), une ligne par colis, colonnes du modèle d'import de colis.
   */
  async function downloadExcel() {
    if (excelBusy) return;
    setExcelBusy(true);
    try {
      const [res, XLSX] = await Promise.all([api.get(`/bons-envoi/${bon.id}`), import('xlsx')]);
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

  async function remove() {
    if (!window.confirm(`Supprimer le bon « ${bon.ref} » ?`)) return;
    setBusy(true);
    try {
      await api.delete(`/bons-envoi/${bon.id}`);
      onDeleted(bon.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusy(false);
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
            className={`row-action ${recu ? '' : 'row-action-success'}`}
            title={recu ? 'Bon non reçu' : 'Bon bien reçu'}
            onClick={toggleReceived}
            disabled={busy}
          >
            {recu ? <Undo2 size={16} /> : <CheckCircle2 size={16} />}
          </button>
          <button
            type="button"
            className="row-action"
            title={ferme ? 'Ouvrir le bon' : 'Fermer le bon'}
            onClick={toggleClosed}
            disabled={busy || recu}
          >
            {ferme ? <LockOpen size={16} /> : <Lock size={16} />}
          </button>
          <button
            type="button"
            className="row-action"
            title={modifiable ? 'Modifier le bon' : 'Bon fermé : modification impossible'}
            onClick={() => navigate(`/admin/bons-envoi/${bon.id}`)}
            disabled={!modifiable}
          >
            <Pencil size={16} />
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
          <button
            type="button"
            className="row-action row-action-danger"
            title={Number(bon.nb_colis) === 0 ? 'Supprimer le bon' : 'Suppression possible uniquement si le bon est vide'}
            onClick={remove}
            disabled={busy || Number(bon.nb_colis) !== 0}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Bons d'envoi — page principale : création, filtres et tableau des bons. */
export default function BonsEnvoi() {
  const [bons, setBons] = useState([]);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    api.get('/bons-envoi/zones').then((res) => setZones(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/bons-envoi', {
        params: {
          zone: applied.zone,
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

  function handleChanged(id, patch) {
    setBons((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function handleDeleted(id) {
    setBons((prev) => prev.filter((b) => b.id !== id));
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Send size={18} /> Bons d'envoi
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Créer un bon d'envoi
          </button>
        </div>

        <div className="filters-bar">
          <SearchSelect
            label="Zone"
            options={zones.map((z) => ({ value: z.id, label: z.label }))}
            value={draft.zone}
            onChange={setDraftField('zone')}
            allLabel="Toutes"
          />
          <select
            className="datatable-select"
            value={draft.status}
            onChange={(e) => setDraftField('status')(e.target.value)}
            title="Statut du bon"
          >
            <option value="new">Nouveau</option>
            <option value="received">Reçu</option>
            <option value="closed">Fermé</option>
            <option value="">Tous les statuts</option>
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
                    Aucun bon d'envoi trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((bon) => (
                  <BonRow
                    key={bon.id}
                    bon={bon}
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

      {createOpen && <CreateBonModal zones={zones} onClose={() => setCreateOpen(false)} />}
      {detail && <DetailBonModal bon={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
