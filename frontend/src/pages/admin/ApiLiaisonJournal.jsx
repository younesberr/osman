import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Ban, History, Lock, RefreshCw, RotateCw } from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { hasAccess } from '../../config/adminMenu';
import { Pager, usePagination } from '../../components/Pagination';
import { Code } from '../../components/ApiDocBlocks';
import { DIRECTIONS, STATUTS, formatDateHeure, formatPhoneInternational } from '../../utils/whatsapp';

/*
 * Onglet « Journal des messages » de la page API liaison › Configuration :
 * table delevery_whatsapp_message (GET /api/whatsapp/journal, 500 lignes max,
 * pagination côté client). Clic sur une ligne → détail (payload JSON échangé
 * avec Meta, erreur complète). File d'envoi du CRM : un envoi « Planifié » peut
 * être annulé, un « Échec » renvoyé (POST /whatsapp/file/:id/annuler|renvoyer).
 */

export default function ApiLiaisonJournal() {
  const { user } = useAuth();
  // Lien « Ouvrir la discussion » : page Discussions = service WHATSAPP_DISCUSSIONS à part.
  const peutDiscussions = hasAccess(user, 'WHATSAPP_DISCUSSIONS');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [direction, setDirection] = useState('');
  const [statut, setStatut] = useState('');
  const [ouvert, setOuvert] = useState(null);
  const [details, setDetails] = useState({});
  const [flash, setFlash] = useState('');

  const pager = usePagination(rows, 'message');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: 500 };
      if (direction) params.direction = direction;
      if (statut) params.statut = statut;
      const res = await api.get('/whatsapp/journal', { params });
      setRows(res.data.rows || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur de chargement du journal.');
    } finally {
      setLoading(false);
    }
  }, [direction, statut]);

  useEffect(() => {
    load();
  }, [load]);

  /** Annuler un envoi planifié / renvoyer un envoi en échec (file du CRM). */
  async function actionFile(e, id, action) {
    e.stopPropagation();
    setFlash('');
    try {
      const res = await api.post(`/whatsapp/file/${id}/${action}`);
      setFlash(res.data.message || 'OK');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Action impossible.');
    }
  }

  async function toggle(id) {
    if (ouvert === id) {
      setOuvert(null);
      return;
    }
    setOuvert(id);
    if (details[id]) return;
    try {
      const res = await api.get(`/whatsapp/journal/${id}`);
      setDetails((d) => ({ ...d, [id]: res.data }));
    } catch (err) {
      setDetails((d) => ({ ...d, [id]: { erreur: err.response?.data?.message || 'Détail indisponible.' } }));
    }
  }

  return (
    <section className="platform-card wa-journal-card">
      <h2>
        <History size={18} /> Journal des messages
      </h2>

      <div className="wa-journal-filters">
        <select className="datatable-select" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="">Tous les sens</option>
          {Object.entries(DIRECTIONS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select className="datatable-select" value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="">Tous les statuts</option>
          {Object.entries(STATUTS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Actualiser
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}
      {flash && <div className="form-success">{flash}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Sens</th>
              <th>Numéro</th>
              <th>Type / modèle</th>
              <th>Contenu</th>
              <th>Statut</th>
              <th>Erreur</th>
              <th>Par / origine</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} className="datatable-empty">
                  Aucun message pour l'instant. Envoyez un message de test depuis l'onglet Configuration.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => {
                const st = STATUTS[r.statut] || { label: r.statut, cls: 'badge-neutral' };
                const detail = details[r.id];
                return (
                  <Fragment key={r.id}>
                  <tr className="wa-row-click" onClick={() => toggle(r.id)} title="Voir le détail">
                    <td>
                      {formatDateHeure(r.createdAt)}
                      {r.updatedAt && r.updatedAt !== r.createdAt && (
                        <div className="cell-sub">màj {formatDateHeure(r.updatedAt)}</div>
                      )}
                    </td>
                    <td>
                      {r.direction === 'entrant' ? (
                        <span className="wa-sens">
                          <ArrowDownLeft size={14} /> Entrant
                        </span>
                      ) : r.direction === 'note' ? (
                        <span className="wa-sens">
                          <Lock size={14} /> Note
                        </span>
                      ) : (
                        <span className="wa-sens">
                          <ArrowUpRight size={14} /> Sortant
                        </span>
                      )}
                    </td>
                    <td className="mono">{formatPhoneInternational(r.phone)}</td>
                    <td>
                      {r.type}
                      {r.template && <div className="cell-sub">{r.template}</div>}
                    </td>
                    <td className="wa-cell-wrap">{r.contenu || '—'}</td>
                    <td>
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="wa-cell-wrap">
                      {r.erreurMessage ? (
                        <>
                          {r.erreurCode && <span className="mono">{r.erreurCode} · </span>}
                          {r.erreurMessage}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {r.createdBy ? r.createdByNom || `#${r.createdBy}` : r.regleNom ? 'Automatique' : 'Système'}
                      {r.regleNom && <div className="cell-sub">règle « {r.regleNom} »</div>}
                      {r.conversationId && peutDiscussions && (
                        <div className="cell-sub">
                          <Link to={`/admin/api-liaison/whatsapp/discussions?conversation=${r.conversationId}`} onClick={(e) => e.stopPropagation()}>
                            Ouvrir la discussion
                          </Link>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row-actions wa-journal-actions">
                        {r.statut === 'planifie' && (
                          <button type="button" className="row-action row-action-danger" title="Annuler l'envoi planifié" onClick={(e) => actionFile(e, r.id, 'annuler')}>
                            <Ban size={16} />
                          </button>
                        )}
                        {r.statut === 'echec' && r.direction === 'sortant' && (
                          <button type="button" className="row-action" title="Renvoyer" onClick={(e) => actionFile(e, r.id, 'renvoyer')}>
                            <RotateCw size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {ouvert === r.id && (
                    <tr className="wa-journal-detail">
                      <td colSpan={9}>
                        {!detail && <div className="modal-loading">Chargement…</div>}
                        {detail?.erreur && <div className="field-error">{detail.erreur}</div>}
                        {detail && !detail.erreur && (
                          <>
                            <div className="wa-detail-meta">
                              {r.wamid && (
                                <span>
                                  Identifiant Meta : <span className="mono">{r.wamid}</span>
                                </span>
                              )}
                              {r.parcelId && <span>Colis lié : #{r.parcelId}</span>}
                              {r.planifieLe && <span>Planifié le : {formatDateHeure(r.planifieLe)}</span>}
                              {r.tentatives > 0 && <span>Essais : {r.tentatives}</span>}
                            </div>
                            <Code label={r.direction === 'entrant' ? 'Message reçu (JSON Meta)' : 'Requête envoyée à Meta (JSON)'}>
                              {JSON.stringify(detail.payload, null, 2) || '—'}
                            </Code>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}
