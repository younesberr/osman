import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Liste déroulante multi-sélection avec champ de recherche intégré
 * (mêmes styles ss-* que SearchableSelect + puces des valeurs choisies).
 * options : [{ value, label }] ; value = tableau des valeurs sélectionnées.
 */
export default function MultiSearchSelect({
  value,
  onChange,
  options,
  placeholder = '— Sélectionner —',
  className = ''
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const searchRef = useRef(null);

  const selectedSet = useMemo(() => new Set((value || []).map(String)), [value]);
  const selected = options.filter((o) => selectedSet.has(String(o.value)));

  const filtered = useMemo(() => {
    const terme = normalize(query.trim());
    if (!terme) return options;
    return options.filter((o) => normalize(o.label).includes(terme));
  }, [options, query]);

  // Fermeture au clic hors du composant et à la touche Échap.
  useEffect(() => {
    if (!open) return undefined;
    function onClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
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

  // Focus sur la recherche à l'ouverture, recherche remise à zéro.
  useEffect(() => {
    if (open) {
      setQuery('');
      searchRef.current?.focus();
    }
  }, [open]);

  function toggle(option) {
    const val = String(option.value);
    if (selectedSet.has(val)) {
      onChange((value || []).filter((v) => String(v) !== val));
    } else {
      onChange([...(value || []), option.value]);
    }
  }

  return (
    <div className={`searchable-select ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={`ss-control ms-control ${open ? 'ss-control-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {selected.length === 0 ? (
          <span className="ss-placeholder">{placeholder}</span>
        ) : (
          <span className="ms-tags">
            {selected.map((o) => (
              <span key={o.value} className="ms-tag">
                {o.label}
                <X
                  size={12}
                  className="ms-tag-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(o);
                  }}
                />
              </span>
            ))}
          </span>
        )}
        <ChevronDown size={16} className="ss-chevron" />
      </button>

      {open && (
        <div className="ss-menu">
          <div className="ss-search">
            <Search size={14} className="ss-search-icon" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Rechercher…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (filtered.length === 1) toggle(filtered[0]);
                }
              }}
            />
          </div>
          <div className="ss-options">
            {filtered.length === 0 ? (
              <div className="ss-empty">Aucun résultat.</div>
            ) : (
              filtered.map((o) => {
                const isSelected = selectedSet.has(String(o.value));
                return (
                  <button
                    type="button"
                    key={o.value}
                    className={`ss-option ${isSelected ? 'ss-option-selected' : ''}`}
                    onClick={() => toggle(o)}
                  >
                    <span>{o.label}</span>
                    {isSelected && <Check size={14} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
