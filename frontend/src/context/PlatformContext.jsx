import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api/client';

const DEFAULT_CONFIG = {
  logo: null,
  icon: null,
  colorPrimary: '#1c428a',
  colorSecondary: '#f6db14'
};

const PlatformContext = createContext({ config: DEFAULT_CONFIG, refresh: () => {} });

/** Assombrit une couleur #rrggbb (pour --primary-dark, état hover des boutons). */
function darken(hex, factor = 0.78) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (shift) => Math.round(((n >> shift) & 0xff) * factor);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function applyBranding(config) {
  const root = document.documentElement;
  root.style.setProperty('--primary', config.colorPrimary);
  root.style.setProperty('--primary-dark', darken(config.colorPrimary));
  root.style.setProperty('--secondary', config.colorSecondary);

  if (config.icon) {
    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = config.icon;
  }
}

export function PlatformProvider({ children }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/platform/config');
      const next = { ...DEFAULT_CONFIG, ...res.data };
      setConfig(next);
      applyBranding(next);
    } catch {
      applyBranding(DEFAULT_CONFIG);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return <PlatformContext.Provider value={{ config, refresh }}>{children}</PlatformContext.Provider>;
}

export function usePlatform() {
  return useContext(PlatformContext);
}
