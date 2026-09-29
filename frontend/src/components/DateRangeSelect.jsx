import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';

/** Date locale → "AAAA-MM-JJ" (format attendu par l'API et les <input type="date">). */
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const j = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${j}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

const PRESETS = [
  { key: 'today', label: "Aujourd'hui", range: () => ({ from: toISO(new Date()), to: toISO(new Date()) }) },
  { key: 'yesterday', label: 'Hier', range: () => ({ from: toISO(daysAgo(1)), to: toISO(daysAgo(1)) }) },
  { key: 'last7', label: '7 derniers jours', range: () => ({ from: toISO(daysAgo(6)), to: toISO(new Date()) }) },
  { key: 'last30', label: '30 derniers jours', range: () => ({ from: toISO(daysAgo(29)), to: toISO(new Date()) }) },
  {
    key: 'month',
    label: 'Ce mois-ci',
    range: () => {
      const now = new Date();
      return { from: toISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: toISO(now) };
    }
  },
  {
    key: 'lastMonth',
    label: 'Mois dernier',
    range: () => {
      const now = new Date();
      return {
        from: toISO(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: toISO(new Date(now.getFullYear(), now.getMonth(), 0))
      };
    }
  },
  { key: 'all', label: 'Toutes les dates', range: () => ({ from: '', to: '' }) }
];

/** Plage par défaut de la page Colis : 30 derniers jours. */
export function defaultRange() {
  return { ...PRESETS.find((p) => p.key === 'last30').range(), preset: 'last30' };
}

function formatFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Bouton de sélection de plage de dates : présets + plage personnalisée.
 * value : { from, to, preset } — from/to en "AAAA-MM-JJ" ('' = sans limite).
 */
export default function DateRangeSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [customFrom, setCustomFrom] = useState(value.from);
  const [customTo, setCustomTo] = useState(value.to);
  const rootRef = useRef(null);
  const popRef = useRef(null);

  /* Bascule le popup à droite du bouton s'il déborderait du bord droit de l'écran. */
  useLayoutEffect(() => {
    if (!open) {
      setAlignRight(false);
      return;
    }
    const pop = popRef.current;
    if (pop && pop.getBoundingClientRect().right > window.innerWidth - 8) setAlignRight(true);
  }, [open]);

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
      setCustomFrom(value.from);
      setCustomTo(value.to);
    }
  }, [open, value.from, value.to]);

  const preset = PRESETS.find((p) => p.key === value.preset);
  const buttonLabel = preset
    ? preset.label
    : `${value.from ? formatFr(value.from) : '…'} – ${value.to ? formatFr(value.to) : '…'}`;

  return (
    <div className="daterange" ref={rootRef}>
      <button type="button" className="daterange-btn" onClick={() => setOpen((v) => !v)}>
        <Calendar size={15} />
        <span>{buttonLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={`daterange-pop${alignRight ? ' is-right' : ''}`} ref={popRef}>
          <ul className="daterange-presets">
            {PRESETS.map((p) => (
              <li
                key={p.key}
                className={value.preset === p.key ? 'is-selected' : ''}
                onClick={() => {
                  onChange({ ...p.range(), preset: p.key });
                  setOpen(false);
                }}
              >
                {p.label}
              </li>
            ))}
          </ul>
          <div className="daterange-custom">
            <div className="daterange-custom-title">Plage personnalisée</div>
            <label>
              Du
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label>
              Au
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
            <button
              type="button"
              className="daterange-ok"
              disabled={!customFrom && !customTo}
              onClick={() => {
                onChange({ from: customFrom, to: customTo, preset: '' });
                setOpen(false);
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
