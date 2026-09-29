/**
 * Interrupteur accessible (même rendu que la page Configuration du client,
 * classes cfg-switch). Partagé par les pages API liaison / CRM WhatsApp.
 */
export default function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`cfg-switch ${disabled ? 'cfg-switch-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="cfg-switch-track" aria-hidden="true" />
    </label>
  );
}
