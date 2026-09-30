import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { BRAND, pageTitle } from './src/config/brand.js';

/**
 * Font Awesome déclare ses polices avec `font-display: block` : les icônes
 * restent invisibles jusqu'à 3 s le temps du téléchargement (audit Lighthouse
 * « Font display »). On force `swap` sur ses seules déclarations.
 */
const fontAwesomeDisplaySwap = {
  postcssPlugin: 'fontawesome-display-swap',
  Declaration: {
    'font-display': (decl) => {
      const file = decl.source?.input?.file || '';
      if (decl.value === 'block' && /fontawesome-free/.test(file)) decl.value = 'swap';
    }
  }
};

/**
 * index.html ne porte aucun texte de marque : le titre et la meta description
 * viennent de src/config/brand.js (placeholders {{BRAND_TITLE}} / {{BRAND_DESCRIPTION}}),
 * en dev comme au build.
 */
const brandHtml = {
  name: 'brand-html',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      return html
        .replaceAll('{{BRAND_TITLE}}', pageTitle(null))
        .replaceAll('{{BRAND_DESCRIPTION}}', BRAND.metaDescriptionAr);
    }
  }
};

export default defineConfig({
  plugins: [react(), brandHtml],
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
