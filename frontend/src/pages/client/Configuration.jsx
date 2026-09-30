import { useEffect, useState } from 'react';
import {
  Phone,
  PackageOpen,
  Save,
  Shirt,
  Lock
} from 'lucide-react';
import api from '../../api/client';

/** "0612345678" → "06 12 34 56 78" (autres formats laissés tels quels). */
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

/** État du formulaire à partir de la réponse de GET / PATCH /clients/me/config. */
function toState(data) {
  return {
    phoneShow: Number(data.phone_show) === 1,
    defaultOpen: Number(data.default_open) === 1,
    defaultEssayage: Number(data.default_essayage) === 1
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
 */
export default function Configuration() {
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(null);
  const [servicePhone, setServicePhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function applyResponse(data) {
    const state = toState(data);
    setConfig(state);
    setSaved(state);
    setServicePhone(data.service_phone || '');
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
        defaultEssayage: config.defaultOpen ? 0 : config.defaultEssayage ? 1 : 0
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
