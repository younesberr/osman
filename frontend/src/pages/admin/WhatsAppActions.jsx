import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import api from '../../api/client';
import { Pager, usePagination } from '../../components/Pagination';
import Toggle from '../../components/Toggle';
import WhatsAppRegleModal from './WhatsAppRegleModal';
import { statutLabel } from '../../utils/statuts';

/*
 * Page /admin/api-liaison/whatsapp/actions — actions automatiques WhatsApp
 * (delevery_whatsapp_regle) : une règle = événement métier (colis créé,
 * changement de statut, ramassage, facture…) → audience (destinataire, client
 * expéditeur, livreur, ramasseur, employés) → modèle approuvé + variables.
 * Table (envois des 30 derniers jours par règle), activation, modale de
 * création / modification avec test à blanc. ?modele=<id> filtre par modèle.
 */

export default function WhatsAppActions() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [catalogue, setCatalogue] = useState(null);
  const [modeles, setModeles] = useState([]);
  const [referentiels, setReferentiels] = useState(null);
  const [config, setConfig] = useState(null);
  const [parametres, setParametres] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [modal, setModal] = useState(null); // { regle | null }
  const [filtreEvenement, setFiltreEvenement] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [r, cat, m, ref, cfg, p] = await Promise.all([
        api.get('/whatsapp/regles'),
        api.get('/whatsapp/evenements'),
        api.get('/whatsapp/modeles'),
        api.get('/whatsapp/referentiels'),
        api.get('/whatsapp/configuration'),
        api.get('/whatsapp/parametres-crm')
      ]);
      setRows(r.data.rows || []);
      setCatalogue(cat.data);
      setModeles(m.data.rows || []);
      setReferentiels(ref.data);
      setConfig(cfg.data);
      setParametres(p.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur de chargement des règles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleActif(regle, actif) {
    setRows((list) => list.map((r) => (r.id === regle.id ? { ...r, actif } : r)));
    try {
      await api.patch(`/whatsapp/regles/${regle.id}/actif`, { actif });
    } catch (err) {
      setRows((list) => list.map((r) => (r.id === regle.id ? { ...r, actif: !actif } : r)));
      setFlash({ type: 'error', text: err.response?.data?.message || 'Modification impossible.' });
    }
  }

  async function supprimer(regle) {
    if (!window.confirm(`Supprimer la règle « ${regle.nom} » ?`)) return;
    try {
      await api.delete(`/whatsapp/regles/${regle.id}`);
      setRows((list) => list.filter((r) => r.id !== regle.id));
      setFlash({ type: 'success', text: 'Règle supprimée.' });
    } catch (err) {
      setFlash({ type: 'error', text: err.response?.data?.message || 'Suppression impossible.' });
    }
  }

  const modeleFiltre = useMemo(() => {
    const id = searchParams.get('modele');
    return id ? modeles.find((m) => String(m.id) === id) || null : null;
  }, [searchParams, modeles]);

  const filtres = useMemo(
    () =>
      rows.filter(
        (r) => (!filtreEvenement || r.evenement === filtreEvenement) && (!modeleFiltre || (r.modele === modeleFiltre.nom && r.langue === modeleFiltre.langue))
      ),
    [rows, filtreEvenement, modeleFiltre]
  );
  const pager = usePagination(filtres, 'règle');

  function libelleCondition(r) {
    const parts = [];
    if (r.conditions.codes.length) parts.push(r.conditions.codes.map((c) => statutLabel(c)).join(', '));
    if (r.conditions.clients.length) parts.push(`${r.conditions.clients.length} client(s)`);
    return parts.length ? parts.join(' · ') : '—';
  }

  return (
    <div className="platform-page wa-crm">
      <section className="platform-card">
        <div className="card-head-actions">
          <h2>
            <Zap size={18} /> Actions automatiques WhatsApp
          </h2>
          <button type="button" className="btn btn-primary" disabled={!catalogue || !referentiels} onClick={() => setModal({ regle: null })}>
            <Plus size={15} /> Nouvelle règle
          </button>
        </div>
        <p className="wa-intro">
          Chaque règle envoie un modèle approuvé à une audience quand un événement se produit (après l'enregistrement en base). Les
          envois passent par la file (Journal des messages), respectent l'opt-out des contacts, l'anti-doublon et les heures calmes.
        </p>
        {config && !config.actif && (
          <div className="form-notice">
            L'intégration WhatsApp est désactivée (Configuration › « Intégration activée ») : aucune règle ne s'exécute.
          </div>
        )}
        {parametres && !parametres.automatisationsActif && (
          <div className="form-notice">Les automatisations sont désactivées dans Configuration › Paramètres CRM.</div>
        )}
        {modeleFiltre && (
          <div className="form-notice">
            Règles utilisant le modèle <span className="mono">{modeleFiltre.nom}</span> ({modeleFiltre.langue}) —{' '}
            <Link to="/admin/api-liaison/whatsapp/actions">voir toutes les règles</Link>
          </div>
        )}
        {flash && <div className={flash.type === 'error' ? 'form-error' : 'form-success'}>{flash.text}</div>}
        {error && <div className="form-error">{error}</div>}

        <div className="datatable-toolbar">
          <select className="datatable-select" value={filtreEvenement} onChange={(e) => setFiltreEvenement(e.target.value)}>
            <option value="">Tous les événements</option>
            {(catalogue?.evenements || []).map((e) => (
              <option key={e.code} value={e.code}>
                {e.label}
              </option>
            ))}
          </select>
        </div>

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Règle</th>
                <th>Événement</th>
                <th className="wa-col-md">Condition</th>
                <th>Audience</th>
                <th className="wa-col-sm">Modèle</th>
                <th className="wa-col-md">Délai</th>
                <th className="wa-col-md">30 jours</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={9} className="datatable-empty">
                    {rows.length === 0 ? 'Aucune règle. Cliquez sur « Nouvelle règle ».' : 'Aucune règle ne correspond au filtre.'}
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="cell-main">{r.nom}</div>
                      <div className="cell-sub wa-col-sm-inline mono">{r.modele} · {r.langue}</div>
                    </td>
                    <td>
                      <div className="cell-main">{r.evenementLabel}</div>
                      <div className="cell-sub">{catalogue?.contextes?.[r.contexte] || r.contexte}</div>
                    </td>
                    <td className="wa-col-md wa-cell-wrap">{libelleCondition(r)}</td>
                    <td>
                      <span className={`wa-type-chip wa-type-${r.audience === 'expediteur' ? 'client' : r.audience === 'admin' ? 'employe' : r.audience === 'ramasseur' ? 'livreur' : r.audience}`}>
                        {r.audienceLabel}
                      </span>
                      {r.audience === 'admin' && <div className="cell-sub">{r.cibles.length} employé(s)</div>}
                    </td>
                    <td className="wa-col-sm mono">
                      {r.modele}
                      <div className="cell-sub">{r.langue}</div>
                    </td>
                    <td className="wa-col-md">
                      {r.delaiMinutes ? `${r.delaiMinutes} min` : 'immédiat'}
                      {r.dedupHeures ? <div className="cell-sub">anti-doublon {r.dedupHeures} h</div> : null}
                      {!r.heuresCalmes && <div className="cell-sub">ignore les heures calmes</div>}
                    </td>
                    <td className="wa-col-md">
                      {r.envoyes30j} envoyé(s)
                      {r.echecs30j ? <div className="cell-sub field-error">{r.echecs30j} échec(s)</div> : null}
                    </td>
                    <td>
                      <Toggle checked={r.actif} onChange={(v) => toggleActif(r, v)} label={`Règle ${r.nom} active`} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="row-action" title="Modifier / tester" onClick={() => setModal({ regle: r })}>
                          <Pencil size={16} />
                        </button>
                        <button type="button" className="row-action row-action-danger" title="Supprimer" onClick={() => supprimer(r)}>
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

      {modal && catalogue && referentiels && (
        <WhatsAppRegleModal
          regle={modal.regle}
          catalogue={catalogue}
          modeles={modeles}
          referentiels={referentiels}
          onClose={() => setModal(null)}
          onSaved={(regle) => {
            setRows((list) => (list.some((r) => r.id === regle.id) ? list.map((r) => (r.id === regle.id ? regle : r)) : [regle, ...list]));
            setFlash({ type: 'success', text: regle.message || 'Règle enregistrée.' });
          }}
        />
      )}
    </div>
  );
}
