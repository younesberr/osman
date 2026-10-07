import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Clock, Image as ImageIcon, RefreshCw, Save, User, X } from 'lucide-react';
import api from '../api/client';
import { statutLabel } from '../utils/statuts';
import { isValidPhone, PHONE_ERROR } from '../utils/phone';
import { isValidParcelCode, PARCEL_CODE_ERROR } from '../utils/parcelCode';
import SearchableSelect from './SearchableSelect';
import FraisMontantNotice from './FraisMontantNotice';
import { fraisMontant } from '../utils/fraisMontant';

/*
 * Modales partagées des colis (page admin Colis ; détail de suivi aussi sur
 * les bons et les réclamations ; dashboard livreur) : squelette commun
 * (ParcelModal), détail de suivi (SuiviModal), information colis (InfoModal),
 * modification du colis (EditModal) et changement de statut (StatutModal).
 */

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
      <div className={`modal ${wide ? 'modal-wide' : ''} ${className || ''}`} onClick={(e) => e.stopPropagation()}>
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
 * Modale "Détail de suivi" : même timeline que la version client, avec en plus
 * le nom de l'utilisateur de chaque étape et les modifications du colis
 * (kind = 'modif' : date, utilisateur et champs modifiés ancien → nouveau).
 * basePath : '/parcels' (admin, défaut) ou '/livreurs/me/colis' (dashboard
 * livreur, restreint à ses propres colis) — GET `${basePath}/:id/suivi`.
 */
export function SuiviModal({ parcel, onClose, basePath = '/parcels' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`${basePath}/${parcel.parcel_id}/suivi`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id, basePath]);

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
                    {e.kind === 'modif' ? (
                      <>
                        <div className="suivi-label">
                          <strong>{e.by_client === 1 ? 'Colis modifié par le client' : 'Colis modifié'}</strong>
                        </div>
                        <ul className="suivi-changes">
                          {e.changes.map((c) => (
                            <li key={c.field}>
                              {c.label} : <s>{c.old || '—'}</s> → <b>{c.new || '—'}</b>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>
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
                          {/* Photo jointe au changement de statut (modale « Changer statut »). */}
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
                        {/* Commentaire d'un statut, ou détail d'un événement
                            (ex. « Livreur changé » : ancien → nouveau livreur). */}
                        {e.comment && (e.status || e.data) && (
                          <div className="cell-sub">{e.comment}</div>
                        )}
                      </>
                    )}
                    {/* e.member : membre de l'équipe du client à l'origine de l'action
                        (affiché seul sur une étape client, après le magasin sur une modif). */}
                    <div className="suivi-date">
                      <Clock size={13} /> {formatHistDate(e.time)}
                      {(e.user || e.member) && (
                        <span className="suivi-user">
                          <User size={13} />{' '}
                          {e.user ? (e.member ? `${e.user} — ${e.member}` : e.user) : e.member}
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
 * Modale "Modifier colis" : code colis (colis en attente de ramassage
 * seulement — data.code_editable ; après enregistrement d'un nouveau code, la
 * modale affiche la confirmation « Vous avez modifié le code colis » au lieu
 * de se fermer), ville de ramassage (en tête), destinataire,
 * téléphone, ville, adresse, commentaire, prix, frais (livraison /
 * supplémentaires / retour / refus) et colis à remplacer. Le changement de ville de
 * ramassage change aussi l'agence du colis (parcel_agence). Changer la ville
 * de destination ou de ramassage recalcule les frais de livraison / retour /
 * refus selon la cascade tarifaire (GET /parcels/:id/tarif), l'admin pouvant
 * encore les ajuster avant d'enregistrer. Chaque
 * modification est tracée (delevery_parcel_modification) et visible dans le
 * détail de suivi avec la date, l'utilisateur et les champs modifiés.
 * Verrouillage partiel selon la facturation (data.lock, calculé côté serveur) :
 * colis sur une facture livreur → seuls les frais et « Colis à remplacer »
 * restent modifiables ; sur une facture client → seul « Colis à remplacer ».
 * Les autres champs sont affichés désactivés, avec le motif en tête.
 */
export function EditModal({ parcel, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // { ancien, nouveau } après enregistrement d'un nouveau code colis : la
  // modale reste ouverte sur la confirmation.
  const [codeModifie, setCodeModifie] = useState(null);

  /** Champ modifiable selon le verrou facturation (tout modifiable sans verrou). */
  const canEdit = (key) => !data?.lock || data.lock.fields.includes(key);
  /** Code colis modifiable : colis en attente de ramassage seulement (serveur). */
  const codeEditable = Number(data?.code_editable) === 1;

  useEffect(() => {
    api
      .get(`/parcels/${parcel.parcel_id}/edit`)
      .then((res) => {
        setData(res.data);
        setForm({
          receiver: res.data.receiver,
          phone: res.data.phone,
          city: String(res.data.city || ''),
          address: res.data.address,
          note: res.data.note,
          price: String(res.data.price),
          deliveredFees: String(res.data.deliveredFees),
          extraFees: String(res.data.extraFees),
          returnedFees: String(res.data.returnedFees),
          refusedFees: String(res.data.refusedFees),
          replace: Number(res.data.replace) === 1 ? 1 : 0,
          pickupCity: String(res.data.pickupCity || ''),
          code: res.data.parcel_code || ''
        });
      })
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Prix modifié → frais supp automatiques (20 DH par tranche de 2 500 DH
  // au-delà de 2 500 DH, option du client du colis) réajustés dans le champ
  // « Frais supplémentaires » : part de l'ancien prix retirée, part du nouveau
  // ajoutée, frais posés à la main conservés (même règle que le serveur côté client).
  const setPriceField = (e) => {
    const value = e.target.value;
    setForm((f) => {
      const regle = data?.frais_montant;
      const delta = fraisMontant(value, regle) - fraisMontant(f.price, regle);
      const extraFees =
        delta !== 0 && canEdit('extraFees')
          ? String(Math.max(0, (Number(f.extraFees) || 0) + delta))
          : f.extraFees;
      return { ...f, price: value, extraFees };
    });
  };

  // Recalcule les frais (livraison / retour / refus) quand la ville de
  // destination ou de ramassage change, selon la cascade tarifaire du client
  // du colis (tarif personnalisé → ligne « Autre » du client → matrice ramassage
  // → destination → tarif par défaut). Le compteur ignore les réponses obsolètes si l'admin change
  // plusieurs fois de ville rapidement.
  const tarifSeq = useRef(0);
  async function refreshFees(city, pickupCity) {
    if (!(Number(city) > 0) || !(Number(pickupCity) > 0)) return;
    const seq = ++tarifSeq.current;
    try {
      const res = await api.get(`/parcels/${parcel.parcel_id}/tarif`, {
        params: { city, pickupCity }
      });
      if (seq !== tarifSeq.current) return;
      setForm((f) =>
        f && {
          ...f,
          deliveredFees: String(res.data.livraison),
          returnedFees: String(res.data.retour),
          refusedFees: String(res.data.refuse)
        }
      );
    } catch {
      // Aucun tarif pour cette combinaison : frais actuels laissés tels quels.
    }
  }
  const setCityField = (key) => (value) => {
    setForm((f) => ({ ...f, [key]: value }));
    refreshFees(key === 'city' ? value : form.city, key === 'pickupCity' ? value : form.pickupCity);
  };

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    // Contrôles limités aux champs modifiables (un champ verrouillé garde sa
    // valeur actuelle, revérifiée côté serveur).
    if ((canEdit('pickupCity') && !form.pickupCity) || (canEdit('city') && !form.city)) {
      setError('Veuillez sélectionner les villes de ramassage et de destination.');
      return;
    }
    if (canEdit('phone') && !isValidPhone(form.phone)) {
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
      const res = await api.put(`/parcels/${parcel.parcel_id}`, {
        // Code envoyé seulement quand il est modifiable (colis en attente de
        // ramassage) ; le serveur refuse tout changement hors de ce statut.
        ...(codeEditable ? { code: form.code.trim() } : {}),
        receiver: form.receiver,
        phone: form.phone,
        city: Number(form.city),
        address: form.address,
        note: form.note,
        price: Number(form.price),
        deliveredFees: Number(form.deliveredFees),
        extraFees: Number(form.extraFees),
        returnedFees: Number(form.returnedFees),
        refusedFees: Number(form.refusedFees),
        replace: form.replace,
        pickupCity: Number(form.pickupCity)
      });
      const nouveauCode = Number(res.data.code_modifie) === 1;
      onSaved(parcel.parcel_id, {
        parcel_receiver: res.data.parcel_receiver,
        parcel_phone: res.data.parcel_phone,
        parcel_price: res.data.parcel_price,
        ville: res.data.ville,
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

  return (
    <ParcelModal
      code={codeModifie ? codeModifie.nouveau : parcel.parcel_code}
      subtitle={codeModifie ? 'Code colis modifié' : 'Modifier colis'}
      onClose={onClose}
      className="modal-edit-colis"
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
            (ancien code) ne sera plus reconnue au scan.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      )}
      {!codeModifie && form && data && (
        <form onSubmit={save}>
          {data.lock?.message && <div className="form-notice">{data.lock.message}</div>}
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
            <div className="modal-form-full edit-ramassage">
              <span className="field-label">Ville de ramassage</span>
              <SearchableSelect
                value={form.pickupCity}
                onChange={setCityField('pickupCity')}
                placeholder="— Sélectionner —"
                options={data.pickupCities.map((c) => ({ value: c.id, label: c.label }))}
                disabled={!canEdit('pickupCity')}
              />
            </div>
            <label className="modal-form-full">
              Destinataire
              <input
                type="text"
                required
                maxLength={250}
                value={form.receiver}
                onChange={setField('receiver')}
                disabled={!canEdit('receiver')}
              />
            </label>
            <label>
              Téléphone
              <input
                type="text"
                required
                maxLength={50}
                value={form.phone}
                onChange={setField('phone')}
                disabled={!canEdit('phone')}
              />
            </label>
            <div>
              <span className="field-label">Ville</span>
              <SearchableSelect
                value={form.city}
                onChange={setCityField('city')}
                placeholder="— Sélectionner —"
                options={data.cities.map((c) => ({ value: c.id, label: c.label }))}
                disabled={!canEdit('city')}
              />
            </div>
            <label className="modal-form-full">
              Adresse
              <textarea
                rows={2}
                required
                value={form.address}
                onChange={setField('address')}
                disabled={!canEdit('address')}
              />
            </label>
            <label className="modal-form-full">
              Commentaire
              <textarea
                rows={2}
                value={form.note}
                onChange={setField('note')}
                placeholder="Commentaire (facultatif)…"
                disabled={!canEdit('note')}
              />
            </label>
            <label>
              Prix (DH)
              <input
                type="number"
                min="0"
                step="0.01"
                required
                value={form.price}
                onChange={setPriceField}
                disabled={!canEdit('price')}
              />
            </label>
            {/* Nouveau prix > 2 500 DH : frais supp automatiques reportés dans « Frais supplémentaires ». */}
            {Number(form.price) !== Number(data.price) && (
              <div className="modal-form-full">
                <FraisMontantNotice price={form.price} regle={data.frais_montant} />
              </div>
            )}
            <label>
              Frais de livraison (DH)
              <input
                type="number"
                min="0"
                step="1"
                required
                value={form.deliveredFees}
                onChange={setField('deliveredFees')}
                disabled={!canEdit('deliveredFees')}
              />
            </label>
            <label>
              Frais supplémentaires (DH)
              <input
                type="number"
                min="0"
                step="1"
                required
                value={form.extraFees}
                onChange={setField('extraFees')}
                disabled={!canEdit('extraFees')}
              />
            </label>
            <label>
              Frais de retour (DH)
              <input
                type="number"
                min="0"
                step="1"
                required
                value={form.returnedFees}
                onChange={setField('returnedFees')}
                disabled={!canEdit('returnedFees')}
              />
            </label>
            <label>
              Frais de refus (DH)
              <input
                type="number"
                min="0"
                step="1"
                required
                value={form.refusedFees}
                onChange={setField('refusedFees')}
                disabled={!canEdit('refusedFees')}
              />
            </label>
            <div className="option-row">
              <span className="field-label">Colis à remplacer</span>
              <div className="radio-group">
                {[
                  [1, 'Oui'],
                  [0, 'Non']
                ].map(([v, text]) => (
                  <label
                    key={v}
                    className={`radio-pill ${form.replace === v ? 'radio-pill-checked' : ''} ${
                      canEdit('replace') ? '' : 'radio-pill-disabled'
                    }`}
                  >
                    <input
                      type="radio"
                      name="replace"
                      checked={form.replace === v}
                      disabled={!canEdit('replace')}
                      onChange={() => setForm((f) => ({ ...f, replace: v }))}
                    />
                    {text}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {(canEdit('city') || canEdit('pickupCity')) && (
            <div className="cell-sub">
              Le changement de ville de ramassage change aussi l'agence du colis. Le changement de
              ville (destination ou ramassage) recalcule automatiquement les frais de livraison, de
              retour et de refus.
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      )}
    </ParcelModal>
  );
}

/* Statuts au commentaire livreur obligatoire / à date à la place du commentaire. */
const STATUTS_COMMENT_OBLIGATOIRE = ['REFUSE', 'CANCELED'];
const STATUTS_CHAMP_DATE = ['PROGRAMMER', 'POSTPONED'];

/* Photo preuve : formats acceptés côté serveur (middleware preuveStatut). */
const PREUVE_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
const PREUVE_MAX_MO = 8;

/**
 * Modale "Changer statut" : liste des statuts actifs + commentaire du livreur
 * (facultatif, obligatoire pour Refusé / Annulé) ; pour Programmé / Reporté le
 * commentaire est remplacé par un champ date. Une photo « preuve » facultative
 * peut être jointe (envoi en multipart/form-data) : elle est affichée en face
 * du statut dans le détail de suivi, côté admin comme côté client.
 * basePath : '/parcels' (admin, défaut) ou '/livreurs/me/colis' (dashboard
 * livreur) — mêmes sous-chemins /statuts/actifs et /:id/statut.
 */
export function StatutModal({ parcel, onClose, onSaved, basePath = '/parcels' }) {
  const [statuts, setStatuts] = useState([]);
  const [code, setCode] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [date, setDate] = useState('');
  const [preuve, setPreuve] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    api
      .get(`${basePath}/statuts/actifs`)
      .then((res) => setStatuts(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, []);

  // Aperçu local de la photo choisie (URL objet libérée au changement / à la fermeture).
  const apercu = useMemo(() => (preuve ? URL.createObjectURL(preuve) : ''), [preuve]);
  useEffect(() => () => apercu && URL.revokeObjectURL(apercu), [apercu]);

  function choisirPreuve(e) {
    const file = e.target.files?.[0] || null;
    e.target.value = '';
    if (!file) return;
    if (file.size > PREUVE_MAX_MO * 1024 * 1024) {
      setError(`Photo trop volumineuse (max ${PREUVE_MAX_MO} Mo).`);
      return;
    }
    setError('');
    setPreuve(file);
  }

  const champDate = STATUTS_CHAMP_DATE.includes(code);
  const commentObligatoire = STATUTS_COMMENT_OBLIGATOIRE.includes(code);

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const champs = {
        statut: code,
        commentaire: champDate ? '' : commentaire,
        date: champDate ? date : ''
      };
      // Avec photo : multipart/form-data (champ fichier « preuve ») ; sinon JSON comme avant.
      let corps = champs;
      if (preuve) {
        corps = new FormData();
        Object.entries(champs).forEach(([k, v]) => corps.append(k, v));
        corps.append('preuve', preuve);
      }
      const res = await api.post(`${basePath}/${parcel.parcel_id}/statut`, corps);
      onSaved(parcel.parcel_id, {
        statut: res.data.statut,
        parcel_status: res.data.parcel_status,
        ...(res.data.statut_color ? { statut_color: res.data.statut_color } : {}),
        report_time: res.data.report_time || ''
      });
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du changement de statut.');
      setSaving(false);
    }
  }

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Changer statut" onClose={onClose}>
      <form onSubmit={save}>
        <div className="modal-recap">
          <div className="modal-recap-row">
            <span>Statut actuel</span>
            <span
              className="badge"
              style={parcel.statut_color ? { background: parcel.statut_color } : undefined}
            >
              {statutLabel(parcel.statut)}
            </span>
          </div>
        </div>
        <label>
          Nouveau statut
          <select
            className="modal-select"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          >
            <option value="">— Sélectionner —</option>
            {statuts.map((s) => (
              <option key={s.code} value={s.code}>
                {statutLabel(s.code)}
              </option>
            ))}
          </select>
        </label>
        {champDate ? (
          <label>
            Date {code === 'PROGRAMMER' ? 'programmée' : 'de report'}
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        ) : (
          <label>
            Commentaire du livreur
            <textarea
              rows={3}
              required={commentObligatoire}
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              placeholder={
                commentObligatoire
                  ? 'Commentaire obligatoire pour ce statut…'
                  : 'Commentaire (facultatif)…'
              }
            />
          </label>
        )}
        <div className="preuve-field">
          <span className="field-label">Preuve (photo)</span>
          <input
            ref={fileRef}
            type="file"
            accept={PREUVE_ACCEPT}
            className="preuve-input"
            onChange={choisirPreuve}
          />
          {preuve ? (
            <div className="preuve-row">
              <a className="preuve-thumb" href={apercu} target="_blank" rel="noopener noreferrer" title="Agrandir">
                <img src={apercu} alt="Aperçu de la preuve" />
              </a>
              <div className="preuve-infos">
                <span className="preuve-nom" title={preuve.name}>{preuve.name}</span>
                <span className="upload-hint">{(preuve.size / 1024 / 1024).toFixed(2)} Mo</span>
              </div>
              <div className="preuve-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={saving}>
                  <Camera size={14} /> Remplacer
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreuve(null)} disabled={saving}>
                  <X size={14} /> Retirer
                </button>
              </div>
            </div>
          ) : (
            <div className="preuve-row">
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={saving}>
                <Camera size={15} /> Ajouter une photo
              </button>
              <span className="upload-hint">Facultatif — JPG, PNG ou WEBP, {PREUVE_MAX_MO} Mo max.</span>
            </div>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !code}>
            <RefreshCw size={15} /> {saving ? 'Enregistrement…' : 'Changer statut'}
          </button>
        </div>
      </form>
    </ParcelModal>
  );
}

/**
 * Modale "Information colis" (page Colis) : mêmes détails que
 * la version client, avec en plus une section à gauche présentant le client
 * expéditeur (magasin, nom, téléphone, ville de ramassage, adresse).
 */
export function InfoModal({ parcel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get(`/parcels/${parcel.parcel_id}/details`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id]);

  const rows = data
    ? [
        ['Destinataire', data.parcel_receiver],
        ['N° téléphone', data.parcel_phone],
        ['Ville de destination', data.ville],
        ['Zone', data.zone],
        ['Livreur', data.livreur],
        ['Adresse', data.parcel_address],
        ['Prix (DH)', data.parcel_price],
        ['Commentaire', data.parcel_note]
      ]
    : [];

  const expediteurRows = data?.expediteur
    ? [
        ['Magasin', data.expediteur.store],
        ['Nom', data.expediteur.nom],
        ['Téléphone', data.expediteur.phone],
        ['Email', data.expediteur.email],
        ['Ville de ramassage', data.expediteur.ville_ramassage],
        ['Adresse', data.expediteur.adresse]
      ]
    : [];

  return (
    <ParcelModal code={parcel.parcel_code} subtitle="Information colis" onClose={onClose} wide>
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <div className="modal-loading">Chargement…</div>}
      {data && (
        <div className="info-colis-cols">
          <div className="info-expediteur">
            <span className="field-label">Client expéditeur</span>
            {data.expediteur ? (
              <dl className="detail-grid detail-grid-1col">
                {expediteurRows.map(([label, value]) => (
                  <div key={label} className="detail-row">
                    <dt>{label}</dt>
                    <dd>{value || '—'}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="cell-sub">Expéditeur introuvable.</div>
            )}
          </div>
          <div>
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
          </div>
        </div>
      )}
    </ParcelModal>
  );
}
