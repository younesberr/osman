import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  FileDown,
  FileSpreadsheet,
  List,
  Pencil,
  Plus,
  Route,
  SlidersHorizontal,
  Trash2,
  Truck,
  Undo2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { SuiviModal } from '../../components/ParcelModals';
import { statutLabel } from '../../utils/statuts';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Bons de distribution — un bon affecte des colis « Reçu en agence » ou
 * « En cours » d'une même zone de destination à un livreur. Création via la
 * modale (zone puis livreur de la zone), puis gestion depuis le tableau :
 * détail (résumé livraison + colis avec statut actuel, date reportée /
 * programmée et bouton « Détail de suivi »), enregistrer / rouvrir, modifier
 * (page dédiée), supprimer (bon vide uniquement), téléchargement du bon en
 * PDF (utils/bonDistributionPdf) ou en
 * Excel (colis du bon, colonnes du modèle d'import : CODE SUIVI,
 * DESTINATAIRE, TELEPHONE, VILLE, ADRESSE, PRIX, COMMENTAIRE, COLIS A
 * REMPLACER, PEUT OUVRIR, PEUT ESSAYER).
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

/** Code statut effectif d'un colis : statut second quand il est « En cours ». */
function colisStatutCode(parcel) {
  if (parcel.status === 'IN_PROGRESS' && parcel.status_second) return parcel.status_second;
  return parcel.status;
}

/** Statuts pour lesquels on affiche la date reportée / programmée sous le badge. */
const STATUTS_AVEC_DATE = ['POSTPONED', 'PROGRAMMER'];

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → affichage "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : String(value).trim();
}

/** Date reportée / programmée d'un colis, vide si son statut ne la prévoit pas. */
function colisReportDate(parcel) {
  return STATUTS_AVEC_DATE.includes(colisStatutCode(parcel)) ? formatReportDate(parcel.report_time) : '';
}

/** Filtres appliqués par défaut : bons « Nouveau » des 30 derniers jours. */
function defaultFilters() {
  return { zone: '', livreur: '', status: 'new', range: defaultRange() };
}

/** Modale « Créer un bon de distribution » : zone (colis à distribuer) puis livreur de la zone. */
function CreateBonModal({ zones, onClose }) {
  const navigate = useNavigate();
  const withDispo = zones.filter((z) => Number(z.dispo) > 0);
  const [zone, setZone] = useState('');
  const [livreurs, setLivreurs] = useState([]);
  const [livreur, setLivreur] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Livreurs rattachés à la zone choisie (liste vidée à chaque changement).
  useEffect(() => {
    setLivreurs([]);
    setLivreur('');
    if (!zone) return undefined;
    let cancelled = false;
    api
      .get('/bons-distribution/livreurs', { params: { zone } })
      .then((res) => {
        if (!cancelled) setLivreurs(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des livreurs.');
      });
    return () => {
      cancelled = true;
    };
  }, [zone]);

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!zone) {
      setError('Veuillez sélectionner une zone.');
      return;
    }
    if (!livreur) {
      setError('Veuillez sélectionner un livreur.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post('/bons-distribution', { zone: Number(zone), livreur: Number(livreur) });
      navigate(`/admin/bons-distribution/${res.data.id}`);
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
            <Truck size={18} />
            <div className="cell-main">Créer un bon de distribution</div>
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
                options={withDispo.map((z) => ({
                  value: z.id,
                  label: `${z.label} (${z.dispo} colis à distribuer)`
                }))}
              />
            </div>
            {zone && (
              <div className="modal-form-full">
                <span className="field-label">Livreur</span>
                <SearchableSelect
                  value={livreur}
                  onChange={(v) => setLivreur(String(v))}
                  placeholder="— Sélectionner un livreur —"
                  options={livreurs.map((l) => ({ value: l.id, label: l.nom }))}
                />
              </div>
            )}
          </div>
          {withDispo.length === 0 && (
            <div className="field-error">Aucune zone n'a de colis « Reçu en agence » ou « En cours ».</div>
          )}
          {zone && livreurs.length === 0 && (
            <div className="field-error">Aucun livreur actif n'est rattaché à cette zone.</div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={creating}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !zone || !livreur}>
              <Plus size={15} /> {creating ? 'Création…' : 'Créer le bon'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Modale « Détail du bon » : résumé livraison (livrés payés = déjà dans une
 * facture livreur, livrés non payés, reste = autres colis du bon, calculé par
 * l'API : stats) puis colis du bon (code / magasin, ville / adresse, statut
 * actuel + date reportée / programmée, commentaire, bouton « Détail de suivi »
 * ouvrant la modale partagée avec la page Colis).
 */
function DetailBonModal({ bon, onClose }) {
  const [parcels, setParcels] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [suiviParcel, setSuiviParcel] = useState(null);

  useEffect(() => {
    api
      .get(`/bons-distribution/${bon.id}`)
      .then((res) => {
        setParcels(res.data.parcels);
        setStats(res.data.stats || null);
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id]);

  const compteurs = [
    {
      key: 'payes',
      label: 'Livrés payés',
      title: 'Colis livrés déjà ajoutés à une facture livreur',
      value: stats?.livres_payes,
      tone: 'tone-success'
    },
    {
      key: 'non-payes',
      label: 'Livrés non payés',
      title: 'Colis livrés pas encore ajoutés à une facture livreur',
      value: stats?.livres_non_payes,
      tone: 'tone-primary'
    },
    {
      key: 'reste',
      label: 'Reste',
      title: 'Colis du bon non livrés (total − livrés payés − livrés non payés)',
      value: stats?.reste,
      tone: ''
    }
  ];

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <List size={18} />
              <div>
                <div className="cell-main">Détail du bon {bon.ref}</div>
                <div className="cell-sub">
                  {bon.zone || '—'} — {bon.livreur_name || '—'} — {parcels.length} colis
                </div>
              </div>
            </div>
            <button type="button" className="row-action" onClick={onClose} title="Fermer">
              <X size={18} />
            </button>
          </div>

          {error && <div className="form-error">{error}</div>}

          {/* Résumé livraison du bon (chiffres calculés par l'API à l'ouverture). */}
          <div className="bon-detail-stats">
            {compteurs.map((c) => (
              <div key={c.key} className={`stat-card ${c.tone}`} title={c.title}>
                <div className="stat-value">{stats ? c.value : '—'}</div>
                <div className="stat-label">{c.label}</div>
              </div>
            ))}
          </div>

          <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Code colis</th>
                  <th>Ville</th>
                  <th>Statut</th>
                  <th>Commentaire</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {parcels.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="datatable-empty">
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
                      <td>
                        <span
                          className="badge"
                          style={p.statut_color ? { background: p.statut_color } : undefined}
                        >
                          {statutLabel(colisStatutCode(p))}
                        </span>
                        {colisReportDate(p) && <div className="cell-sub">{colisReportDate(p)}</div>}
                      </td>
                      <td className="mvnt-cell-texte">{p.commentaire || '—'}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="Détail de suivi"
                            onClick={() => setSuiviParcel(p)}
                          >
                            <Route size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modale « Détail de suivi » (composant partagé avec la page Colis) : rendue
          après la modale du bon pour s'afficher au-dessus (même z-index). */}
      {suiviParcel && (
        <SuiviModal
          parcel={{ parcel_id: suiviParcel.id, parcel_code: suiviParcel.code }}
          onClose={() => setSuiviParcel(null)}
        />
      )}
    </>
  );
}

/** Ligne du tableau des bons : statut + actions. */
function BonRow({ bon, onDetail, onChanged, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [excelBusy, setExcelBusy] = useState(false);
  const statut = bonStatut(bon);
  const enregistre = Number(bon.save) === 1;

  async function toggleSaved() {
    const question = enregistre
      ? `Rouvrir le bon « ${bon.ref} » ? Il redeviendra modifiable.`
      : `Enregistrer le bon « ${bon.ref} » ? Il passera en lecture seule.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await api.patch(`/bons-distribution/${bon.id}/save`, { saved: enregistre ? 0 : 1 });
      onChanged(bon.id, { save: res.data.save });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusy(false);
    }
  }

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
        api.get(`/bons-distribution/${bon.id}`),
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
   * (mêmes colonnes que l'export du bon d'envoi).
   */
  async function downloadExcel() {
    if (excelBusy) return;
    setExcelBusy(true);
    try {
      const [res, XLSX] = await Promise.all([api.get(`/bons-distribution/${bon.id}`), import('xlsx')]);
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
      await api.delete(`/bons-distribution/${bon.id}`);
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
      <td>{bon.livreur_name || '—'}</td>
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
            className={`row-action ${enregistre ? '' : 'row-action-success'}`}
            title={enregistre ? 'Rouvrir le bon' : 'Enregistrer le bon'}
            onClick={toggleSaved}
            disabled={busy || (!enregistre && Number(bon.nb_colis) === 0)}
          >
            {enregistre ? <Undo2 size={16} /> : <CheckCircle2 size={16} />}
          </button>
          <button
            type="button"
            className="row-action"
            title={enregistre ? 'Bon enregistré : modification impossible' : 'Modifier le bon'}
            onClick={() => navigate(`/admin/bons-distribution/${bon.id}`)}
            disabled={enregistre}
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
            disabled={busy || Number(bon.nb_colis) !== 0 || enregistre}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Bons de distribution — page principale : création, filtres et tableau des bons. */
export default function BonsDistribution() {
  const [bons, setBons] = useState([]);
  const [zones, setZones] = useState([]);
  const [livreurs, setLivreurs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    api.get('/bons-distribution/zones').then((res) => setZones(res.data)).catch(() => {});
    api.get('/bons-distribution/livreurs').then((res) => setLivreurs(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/bons-distribution', {
        params: {
          zone: applied.zone,
          livreur: applied.livreur,
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
            <Truck size={18} /> Bons de distribution
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Créer un bon de distribution
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
          <SearchSelect
            label="Livreur"
            options={livreurs.map((l) => ({ value: l.id, label: l.nom }))}
            value={draft.livreur}
            onChange={setDraftField('livreur')}
            allLabel="Tous"
          />
          <select
            className="datatable-select"
            value={draft.status}
            onChange={(e) => setDraftField('status')(e.target.value)}
            title="Statut du bon"
          >
            <option value="new">Nouveau</option>
            <option value="saved">Enregistré</option>
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
                <th>Livreur</th>
                <th>Statut</th>
                <th>Nombre de colis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun bon de distribution trouvé.
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
