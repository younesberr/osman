import { Link } from 'react-router-dom';
import { Bike, Link2, Route, Store, User, X } from 'lucide-react';
import Toggle from './Toggle';
import { useAuth } from '../context/AuthContext';
import { hasAccess } from '../config/adminMenu';
import { STATUTS_CONVERSATION, TYPES_CONTACT, formatDateHeure } from '../utils/whatsapp';

/*
 * Volet « Infos » d'une discussion WhatsApp : contact résolu (client, livreur /
 * employé), colis récents du numéro (lien vers le détail de suivi, « Lier »
 * comme colis de la discussion), réglages (opt-out, langue, statut) et
 * informations (créée le, affectée à, étiquettes de réponse par bouton).
 */

const LANGUES = [
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'Arabe' },
  { code: 'en', label: 'Anglais' }
];

function formatDh(v) {
  const n = Number(v) || 0;
  return `${n.toLocaleString('fr-FR')} DH`;
}

export default function WhatsAppContactPanel({ conversation, contact, onPatch, onSuivi, onClose }) {
  const { user } = useAuth();
  const peutSuivi = hasAccess(user, ['COLIS', 'WHATSAPP_DISCUSSIONS']);
  const peutClient = hasAccess(user, 'CLIENTS');
  const c = conversation;
  const statut = STATUTS_CONVERSATION[c.statut] || { label: c.statut, cls: 'badge-neutral' };

  function toggleOptOut(v) {
    if (!v && !window.confirm('Réactiver les envois automatiques vers ce contact ?')) return;
    onPatch({ optOut: v });
  }

  return (
    <aside className="wa-contact">
      <div className="wa-contact-head">
        <span>
          <User size={16} /> Contact
        </span>
        <button type="button" className="row-action" title="Fermer" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="wa-contact-sec">
        <div className="wa-contact-titre">
          <span className={`wa-type-chip wa-type-${c.typeContact}`}>{TYPES_CONTACT[c.typeContact] || 'Inconnu'}</span>
          <span className={`badge ${statut.cls}`}>{statut.label}</span>
        </div>
        <div className="wa-contact-nom">{c.nom || '—'}</div>
        <div className="mono">{c.phoneAffiche || c.phone}</div>
        {contact?.client && (
          <div className="wa-contact-card">
            <Store size={15} />
            <div>
              <strong>{contact.client.magasin || contact.client.nom}</strong>
              {contact.client.nom && contact.client.magasin !== contact.client.nom && <div className="cell-sub">{contact.client.nom}</div>}
              <div className="cell-sub">Personnel : {contact.client.telAffiche || '—'}</div>
              {contact.client.telMagasinAffiche && contact.client.telMagasinAffiche !== contact.client.telAffiche && (
                <div className="cell-sub">Magasin : {contact.client.telMagasinAffiche}</div>
              )}
              {peutClient && (
                <Link to={`/admin/clients/${contact.client.id}`} className="wa-lien">
                  Ouvrir la fiche client
                </Link>
              )}
            </div>
          </div>
        )}
        {contact?.utilisateur && (
          <div className="wa-contact-card">
            <Bike size={15} />
            <div>
              <strong>{contact.utilisateur.nom}</strong>
              <div className="cell-sub">
                {contact.utilisateur.type === 'livreur' ? 'Livreur' : 'Employé'} · {contact.utilisateur.telAffiche || '—'}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="wa-contact-sec">
        <h4>Colis récents</h4>
        {!contact?.colis?.length ? (
          <div className="cell-sub">Aucun colis pour ce numéro.</div>
        ) : (
          <ul className="wa-contact-colis">
            {contact.colis.map((p) => (
              <li key={p.id} className={p.id === c.dernierColisId ? 'is-lie' : ''}>
                <div className="wa-colis-ligne">
                  <span className="mono">{p.code}</span>
                  <span className="badge" style={p.statutColor ? { background: p.statutColor } : undefined}>
                    {p.statutLabel || p.statut}
                  </span>
                </div>
                <div className="cell-sub">
                  {p.destinataire || '—'} · {p.ville || '—'} · {formatDh(p.crbt)}
                  {p.magasin ? ` · ${p.magasin}` : ''}
                </div>
                <div className="wa-colis-actions">
                  {peutSuivi && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSuivi({ parcel_id: p.id, parcel_code: p.code })}>
                      <Route size={13} /> Suivi
                    </button>
                  )}
                  {p.id !== c.dernierColisId ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPatch({ dernierColis: p.id })}>
                      <Link2 size={13} /> Lier
                    </button>
                  ) : (
                    <span className="cell-sub">Colis de la discussion</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wa-contact-sec">
        <h4>Réglages</h4>
        <div className="wa-switch-row">
          <Toggle checked={c.optOut} onChange={toggleOptOut} label="Bloquer les envois (opt-out)" />
          <span>Envois bloqués (opt-out)</span>
        </div>
        <label className="wa-field">
          <span className="field-label">Langue des modèles</span>
          <select className="modal-select" value={c.langue || 'fr'} onChange={(e) => onPatch({ langue: e.target.value })}>
            {LANGUES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="wa-contact-sec">
        <h4>Informations</h4>
        <dl className="wa-meta">
          <dt>Créée le</dt>
          <dd>{formatDateHeure(c.createdAt) || '—'}</dd>
          <dt>Dernier message</dt>
          <dd>{formatDateHeure(c.dernierLe) || '—'}</dd>
          <dt>Dernier entrant</dt>
          <dd>{formatDateHeure(c.dernierEntrantLe) || '—'}</dd>
          <dt>Affectée à</dt>
          <dd>{c.affecteNom || 'Non affectée'}</dd>
          {c.etiquettes?.length > 0 && (
            <>
              <dt>Réponses bouton</dt>
              <dd>
                {c.etiquettes.map((e) => (
                  <span key={e} className="wa-chip">
                    {e.replace(/^bouton:/, '')}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}
