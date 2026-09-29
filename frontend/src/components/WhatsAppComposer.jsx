import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Lock, Mic, Send, Smile, Square, StickyNote, Trash2, X, Zap } from 'lucide-react';
import { EMOJIS } from './ChatConversation';
import { remplacerBalisesReponse } from '../utils/whatsappModele';
import { formatDuree } from '../utils/whatsapp';
import { capaciteVocal, demarrerEnregistrement } from '../utils/enregistreurVocal';

/*
 * Zone de saisie d'une discussion WhatsApp :
 *  - fenêtre de 24 h ouverte : texte libre (emojis, image jpg/png/webp avec
 *    légende, message vocal enregistré au micro — utils/enregistreurVocal.js,
 *    envoyé seul sans le texte —, réponses rapides) ;
 *  - fenêtre fermée : seul un modèle approuvé peut partir (bouton « Choisir un
 *    modèle » → modale d'envoi, gérée par la page) ;
 *  - note interne (jamais envoyée au contact), disponible dans tous les cas ;
 *  - contact désinscrit (opt-out) ou discussion terminée : envoi bloqué.
 * Entrée = envoyer, Maj+Entrée = retour à la ligne.
 */

/** Durée maximale d'un message vocal (arrêt automatique). */
const VOCAL_MAX_SECONDES = 300;

export default function WhatsAppComposer({ conversation, reponsesRapides = [], onSendText, onSendNote, onOuvrirModele }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('texte'); // texte | note
  const [attachment, setAttachment] = useState(null); // { file, url, type: 'image' | 'audio' }
  const [showEmojis, setShowEmojis] = useState(false);
  const [showRapides, setShowRapides] = useState(false);
  const [filtreRapide, setFiltreRapide] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [vocalDispo, setVocalDispo] = useState(undefined); // undefined = détection en cours, null = non pris en charge
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const fileInputRef = useRef(null);
  const textRef = useRef(null);
  const recorderRef = useRef(null);
  const timerRef = useRef(null);
  const secondesRef = useRef(0);
  const monteRef = useRef(true);

  const optOut = Boolean(conversation?.optOut);
  const terminee = conversation?.statut === 'termine';
  const fenetreOuverte = Boolean(conversation?.fenetreOuverte);
  const bloqueTexte = optOut
    ? 'Contact désinscrit : aucun envoi possible (réactivez les envois dans le volet Infos).'
    : terminee
      ? 'Discussion terminée : rouvrez-la pour répondre.'
      : null;

  useEffect(() => {
    monteRef.current = true;
    capaciteVocal().then((c) => monteRef.current && setVocalDispo(c));
    return () => {
      monteRef.current = false;
      annulerVocal();
    };
  }, []);

  useEffect(() => {
    annulerVocal();
    setText('');
    setAttachment(null);
    setMode('texte');
    setShowEmojis(false);
    setShowRapides(false);
    setSendError('');
  }, [conversation?.id]);

  useEffect(() => () => attachment?.url && URL.revokeObjectURL(attachment.url), [attachment]);

  const rapidesFiltrees = useMemo(() => {
    const q = filtreRapide.trim().toLowerCase();
    return reponsesRapides.filter((r) => !q || r.titre.toLowerCase().includes(q) || r.texte.toLowerCase().includes(q));
  }, [reponsesRapides, filtreRapide]);

  function insererTexte(morceau) {
    const input = textRef.current;
    if (input) {
      const start = input.selectionStart ?? text.length;
      const end = input.selectionEnd ?? text.length;
      const next = text.slice(0, start) + morceau + text.slice(end);
      setText(next);
      requestAnimationFrame(() => {
        input.focus();
        input.selectionStart = input.selectionEnd = start + morceau.length;
      });
    } else setText((t) => t + morceau);
  }

  function poserPieceJointe(file, type) {
    setAttachment((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file), type };
    });
  }

  function onPickImage(e) {
    const file = e.target.files?.[0];
    if (file) poserPieceJointe(file, 'image');
    e.target.value = '';
  }

  /** Coupe un enregistrement en cours sans rien garder (corbeille, changement de discussion, démontage). */
  function annulerVocal() {
    clearInterval(timerRef.current);
    const rec = recorderRef.current;
    recorderRef.current = null;
    rec?.annuler();
    if (monteRef.current) setRecording(false);
  }

  async function demarrerVocal() {
    if (recording || sending || recorderRef.current) return;
    setSendError('');
    setShowEmojis(false);
    setShowRapides(false);
    try {
      const rec = await demarrerEnregistrement();
      if (!monteRef.current || recorderRef.current) {
        rec.annuler();
        return;
      }
      recorderRef.current = rec;
      secondesRef.current = 0;
      setRecordSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => {
        secondesRef.current += 1;
        setRecordSeconds(secondesRef.current);
        if (secondesRef.current >= VOCAL_MAX_SECONDES) terminerVocal();
      }, 1000);
    } catch (err) {
      setSendError(
        err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
          ? 'Micro inaccessible : autorisez le micro dans le navigateur (ou branchez-en un).'
          : err?.message || 'Micro inaccessible.'
      );
    }
  }

  /** Arrête l'enregistrement et le place en pièce jointe (aperçu avant envoi). */
  async function terminerVocal() {
    clearInterval(timerRef.current);
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!rec) return;
    if (secondesRef.current < 1) {
      rec.annuler();
      setSendError('Enregistrement trop court (moins d’une seconde).');
      return;
    }
    try {
      const file = await rec.stop();
      if (monteRef.current) poserPieceJointe(file, 'audio');
    } catch (err) {
      if (monteRef.current) setSendError(err?.message || "Échec de l'enregistrement vocal.");
    }
  }

  async function envoyer() {
    const trimmed = text.trim();
    if (sending || recording) return;
    if (mode === 'note') {
      if (!trimmed) return;
      setSending(true);
      setSendError('');
      try {
        await onSendNote(trimmed);
        setText('');
        setMode('texte');
      } catch (err) {
        setSendError(err.response?.data?.message || "Erreur lors de l'ajout de la note.");
      } finally {
        setSending(false);
      }
      return;
    }
    if (!trimmed && !attachment) return;
    setSending(true);
    setSendError('');
    try {
      const vocal = attachment?.type === 'audio';
      await onSendText({ text: vocal ? '' : trimmed, file: attachment?.file || null, type: attachment?.type || null });
      if (!vocal) setText('');
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
      envoyer();
    }
  }

  const texteBloque = mode === 'texte' && (Boolean(bloqueTexte) || !fenetreOuverte);
  const vocalJoint = attachment?.type === 'audio';
  const recordLabel = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(recordSeconds % 60).padStart(2, '0')}`;
  const titreMicro =
    vocalDispo === null
      ? 'Enregistrement vocal non pris en charge par ce navigateur'
      : vocalDispo === undefined
        ? 'Vérification du micro…'
        : 'Message vocal';

  let placeholder = 'Écrire un message… (Entrée pour envoyer)';
  if (mode === 'note') placeholder = 'Note interne (invisible pour le contact)…';
  else if (texteBloque) placeholder = 'Envoi de texte indisponible.';
  else if (recording) placeholder = 'Enregistrement en cours… (■ pour terminer, corbeille pour annuler)';
  else if (vocalJoint) placeholder = 'Message vocal prêt : envoyez-le ou retirez-le.';

  return (
    <div className="wa-composer">
      {sendError && <div className="form-error chat-send-error">{sendError}</div>}

      {mode === 'texte' && bloqueTexte && <div className="wa-composer-off">{bloqueTexte}</div>}
      {mode === 'texte' && !bloqueTexte && !fenetreOuverte && (
        <div className="wa-composer-ferme">
          <span>
            <Lock size={14} /> Fenêtre de 24 h fermée : seul un modèle approuvé peut être envoyé à ce contact.
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={onOuvrirModele}>
            <FileText size={14} /> Choisir un modèle
          </button>
        </div>
      )}
      {mode === 'texte' && !bloqueTexte && fenetreOuverte && conversation?.fenetreRestantSecondes > 0 && conversation.fenetreRestantSecondes < 3600 && (
        <div className="wa-composer-avert">Fenêtre de 24 h : expire dans {formatDuree(conversation.fenetreRestantSecondes)}.</div>
      )}

      {attachment && (
        <div className="chat-attachment-preview">
          {vocalJoint ? (
            <>
              <audio controls src={attachment.url} preload="metadata" />
              <span className="cell-sub">
                {text.trim() ? 'Message vocal envoyé seul : le texte saisi reste dans la zone de saisie.' : 'Message vocal prêt à envoyer.'}
              </span>
            </>
          ) : (
            <>
              <img src={attachment.url} alt="Aperçu" />
              <span className="cell-sub">Le texte saisi servira de légende.</span>
            </>
          )}
          <button
            type="button"
            className="chat-attachment-remove"
            title={vocalJoint ? 'Retirer le message vocal' : "Retirer l'image"}
            onClick={() => setAttachment(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {showEmojis && mode === 'texte' && (
        <div className="chat-emoji-palette">
          {EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => insererTexte(e)}>
              {e}
            </button>
          ))}
        </div>
      )}

      {showRapides && mode === 'texte' && (
        <div className="wa-quick-menu">
          <input
            type="text"
            value={filtreRapide}
            placeholder="Rechercher une réponse rapide…"
            onChange={(e) => setFiltreRapide(e.target.value)}
            autoFocus
          />
          <div className="wa-quick-list">
            {rapidesFiltrees.length === 0 ? (
              <div className="cell-sub">Aucune réponse rapide (Configuration › Paramètres CRM).</div>
            ) : (
              rapidesFiltrees.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    insererTexte(remplacerBalisesReponse(r.texte, conversation));
                    setShowRapides(false);
                  }}
                >
                  <strong>{r.titre}</strong>
                  <span>{r.texte}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className={`chat-composer ${mode === 'note' ? 'is-note' : ''} ${texteBloque ? 'is-disabled' : ''}`}>
        {recording ? (
          <>
            <button type="button" className="chat-tool chat-tool-recording" title="Terminer l'enregistrement" onClick={terminerVocal}>
              <Square size={14} /> <span className="chat-record-time">{recordLabel}</span>
            </button>
            <button type="button" className="chat-tool" title="Annuler l'enregistrement" onClick={annulerVocal}>
              <Trash2 size={18} />
            </button>
          </>
        ) : mode === 'texte' ? (
          <>
            <button
              type="button"
              className={`chat-tool ${showEmojis ? 'is-active' : ''}`}
              title="Emojis"
              disabled={texteBloque || vocalJoint}
              onClick={() => {
                setShowRapides(false);
                setShowEmojis((v) => !v);
              }}
            >
              <Smile size={18} />
            </button>
            <button type="button" className="chat-tool" title="Envoyer une image" disabled={texteBloque} onClick={() => fileInputRef.current?.click()}>
              <ImageIcon size={18} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onPickImage} />
            <button type="button" className="chat-tool" title={titreMicro} disabled={texteBloque || !vocalDispo} onClick={demarrerVocal}>
              <Mic size={18} />
            </button>
            <button
              type="button"
              className={`chat-tool ${showRapides ? 'is-active' : ''}`}
              title="Réponses rapides"
              disabled={texteBloque || vocalJoint}
              onClick={() => {
                setShowEmojis(false);
                setShowRapides((v) => !v);
              }}
            >
              <Zap size={18} />
            </button>
            <button type="button" className="chat-tool" title="Envoyer un modèle" disabled={Boolean(bloqueTexte)} onClick={onOuvrirModele}>
              <FileText size={18} />
            </button>
            <button type="button" className="chat-tool" title="Note interne" onClick={() => { setMode('note'); setShowEmojis(false); setShowRapides(false); }}>
              <StickyNote size={18} />
            </button>
          </>
        ) : (
          <button type="button" className="chat-tool is-active" title="Revenir au message" onClick={() => setMode('texte')}>
            <X size={18} />
          </button>
        )}
        <textarea
          ref={textRef}
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={texteBloque || recording || vocalJoint}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={`btn ${mode === 'note' ? 'btn-ghost' : 'btn-primary'} chat-send-btn`}
          disabled={sending || texteBloque || recording || (!text.trim() && !attachment)}
          onClick={envoyer}
          title={mode === 'note' ? 'Enregistrer la note' : vocalJoint ? 'Envoyer le message vocal' : 'Envoyer'}
        >
          {mode === 'note' ? <StickyNote size={16} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}
