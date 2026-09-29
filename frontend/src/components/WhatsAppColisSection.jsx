import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Lock, MessageCircle, Send } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { hasAccess } from '../config/adminMenu';
import WhatsAppEnvoiModeleModal from './WhatsAppEnvoiModeleModal';
import { STATUTS, formatDateHeure } from '../utils/whatsapp';

/*
 * Section « WhatsApp » de la modale « Détail de suivi » d'un colis (admin,
 * service API_LIAISON ou WHATSAPP_DISCUSSIONS, fonctions 1-2) : messages liés
 * au colis (envois automatiques, manuels, réponses du destinataire) et bouton
 * « Envoyer un message » (modèle approuvé au destinataire, au client ou au
 * livreur). Le lien « Ouvrir la discussion » n'apparaît qu'avec le service
 * WHATSAPP_DISCUSSIONS (page Discussions).
 */

export default function WhatsAppColisSection({ parcel }) {
  const { user } = useAuth();
  const peutDiscussions = hasAccess(user, 'WHATSAPP_DISCUSSIONS');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);

  const load = useCallback(() => {
    return api
      .get(`/whatsapp/colis/${parcel.parcel_id}/messages`)
      .then((res) => {
        setData(res.data);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.message || 'Messages WhatsApp indisponibles.'));
  }, [parcel.parcel_id]);

  useEffect(() => {
    load();
  }, [load]);

  const messages = data?.messages || [];

  return (
    <div className="wa-colis-section">
      <div className="suivi-section-title wa-colis-titre">
        <span>
          <MessageCircle size={14} /> WhatsApp
        </span>
        <span className="wa-colis-titre-actions">
          {data?.conversationId && peutDiscussions && (
            <Link to={`/admin/api-liaison/whatsapp/discussions?conversation=${data.conversationId}`} className="btn btn-ghost btn-sm">
              Ouvrir la discussion
            </Link>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModal(true)}>
            <Send size={13} /> Envoyer un message
          </button>
        </span>
      </div>
      {error && <div className="field-error">{error}</div>}
      {!error && data && messages.length === 0 && <div className="modal-loading">Aucun message WhatsApp pour ce colis.</div>}
      {messages.length > 0 && (
        <ul className="suivi-timeline wa-colis-timeline">
          {messages.map((m) => {
            const st = STATUTS[m.statut] || { label: m.statut, cls: 'badge-neutral' };
            return (
              <li key={m.id} className="suivi-item">
                <span className="suivi-dot" />
                <div>
                  <div className="suivi-label">
                    {m.direction === 'entrant' ? <ArrowDownLeft size={13} /> : m.direction === 'note' ? <Lock size={13} /> : <ArrowUpRight size={13} />}
                    {m.template && <span className="mono wa-colis-tpl">{m.template}</span>}
                    <span className="wa-colis-texte">{m.texte || '—'}</span>
                    {m.direction !== 'note' && <span className={`badge ${st.cls}`}>{st.label}</span>}
                  </div>
                  {m.erreur && <div className="cell-sub field-error">{m.erreur}</div>}
                  <div className="suivi-date">
                    {formatDateHeure(m.date)}
                    {m.auteurNom ? ` · ${m.auteurNom}` : ''}
                    {m.regleNom ? ` · règle « ${m.regleNom} »` : ''}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {modal && (
        <WhatsAppEnvoiModeleModal
          mode="colis"
          parcel={parcel}
          onClose={() => setModal(false)}
          onSent={() => load()}
        />
      )}
    </div>
  );
}
