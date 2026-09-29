import { useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';

/*
 * Champ secret (jeton d'accès, clé secrète…) : saisie masquée avec œil.
 * Le serveur ne renvoie jamais la valeur : `defini` + `masque` (« ••••Zx1Q »)
 * décrivent ce qui est enregistré. Convention d'enregistrement :
 *   value ''   → conserver la valeur enregistrée ;
 *   value null → effacer (bouton croix, annulable) ;
 *   chaîne     → remplacer.
 */
export default function SecretInput({
  label,
  hint,
  value,
  onChange,
  defini = false,
  masque = '',
  dechiffrable = true,
  disabled = false,
  placeholder = 'Collez la valeur ici'
}) {
  const [visible, setVisible] = useState(false);
  const effacer = value === null;
  const texte = effacer ? 'Sera effacé à l’enregistrement' : defini ? `Enregistré (${masque || '••••'}) — laisser vide pour conserver` : placeholder;

  return (
    <div className="secret-field">
      <span className="field-label">{label}</span>
      <div className="secret-input">
        <input
          type={visible ? 'text' : 'password'}
          value={value || ''}
          disabled={disabled || effacer}
          placeholder={texte}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="api-copy"
          title={visible ? 'Masquer' : 'Afficher la saisie'}
          aria-label={visible ? 'Masquer' : 'Afficher la saisie'}
          disabled={disabled || effacer}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        {defini && !effacer && (
          <button
            type="button"
            className="api-copy"
            title="Effacer la valeur enregistrée"
            aria-label="Effacer la valeur enregistrée"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <X size={15} />
          </button>
        )}
        {effacer && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange('')}>
            Annuler
          </button>
        )}
      </div>
      {hint && <span className="wa-field-hint">{hint}</span>}
      {defini && !dechiffrable && (
        <span className="field-error">
          Valeur enregistrée illisible (la clé de chiffrement du serveur a changé) : saisissez-la de nouveau.
        </span>
      )}
    </div>
  );
}
