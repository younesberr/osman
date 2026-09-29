import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, Check, CheckCheck, Clock, FileText, Lock, MapPin, Paperclip, Reply, Zap } from 'lucide-react';
import { STATUTS, formatHeureCourte, formatJour } from '../utils/whatsapp';

/*
 * Fil d'une discussion WhatsApp (page Discussions) : bulles sortantes à
 * droite, entrantes à gauche, notes internes en jaune ; chip du modèle,
 * médias, citation du message auquel on répond, réponse par bouton, coches
 * de statut (en attente / envoyé / remis / lu / échec). Le compositeur est
 * passé en enfant. Défilement automatique en bas à l'ouverture et à l'arrivée
 * d'un message si l'utilisateur est déjà en bas (sinon pastille « Nouveaux »).
 */

function Ticks({ msg }) {
  const st = STATUTS[msg.statut] || { label: msg.statut };
  if (msg.statut === 'echec') {
    return (
      <span className="wa-ticks wa-ticks-echec" title={msg.erreur || 'Échec'}>
        <AlertTriangle size={12} /> Échec
      </span>
    );
  }
  if (msg.statut === 'planifie' || msg.statut === 'en_attente') {
    return (
      <span className="wa-ticks wa-ticks-attente" title={msg.statut === 'planifie' ? `Planifié${msg.planifieLe ? ` : ${formatHeureCourte(msg.planifieLe)}` : ''}` : 'Envoi en cours'}>
        <Clock size={12} /> {st.label}
      </span>
    );
  }
  if (msg.statut === 'envoye') return <span className="wa-ticks" title="Envoyé"><Check size={13} /></span>;
  if (msg.statut === 'remis') return <span className="wa-ticks" title="Remis"><CheckCheck size={13} /></span>;
  if (msg.statut === 'lu') return <span className="wa-ticks wa-ticks-lu" title="Lu"><CheckCheck size={13} /></span>;
  return null;
}

function Media({ msg }) {
  if (!msg.mediaUrl) return null;
  const type = String(msg.mediaType || '');
  if (type.startsWith('image/') || msg.type === 'image' || msg.type === 'sticker') {
    return (
      <a href={msg.mediaUrl} target="_blank" rel="noreferrer" className="chat-img-link">
        <img src={msg.mediaUrl} alt="Image" className="chat-img" loading="lazy" />
      </a>
    );
  }
  if (type.startsWith('audio/') || msg.type === 'audio') return <audio controls src={msg.mediaUrl} className="chat-audio" preload="none" />;
  if (type.startsWith('video/') || msg.type === 'video') return <video controls src={msg.mediaUrl} className="wa-video" preload="none" />;
  return (
    <a href={msg.mediaUrl} target="_blank" rel="noreferrer" className="wa-media-link">
      <Paperclip size={14} /> Pièce jointe {type.includes('pdf') ? '(PDF)' : ''}
    </a>
  );
}

function Bulle({ msg, onQuoteClick }) {
  const side = msg.direction === 'entrant' ? 'chat-msg-client' : 'chat-msg-user';
  const note = msg.direction === 'note';
  const nonSupporte = msg.direction === 'entrant' && msg.mediaUrl == null && /^\[[a-z_]+\]$/.test(msg.texte || '');
  return (
    <div id={`wa-msg-${msg.id}`} className={`chat-msg ${side} ${note ? 'wa-msg-note' : ''}`}>
      <div className="chat-bubble">
        {note && (
          <div className="wa-tpl-chip">
            <Lock size={12} /> Note interne
          </div>
        )}
        {msg.reponseATexte && (
          <button type="button" className="wa-quote" onClick={() => onQuoteClick?.(msg.reponseAId)} title="Voir le message cité">
            <Reply size={12} /> {String(msg.reponseATexte).slice(0, 120)}
          </button>
        )}
        {msg.type === 'template' && msg.direction === 'sortant' && (
          <div className="wa-tpl-chip" title={msg.regleNom ? `Règle : ${msg.regleNom}` : 'Modèle'}>
            {msg.regleNom ? <Zap size={12} /> : <FileText size={12} />} {msg.template}
          </div>
        )}
        <Media msg={msg} />
        {msg.bouton && (
          <span className="wa-reply-chip">
            <Reply size={13} /> {msg.texte}
          </span>
        )}
        {msg.type === 'location' && (
          <span className="wa-reply-chip">
            <MapPin size={13} /> {msg.texte}
          </span>
        )}
        {!msg.bouton && msg.type !== 'location' && msg.texte && !(msg.mediaUrl && /^\[[a-z_]+\]$/.test(msg.texte)) && (
          <div className={`chat-text ${nonSupporte ? 'wa-unsupported' : ''}`}>
            {nonSupporte ? 'Message non pris en charge' : msg.texte}
          </div>
        )}
        {msg.parcelCode && msg.direction !== 'note' && <div className="wa-msg-colis mono">{msg.parcelCode}</div>}
      </div>
      <div className="chat-msg-date">
        {msg.auteurNom ? `${msg.auteurNom} · ` : ''}
        {formatHeureCourte(msg.date)}
        {msg.direction === 'sortant' && <Ticks msg={msg} />}
      </div>
    </div>
  );
}

export default function WhatsAppConversation({ conversation, messages, emptyText = 'Aucun message.', children }) {
  const listRef = useRef(null);
  const [nouveaux, setNouveaux] = useState(false);
  const enBasRef = useRef(true);
  const dernierId = messages.length ? messages[messages.length - 1].id : 0;
  const dernier = messages.length ? messages[messages.length - 1] : null;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    enBasRef.current = true;
    setNouveaux(false);
  }, [conversation?.id]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !dernier) return;
    if (enBasRef.current || dernier.direction !== 'entrant') {
      el.scrollTop = el.scrollHeight;
      setNouveaux(false);
    } else setNouveaux(true);
  }, [dernierId, dernier]);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    enBasRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (enBasRef.current) setNouveaux(false);
  }

  function versLeBas() {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setNouveaux(false);
  }

  function versMessage(id) {
    const cible = document.getElementById(`wa-msg-${id}`);
    if (cible) cible.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  let jourCourant = '';
  return (
    <div className="chat-conv">
      <div className="chat-messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty-fil">{emptyText}</div>
        ) : (
          messages.map((m) => {
            const jour = formatJour(m.date);
            const separateur = jour !== jourCourant;
            jourCourant = jour;
            return (
              <Fragment key={m.id}>
                {separateur && <div className="wa-day">{jour}</div>}
                <Bulle msg={m} onQuoteClick={versMessage} />
              </Fragment>
            );
          })
        )}
        {nouveaux && (
          <button type="button" className="wa-new-msgs" onClick={versLeBas}>
            <ArrowDown size={14} /> Nouveaux messages
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
