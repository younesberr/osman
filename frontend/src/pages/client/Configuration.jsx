import { useEffect, useState } from 'react';
import {
  Phone,
  PackageOpen,
  Save,
  Shirt,
  Lock,
  MessageCircle,
  Undo2,
  ShieldAlert,
  HandCoins,
  FilePen,
  Receipt,
  BadgeCheck
} from 'lucide-react';
import api from '../../api/client';

/* Icône de chaque option de notification WhatsApp (codes du catalogue backend). */
const WA_ICONS = {
  BON_RETOUR_EXPEDIE: Undo2,
  RECLAMATION_TRAITEE: ShieldAlert,
  REMBOURSEMENT: HandCoins,
  MODIFICATION_COLIS: FilePen,
  FACTURE_ENREGISTREE: Receipt,
  FACTURE_PAYEE: BadgeCheck
};

/** "0661280962" → "06 61 28 09 62" (autres formats laissés tels quels). */
function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? digits.replace(/(\d{2})(?=\d)/g, '$1 ') : String(phone || '');
}

/** Interrupteur accessible : case à cocher stylée en toggle. */
function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`cfg-switch ${disabled ? 'cfg-switch-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="cfg-switch-track" aria-hidden="true" />
    </label>
  );
}

/** Ligne d'option : titre + description à gauche, interrupteur à droite. */
function OptionRow({ icon: Icon, title, description, checked, onChange, disabled = false }) {
  return (
    <div className="cfg-row">
      <div className="cfg-row-icon">
        <Icon size={18} />
      </div>
      <div className="cfg-row-text">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

/** Ligne d'option à choix Activer / Désactiver (boutons radio), même style que la modale Options admin. */
function ChoiceRow({ icon: Icon, title, description, name, value, onChange, disabled = false }) {
  return (
    <div className="cfg-row cfg-row-choice">
      <div className="cfg-row-icon">
        <Icon size={18} />
      </div>
      <div className="cfg-row-text">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="radio-group" role="radiogroup" aria-label={title}>
        {[
          [1, 'Activer'],
          [0, 'Désactiver']
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
    </div>
  );
}

/** État du formulaire à partir de la réponse de GET / PATCH /clients/me/config. */
function toState(data) {
  return {
    phoneShow: Number(data.phone_show) === 1,
    defaultOpen: Number(data.default_open) === 1,
    defaultEssayage: Number(data.default_essayage) === 1,
    whatsappNotifs: { ...(data.whatsapp?.prefs || {}) }
  };
}

/**
 * Page /client/configuration — préférences du compte client :
 *  - customers_phone_show : numéro affiché sur les étiquettes des colis ;
 *  - customers_default_open / customers_default_essayage : valeurs par
 *    défaut des cases « ouverture interdite » et « essayage » d'un nouveau colis.
 * En base, customers_default_essayage = 1 signifie essayage autorisé ; l'option
 * affichée est « interdire l'essayage » (inversée), et elle est liée à
 * « interdire l'ouverture » : ouverture interdite → essayage interdit, verrouillé.
 *  - whatsappNotifs : section « Notifications WhatsApp » — pour chaque option
 *    du catalogue backend (bon retour expédié, réclamation traitée,
 *    remboursement, modification de colis, facture enregistrée / payée), le
 *    client choisit Activer / Désactiver la réception du message WhatsApp
 *    automatique (delevery_whatsapp_pref_client ; mêmes choix dans la modale
 *    Options de /admin/clients). `whatsapp.disponible` = false (migration non
 *    exécutée) : lignes affichées mais verrouillées, rien n'est envoyé.
 */
export default function Configuration() {
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(null);
  const [servicePhone, setServicePhone] = useState('');
  const [whatsapp, setWhatsapp] = useState({ disponible: false, options: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function applyResponse(data) {
    const state = toState(data);
    setConfig(state);
    setSaved(state);
    setServicePhone(data.service_phone || '');
    setWhatsapp({
      disponible: Boolean(data.whatsapp?.disponible),
      options: Array.isArray(data.whatsapp?.options) ? data.whatsapp.options : []
    });
  }

  useEffect(() => {
    api
      .get('/clients/me/config')
      .then((res) => applyResponse(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, []);

  const dirty =
    config && saved && JSON.stringify(config) !== JSON.stringify(saved);

  function setField(field, value) {
    setSuccess('');
    setConfig((c) => ({ ...c, [field]: value }));
  }

  function setWhatsappNotif(code, value) {
    setSuccess('');
    setConfig((c) => ({ ...c, whatsappNotifs: { ...c.whatsappNotifs, [code]: value } }));
  }

  /* Interdire l'ouverture → interdire aussi l'essayage (defaultEssayage = autorisé). */
  function setDefaultOpen(v) {
    setSuccess('');
    setConfig((c) => ({ ...c, defaultOpen: v, defaultEssayage: v ? false : c.defaultEssayage }));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.patch('/clients/me/config', {
        phoneShow: config.phoneShow ? 1 : 0,
        defaultOpen: config.defaultOpen ? 1 : 0,
        // Ouverture interdite → essayage interdit d'office (0 = non autorisé).
        defaultEssayage: config.defaultOpen ? 0 : config.defaultEssayage ? 1 : 0,
        // Préférences WhatsApp envoyées seulement si la migration est en place.
        ...(whatsapp.disponible ? { whatsappNotifs: config.whatsappNotifs } : {})
      });
      applyResponse(res.data);
      setSuccess('Configuration enregistrée.');
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="modal-loading">Chargement…</div>;

  if (!config) return <div className="form-error">{error}</div>;

  const phoneOffText = servicePhone
    ? `Si désactivé, le numéro de la société (${formatPhone(servicePhone)}) sera affiché à la place.`
    : 'Si désactivé, le numéro de la société sera affiché à la place.';

  return (
    <div className="cfg-page">
      <section className="platform-card cfg-card">
        <div className="cfg-section-head">
          <span className="cfg-section-kicker">
            <Phone size={14} /> Numéro de téléphone sur les tickets
          </span>
        </div>
        <OptionRow
          icon={Phone}
          title="Afficher mon numéro de téléphone sur les tickets"
          description={phoneOffText}
          checked={config.phoneShow}
          onChange={(v) => setField('phoneShow', v)}
        />
      </section>

      <section className="platform-card cfg-card">
        <div className="cfg-section-head">
          <span className="cfg-section-kicker">
            <PackageOpen size={14} /> Options par défaut pour les nouveaux colis
          </span>
        </div>
        <OptionRow
          icon={Lock}
          title="Interdire l'ouverture du colis par défaut"
          description="Si activé, la case « interdire l'ouverture » sera cochée automatiquement lors de l'ajout d'un nouveau colis, et l'essayage sera interdit d'office."
          checked={config.defaultOpen}
          onChange={setDefaultOpen}
        />
        <OptionRow
          icon={Shirt}
          title="Interdire l'essayage par défaut"
          description={
            config.defaultOpen
              ? "Verrouillé : l'ouverture du colis est interdite, l'essayage l'est donc aussi."
              : "Si activé, la case « interdire l'essayage » sera cochée automatiquement lors de l'ajout d'un nouveau colis."
          }
          checked={config.defaultOpen ? true : !config.defaultEssayage}
          onChange={(v) => setField('defaultEssayage', !v)}
          disabled={config.defaultOpen}
        />
      </section>

      <section className="platform-card cfg-card">
        <div className="cfg-section-head">
          <span className="cfg-section-kicker">
            <MessageCircle size={14} /> Notifications WhatsApp
          </span>
          <p className="cfg-section-desc">
            Choisissez les événements pour lesquels vous acceptez de recevoir un message WhatsApp automatique, envoyé
            sur votre numéro de téléphone personnel (celui du magasin s'il n'est pas renseigné).
          </p>
        </div>
        {!whatsapp.disponible && (
          <div className="cfg-row-note">
            Les préférences de notification WhatsApp sont momentanément indisponibles : les choix ci-dessous ne
            peuvent pas être modifiés pour l'instant.
          </div>
        )}
        {whatsapp.options.map((o) => (
          <ChoiceRow
            key={o.code}
            icon={WA_ICONS[o.code] || MessageCircle}
            title={o.label}
            description={o.description}
            name={`wa_${o.code}`}
            value={config.whatsappNotifs[o.code] === 0 ? 0 : 1}
            onChange={(v) => setWhatsappNotif(o.code, v)}
            disabled={!whatsapp.disponible}
          />
        ))}
      </section>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-success">{success}</div>}

      <div className="cfg-footer">
        <button
          type="button"
          className="btn btn-primary btn-icon"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          <Save size={16} />
          {saving ? 'Enregistrement…' : 'Enregistrer la configuration'}
        </button>
      </div>
    </div>
  );
}
