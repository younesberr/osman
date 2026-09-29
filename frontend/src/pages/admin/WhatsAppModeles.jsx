import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, FileText, RefreshCw, Save, X } from 'lucide-react';
import api from '../../api/client';
import { Pager, usePagination } from '../../components/Pagination';
import Toggle from '../../components/Toggle';
import WhatsAppModelePreview from '../../components/WhatsAppModelePreview';
import { CATEGORIES, QUALITE, STATUTS_META, formatDateHeure } from '../../utils/whatsapp';

/*
 * Page /admin/api-liaison/whatsapp/modeles — modèles de message WhatsApp
 * (message templates Meta). Les modèles se créent dans WhatsApp Manager ; la
 * page les synchronise (POST /whatsapp/modeles/synchroniser), affiche leur
 * statut d'approbation / qualité, et permet de régler localement : actif
 * (proposé dans les listes), description, correspondance par défaut des
 * variables pour l'envoi manuel depuis un colis.
 */

function badgeStatut(m) {
  const s = STATUTS_META[m.statut] || { label: m.statut, cls: 'badge-neutral' };
  return <span className={`badge ${s.cls}`} title={m.motifRejet || m.nonSupporte || ''}>{s.label}</span>;
}

/** Modale de détail : aperçu, informations, réglages locaux. */
function ModeleDetailModal({ modele, variables, onClose, onSaved }) {
  const [mapping, setMapping] = useState(() =>
    Array.from({ length: modele.nbVariables }, (_, i) => modele.mappingDefaut[i] || { type: 'variable', code: '' })
  );
  const [description, setDescription] = useState(modele.description || '');
  const [actif, setActif] = useState(modele.actif);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const exemplesApercu = mapping.map((m, i) => {
    if (m.type === 'fixe') return m.texte || '';
    const v = variables.find((x) => x.code === m.code);
    return v ? v.exemple : modele.exemples?.[i] || '';
  });

  function setMap(i, patch) {
    setFeedback(null);
    setMapping((list) => list.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.put(`/whatsapp/modeles/${modele.id}`, {
        actif,
        description,
        mappingDefaut: mapping.map((m) => (m.type === 'fixe' ? { type: 'fixe', texte: m.texte || '' } : { type: 'variable', code: m.code || '' }))
      });
      onSaved(res.data);
      setFeedback({ type: 'success', text: 'Modèle enregistré.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide wa-crm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <FileText size={20} />
            <div>
              <div className="cell-main mono">{modele.nom}</div>
              <div className="cell-sub">
                {modele.langue} · {CATEGORIES[modele.categorie] || modele.categorie} · {badgeStatut(modele)}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="wa-modele-detail">
          <div>
            <WhatsAppModelePreview modele={modele} params={exemplesApercu} />
            <dl className="wa-meta">
              <dt>Qualité</dt>
              <dd>{modele.qualite ? (QUALITE[modele.qualite]?.[0] || modele.qualite) : '—'}</dd>
              <dt>Variables</dt>
              <dd>{modele.nbVariables}</dd>
              <dt>Boutons</dt>
              <dd>{modele.boutons.length ? modele.boutons.map((b) => b.texte).join(', ') : '—'}</dd>
              <dt>Identifiant Meta</dt>
              <dd className="mono">{modele.metaId || '—'}</dd>
              <dt>Synchronisé le</dt>
              <dd>{formatDateHeure(modele.syncLe) || '—'}</dd>
              <dt>Utilisé par</dt>
              <dd>
                {modele.nbRegles ? (
                  <Link to={`/admin/api-liaison/whatsapp/actions?modele=${modele.id}`}>{modele.nbRegles} règle(s)</Link>
                ) : (
                  'aucune règle'
                )}
              </dd>
            </dl>
            {modele.motifRejet && <div className="form-error">Motif Meta : {modele.motifRejet}</div>}
            {modele.nonSupporte && (
              <div className="form-notice">Non utilisable par ORTALOG : {modele.nonSupporte}.</div>
            )}
          </div>

          <div>
            <h3 className="wa-h3">Réglages ORTALOG</h3>
            <label className="wa-field">
              <span className="field-label">Description (usage interne)</span>
              <input
                type="text"
                value={description}
                maxLength={255}
                placeholder="Ex. : envoyé au destinataire quand le colis part en distribution"
                onChange={(e) => {
                  setFeedback(null);
                  setDescription(e.target.value);
                }}
              />
            </label>
            <div className="wa-switch-row">
              <Toggle checked={actif} onChange={(v) => { setFeedback(null); setActif(v); }} label="Modèle actif" />
              <span>Proposé dans les listes (règles, discussions, fiche colis)</span>
            </div>

            <h3 className="wa-h3">Variables par défaut (envoi manuel depuis un colis)</h3>
            {modele.nbVariables === 0 ? (
              <span className="cell-sub">Ce modèle n'a pas de variable.</span>
            ) : (
              <div className="wa-mapping">
                {mapping.map((m, i) => (
                  <div key={i} className="wa-mapping-row">
                    <span className="mono">{`{{${i + 1}}}`}</span>
                    <select
                      className="modal-select"
                      value={m.type === 'fixe' ? '__fixe' : m.code || ''}
                      onChange={(e) =>
                        e.target.value === '__fixe' ? setMap(i, { type: 'fixe', texte: m.texte || '' }) : setMap(i, { type: 'variable', code: e.target.value })
                      }
                    >
                      <option value="">— À saisir à l'envoi —</option>
                      {variables.map((v) => (
                        <option key={v.code} value={v.code}>
                          {v.label} (ex. {v.exemple})
                        </option>
                      ))}
                      <option value="__fixe">Texte fixe…</option>
                    </select>
                    {m.type === 'fixe' && (
                      <input type="text" value={m.texte || ''} placeholder="Texte fixe" onChange={(e) => setMap(i, { texte: e.target.value })} />
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              {feedback && <span className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</span>}
              <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
                <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WhatsAppModeles() {
  const [rows, setRows] = useState([]);
  const [variables, setVariables] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [statut, setStatut] = useState('');
  const [categorie, setCategorie] = useState('');
  const [langue, setLangue] = useState('');
  const [recherche, setRecherche] = useState('');
  const [ouvert, setOuvert] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [m, cat, cfg] = await Promise.all([
        api.get('/whatsapp/modeles'),
        api.get('/whatsapp/evenements'),
        api.get('/whatsapp/configuration')
      ]);
      setRows(m.data.rows || []);
      setVariables((cat.data.variables || []).filter((v) => v.contextes.includes('*') || v.contextes.includes('COLIS')));
      setConfig(cfg.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur de chargement des modèles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function synchroniser() {
    setSyncing(true);
    setFlash(null);
    setError('');
    try {
      const res = await api.post('/whatsapp/modeles/synchroniser');
      setRows(res.data.rows || []);
      setFlash({ type: 'success', text: res.data.message });
    } catch (err) {
      setFlash({ type: 'error', text: err.response?.data?.message || 'Synchronisation impossible.' });
    } finally {
      setSyncing(false);
    }
  }

  async function toggleActif(m, actif) {
    setRows((list) => list.map((r) => (r.id === m.id ? { ...r, actif } : r)));
    try {
      await api.put(`/whatsapp/modeles/${m.id}`, { actif });
    } catch (err) {
      setRows((list) => list.map((r) => (r.id === m.id ? { ...r, actif: !actif } : r)));
      setFlash({ type: 'error', text: err.response?.data?.message || 'Modification impossible.' });
    }
  }

  const langues = useMemo(() => [...new Set(rows.map((r) => r.langue))].sort(), [rows]);
  const filtres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!statut || r.statut === statut) &&
        (!categorie || r.categorie === categorie) &&
        (!langue || r.langue === langue) &&
        (!q || r.nom.toLowerCase().includes(q) || (r.corps || '').toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    );
  }, [rows, statut, categorie, langue, recherche]);
  const pager = usePagination(filtres, 'modèle');
  const modeleOuvert = rows.find((r) => r.id === ouvert) || null;

  return (
    <div className="platform-page wa-crm">
      <section className="platform-card">
        <div className="card-head-actions">
          <h2>
            <FileText size={18} /> Modèles de message WhatsApp
          </h2>
          <button type="button" className="btn btn-primary" disabled={syncing || loading} onClick={synchroniser}>
            <RefreshCw size={15} className={syncing ? 'wa-spin' : ''} /> {syncing ? 'Synchronisation…' : 'Synchroniser depuis Meta'}
          </button>
        </div>
        <p className="wa-intro">
          Les modèles se créent et se soumettent à l'approbation dans <strong>WhatsApp Manager</strong> (Outils du compte ›
          Modèles de message). Cette page en garde une copie synchronisée : seuls les modèles <em>approuvés</em> et{' '}
          <em>actifs</em> sont proposés dans les actions automatiques, les discussions et la fiche colis.
        </p>
        {config && !config.wabaId && (
          <div className="form-notice">
            Renseignez le WhatsApp Business Account ID (WABA ID) dans API liaison › Configuration pour synchroniser les modèles.
          </div>
        )}
        {flash && <div className={flash.type === 'error' ? 'form-error' : 'form-success'}>{flash.text}</div>}
        {error && <div className="form-error">{error}</div>}

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <input type="text" value={recherche} placeholder="Rechercher un modèle…" onChange={(e) => setRecherche(e.target.value)} />
          </div>
          <select className="datatable-select" value={statut} onChange={(e) => setStatut(e.target.value)}>
            <option value="">Tous les statuts</option>
            {Object.entries(STATUTS_META).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </select>
          <select className="datatable-select" value={categorie} onChange={(e) => setCategorie(e.target.value)}>
            <option value="">Toutes les catégories</option>
            {Object.entries(CATEGORIES).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select className="datatable-select" value={langue} onChange={(e) => setLangue(e.target.value)}>
            <option value="">Toutes les langues</option>
            {langues.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Nom</th>
                <th className="wa-col-sm">Langue</th>
                <th className="wa-col-sm">Catégorie</th>
                <th>Statut Meta</th>
                <th className="wa-col-md">Qualité</th>
                <th className="wa-col-md">Variables</th>
                <th className="wa-col-md">Boutons</th>
                <th className="wa-col-md">Règles</th>
                <th>Actif</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={10} className="datatable-empty">
                    {rows.length === 0
                      ? 'Aucun modèle synchronisé. Cliquez sur « Synchroniser depuis Meta ».'
                      : 'Aucun modèle ne correspond aux filtres.'}
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((m) => (
                  <tr key={m.id} className="wa-row-click" onClick={() => setOuvert(m.id)}>
                    <td>
                      <div className="cell-main mono">{m.nom}</div>
                      <div className="cell-sub wa-cell-ellipsis">{m.description || m.corps}</div>
                    </td>
                    <td className="wa-col-sm">{m.langue}</td>
                    <td className="wa-col-sm">{CATEGORIES[m.categorie] || m.categorie}</td>
                    <td>
                      {badgeStatut(m)}
                      {m.nonSupporte && <div className="cell-sub">non pris en charge</div>}
                    </td>
                    <td className="wa-col-md">{m.qualite ? (QUALITE[m.qualite]?.[0] || m.qualite) : '—'}</td>
                    <td className="wa-col-md">{m.nbVariables}</td>
                    <td className="wa-col-md" title={m.boutons.map((b) => b.texte).join(', ')}>{m.boutons.length || '—'}</td>
                    <td className="wa-col-md">
                      {m.nbRegles ? (
                        <Link to={`/admin/api-liaison/whatsapp/actions?modele=${m.id}`} onClick={(e) => e.stopPropagation()}>
                          {m.nbRegles}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Toggle checked={m.actif} onChange={(v) => toggleActif(m, v)} label={`Modèle ${m.nom} actif`} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="row-action" title="Détail" onClick={(e) => { e.stopPropagation(); setOuvert(m.id); }}>
                          <Eye size={16} />
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

      {modeleOuvert && (
        <ModeleDetailModal
          modele={modeleOuvert}
          variables={variables}
          onClose={() => setOuvert(null)}
          onSaved={(m) => setRows((list) => list.map((r) => (r.id === m.id ? m : r)))}
        />
      )}
    </div>
  );
}
