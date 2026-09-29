import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bus, FileDown, List, Pencil, SlidersHorizontal, Trash2, X } from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { hasTypeAccess } from '../../config/adminMenu';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import DateRangeSelect, { defaultRange } from '../../components/DateRangeSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Transport > Bons de transport — un bon par trajet et par journée (06:00 →
 * 06:00 le lendemain), créé automatiquement au premier envoi / retour scanné
 * dont la ville de destination appartient à une zone du trajet (Transport >
 * Configuration > Trajets). Aucune création manuelle. Tableau : référence,
 * trajet, journée, nombre de colis, actions — détail (colis regroupés par
 * société expéditeur puis ville de destination), modifier (page dédiée :
 * ajout de colis non affectés / retrait), bon en PDF (utils/bonTransportPdf :
 * colis par ville de destination puis expéditeur, codes de colis), supprimer
 * (types 1/2, bon vide).
 */

/** "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function formatJournee(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-');
  return jj ? `${jj}/${mm}/${aaaa}` : '—';
}

/** Plage horaire de la journée : "06:00 → JJ/MM 06:00" (lendemain). */
function formatPlage(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-').map(Number);
  if (!jj) return '';
  const fin = new Date(Date.UTC(aaaa, mm - 1, jj) + 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `06:00 → ${p(fin.getUTCDate())}/${p(fin.getUTCMonth() + 1)} 06:00`;
}

/** Ville en "REF - Nom". */
function villeLabel(ref, nom) {
  if (!ref && !nom) return '—';
  return [ref, nom].filter(Boolean).join(' - ');
}

/** Filtres par défaut : tous les trajets, 30 derniers jours. */
function defaultFilters() {
  return { trajet: '', range: defaultRange() };
}

/**
 * Regroupe les colis d'un bon : société expéditeur (tri alphabétique) →
 * ville de destination (tri alphabétique) → nombre de colis.
 */
function grouperColis(colis) {
  const parSociete = new Map();
  for (const c of colis) {
    const societe = c.societe_exp || '—';
    const ville = villeLabel(c.ville_ref, c.ville);
    if (!parSociete.has(societe)) parSociete.set(societe, new Map());
    const villes = parSociete.get(societe);
    villes.set(ville, (villes.get(ville) || 0) + 1);
  }
  return [...parSociete.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'fr'))
    .map(([societe, villes]) => {
      const lignes = [...villes.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], 'fr'))
        .map(([ville, nb]) => ({ ville, nb }));
      return { societe, total: lignes.reduce((s, l) => s + l.nb, 0), lignes };
    });
}

/** Modale « Détail du bon » : colis regroupés par société expéditeur puis ville. */
function DetailBonModal({ bon, onClose }) {
  const [colis, setColis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/transport/bons/${bon.id}`)
      .then((res) => setColis(res.data.colis))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement du bon.'))
      .finally(() => setLoading(false));
  }, [bon.id]);

  const groupes = useMemo(() => grouperColis(colis), [colis]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <List size={18} />
            <div>
              <div className="cell-main">Détail du bon {bon.ref}</div>
              <div className="cell-sub">
                {bon.trajet || '—'} — journée du {formatJournee(bon.journee)} — {colis.length} colis
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
                <th>Société expéditeur</th>
                <th>Ville de destination</th>
                <th>Nombre de colis</th>
              </tr>
            </thead>
            <tbody>
              {groupes.length === 0 && !loading ? (
                <tr>
                  <td colSpan={3} className="datatable-empty">
                    Aucun colis dans ce bon.
                  </td>
                </tr>
              ) : (
                groupes.map((g) =>
                  g.lignes.map((l, i) => (
                    <tr key={`${g.societe}-${l.ville}`}>
                      {i === 0 && (
                        <td rowSpan={g.lignes.length}>
                          <div className="cell-main">{g.societe}</div>
                          <div className="cell-sub">{g.total} colis</div>
                        </td>
                      )}
                      <td>{l.ville}</td>
                      <td>{l.nb}</td>
                    </tr>
                  ))
                )
              )}
            </tbody>
            {groupes.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={2}>
                    <div className="cell-main">Total</div>
                  </td>
                  <td>
                    <div className="cell-main">{colis.length}</div>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

/** Ligne du tableau des bons. */
function BonRow({ bon, peutSupprimer, onDetail, onDeleted }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const vide = Number(bon.nb_colis) === 0;

  /**
   * Télécharge le bon en PDF : colis du bon + informations société (en-tête
   * et pied de page), génération via utils/bonTransportPdf puis ouverture dans
   * un nouvel onglet (ouvert pendant le clic pour ne pas être bloqué).
   */
  async function downloadPdf() {
    if (pdfBusy) return;
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    setPdfBusy(true);
    try {
      const [bonRes, societeRes] = await Promise.all([
        api.get(`/transport/bons/${bon.id}`),
        api.get('/platform/societe')
      ]);
      const { genererBonTransportPdf } = await import('../../utils/bonTransportPdf');
      const url = await genererBonTransportPdf({
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page'),
        bon: bonRes.data,
        colis: bonRes.data.colis,
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
    if (!window.confirm(`Supprimer le bon « ${bon.ref} » ?`)) return;
    setBusy(true);
    try {
      await api.delete(`/transport/bons/${bon.id}`);
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
        <div className="cell-sub">{bon.cree_par ? `Créé par ${bon.cree_par}` : ''}</div>
      </td>
      <td>{bon.trajet || '—'}</td>
      <td>
        <div className="cell-main">{formatJournee(bon.journee)}</div>
        <div className="cell-sub">{formatPlage(bon.journee)}</div>
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
            title="Modifier le bon (ajouter / retirer des colis)"
            onClick={() => navigate(`/admin/transport/bons/${bon.id}`)}
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title="Bon en PDF"
            onClick={downloadPdf}
            disabled={pdfBusy}
          >
            <FileDown size={16} />
          </button>
          {peutSupprimer && (
            <button
              type="button"
              className="row-action row-action-danger"
              title={vide ? 'Supprimer le bon' : 'Suppression possible uniquement si le bon est vide'}
              onClick={remove}
              disabled={busy || !vide}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Bons de transport — filtres et tableau des bons. */
export default function TransportBons() {
  const { user } = useAuth();
  const peutSupprimer = hasTypeAccess(user, [1, 2]);
  const [bons, setBons] = useState([]);
  const [trajets, setTrajets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [detail, setDetail] = useState(null);

  const pager = usePagination(bons, 'bon');

  useEffect(() => {
    api
      .get('/transport/bons/trajets')
      .then((res) => setTrajets(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/transport/bons', {
        params: { trajet: applied.trajet, debut: applied.range.from, fin: applied.range.to }
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
            <Bus size={18} /> Bons de transport
          </h2>
        </div>
        <p className="upload-hint">
          Un bon par trajet et par journée (de 06:00 à 06:00 le lendemain), créé automatiquement au
          premier envoi ou retour scanné dont la ville de destination appartient à une zone du trajet
          (Configuration › Trajets).
        </p>

        <div className="filters-bar">
          <SearchSelect
            label="Trajet"
            options={trajets.map((t) => ({ value: t.id, label: t.nom }))}
            value={draft.trajet}
            onChange={setDraftField('trajet')}
            allLabel="Tous"
          />
          <DateRangeSelect value={draft.range} onChange={setDraftField('range')} />
          <button
            type="button"
            className="btn-apply"
            onClick={() => {
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
                <th>Trajet</th>
                <th>Journée</th>
                <th>Nombre de colis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bons.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="datatable-empty">
                    Aucun bon de transport sur la période.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((bon) => (
                  <BonRow
                    key={bon.id}
                    bon={bon}
                    peutSupprimer={peutSupprimer}
                    onDetail={setDetail}
                    onDeleted={(id) => setBons((prev) => prev.filter((b) => b.id !== id))}
                  />
                ))
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
