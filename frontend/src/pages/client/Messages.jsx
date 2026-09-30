import { useCallback, useEffect, useRef, useState } from 'react';
import { BRAND } from '../../config/brand';
import { MessagesSquare, Plus, ChevronLeft } from 'lucide-react';
import api from '../../api/client';
import ChatConversation, { formatMessageDate } from '../../components/ChatConversation';

/*
 * Messages (dashboard client) — boîte à lettres en deux volets :
 * à gauche la liste des discussions du client (badge Non lu (n) /
 * En cours / Terminé), à droite le fil de la discussion sélectionnée
 * (messages du client à gauche, réponses de l'admin à droite).
 * En mobile, un seul volet à la fois avec bouton retour.
 */

const POLL_MS = 10000;

/** Badge de statut d'une discussion (le « Non lu » prime sur le statut). */
function chatBadge(chat) {
  if (Number(chat.unread) > 0) return { label: 'Non lu', className: 'badge-chat-nonlu' };
  if (chat.statut === 'termine') return { label: 'Terminé', className: 'badge-chat-termine' };
  if (chat.statut === 'en_cours') return { label: 'En cours', className: 'badge-chat-encours' };
  return { label: 'En cours', className: 'badge-chat-encours' };
}

/** Un élément de la liste des discussions (volet gauche). */
function ChatListItem({ chat, active, onClick }) {
  const badge = chatBadge(chat);
  return (
    <button type="button" className={`chat-item ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="chat-item-top">
        <span className="chat-item-title">{chat.subject || `Discussion n°${chat.id}`}</span>
        <span className={`badge ${badge.className}`}>{badge.label}</span>
        {Number(chat.unread) > 0 && <span className="chat-unread-count">{chat.unread}</span>}
      </div>
      <div className="chat-item-bottom">
        <span className="chat-item-preview">{chat.lastText || '—'}</span>
        <span className="chat-item-date">{formatMessageDate(chat.lastAt)}</span>
      </div>
    </button>
  );
}

/** Messages — messagerie du client avec le support de la plateforme. */
export default function Messages() {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [activeId, setActiveId] = useState(null);
  const [conversation, setConversation] = useState(null); // { chat, messages }

  const [showNew, setShowNew] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [newText, setNewText] = useState('');
  const [newError, setNewError] = useState('');
  const [creating, setCreating] = useState(false);

  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;

  const loadChats = useCallback(() => {
    return api
      .get('/messages/client/chats')
      .then((res) => setChats(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des discussions.'));
  }, []);

  const loadConversation = useCallback((id) => {
    return api
      .get(`/messages/client/chats/${id}`)
      .then((res) => {
        /* Ignore la réponse si l'utilisateur a changé de discussion entre-temps. */
        if (activeIdRef.current === id) setConversation(res.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadChats().finally(() => setLoading(false));
  }, [loadChats]);

  /* Ouverture d'une discussion : charge le fil (et marque les réponses comme lues). */
  useEffect(() => {
    if (!activeId) {
      setConversation(null);
      return;
    }
    setConversation(null);
    loadConversation(activeId).then(loadChats);
  }, [activeId, loadConversation, loadChats]);

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
    await api.post(`/messages/client/chats/${activeId}/messages`, form);
    await Promise.all([loadConversation(activeId), loadChats()]);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newText.trim() || creating) return;
    setCreating(true);
    setNewError('');
    try {
      const res = await api.post('/messages/client/chats', {
        subject: newSubject.trim(),
        text: newText.trim()
      });
      setShowNew(false);
      setNewSubject('');
      setNewText('');
      await loadChats();
      setActiveId(res.data.id);
    } catch (err) {
      setNewError(err.response?.data?.message || 'Erreur lors de la création de la discussion.');
    } finally {
      setCreating(false);
    }
  }

  function openNew() {
    setActiveId(null);
    setShowNew(true);
    setNewError('');
  }

  const convOpen = Boolean(activeId) || showNew;
  const activeChat = chats.find((c) => c.id === activeId);

  return (
    <div className="platform-page chat-page">
      <section className="platform-card chat-card">
        <h2>
          <MessagesSquare size={18} /> Messages
        </h2>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`chat-layout ${convOpen ? 'is-conv-open' : ''}`}>
          {/* Volet gauche : liste des discussions. */}
          <aside className="chat-list">
            <button type="button" className="btn btn-primary chat-new-btn" onClick={openNew}>
              <Plus size={16} /> Nouvelle discussion
            </button>
            <div className="chat-list-items">
              {loading ? (
                <div className="chat-list-empty">Chargement…</div>
              ) : chats.length === 0 ? (
                <div className="chat-list-empty">Aucune discussion. Écrivez-nous !</div>
              ) : (
                chats.map((c) => (
                  <ChatListItem
                    key={c.id}
                    chat={c}
                    active={c.id === activeId}
                    onClick={() => {
                      setShowNew(false);
                      setActiveId(c.id);
                    }}
                  />
                ))
              )}
            </div>
          </aside>

          {/* Volet droit : fil de discussion ou formulaire de création. */}
          <div className="chat-panel">
            {showNew ? (
              <>
                <div className="chat-panel-header">
                  <button type="button" className="chat-back" onClick={() => setShowNew(false)}>
                    <ChevronLeft size={18} />
                  </button>
                  <div className="chat-panel-title">Nouvelle discussion</div>
                </div>
                <form className="chat-new-form" onSubmit={handleCreate}>
                  <label>
                    Sujet <span className="chat-optional">(facultatif)</span>
                    <input
                      type="text"
                      maxLength={255}
                      placeholder="Ex. : Question sur un colis"
                      value={newSubject}
                      onChange={(e) => setNewSubject(e.target.value)}
                    />
                  </label>
                  <label>
                    Message
                    <textarea
                      rows={5}
                      placeholder="Votre message…"
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                      required
                    />
                  </label>
                  {newError && <div className="form-error">{newError}</div>}
                  <button type="submit" className="btn btn-primary" disabled={creating || !newText.trim()}>
                    {creating ? 'Envoi…' : 'Démarrer la discussion'}
                  </button>
                </form>
              </>
            ) : activeId ? (
              <>
                <div className="chat-panel-header">
                  <button type="button" className="chat-back" onClick={() => setActiveId(null)}>
                    <ChevronLeft size={18} />
                  </button>
                  <div>
                    <div className="chat-panel-title">
                      {conversation?.chat?.subject || activeChat?.subject || `Discussion n°${activeId}`}
                    </div>
                    <div className="chat-panel-sub">Support {BRAND.name}</div>
                  </div>
                </div>
                <ChatConversation
                  messages={conversation?.messages || []}
                  onSend={handleSend}
                  disabled={(conversation?.chat?.statut || activeChat?.statut) === 'termine'}
                  emptyText={conversation ? 'Aucun message.' : 'Chargement…'}
                />
              </>
            ) : (
              <div className="chat-placeholder">
                <MessagesSquare size={40} />
                <p>Sélectionnez une discussion ou démarrez-en une nouvelle.</p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
