import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, Search, Send, X } from 'lucide-react';
import api from '../api/client';
import SearchableSelect from './SearchableSelect';
import WhatsAppModelePreview from './WhatsAppModelePreview';
import { isValidPhone, PHONE_ERROR } from '../utils/phone';
import { libelleModele, TYPES_CONTACT } from '../utils/whatsapp';

/*
 * Envoi d'un modèle WhatsApp approuvé — une modale, trois entrées :
 *  - mode 'nouvelle' (page Discussions) : choix du destinataire (colis + audience,
 *    client, livreur ou numéro) puis modèle → POST /whatsapp/conversations ;
 *  - mode 'colis' (fiche colis, liste Colis) : audience destinataire / client
 *    expéditeur / livreur → POST /whatsapp/colis/:id/envoyer ;
 *  - mode 'conversation' (fenêtre de 24 h fermée) → POST /whatsapp/conversations/:id/messages.
 * Les variables du modèle sont préremplies depuis le colis (correspondance par
 * défaut du modèle, POST /whatsapp/modeles/:id/apercu) et restent modifiables.
 */

const AUDIENCES_COLIS = [
  { value: 'destinataire', label: 'Destinataire' },
  { value: 'expediteur', label: 'Client expéditeur' },
  { value: 'livreur', label: 'Livreur' }
];

const CIBLES = [
  { value: 'colis', label: 'Colis' },
  { value: 'client', label: 'Client' },
  { value: 'livreur', label: 'Livreur' },
  { value: 'numero', label: 'Numéro' }
];

function Pills({ options, value, onChange, name }) {
  return (
    <div className="radio-group wa-pills">
      {options.map((o) => (
        <label key={o.value} className={`radio-pill ${value === o.value ? 'radio-pill-checked' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export default function WhatsAppEnvoiModeleModal({ mode = 'nouvelle', parcel = null, conversation = null, onClose, onSent }) {
  const [modeles, setModeles] = useState([]);
  const [referentiels, setReferentiels] = useState({ magasins: [], livreurs: [] });
  const [cibleType, setCibleType] = useState(parcel ? 'colis' : 'colis');
  const [audience, setAudience] = useState('destinataire');
  const [recherche, setRecherche] = useState('');
  const [resultats, setResultats] = useState([]);
  const [colis, setColis] = useState(parcel ? { id: parcel.parcel_id, code: parcel.parcel_code, destinataire: parcel.parcel_receiver } : null);
  const [clientId, setClientId] = useState('');
  const [livreurId, setLivreurId] = useState('');
  const [phone, setPhone] = useState('');
  const [modeleId, setModeleId] = useState('');
  const [params, setParams] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const charges = [api.get('/whatsapp/modeles', { params: { utilisables: 1 } })];
    if (mode === 'nouvelle') charges.push(api.get('/whatsapp/referentiels'));
    Promise.all(charges)
      .then(([m, r]) => {
        if (cancelled) return;
        setModeles(m.data.rows || []);
        if (r) setReferentiels(r.data);
      })
      .catch((err) => !cancelled && setError(err.response?.data?.message || 'Chargement impossible.'))
      .finally(() => !cancelled && setChargement(false));
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const modele = useMemo(() => modeles.find((m) => String(m.id) === String(modeleId)) || null, [modeles, modeleId]);

  // Préremplissage des variables à partir du colis (ou du dernier colis de la discussion).
  useEffect(() => {
    if (!modele) {
      setParams([]);
      return;
    }
    let cancelled = false;
    const parcelId = colis?.id || null;
    api
      .post(`/whatsapp/modeles/${modele.id}/apercu`, { parcelId, conversationId: conversation?.id || null })
      .then((res) => !cancelled && setParams((res.data.params || []).slice(0, modele.nbVariables)))
      .catch(() => !cancelled && setParams(Array.from({ length: modele.nbVariables }, () => '')));
    return () => {
      cancelled = true;
    };
  }, [modele, colis?.id, conversation?.id]);

  async function chercherColis(e) {
    e?.preventDefault();
    const q = recherche.trim();
    if (q.length < 3) return;
    try {
      const res = await api.get('/whatsapp/colis/recherche', { params: { q } });
      setResultats(res.data.rows || []);
      if ((res.data.rows || []).length === 1) setColis(res.data.rows[0]);
    } catch (err) {
      setError(err.response?.data?.message || 'Recherche impossible.');
    }
  }

  function cibleValide() {
    if (mode !== 'nouvelle') return true;
    if (cibleType === 'colis') return Boolean(colis);
    if (cibleType === 'client') return Boolean(clientId);
    if (cibleType === 'livreur') return Boolean(livreurId);
    return isValidPhone(phone);
  }

  const paramsOk = modele && params.length === modele.nbVariables && params.every((p) => String(p || '').trim());

  async function envoyer(e) {
    e.preventDefault();
    if (!modele || !paramsOk || !cibleValide() || busy) return;
    setBusy(true);
    setError('');
    const message = { modele: modele.nom, langue: modele.langue, params: params.map((p) => String(p).trim()) };
    try {
      let res;
      if (mode === 'conversation' && conversation) {
        res = await api.post(`/whatsapp/conversations/${conversation.id}/messages`, message);
      } else if (mode === 'colis' && parcel) {
        res = await api.post(`/whatsapp/colis/${parcel.parcel_id}/envoyer`, { audience, ...message });
      } else {
        const cible =
          cibleType === 'colis'
            ? { parcelId: colis.id, audience }
            : cibleType === 'client'
              ? { customerId: Number(clientId) }
              : cibleType === 'livreur'
                ? { usersId: Number(livreurId) }
                : { phone: phone.trim() };
        res = await api.post('/whatsapp/conversations', { ...cible, ...message });
      }
      onSent?.(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Échec de l'envoi.");
    } finally {
      setBusy(false);
    }
  }

  const titre = mode === 'colis' ? 'Message WhatsApp' : mode === 'conversation' ? 'Envoyer un modèle' : 'Nouvelle discussion';
  const sousTitre =
    mode === 'colis'
      ? `Colis ${parcel?.parcel_code || ''}`
      : mode === 'conversation'
        ? 'Fenêtre de 24 h fermée : seul un modèle approuvé peut être envoyé.'
        : 'Le premier message vers un contact doit être un modèle approuvé par Meta.';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide wa-crm wa-envoi-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <MessageCircle size={20} />
            <div>
              <div className="cell-main">{titre}</div>
              <div className="cell-sub">{sousTitre}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {chargement ? (
          <div className="modal-loading">Chargement…</div>
        ) : (
          <form onSubmit={envoyer} className="wa-envoi-form">
            {mode === 'nouvelle' && (
              <div className="wa-envoi-bloc">
                <span className="field-label">Destinataire</span>
                <Pills options={CIBLES} value={cibleType} onChange={setCibleType} name="cible" />
                {cibleType === 'colis' && (
                  <div className="wa-envoi-colis">
                    <div className="wa-envoi-recherche">
                      <input
                        type="text"
                        value={recherche}
                        placeholder="Code colis, nom ou téléphone du destinataire"
                        onChange={(e) => setRecherche(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && chercherColis(e)}
                      />
                      <button type="button" className="btn btn-ghost btn-sm" onClick={chercherColis}>
                        <Search size={14} /> Rechercher
                      </button>
                    </div>
                    {resultats.length > 1 && (
                      <SearchableSelect
                        value={colis ? String(colis.id) : ''}
                        onChange={(v) => setColis(resultats.find((r) => String(r.id) === String(v)) || null)}
                        options={resultats.map((r) => ({ value: String(r.id), label: `${r.code} — ${r.destinataire || '—'} (${r.statutLabel || r.statut})` }))}
                        placeholder="Choisir le colis"
                      />
                    )}
                    {colis && (
                      <div className="wa-envoi-colis-card">
                        <span className="mono">{colis.code}</span>
                        <span>{colis.destinataire || '—'}</span>
                        {colis.magasin && <span className="cell-sub">{colis.magasin}</span>}
                        {colis.statutLabel && <span className="badge badge-neutral">{colis.statutLabel}</span>}
                      </div>
                    )}
                  </div>
                )}
                {cibleType === 'client' && (
                  <>
                    <SearchableSelect
                      value={clientId}
                      onChange={setClientId}
                      options={referentiels.magasins.map((m) => ({ value: String(m.id), label: m.label }))}
                      placeholder="Choisir un client (magasin)"
                    />
                    <span className="cell-sub wa-block">Envoi sur le téléphone personnel du client (à défaut, celui du magasin).</span>
                  </>
                )}
                {cibleType === 'livreur' && (
                  <SearchableSelect
                    value={livreurId}
                    onChange={setLivreurId}
                    options={referentiels.livreurs.map((l) => ({ value: String(l.id), label: l.label }))}
                    placeholder="Choisir un livreur"
                  />
                )}
                {cibleType === 'numero' && (
                  <div>
                    <input
                      type="tel"
                      value={phone}
                      placeholder="06XXXXXXXX"
                      maxLength={14}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                    {phone && !isValidPhone(phone) && <span className="field-error wa-block">{PHONE_ERROR}</span>}
                  </div>
                )}
              </div>
            )}

            {(mode === 'colis' || (mode === 'nouvelle' && cibleType === 'colis')) && (
              <div className="wa-envoi-bloc">
                <span className="field-label">Envoyer au</span>
                <Pills options={AUDIENCES_COLIS} value={audience} onChange={setAudience} name="audience" />
              </div>
            )}

            <div className="wa-envoi-bloc">
              <span className="field-label">Modèle de message</span>
              {modeles.length === 0 ? (
                <div className="form-notice">
                  Aucun modèle approuvé et actif. Synchronisez les modèles depuis Meta (API liaison › Modèles de message).
                </div>
              ) : (
                <SearchableSelect
                  value={modeleId}
                  onChange={setModeleId}
                  options={modeles.map((m) => ({ value: String(m.id), label: libelleModele(m) }))}
                  placeholder="Choisir un modèle approuvé"
                />
              )}
            </div>

            {modele && (
              <div className="wa-envoi-grille">
                <div className="wa-params">
                  {modele.nbVariables === 0 && <span className="cell-sub">Ce modèle n'a pas de variable.</span>}
                  {Array.from({ length: modele.nbVariables }, (_, i) => (
                    <label key={i}>
                      <span>{`Variable {{${i + 1}}}`}</span>
                      <input
                        type="text"
                        value={params[i] ?? ''}
                        placeholder={modele.exemples?.[i] || ''}
                        onChange={(e) => setParams((p) => Object.assign([...p], { [i]: e.target.value }))}
                      />
                    </label>
                  ))}
                  {conversation?.typeContactLabel && (
                    <span className="cell-sub">Contact : {TYPES_CONTACT[conversation.typeContact] || conversation.typeContactLabel}</span>
                  )}
                </div>
                <WhatsAppModelePreview modele={modele} params={params} />
              </div>
            )}

            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Annuler
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !modele || !paramsOk || !cibleValide()}>
                <Send size={15} /> {busy ? 'Envoi…' : 'Envoyer'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
