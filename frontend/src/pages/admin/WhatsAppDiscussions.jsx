import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertOctagon, CheckCheck, ChevronLeft, ExternalLink, Info, Link2, MessageCircle, Plus, RotateCcw, Search } from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import { CopyBtn } from '../../components/ApiDocBlocks';
import { SuiviModal } from '../../components/ParcelModals';
import WhatsAppConversation from '../../components/WhatsAppConversation';
import WhatsAppComposer from '../../components/WhatsAppComposer';
import WhatsAppContactPanel from '../../components/WhatsAppContactPanel';
import WhatsAppEnvoiModeleModal from '../../components/WhatsAppEnvoiModeleModal';
import { STATUTS_CONVERSATION, TYPES_CONTACT, formatDuree, formatHeureCourte, rafraichirCompteurs, waMeLink } from '../../utils/whatsapp';

/*
 * Page /admin/api-liaison/whatsapp/discussions — boîte de réception WhatsApp
 * (CRM) : liste des discussions où le contact a répondu au moins une fois
 * (les envois sans réponse ne sont pas listés ; filtres statut / affectation /
 * type de contact / non lus / recherche), fil de la discussion ouverte (texte, image,
 * message vocal, modèle, note interne), volet contact (client, livreur, colis récents),
 * affectation à un employé, statut, colis lié, opt-out. Rafraîchissement
 * toutes les 10 s (liste + nouveaux messages / statuts), en pause quand
 * l'onglet est masqué. API : /api/whatsapp/conversations*.
 */

const POLL_MS = 10000;
const PAGE = 30;

function WaListItem({ c, active, onClick }) {
  const statut = STATUTS_CONVERSATION[c.statut] || { label: c.statut, cls: 'badge-neutral' };
  return (
    <button type="button" className={`chat-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="chat-item-top">
        <span className="chat-item-title">{c.nom || c.phoneAffiche || c.phone}</span>
        <span className={`wa-type-chip wa-type-${c.typeContact}`}>{TYPES_CONTACT[c.typeContact] || 'Inconnu'}</span>
        {c.nonLus > 0 ? <span className="chat-unread-count">{c.nonLus}</span> : <span className={`badge ${statut.cls}`}>{statut.label}</span>}
      </div>
      {(c.magasin || c.dernierColisCode) && (
        <div className="chat-item-subject">
          {c.magasin || ''}
          {c.magasin && c.dernierColisCode ? ' · ' : ''}
          {c.dernierColisCode && <span className="mono">{c.dernierColisCode}</span>}
        </div>
      )}
      <div className="chat-item-bottom">
        <span className={`wa-dot ${c.fenetreOuverte ? 'wa-dot-open' : 'wa-dot-closed'}`} title={c.fenetreOuverte ? 'Fenêtre de 24 h ouverte' : 'Fenêtre de 24 h fermée'} />
        <span className="chat-item-preview">
          {c.derniereDirection === 'sortant' ? 'Vous : ' : ''}
          {c.dernierTexte || '—'}
        </span>
        {c.optOut && <AlertOctagon size={13} className="wa-optout-ico" title="Contact désinscrit" />}
        <span className="chat-item-date">{formatHeureCourte(c.dernierLe)}</span>
      </div>
      {c.affecteNom && <div className="chat-item-assigned">Affectée à : {c.affecteNom}</div>}
    </button>
  );
}

export default function WhatsAppDiscussions() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [statut, setStatut] = useState('ouvertes');
  const [affectation, setAffectation] = useState('');
  const [affecteUser, setAffecteUser] = useState('');
  const [type, setType] = useState('');
  const [nonLus, setNonLus] = useState(false);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(1);
  const [referentiels, setReferentiels] = useState({ utilisateurs: [] });
  const [reponsesRapides, setReponsesRapides] = useState([]);
  const [activeId, setActiveId] = useState(() => Number(searchParams.get('conversation')) || null);
  const [thread, setThread] = useState(null); // { conversation, contact, messages }
  const [contactOpen, setContactOpen] = useState(false);
  const [lierOpen, setLierOpen] = useState(false);
  const [lierRecherche, setLierRecherche] = useState('');
  const [lierResultats, setLierResultats] = useState([]);
  const [modal, setModal] = useState(null); // { type: 'nouvelle' | 'modele' | 'suivi', parcel? }
  const [tick, setTick] = useState(0);
  const [actionError, setActionError] = useState('');

  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  const filtersRef = useRef({});
  filtersRef.current = { statut, affectation: affectation === 'utilisateur' ? affecteUser : affectation, type, nonLus, q, pages };
  const lastIdRef = useRef(0);
  const lastPollRef = useRef(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 400);
    return () => clearTimeout(t);
  }, [qInput]);

  const loadList = useCallback(() => {
    const f = filtersRef.current;
    const params = { page: 1, pageSize: Math.min(PAGE * f.pages, 200) };
    if (f.statut) params.statut = f.statut;
    if (f.affectation) params.affectation = f.affectation;
    if (f.type) params.type = f.type;
    if (f.nonLus) params.nonLus = 1;
    if (f.q) params.q = f.q;
    return api
      .get('/whatsapp/conversations', { params })
      .then((res) => {
        setRows(res.data.rows || []);
        setTotal(res.data.total || 0);
        setLoadError('');
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des discussions.'));
  }, []);

  const loadThread = useCallback((id) => {
    return api
      .get(`/whatsapp/conversations/${id}`)
      .then((res) => {
        if (activeIdRef.current !== id) return;
        setThread(res.data);
        const msgs = res.data.messages || [];
        lastIdRef.current = msgs.length ? msgs[msgs.length - 1].id : 0;
        lastPollRef.current = new Date().toISOString();
      })
      .catch((err) => setActionError(err.response?.data?.message || 'Discussion introuvable.'));
  }, []);

  const pollThread = useCallback((id) => {
    return api
      .get(`/whatsapp/conversations/${id}/messages`, { params: { after: lastIdRef.current, depuis: lastPollRef.current } })
      .then((res) => {
        if (activeIdRef.current !== id) return;
        lastPollRef.current = new Date().toISOString();
        const nouveaux = res.data.nouveaux || [];
        const statuts = res.data.statuts || [];
        setThread((t) => {
          if (!t) return t;
          const ids = new Set(t.messages.map((m) => m.id));
          const ajout = nouveaux.filter((m) => !ids.has(m.id));
          if (ajout.length) lastIdRef.current = ajout[ajout.length - 1].id;
          const patch = new Map(statuts.map((s) => [s.id, s]));
          const messages = t.messages.map((m) => (patch.has(m.id) ? { ...m, ...patch.get(m.id) } : m)).concat(ajout);
          return { ...t, conversation: res.data.conversation || t.conversation, messages };
        });
        if (nouveaux.some((m) => m.direction === 'entrant')) rafraichirCompteurs();
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      loadList(),
      api.get('/whatsapp/referentiels').then((r) => setReferentiels(r.data)).catch(() => {}),
      api.get('/whatsapp/reponses-rapides').then((r) => setReponsesRapides(r.data.rows || [])).catch(() => {})
    ]).finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    loadList();
  }, [statut, affectation, affecteUser, type, nonLus, q, pages, loadList]);

  // Ouverture d'une discussion : fil complet, non lus remis à zéro (liste + badge).
  useEffect(() => {
    if (!activeId) {
      setThread(null);
      return;
    }
    setThread(null);
    setLierOpen(false);
    setActionError('');
    loadThread(activeId).then(() => {
      setRows((list) => list.map((c) => (c.id === activeId ? { ...c, nonLus: 0 } : c)));
      rafraichirCompteurs();
    });
  }, [activeId, loadThread]);

  // Rafraîchissement périodique (liste + discussion ouverte), en pause si l'onglet est masqué.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      loadList();
      const id = activeIdRef.current;
      if (id) {
        pollCountRef.current += 1;
        if (pollCountRef.current % 6 === 0) loadThread(id);
        else pollThread(id);
      }
      setTick((n) => n + 1);
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        loadList();
        if (activeIdRef.current) loadThread(activeIdRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadList, loadThread, pollThread]);

  const conv = thread?.conversation || rows.find((c) => c.id === activeId) || null;

  // Décompte de la fenêtre de 24 h entre deux rafraîchissements.
  const fenetreLabel = useMemo(() => {
    if (!conv) return '';
    if (!conv.fenetreOuverte) return 'Fenêtre fermée : modèle requis';
    const restant = Math.max(0, (conv.fenetreRestantSecondes || 0) - (tick % 6) * (POLL_MS / 1000));
    return `Fenêtre ouverte · expire dans ${formatDuree(restant)}`;
  }, [conv, tick]);

  function ajouterMessage(message) {
    setThread((t) => (t && !t.messages.some((m) => m.id === message.id) ? { ...t, messages: [...t.messages, message] } : t));
    if (message?.id) lastIdRef.current = Math.max(lastIdRef.current, message.id);
    loadList();
  }

  /** Texte seul, image (+ légende) ou message vocal (champ `audio`, sans texte). */
  async function envoyerTexte({ text, file, type }) {
    let res;
    if (file) {
      const form = new FormData();
      if (type === 'audio') form.append('audio', file);
      else {
        form.append('image', file);
        if (text) form.append('legende', text);
      }
      res = await api.post(`/whatsapp/conversations/${activeId}/messages`, form);
    } else {
      res = await api.post(`/whatsapp/conversations/${activeId}/messages`, { texte: text });
    }
    ajouterMessage(res.data);
    loadThread(activeId);
  }

  async function envoyerNote(texte) {
    const res = await api.post(`/whatsapp/conversations/${activeId}/notes`, { texte });
    ajouterMessage(res.data);
  }

  async function patchConversation(patch) {
    setActionError('');
    try {
      const res = await api.patch(`/whatsapp/conversations/${activeId}`, patch);
      setThread((t) => (t ? { ...t, conversation: res.data } : t));
      loadList();
      if (patch.dernierColis !== undefined || patch.optOut !== undefined) loadThread(activeId);
    } catch (err) {
      setActionError(err.response?.data?.message || 'Modification impossible.');
    }
  }

  async function chercherColisALier(e) {
    e?.preventDefault();
    const s = lierRecherche.trim();
    if (s.length < 3) return;
    try {
      const res = await api.get('/whatsapp/colis/recherche', { params: { q: s } });
      setLierResultats(res.data.rows || []);
    } catch (err) {
      setActionError(err.response?.data?.message || 'Recherche impossible.');
    }
  }

  const utilisateursOptions = useMemo(
    () => [{ value: '', label: 'Non affectée' }, ...referentiels.utilisateurs.map((u) => ({ value: String(u.id), label: u.label }))],
    [referentiels.utilisateurs]
  );

  return (
    <div className="platform-page chat-page wa-crm wa-inbox-page">
      <section className="platform-card chat-card">
        <div className="card-head-actions">
          <h2>
            <MessageCircle size={18} /> Discussions WhatsApp
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ type: 'nouvelle' })}>
            <Plus size={15} /> Nouvelle discussion
          </button>
        </div>

        <div className="datatable-toolbar chat-filters wa-filters">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input type="text" value={qInput} placeholder="Nom, numéro, code colis…" onChange={(e) => setQInput(e.target.value)} />
          </div>
          <select className="datatable-select" value={statut} onChange={(e) => setStatut(e.target.value)}>
            <option value="ouvertes">Ouvertes (nouvelles + en cours)</option>
            <option value="nouveau">Nouvelles</option>
            <option value="en_cours">En cours</option>
            <option value="termine">Terminées</option>
            <option value="">Toutes</option>
          </select>
          <select className="datatable-select" value={affectation} onChange={(e) => setAffectation(e.target.value)}>
            <option value="">Toutes les affectations</option>
            <option value="moi">Mes discussions</option>
            <option value="aucune">Non affectées</option>
            <option value="utilisateur">Un utilisateur…</option>
          </select>
          {affectation === 'utilisateur' && (
            <SearchableSelect
              className="ss-toolbar"
              value={affecteUser}
              onChange={setAffecteUser}
              placeholder="Choisir un utilisateur"
              options={referentiels.utilisateurs.map((u) => ({ value: String(u.id), label: u.label }))}
            />
          )}
          <select className="datatable-select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Tous les contacts</option>
            {Object.entries(TYPES_CONTACT).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <label className={`radio-pill ${nonLus ? 'radio-pill-checked' : ''}`}>
            <input type="checkbox" checked={nonLus} onChange={(e) => setNonLus(e.target.checked)} /> Non lus
          </label>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`chat-layout wa-inbox ${activeId ? 'is-conv-open has-conv' : ''} ${contactOpen ? 'is-contact-open' : ''}`}>
          <aside className="chat-list">
            <div className="chat-list-items">
              {loading ? (
                <div className="chat-list-empty">Chargement…</div>
              ) : rows.length === 0 ? (
                <div className="chat-list-empty">Aucune discussion trouvée.</div>
              ) : (
                <>
                  {rows.map((c) => (
                    <WaListItem key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />
                  ))}
                  {rows.length < total && (
                    <button type="button" className="btn btn-ghost btn-sm wa-charger-plus" onClick={() => setPages((p) => p + 1)}>
                      Charger plus ({rows.length} / {total})
                    </button>
                  )}
                </>
              )}
            </div>
          </aside>

          <div className="chat-panel">
            {activeId && conv ? (
              <>
                <div className="chat-panel-header wa-head">
                  <button type="button" className="chat-back" onClick={() => setActiveId(null)}>
                    <ChevronLeft size={18} />
                  </button>
                  <div className="chat-panel-headings">
                    <div className="chat-panel-title">
                      {conv.nom || conv.phoneAffiche}
                      <span className={`wa-type-chip wa-type-${conv.typeContact}`}>{TYPES_CONTACT[conv.typeContact] || 'Inconnu'}</span>
                    </div>
                    <div className="chat-panel-sub wa-head-sub">
                      <span className="mono">{conv.phoneAffiche || conv.phone}</span>
                      <CopyBtn text={conv.phone} title="Copier le numéro" />
                      <a href={waMeLink(conv.phone)} target="_blank" rel="noreferrer" title="Ouvrir dans WhatsApp" className="row-action">
                        <ExternalLink size={14} />
                      </a>
                      {conv.dernierColisCode && <span className="mono wa-head-colis">Colis {conv.dernierColisCode}</span>}
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm wa-btn-infos" onClick={() => setContactOpen((v) => !v)} title="Informations du contact">
                    <Info size={15} /> Infos
                  </button>
                </div>
                <div className="wa-head-actions">
                  <span className={`badge ${conv.fenetreOuverte ? 'wa-window-open' : 'wa-window-closed'}`}>{fenetreLabel}</span>
                  {conv.optOut && <span className="badge badge-inactive">Désinscrit</span>}
                  <SearchableSelect
                    className="ss-toolbar wa-affectation"
                    value={conv.affecteA ? String(conv.affecteA) : ''}
                    onChange={(v) => patchConversation({ affecteA: v ? Number(v) : null })}
                    options={utilisateursOptions}
                    placeholder="Affecter à…"
                  />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLierOpen((v) => !v)}>
                    <Link2 size={14} /> {conv.dernierColisCode ? 'Changer le colis' : 'Lier à un colis'}
                  </button>
                  {conv.statut === 'termine' ? (
                    <button type="button" className="btn btn-ghost btn-sm chat-statut-btn" onClick={() => patchConversation({ statut: 'en_cours' })}>
                      <RotateCcw size={14} /> Rouvrir
                    </button>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm chat-statut-btn" onClick={() => patchConversation({ statut: 'termine' })}>
                      <CheckCheck size={14} /> Terminer
                    </button>
                  )}
                </div>
                {lierOpen && (
                  <div className="wa-lier">
                    {thread?.contact?.colis?.length > 0 && (
                      <SearchableSelect
                        value={conv.dernierColisId ? String(conv.dernierColisId) : ''}
                        onChange={(v) => {
                          patchConversation({ dernierColis: Number(v) });
                          setLierOpen(false);
                        }}
                        options={thread.contact.colis.map((p) => ({ value: String(p.id), label: `${p.code} — ${p.destinataire || '—'} (${p.statutLabel || p.statut})` }))}
                        placeholder="Colis récents de ce numéro"
                      />
                    )}
                    <form className="wa-lier-recherche" onSubmit={chercherColisALier}>
                      <input type="text" value={lierRecherche} placeholder="Ou rechercher un code colis…" onChange={(e) => setLierRecherche(e.target.value)} />
                      <button type="submit" className="btn btn-ghost btn-sm">
                        <Search size={14} />
                      </button>
                    </form>
                    {lierResultats.length > 0 && (
                      <SearchableSelect
                        value=""
                        onChange={(v) => {
                          patchConversation({ dernierColis: Number(v) });
                          setLierOpen(false);
                          setLierResultats([]);
                        }}
                        options={lierResultats.map((p) => ({ value: String(p.id), label: `${p.code} — ${p.destinataire || '—'} (${p.statutLabel || p.statut})` }))}
                        placeholder="Résultats de la recherche"
                      />
                    )}
                  </div>
                )}
                {actionError && <div className="form-error chat-send-error">{actionError}</div>}
                <WhatsAppConversation
                  conversation={conv}
                  messages={thread?.messages || []}
                  emptyText={thread ? 'Aucun message.' : 'Chargement…'}
                >
                  <WhatsAppComposer
                    conversation={conv}
                    reponsesRapides={reponsesRapides}
                    onSendText={envoyerTexte}
                    onSendNote={envoyerNote}
                    onOuvrirModele={() => setModal({ type: 'modele' })}
                  />
                </WhatsAppConversation>
              </>
            ) : (
              <div className="chat-placeholder">
                <MessageCircle size={40} />
                <p>Sélectionnez une discussion, ou démarrez-en une avec « Nouvelle discussion ».</p>
              </div>
            )}
          </div>

          {activeId && conv && (
            <WhatsAppContactPanel
              conversation={conv}
              contact={thread?.contact}
              onPatch={patchConversation}
              onSuivi={(parcel) => setModal({ type: 'suivi', parcel })}
              onClose={() => setContactOpen(false)}
            />
          )}
        </div>
      </section>

      {modal?.type === 'nouvelle' && (
        <WhatsAppEnvoiModeleModal
          mode="nouvelle"
          onClose={() => setModal(null)}
          onSent={(r) => {
            loadList();
            if (r?.conversation?.id) setActiveId(r.conversation.id);
          }}
        />
      )}
      {modal?.type === 'modele' && conv && (
        <WhatsAppEnvoiModeleModal
          mode="conversation"
          conversation={conv}
          onClose={() => setModal(null)}
          onSent={(message) => {
            ajouterMessage(message);
            loadThread(activeId);
          }}
        />
      )}
      {modal?.type === 'suivi' && <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />}
    </div>
  );
}
