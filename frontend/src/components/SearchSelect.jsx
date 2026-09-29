import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Liste déroulante avec recherche intégrée.
 * options : [{ value, label }] — value '' est réservée à "Tous".
 */
export default function SearchSelect({ label, options, value, onChange, allLabel = 'Tous' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return options;
    return options.filter((o) => normalize(o.label).includes(q));
  }, [options, query]);

  const selected = options.find((o) => String(o.value) === String(value));

  return (
    <div className={`search-select ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`search-select-btn ${selected ? 'has-value' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
      >
        <span className="search-select-label">
          {selected ? selected.label : `${label} : ${allLabel}`}
        </span>
        {selected ? (
          <X
            size={14}
            className="search-select-clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
          />
        ) : (
          <ChevronDown size={14} />
        )}
      </button>
      {open && (
        <div className="search-select-pop">
          <div className="search-select-search">
            <Search size={14} />
            <input
              ref={inputRef}
              type="text"
              placeholder="Rechercher…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="search-select-list">
            <li
              className={!value ? 'is-selected' : ''}
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {allLabel}
            </li>
            {filtered.map((o) => (
              <li
                key={o.value}
                className={String(o.value) === String(value) ? 'is-selected' : ''}
                onClick={() => {
                  onChange(String(o.value));
                  setOpen(false);
                }}
              >
                {o.label}
              </li>
            ))}
            {filtered.length === 0 && <li className="is-empty">Aucun résultat</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
