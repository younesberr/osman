import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Font Awesome déclare ses polices avec `font-display: block` : les icônes
 * restent invisibles jusqu'à 3 s le temps du téléchargement (audit Lighthouse
 * « Font display »). On force `swap` sur ses seules déclarations.
 */
const fontAwesomeDisplaySwap = {
  postcssPlugin: 'ortalog-fontawesome-display-swap',
  Declaration: {
    'font-display': (decl) => {
      const file = decl.source?.input?.file || '';
      if (decl.value === 'block' && /fontawesome-free/.test(file)) decl.value = 'swap';
    }
  }
};

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: { plugins: [fontAwesomeDisplaySwap] }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Socle React/router/axios dans un chunk stable : son hash ne change
          // pas à chaque déploiement, le navigateur le garde en cache un an.
          if (/node_modules[\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run|axios)[\/]/.test(id)) {
            return 'vendor';
          }
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    allowedHosts: ['washbowl-data-slapstick.ngrok-free.dev'],
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/uploads': {
        target: 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
});
