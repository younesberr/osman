import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  ClipboardList,
  FileDown,
  List,
  Plus,
  Search,
  Ticket,
  Trash2,
  UserRoundPlus,
  X
} from 'lucide-react';
import api from '../../api/client';
import { Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';
import DateRangeSelect from '../../components/DateRangeSelect';
import { usePlatform } from '../../context/PlatformContext';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Gestion de stock > Bon de sortie — un bon regroupe des colis de stock en
 * attente de ramassage à sortir de l'entrepôt. Création via le bouton
 * « Créer bon » (redirige vers la page de création), puis gestion depuis le
 * tableau : détail (modale avec les colis et leurs produits), affectation à
 * un utilisateur (modale avec recherche), traitement (colis → Ramassé),
 * téléchargement du bon en PDF A4 (utils/bonSortiePdf) et impression des
 * tickets 100 × 100 mm (utils/etiquettes, comme la page Colis).
 * Le traitement, le PDF et les tickets exigent un bon affecté.
 * Liste paginée, recherchée et filtrée côté serveur (tous les bons).
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

/** Statut affiché d'un bon : Traité > Affecté > Nouveau. */
function bonStatut(bon) {
  if (Number(bon.delivered) === 1) return { label: 'Traité', badge: 'badge-active' };
  if (bon.affecter_id) return { label: 'Affecté', badge: 'badge-affecte' };
  return { label: 'Nouveau', badge: 'badge-attente' };
}

/** Nom de magasin affiché : enseigne du client, sinon son nom. */
function magasinLabel(colis) {
  return colis.magasin || colis.clientNom || '';
}

/** Modale « Détail du bon » : colis du bon avec produits, retrait possible. */
function DetailBonModal({ bon, onClose, onRemoved }) {
  const [parcels, setParcels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const editable = Number(bon.delivered) !== 1;

  useEffect(() => {
    api
      .get(`/bons-sortie/${bon.id}`)
      .then((res) => setParcels(res.data.parcels))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id]);

  async function removeParcel(parcel) {
    if (!window.confirm(`Retirer le colis « ${parcel.code} » de ce bon ?`)) return;
    setBusyId(parcel.id);
    try {
      await api.delete(`/bons-sortie/${bon.id}/parcels/${parcel.id}`);
      setParcels((prev) => prev.filter((p) => p.id !== parcel.id));
      onRemoved(bon.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors du retrait.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock modal-bon-sortie" onClick={(e) => e.stopPropagation()}>
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
                <th>Ville de destination</th>
                <th>Adresse</th>
                <th>Commentaire</th>
                <th>Produits</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {parcels.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                parcels.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-main mono">{p.code || '—'}</div>
                      <div className="cell-sub">{magasinLabel(p) || '—'}</div>
                    </td>
                    <td>{p.ville || '—'}</td>
                    <td className="mvnt-cell-texte">{p.adresse || '—'}</td>
                    <td className="mvnt-cell-texte">{p.commentaire || '—'}</td>
                    <td>
                      {p.produits.length === 0 ? (
                        <span className="cell-sub">—</span>
                      ) : (
                        <ul className="bon-sortie-produits">
                          {p.produits.map((pr, i) => (
                            <li key={i}>
                              <b>({pr.qty})</b> {pr.nom || '—'}
                              {pr.variante ? ` — ${pr.variante}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          title={editable ? 'Retirer ce colis du bon' : 'Bon traité : retrait impossible'}
                          onClick={() => removeParcel(p)}
                          disabled={!editable || busyId === p.id}
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
      </div>
    </div>
  );
}

/** Modale « Affecter le bon » : liste déroulante des utilisateurs avec recherche. */
function AffecterModal({ bon, onClose, onChanged }) {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(bon.affecter_id ? String(bon.affecter_id) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/bons-sortie/users')
      .then((res) => setUsers(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement des utilisateurs.'));
  }, []);

  async function affecter(e) {
    e.preventDefault();
    setError('');
    if (!userId) {
      setError('Veuillez sélectionner un utilisateur.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.patch(`/bons-sortie/${bon.id}/affecter`, { userId: Number(userId) });
      onChanged(bon.id, { affecter_id: res.data.affecter_id, affecter_name: res.data.affecter_name });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'affectation.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-affecter" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <UserRoundPlus size={18} />
            <div>
              <div className="cell-main">Affecter le bon {bon.ref}</div>
              {bon.affecter_name && <div className="cell-sub">Actuellement affecté à {bon.affecter_name}</div>}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={affecter}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Utilisateur</span>
              <SearchableSelect
                value={userId}
                onChange={setUserId}
                placeholder="— Sélectionner un utilisateur —"
                options={users.map((u) => ({ value: String(u.id), label: u.nom }))}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !userId}>
              <UserRoundPlus size={15} /> {busy ? 'Affectation…' : 'Affecter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Ligne du tableau des bons : statut + actions. */
function BonRow({ bon, onDetail, onAffecter, onChanged, onDeleted }) {
  const { config } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [ticketsBusy, setTicketsBusy] = useState(false);
  const statut = bonStatut(bon);
  const traite = Number(bon.delivered) === 1;
  const affecte = Boolean(bon.affecter_id);

  /** Supprime un bon vide (aucun colis). */
  async function remove() {
    if (!window.confirm(`Supprimer le bon « ${bon.ref} » ?`)) return;
    setBusy(true);
    try {
      await api.delete(`/bons-sortie/${bon.id}`);
      onDeleted(bon.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setBusy(false);
    }
  }

  async function traiter() {
    if (
      !window.confirm(
        `Confirmer le traitement du bon « ${bon.ref} » ? Ses colis en attente passeront en « Ramassé ».`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/bons-sortie/${bon.id}/traiter`);
      onChanged(bon.id, { delivered: 1 });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors du traitement.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Télécharge le bon en PDF A4 (logo, encadré d'informations, colis avec
   * produits et positions) : génération via utils/bonSortiePdf puis ouverture
   * dans un nouvel onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const res = await api.get(`/bons-sortie/${bon.id}`);
      const { genererBonSortiePdf } = await import('../../utils/bonSortiePdf');
      const url = await genererBonSortiePdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        bon: res.data,
        parcels: res.data.parcels
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
   * Imprime les tickets des colis du bon (format 100 × 100 mm, même style que
   * la page Colis) : données via /bons-sortie/:id/labels, PDF via
   * utils/etiquettes, ouvert dans un nouvel onglet.
   */
  async function printTickets() {
    if (ticketsBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération des tickets…');
    setTicketsBusy(true);
    try {
      const res = await api.get(`/bons-sortie/${bon.id}/labels`);
      const { genererEtiquettesPdf } = await import('../../utils/etiquettes');
      const url = await genererEtiquettesPdf({
        ...res.data,
        logoUrl: config.logo,
        format: '100',
        onProgress: progressionOnglet(win, 'Génération des tickets…', 'ticket')
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération des tickets.');
    } finally {
      setTicketsBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="cell-main mono">{bon.ref || '—'}</div>
      </td>
      <td>{formatDate(bon.time)}</td>
      <td>{bon.by_name || '—'}</td>
      <td>{bon.affecter_name || '—'}</td>
      <td>{bon.nb_colis}</td>
      <td>
        <span className={`badge ${statut.badge}`}>{statut.label}</span>
        {traite && bon.affecter_name && <div className="cell-sub">{bon.affecter_name}</div>}
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Détail du bon" onClick={() => onDetail(bon)}>
            <List size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title={traite ? 'Bon traité : affectation impossible' : 'Affecter à un utilisateur'}
            onClick={() => onAffecter(bon)}
            disabled={traite}
          >
            <UserRoundPlus size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-success"
            title={
              traite
                ? 'Bon déjà traité'
                : affecte
                  ? 'Traiter le bon'
                  : "Affectez d'abord ce bon à un utilisateur"
            }
            onClick={traiter}
            disabled={busy || traite || !affecte}
          >
            <CheckCircle2 size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title={affecte ? 'Télécharger le bon de sortie (PDF)' : "Affectez d'abord ce bon à un utilisateur"}
            onClick={downloadPdf}
            disabled={pdfBusy || !affecte}
          >
            <FileDown size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title={affecte ? 'Imprimer les tickets des colis' : "Affectez d'abord ce bon à un utilisateur"}
            onClick={printTickets}
            disabled={ticketsBusy || !affecte}
          >
            <Ticket size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title={
              Number(bon.nb_colis) === 0
                ? 'Supprimer le bon'
                : 'Suppression possible uniquement si le bon est vide'
            }
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

/**
 * Gestion de stock > Bon de sortie — page principale : création et tableau
 * des bons. Pagination, recherche et filtres côté serveur (GET /bons-sortie
 * renvoie { rows, total, page, pageSize, totalPages }) : tous les bons sont
 * accessibles, pas seulement les plus récents.
 */
export default function BonsSortie() {
  const navigate = useNavigate();
  const [bons, setBons] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [rechercheInput, setRechercheInput] = useState('');
  const [recherche, setRecherche] = useState('');
  // Filtres : statut (non traité par défaut), affectation (tous), plage de dates.
  const [filtreStatut, setFiltreStatut] = useState('non-traite');
  const [filtreAffecte, setFiltreAffecte] = useState('');
  const [range, setRange] = useState({ from: '', to: '', preset: 'all' });
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState(null);
  const [affecter, setAffecter] = useState(null);

  // Recherche débouncée : le serveur n'est interrogé que 400 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setRecherche(rechercheInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [rechercheInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/bons-sortie', {
        params: {
          page,
          pageSize,
          search: recherche,
          statut: filtreStatut,
          affecte: filtreAffecte,
          dateFrom: range.from,
          dateTo: range.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        // Page devenue vide (suppressions, filtre) : on recule sur la dernière page.
        if (page > res.data.totalPages) {
          setPage(res.data.totalPages);
          return;
        }
        setBons(res.data.rows);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
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
  }, [page, pageSize, recherche, filtreStatut, filtreAffecte, range.from, range.to, reload]);

  const rangeLabel = useMemo(() => {
    if (!total) return '0 bon';
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} ${
      total > 1 ? 'bons' : 'bon'
    }`;
  }, [page, pageSize, total]);

  // Même barre de navigation que la pagination navigateur (components/Pagination).
  const pager = { page, setPage, pageSize, setPageSize, totalPages, rangeLabel };

  /** Crée un bon vide puis ouvre sa page de création (ajout des colis). */
  async function createBon() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await api.post('/bons-sortie');
      navigate(`/admin/stock/bon-de-sortie/${res.data.id}`);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la création du bon.');
      setCreating(false);
    }
  }

  /**
   * Après une affectation, un traitement, une suppression ou le retrait d'un
   * colis : la page courante est rechargée du serveur (statut, compteur et
   * total à jour, filtres réappliqués).
   */
  function refresh() {
    setReload((n) => n + 1);
  }

  return (
    <div className="platform-page bons-sortie-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ClipboardList size={18} /> Bons de sortie
          </h2>
          <button type="button" className="btn btn-primary" onClick={createBon} disabled={creating}>
            <Plus size={15} /> {creating ? 'Création…' : 'Créer bon'}
          </button>
        </div>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher : référence, créateur, affecté à, statut…"
              value={rechercheInput}
              onChange={(e) => setRechercheInput(e.target.value)}
            />
          </div>
          <select
            className="datatable-select"
            value={filtreStatut}
            onChange={(e) => {
              setFiltreStatut(e.target.value);
              setPage(1);
            }}
            title="Statut du bon"
          >
            <option value="non-traite">Non traité</option>
            <option value="traite">Traité</option>
            <option value="">Tous les statuts</option>
          </select>
          <select
            className="datatable-select"
            value={filtreAffecte}
            onChange={(e) => {
              setFiltreAffecte(e.target.value);
              setPage(1);
            }}
            title="Affectation du bon"
          >
            <option value="">Tous</option>
            <option value="affecte">Affecté</option>
            <option value="non-affecte">Non affecté</option>
          </select>
          <DateRangeSelect
            value={range}
            onChange={(v) => {
              setRange(v);
              setPage(1);
            }}
          />
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Réf bon</th>
                <th>Date de création</th>
                <th>Créé par</th>
                <th>Affecté à</th>
                <th>Colis</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun bon de sortie trouvé.
                  </td>
                </tr>
              ) : (
                bons.map((bon) => (
                  <BonRow
                    key={bon.id}
                    bon={bon}
                    onDetail={setDetail}
                    onAffecter={setAffecter}
                    onChanged={refresh}
                    onDeleted={refresh}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {detail && <DetailBonModal bon={detail} onClose={() => setDetail(null)} onRemoved={refresh} />}
      {affecter && <AffecterModal bon={affecter} onClose={() => setAffecter(null)} onChanged={refresh} />}
    </div>
  );
}
