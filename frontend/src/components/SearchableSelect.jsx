import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';

/**
 * Liste déroulante avec champ de recherche intégré.
 * options : [{ value, label }] ; value '' = aucune sélection (placeholder affiché).
 * onChange reçoit la valeur de l'option choisie.
 * portal : rend le menu dans document.body (position fixe) pour échapper aux
 * conteneurs à overflow (ex. tableau horizontalement scrollable).
 * disabled : contrôle verrouillé (valeur affichée, menu inaccessible).
 */
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = '— Sélectionner —',
  className = '',
  portal = false,
  searchPlaceholder = 'Rechercher…',
  emptyText = 'Aucun résultat.',
  disabled = false
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPos, setMenuPos] = useState(null);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  const selected = options.find((o) => String(o.value) === String(value));

  const filtered = useMemo(() => {
    const terme = query.trim().toLowerCase();
    if (!terme) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(terme));
  }, [options, query]);

  // Fermeture au clic hors du composant (menu porté inclus) et à la touche Échap.
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) {
      if (wrapRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Mode portal : menu positionné en fixe sous le bouton, suivi au scroll/redimensionnement.
  useEffect(() => {
    if (!open || !portal) return;
    function place() {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, portal]);

  // Focus sur la recherche à l'ouverture, recherche remise à zéro.
  useEffect(() => {
    if (open) {
      setQuery('');
      searchRef.current?.focus();
    }
  }, [open]);

  function pick(option) {
    onChange(option.value);
    setOpen(false);
  }

  const menu = open && (!portal || menuPos) && (
    <div
      className="ss-menu"
      ref={menuRef}
      style={portal ? { position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, right: 'auto' } : undefined}
    >
      <div className="ss-search">
        <Search size={14} className="ss-search-icon" />
        <input
          ref={searchRef}
          type="search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (filtered.length === 1) pick(filtered[0]);
            }
          }}
        />
      </div>
      <div className="ss-options">
        {filtered.length === 0 ? (
          <div className="ss-empty">{emptyText}</div>
        ) : (
          filtered.map((o) => {
            const isSelected = String(o.value) === String(value);
            return (
              <button
                type="button"
                key={o.value}
                className={`ss-option ${isSelected ? 'ss-option-selected' : ''}`}
                onClick={() => pick(o)}
              >
                <span>{o.label}</span>
                {isSelected && <Check size={14} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className={`searchable-select ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={`ss-control ${open ? 'ss-control-open' : ''} ${disabled ? 'ss-control-disabled' : ''}`}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <span className={selected ? '' : 'ss-placeholder'}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={16} className="ss-chevron" />
      </button>

      {portal ? menu && createPortal(menu, document.body) : menu}
    </div>
  );
}
