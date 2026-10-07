import { useEffect, useState } from 'react';
import { Clock, Image as ImageIcon, Save, Send, User, X } from 'lucide-react';
import api from '../api/client';
import { statutLabel } from '../utils/statuts';
import { isValidPhone, PHONE_ERROR } from '../utils/phone';
import { isValidParcelCode, PARCEL_CODE_ERROR } from '../utils/parcelCode';
import SearchableSelect from './SearchableSelect';
import FraisMontantNotice from './FraisMontantNotice';

/*
 * Modales des colis côté CLIENT (page Liste des colis) : squelette commun
 * (ParcelModal), détail de suivi (SuiviModal), information colis (InfoModal)
 * et modification du colis (EditModal — modification directe en attente de
 * ramassage, demande à valider par l'administration ensuite). Miroir de
 * components/ParcelModals.jsx (admin), sur les endpoints /parcels/client/*.
 */

/**
 * Condition d'affichage de l'action « Modifier colis » (page Liste des colis) :
 * tout statut sauf livré / retourné ; le serveur décide
 * ensuite entre modification directe et demande de validation.
 */
export function editVisible(p) {
  return !['DELIVERED', 'RETURNED'].includes(p.parcel_status);
}
/** Timestamp unix (secondes) → "lundi 3 août 2026, à 21:45". */
function formatHistDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const date = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date}, à ${heure}`;
}

/** Libellés des événements de l'historique (parcel_history_data legacy). */
const DATA_LABELS = {
  CREATED: 'Colis créé',
  PARCEL_CREATED: 'Colis créé',
  EDITED: 'Colis modifié',
  PARCEL_EDITED: 'Colis modifié',
  UPDATED: 'Colis modifié',
  MODIFIED: 'Colis modifié',
  CLIENT_BLOCK: 'Expédition bloquée par le client',
  CLIENT_UNBLOCK: 'Expédition débloquée par le client',
  LIVREUR_CHANGED: 'Livreur changé'
};

/** Squelette commun des modales colis : entête avec code du colis + croix de fermeture. */
export function ParcelModal({ code, subtitle, onClose, children, wide, className }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal ${wide ? 'modal-wide' : ''} ${className || ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main mono">{code || '—'}</div>
              <div className="cell-sub">{subtitle}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Modale "Détail de suivi" : historique des statuts du colis (timeline) avec la
 * date de chaque action. Pied de modale : livreur affecté et son n° de téléphone
 * (pour un salarié, celui de son compte de fonction "livreur").
 */
export function SuiviModal({ parcel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/client/${parcel.parcel_id}/suivi`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Détail de suivi" onClose={onClose}>
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <div className="modal-loading">Chargement…</div>}
      {data && (
        <>
          <div className="suivi-section-title">Historique</div>
          {data.entries.length === 0 ? (
            <div className="modal-loading">Aucun historique pour ce colis.</div>
          ) : (
            <ul className="suivi-timeline">
              {data.entries.map((e) => (
                <li key={e.id} className="suivi-item">
                  <span className="suivi-dot" />
                  <div>
                    <div className="suivi-label">
                      {e.status ? (
                        <span
                          className="badge"
                          style={e.status_color ? { background: e.status_color } : undefined}
                        >
                          {statutLabel(e.status)}
                        </span>
                      ) : (
                        <strong>{DATA_LABELS[e.data] || e.data || e.comment || 'Action'}</strong>
                      )}
                      {/* Photo jointe par le livreur / l'admin au changement de statut. */}
                      {e.status && e.preuve && (
                        <a
                          className="suivi-preuve"
                          href={e.preuve}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Voir la photo preuve de ce statut"
                        >
                          <ImageIcon size={13} /> Voir la preuve
                        </a>
                      )}
                    </div>
                    {e.status && e.comment && <div className="cell-sub">{e.comment}</div>}
                    {/* e.member : membre de l'équipe à l'origine de l'action (page /client/equipe). */}
                    <div className="suivi-date">
                      <Clock size={13} /> {formatHistDate(e.time)}
                      {e.member && (
                        <span className="suivi-user">
                          <User size={13} /> {e.member}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.livreur && (
            <div className="suivi-livreur">
              <span className="field-label">Livreur</span>
              <span>
                <strong>{data.livreur.name}</strong>
                {data.livreur.phone ? ` — ${data.livreur.phone}` : ''}
              </span>
            </div>
          )}
        </>
      )}
    </ParcelModal>
  );
}

/**
 * Modale "Information colis" : détails du colis ; pour un colis de stock,
 * la marchandise est la liste des produits (delevery_parcel_content).
 */
export function InfoModal({ parcel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/client/${parcel.parcel_id}/details`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  const rows = data
    ? [
        ['Destinataire', data.parcel_receiver],
        ['N° téléphone', data.parcel_phone],
        ['Ville de destination', data.ville],
        ['Adresse', data.parcel_address],
        ['Prix (DH)', data.parcel_price],
        ['Commentaire', data.parcel_note]
      ]
    : [];

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Information colis" onClose={onClose}>
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <div className="modal-loading">Chargement…</div>}
      {data && (
        <>
          <dl className="detail-grid">
            {rows.map(([label, value]) => (
              <div key={label} className="detail-row">
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
            {data.parcel_from_stock !== 1 && (
              <>
                <div className="detail-row">
                  <dt>Marchandise</dt>
                  <dd>{data.parcel_product_name || '—'}</dd>
                </div>
                <div className="detail-row">
                  <dt>Quantité</dt>
                  <dd>{data.parcel_product_qty || '—'}</dd>
                </div>
              </>
            )}
          </dl>
          {data.parcel_from_stock === 1 && (
            <div className="info-produits">
              <span className="field-label">Marchandise (stock)</span>
              {data.produits.length === 0 ? (
                <div className="cell-sub">Aucun produit lié à ce colis.</div>
              ) : (
                <ul>
                  {data.produits.map((pr, i) => (
                    <li key={i}>
                      {pr.produit || '—'}
                      {pr.variante ? ` — ${pr.variante}` : ''} <b>× {pr.qty}</b>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </ParcelModal>
  );
}

/**
 * Modale "Modifier colis" : code colis (colis en attente de ramassage
 * seulement — data.code_editable ; après enregistrement d'un nouveau code, la
 * modale affiche la confirmation « Vous avez modifié le code colis » au lieu
 * de se fermer), destinataire, téléphone, ville, adresse,
 * commentaire, prix, marchandise / quantité (colis normal uniquement) et
 * options ouverture / essayage / colis à remplacer.
 *  - Colis en attente de ramassage : modification directe, tracée
 *    (delevery_parcel_modification) et visible dans le suivi admin. Si
 *    l'étiquette est déjà imprimée, elle devient obsolète (badge "Étiquette à
 *    réimprimer" + refus au scan ramassage tant qu'elle n'est pas réimprimée).
 *  - Tout autre statut sauf livré / retourné (requires_validation) : rien
 *    n'est modifié tout de suite, une demande est envoyée à l'administration
 *    pour validation ; une seule demande en attente par colis (pending_demande).
 *  - Ville de destination modifiable uniquement en attente de ramassage /
 *    ramassé (data.city_editable, décidé par le serveur) : au-delà, le champ
 *    est verrouillé et un message renvoie vers le service client (bouton
 *    « Réclamation » du colis).
 */
export function EditModal({ parcel, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  // { ancien, nouveau } après enregistrement d'un nouveau code colis : la
  // modale reste ouverte sur la confirmation.
  const [codeModifie, setCodeModifie] = useState(null);

  useEffect(() => {
    api
      .get(`/parcels/client/${parcel.parcel_id}/edit`)
      .then((res) => {
        setData(res.data);
        setForm({
          receiver: res.data.receiver,
          phone: res.data.phone,
          city: String(res.data.city || ''),
          address: res.data.address,
          note: res.data.note,
          price: String(res.data.price),
          product: res.data.product,
          qty: String(res.data.qty || 1),
          open: Number(res.data.open) === 1 ? 1 : 0,
          essayage: Number(res.data.essayage) === 1 ? 1 : 0,
          replace: Number(res.data.replace) === 1 ? 1 : 0,
          code: res.data.parcel_code || ''
        });
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    if (!form.city) {
      setError('Veuillez sélectionner une ville de destination.');
      return;
    }
    if (!isValidPhone(form.phone)) {
      setError(PHONE_ERROR);
      return;
    }
    // Code colis (colis en attente de ramassage) : ne peut pas être supprimé
    // et doit rester alphanumérique, 5 caractères minimum.
    if (codeEditable && !form.code.trim()) {
      setError('Le code colis est obligatoire : il ne peut pas être supprimé.');
      return;
    }
    if (codeEditable && !isValidParcelCode(form.code.trim())) {
      setError(PARCEL_CODE_ERROR);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await api.put(`/parcels/client/${parcel.parcel_id}`, {
        // Code envoyé seulement quand il est modifiable (colis en attente de
        // ramassage) ; le serveur refuse tout changement hors de ce statut.
        ...(codeEditable ? { code: form.code.trim() } : {}),
        receiver: form.receiver,
        phone: form.phone,
        city: Number(form.city),
        address: form.address,
        note: form.note,
        price: Number(form.price),
        product: form.product,
        qty: form.qty,
        open: form.open,
        essayage: form.essayage,
        replace: form.replace
      });
      // Colis déjà ramassé : demande enregistrée, rien à mettre à jour dans la
      // liste tant que l'admin n'a pas validé.
      if (Number(res.data.pending_validation) === 1) {
        setSent(true);
        return;
      }
      const nouveauCode = Number(res.data.code_modifie) === 1;
      onSaved(parcel.parcel_id, {
        parcel_receiver: res.data.parcel_receiver,
        parcel_phone: res.data.parcel_phone,
        parcel_price: res.data.parcel_price,
        parcel_replace: res.data.parcel_replace,
        ville: res.data.ville,
        label_stale: res.data.label_stale,
        ...(nouveauCode ? { parcel_code: res.data.parcel_code } : {})
      });
      if (nouveauCode) {
        // Confirmation du nouveau code dans la modale (pas d'alerte navigateur).
        setSaving(false);
        setCodeModifie({ ancien: parcel.parcel_code, nouveau: res.data.parcel_code });
        return;
      }
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de l’enregistrement.');
      setSaving(false);
    }
  }

  // Ouverture interdite → essayage forcément interdit aussi (même règle que la création).
  const setOpen = (v) => setForm((f) => ({ ...f, open: v, essayage: v === 0 ? 0 : f.essayage }));

  const pills = (name, value, onChange, disabled = false) => (
    <div className="radio-group">
      {[
        [1, 'Oui'],
        [0, 'Non']
      ].map(([v, text]) => (
        <label
          key={v}
          className={`radio-pill ${value === v ? 'radio-pill-checked' : ''} ${disabled ? 'radio-pill-disabled' : ''}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === v}
            disabled={disabled}
            onChange={() => onChange(v)}
          />
          {text}
        </label>
      ))}
    </div>
  );

  const requiresValidation = Number(data?.requires_validation) === 1;
  /** Code colis modifiable : colis en attente de ramassage seulement (serveur). */
  const codeEditable = Number(data?.code_editable) === 1;
  /**
   * Ville de destination verrouillée une fois le colis expédié (statut hors
   * WAITING_PICKUP / PICKED_UP) : le changement passe par le service client
   * via le bouton « Réclamation » du colis.
   */
  const cityEditable = Number(data?.city_editable) === 1;

  return (
    <ParcelModal
      code={codeModifie ? codeModifie.nouveau : parcel.parcel_code}
      subtitle={codeModifie ? 'Code colis modifié' : 'Modifier colis'}
      onClose={onClose}
      wide
    >
      {!form && !error && <div className="modal-loading">Chargement…</div>}
      {!form && error && <div className="form-error">{error}</div>}
      {codeModifie && (
        <>
          <div className="form-success">Vous avez modifié le code colis.</div>
          <div className="code-modif">
            <span className="code-modif-old mono">{codeModifie.ancien || '—'}</span>
            <span className="code-modif-arrow" aria-hidden="true">
              →
            </span>
            <span className="code-modif-new mono">{codeModifie.nouveau}</span>
          </div>
          <div className="cell-sub">
            Si l'étiquette de ce colis est déjà imprimée, réimprimez-la : l'ancienne étiquette
            (ancien code) ne sera plus reconnue au ramassage.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      )}
      {sent && (
        <>
          <div className="form-success">
            Votre demande de modification a bien été envoyée. Les changements seront appliqués
            après validation par l’administration.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      )}
      {!sent && form && data && Number(data.pending_demande) === 1 && (
        <>
          <div className="form-error">
            Une demande de modification est déjà en attente de validation pour ce colis.
            Vous pourrez le modifier à nouveau une fois la demande traitée par l’administration.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      )}
      {!sent && !codeModifie && form && data && Number(data.pending_demande) !== 1 && (
        <form onSubmit={save}>
          {requiresValidation && (
            <div className="remb-info">
              Ce colis est déjà pris en charge : vos modifications ne seront appliquées
              qu’après validation par l’administration.
            </div>
          )}
          <div className="modal-form-grid">
            {codeEditable && (
              <label className="modal-form-full">
                Code colis
                <input
                  type="text"
                  required
                  maxLength={100}
                  className="mono"
                  value={form.code}
                  onChange={setField('code')}
                />
                <span className="cell-sub">
                  Modifiable uniquement tant que le colis est en attente de ramassage. Lettres et
                  chiffres uniquement, 5 caractères minimum ; le code ne peut pas être supprimé.
                </span>
              </label>
            )}
            <label>
              Destinataire
              <input type="text" required maxLength={250} value={form.receiver} onChange={setField('receiver')} />
            </label>
            <label>
              Téléphone
              <input type="text" required maxLength={50} value={form.phone} onChange={setField('phone')} />
            </label>
            <div>
              <span className="field-label">Ville de destination</span>
              <SearchableSelect
                value={form.city}
                onChange={(v) => setForm((f) => ({ ...f, city: v }))}
                placeholder="— Sélectionner —"
                options={data.cities.map((c) => ({ value: c.id, label: c.label }))}
                disabled={!cityEditable}
              />
              {!cityEditable && (
                <span className="cell-sub edit-city-hint">
                  Changement de ville après expédition : contactez le service client via le
                  bouton « Réclamation » du colis.
                </span>
              )}
            </div>
            <label>
              Prix (DH)
              <input type="number" min="0" step="0.01" required value={form.price} onChange={setField('price')} />
            </label>
            {/* Nouveau montant > 2 500 DH : frais supp automatiques réajustés par le serveur. */}
            {Number(form.price) !== Number(data.price) && (
              <div className="modal-form-full">
                <FraisMontantNotice price={form.price} regle={data.frais_montant} />
              </div>
            )}
            <label className="modal-form-full">
              Adresse
              <textarea rows={2} required value={form.address} onChange={setField('address')} />
            </label>
            <label className="modal-form-full">
              Commentaire
              <textarea rows={2} value={form.note} onChange={setField('note')} placeholder="Commentaire (facultatif)…" />
            </label>
            {Number(data.from_stock) !== 1 && (
              <>
                <label>
                  Marchandise
                  <input
                    type="text"
                    maxLength={250}
                    value={form.product}
                    onChange={setField('product')}
                    placeholder="Marchandise (facultatif)…"
                  />
                </label>
                <label>
                  Quantité
                  <input type="number" min="1" max="9999" step="1" value={form.qty} onChange={setField('qty')} />
                </label>
              </>
            )}
            <div className="option-row">
              <span className="field-label">Ouverture autorisée</span>
              {pills('open', form.open, setOpen)}
            </div>
            <div className="option-row">
              <span className="field-label">Essayage autorisé</span>
              {pills('essayage', form.essayage, (v) => setForm((f) => ({ ...f, essayage: v })), form.open === 0)}
            </div>
            <div className="option-row">
              <span className="field-label">Colis à remplacer</span>
              {pills('replace', form.replace, (v) => setForm((f) => ({ ...f, replace: v })))}
            </div>
          </div>
          {!requiresValidation && (
            <div className="cell-sub">
              Si l'étiquette de ce colis est déjà imprimée, réimprimez-la après modification :
              l'ancienne étiquette sera refusée au ramassage.
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {requiresValidation ? (
                <>
                  <Send size={15} /> {saving ? 'Envoi…' : 'Envoyer la demande'}
                </>
              ) : (
                <>
                  <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </ParcelModal>
  );
}
