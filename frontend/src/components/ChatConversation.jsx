import { useEffect, useRef, useState } from 'react';
import { Smile, Image as ImageIcon, Mic, Square, Send, X } from 'lucide-react';

/*
 * Volet droit de la messagerie (pages client/Messages et admin/MessagesClients) :
 * fil de discussion + zone de saisie. Messages du client à GAUCHE, messages
 * de l'admin à DROITE (même disposition sur les deux dashboards).
 * Saisie : texte avec emojis (palette rapide), photo (input file) et message
 * vocal (MediaRecorder -> webm), envoyés en multipart à l'API.
 */

export const EMOJIS = [
  '😀', '😂', '🙂', '😉', '😍', '🤔', '😮', '😢', '😡', '🙏',
  '👍', '👌', '👏', '💪', '🤝', '❤️', '🎉', '🔥', '✅', '❌',
  '⚠️', '⏳', '📦', '🚚', '💰', '📞'
];

/** Date + heure d'un message au format français (ex. 08/08/2026 14:35). */
export function formatMessageDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Une bulle de message : texte, photo ou audio + nom de l'expéditeur et date. */
function MessageBubble({ msg }) {
  const side = msg.from === 'user' ? 'chat-msg-user' : 'chat-msg-client';
  return (
    <div className={`chat-msg ${side}`}>
      <div className="chat-bubble">
        {msg.fileType === 'image' && msg.fileUrl && (
          <a href={msg.fileUrl} target="_blank" rel="noreferrer" className="chat-img-link">
            <img src={msg.fileUrl} alt="Photo envoyée" className="chat-img" loading="lazy" />
          </a>
        )}
        {msg.fileType === 'audio' && msg.fileUrl && (
          <audio controls src={msg.fileUrl} className="chat-audio" preload="none" />
        )}
        {msg.text && <div className="chat-text">{msg.text}</div>}
      </div>
      <div className="chat-msg-date">
        {msg.senderName ? `${msg.senderName} · ` : ''}
        {formatMessageDate(msg.date)}
      </div>
    </div>
  );
}

/**
 * Fil + composer. Props :
 * - messages : liste renvoyée par l'API ;
 * - onSend({ text, file }) : envoi (async) ;
 * - disabled : désactive la saisie (ex. discussion terminée) ;
 * - emptyText : texte affiché quand il n'y a aucun message.
 */
export default function ChatConversation({ messages, onSend, disabled = false, emptyText = 'Aucun message.' }) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState(null); // { file, url, type }
  const [showEmojis, setShowEmojis] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const listRef = useRef(null);
  const fileInputRef = useRef(null);
  const textRef = useRef(null);
  const recorderRef = useRef(null);
  const recordTimerRef = useRef(null);

  /* Défilement automatique en bas du fil à chaque nouveau message. */
  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  /* Libère l'URL de prévisualisation et coupe l'enregistrement au démontage. */
  useEffect(() => {
    return () => {
      if (attachment?.url) URL.revokeObjectURL(attachment.url);
    };
  }, [attachment]);
  useEffect(() => () => stopRecordingTracks(), []);

  function stopRecordingTracks() {
    clearInterval(recordTimerRef.current);
    const rec = recorderRef.current;
    if (rec) {
      if (rec.state !== 'inactive') rec.stop();
      rec.stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
    }
  }

  function setFileAttachment(file, type) {
    if (!file) return;
    setAttachment((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file), type };
    });
  }

  function onPickImage(e) {
    const file = e.target.files?.[0];
    if (file) setFileAttachment(file, 'image');
    e.target.value = '';
  }

  /** Enregistrement d'un message vocal via le micro (MediaRecorder). */
  async function startRecording() {
    setSendError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const file = new File([blob], `vocal-${Date.now()}.webm`, { type: blob.type });
        setFileAttachment(file, 'audio');
        stream.getTracks().forEach((t) => t.stop());
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setSendError("Micro inaccessible : vérifiez l'autorisation du navigateur.");
    }
  }

  function stopRecording() {
    clearInterval(recordTimerRef.current);
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  function insertEmoji(emoji) {
    const input = textRef.current;
    if (input) {
      const start = input.selectionStart ?? text.length;
      const end = input.selectionEnd ?? text.length;
      const next = text.slice(0, start) + emoji + text.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        input.focus();
        input.selectionStart = input.selectionEnd = start + emoji.length;
      });
    } else {
      setText((t) => t + emoji);
    }
  }

  async function handleSend() {
    const trimmed = text.trim();
    if ((!trimmed && !attachment) || sending || disabled) return;
    setSending(true);
    setSendError('');
    try {
      await onSend({ text: trimmed, file: attachment?.file || null });
      setText('');
      setAttachment((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return null;
      });
      setShowEmojis(false);
    } catch (err) {
      setSendError(err.response?.data?.message || "Erreur lors de l'envoi du message.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const recordLabel = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(recordSeconds % 60).padStart(2, '0')}`;

  return (
    <div className="chat-conv">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty-fil">{emptyText}</div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
      </div>

      {sendError && <div className="form-error chat-send-error">{sendError}</div>}

      {attachment && (
        <div className="chat-attachment-preview">
          {attachment.type === 'image' ? (
            <img src={attachment.url} alt="Aperçu" />
          ) : (
            <audio controls src={attachment.url} />
          )}
          <button
            type="button"
            className="chat-attachment-remove"
            title="Retirer la pièce jointe"
            onClick={() => setAttachment(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {showEmojis && (
        <div className="chat-emoji-palette">
          {EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => insertEmoji(e)}>
              {e}
            </button>
          ))}
        </div>
      )}

      <div className={`chat-composer ${disabled ? 'is-disabled' : ''}`}>
        <button
          type="button"
          className={`chat-tool ${showEmojis ? 'is-active' : ''}`}
          title="Emojis"
          disabled={disabled}
          onClick={() => setShowEmojis((v) => !v)}
        >
          <Smile size={18} />
        </button>
        <button
          type="button"
          className="chat-tool"
          title="Envoyer une photo"
          disabled={disabled || recording}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImageIcon size={18} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={onPickImage}
        />
        {recording ? (
          <button type="button" className="chat-tool chat-tool-recording" title="Arrêter" onClick={stopRecording}>
            <Square size={16} />
            <span className="chat-record-time">{recordLabel}</span>
          </button>
        ) : (
          <button
            type="button"
            className="chat-tool"
            title="Enregistrer un message vocal"
            disabled={disabled}
            onClick={startRecording}
          >
            <Mic size={18} />
          </button>
        )}
        <textarea
          ref={textRef}
          rows={1}
          placeholder={disabled ? 'Discussion terminée.' : 'Écrire un message…'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary chat-send-btn"
          disabled={disabled || sending || (!text.trim() && !attachment)}
          onClick={handleSend}
          title="Envoyer"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
