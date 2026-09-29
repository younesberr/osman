import { useCallback, useEffect, useRef, useState } from 'react';
import { MessagesSquare, ChevronLeft, CheckCheck, RotateCcw } from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import ChatConversation, { formatMessageDate } from '../../components/ChatConversation';

/*
 * Messages > Clients (dashboard admin) — même boîte à lettres que côté client,
 * mais avec les discussions de TOUS les clients. Filtres en haut : Lu / Non lu,
 * En cours / Terminé, magasin, utilisateur affecté. Les discussions restent
 * visibles par tous les employés ; une discussion est affectée automatiquement
 * au premier employé qui l'ouvre (affichage « Affectée à »).
 */

const POLL_MS = 10000;

/** Badge de statut d'une discussion (le « Non lu » prime sur le statut). */
function chatBadge(chat) {
  if (Number(chat.unread) > 0) return { label: 'Non lu', className: 'badge-chat-nonlu' };
  if (chat.statut === 'termine') return { label: 'Terminé', className: 'badge-chat-termine' };
  if (chat.statut === 'en_cours') return { label: 'En cours', className: 'badge-chat-encours' };
  return { label: 'Lu', className: 'badge-chat-lu' };
}

/** Un élément de la liste des discussions (volet gauche). */
function ChatListItem({ chat, active, onClick }) {
  const badge = chatBadge(chat);
  return (
    <button type="button" className={`chat-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="chat-item-top">
        <span className="chat-item-title">{chat.magasin || `Client n°${chat.clientId}`}</span>
        <span className={`badge ${badge.className}`}>{badge.label}</span>
        {Number(chat.unread) > 0 && <span className="chat-unread-count">{chat.unread}</span>}
      </div>
      {chat.subject && <div className="chat-item-subject">{chat.subject}</div>}
      <div className="chat-item-bottom">
        <span className="chat-item-preview">{chat.lastText || '—'}</span>
        <span className="chat-item-date">{formatMessageDate(chat.lastAt)}</span>
      </div>
      {chat.assignedName && <div className="chat-item-assigned">Affectée à : {chat.assignedName}</div>}
    </button>
  );
}

/** Messages > Clients — messagerie admin avec filtres. */
export default function MessagesClients() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [filtreLu, setFiltreLu] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('');
  const [filtreMagasin, setFiltreMagasin] = useState('');
  const [filtreUser, setFiltreUser] = useState('');
  const [filterOptions, setFilterOptions] = useState({ magasins: [], users: [] });

  const [activeId, setActiveId] = useState(null);
  const [conversation, setConversation] = useState(null); // { chat, messages }
  const [statutSaving, setStatutSaving] = useState(false);

  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  const filtersRef = useRef({});
  filtersRef.current = { lu: filtreLu, statut: filtreStatut, magasin: filtreMagasin, user: filtreUser };

  const loadChats = useCallback(() => {
    const f = filtersRef.current;
    const params = {};
    if (f.lu) params.lu = f.lu;
    if (f.statut) params.statut = f.statut;
    if (f.magasin) params.magasin = f.magasin;
    if (f.user) params.user = f.user;
    return api
      .get('/messages/chats', { params })
      .then((res) => setChats(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des discussions.'));
  }, []);

  const loadFilters = useCallback(() => {
    return api
      .get('/messages/filters')
      .then((res) => setFilterOptions(res.data))
      .catch(() => {});
  }, []);

  const loadConversation = useCallback((id) => {
    return api
      .get(`/messages/chats/${id}`)
      .then((res) => {
        /* Ignore la réponse si l'utilisateur a changé de discussion entre-temps. */
        if (activeIdRef.current === id) setConversation(res.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([loadChats(), loadFilters()]).finally(() => setLoading(false));
  }, [loadChats, loadFilters]);

  /* Rechargement de la liste à chaque changement de filtre. */
  useEffect(() => {
    loadChats();
  }, [filtreLu, filtreStatut, filtreMagasin, filtreUser, loadChats]);

  /* Ouverture d'une discussion : charge le fil (lecture -> affectation + messages lus). */
  useEffect(() => {
    if (!activeId) {
      setConversation(null);
      return;
    }
    setConversation(null);
    loadConversation(activeId).then(() => {
      loadChats();
      loadFilters();
    });
  }, [activeId, loadConversation, loadChats, loadFilters]);

  /* Rafraîchissement périodique : liste + discussion ouverte. */
  useEffect(() => {
    const timer = setInterval(() => {
      loadChats();
      if (activeIdRef.current) loadConversation(activeIdRef.current);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadChats, loadConversation]);

  async function handleSend({ text, file }) {
    const form = new FormData();
    if (text) form.append('text', text);
    if (file) form.append('file', file);
    await api.post(`/messages/chats/${activeId}/messages`, form);
    await Promise.all([loadConversation(activeId), loadChats()]);
  }

  /** Bascule le statut de la discussion ouverte (En cours <-> Terminé). */
  async function setStatut(statut) {
    if (statutSaving) return;
    setStatutSaving(true);
    try {
      await api.patch(`/messages/chats/${activeId}/statut`, { statut });
      await Promise.all([loadConversation(activeId), loadChats()]);
    } catch {
      /* Le prochain rafraîchissement remettra l'affichage d'aplomb. */
    } finally {
      setStatutSaving(false);
    }
  }

  const activeChat = chats.find((c) => c.id === activeId);
  const convInfo = conversation?.chat;
  const statut = convInfo?.statut || activeChat?.statut;

  return (
    <div className="platform-page chat-page">
      <section className="platform-card chat-card">
        <h2>
          <MessagesSquare size={18} /> Messages clients
        </h2>

        {/* Filtres : lecture, statut, magasin, utilisateur affecté. */}
        <div className="datatable-toolbar chat-filters">
          <select className="datatable-select" value={filtreLu} onChange={(e) => setFiltreLu(e.target.value)}>
            <option value="">Lus et non lus</option>
            <option value="non_lu">Non lus</option>
            <option value="lu">Lus</option>
          </select>
          <select
            className="datatable-select"
            value={filtreStatut}
            onChange={(e) => setFiltreStatut(e.target.value)}
          >
            <option value="">Tous les statuts</option>
            <option value="en_cours">En cours</option>
            <option value="termine">Terminé</option>
          </select>
          <SearchableSelect
            className="ss-toolbar"
            value={filtreMagasin}
            onChange={setFiltreMagasin}
            placeholder="Tous les magasins"
            options={[
              { value: '', label: 'Tous les magasins' },
              ...filterOptions.magasins.map((m) => ({ value: String(m.id), label: m.label }))
            ]}
          />
          <SearchableSelect
            className="ss-toolbar"
            value={filtreUser}
            onChange={setFiltreUser}
            placeholder="Tous les utilisateurs"
            options={[
              { value: '', label: 'Tous les utilisateurs' },
              ...filterOptions.users.map((u) => ({ value: String(u.id), label: u.label }))
            ]}
          />
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`chat-layout ${activeId ? 'is-conv-open' : ''}`}>
          {/* Volet gauche : discussions de tous les clients. */}
          <aside className="chat-list">
            <div className="chat-list-items">
              {loading ? (
                <div className="chat-list-empty">Chargement…</div>
              ) : chats.length === 0 ? (
                <div className="chat-list-empty">Aucune discussion trouvée.</div>
              ) : (
                chats.map((c) => (
                  <ChatListItem key={c.id} chat={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />
                ))
              )}
            </div>
          </aside>

          {/* Volet droit : fil de la discussion sélectionnée. */}
          <div className="chat-panel">
            {activeId ? (
              <>
                <div className="chat-panel-header">
                  <button type="button" className="chat-back" onClick={() => setActiveId(null)}>
                    <ChevronLeft size={18} />
                  </button>
                  <div className="chat-panel-headings">
                    <div className="chat-panel-title">
                      {convInfo?.magasin || activeChat?.magasin || `Client n°${activeChat?.clientId ?? ''}`}
                    </div>
                    <div className="chat-panel-sub">
                      {(convInfo?.subject || activeChat?.subject) ? `${convInfo?.subject || activeChat?.subject} · ` : ''}
                      {convInfo?.assignedName ? `Affectée à : ${convInfo.assignedName}` : 'Non affectée'}
                    </div>
                  </div>
                  {statut === 'termine' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm chat-statut-btn"
                      disabled={statutSaving}
                      onClick={() => setStatut('en_cours')}
                    >
                      <RotateCcw size={14} /> Rouvrir
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm chat-statut-btn"
                      disabled={statutSaving}
                      onClick={() => setStatut('termine')}
                    >
                      <CheckCheck size={14} /> Terminer
                    </button>
                  )}
                </div>
                <ChatConversation
                  messages={conversation?.messages || []}
                  onSend={handleSend}
                  disabled={statut === 'termine'}
                  emptyText={conversation ? 'Aucun message.' : 'Chargement…'}
                />
              </>
            ) : (
              <div className="chat-placeholder">
                <MessagesSquare size={40} />
                <p>Sélectionnez une discussion pour afficher les messages.</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
