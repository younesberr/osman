/*
 * Outils communs aux générateurs PDF (html2canvas + jsPDF).
 *
 * Tous les documents sont bâtis en DOM hors écran (le navigateur rend l'arabe
 * correctement) puis photographiés page par page. Le temps de génération est
 * donc proportionnel au nombre de pages ; ce module concentre ce qui le rend
 * supportable :
 *  - ignorerHorsHost : html2canvas clone TOUT le document à chaque capture
 *    (datatable, modales, menus…). On écarte du clone tout ce qui n'est pas
 *    le conteneur hors écran du document : chaque page ne coûte plus que son
 *    propre DOM ;
 *  - ECHELLE_A4 : facteur de capture des pages A4. Le DOM est à 5 px / mm
 *    (1050 × 1485 px) ; à 1,5 la page fait 1575 × 2228 px (≈ 190 dpi, net à
 *    l'impression) pour 44 % de pixels de moins qu'à l'échelle 2 ;
 *  - pagesVersPdf : boucle de capture partagée (JPEG posé plein format A4)
 *    avec remontée de la progression pour l'onglet d'attente ;
 *  - ecrireOngletAttente / progressionOnglet : page d'attente (logo, anneau
 *    animé, barre de progression aux couleurs de marque) dans l'onglet ouvert
 *    par la page avant la génération, mise à jour « Page 3 / 12 » à chaque
 *    capture ; l'onglet reçoit ensuite l'URL blob du PDF.
 */

export const ECHELLE_A4 = 1.5;
export const JPEG_QUALITE = 0.92;

/**
 * Filtre `ignoreElements` de html2canvas : ne garde dans le clone que `host`
 * (conteneur hors écran) parmi les enfants directs de <body>.
 * @param {HTMLElement} host
 */
export function ignorerHorsHost(host) {
  return (el) => el.parentElement === document.body && el !== host;
}

/**
 * Capture chaque page A4 (éléments DOM de 1050 × 1485 px déjà rendus dans
 * `host`) en JPEG et les assemble dans un PDF ; renvoie une URL blob.
 * @param {{jsPDF: Function, html2canvas: Function, host: HTMLElement,
 *   pages: HTMLElement[], onProgress?: (page: number, total: number) => void}} options
 *   onProgress est appelé avant chaque capture avec le n° de page (1-based).
 */
export async function pagesVersPdf({ jsPDF, html2canvas, host, pages, onProgress }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const total = pages.length;
  const ignoreElements = ignorerHorsHost(host);
  for (let i = 0; i < total; i += 1) {
    if (onProgress) onProgress(i + 1, total);
    const shot = await html2canvas(pages[i], {
      scale: ECHELLE_A4,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      ignoreElements
    });
    if (i > 0) doc.addPage();
    doc.addImage(shot.toDataURL('image/jpeg', JPEG_QUALITE), 'JPEG', 0, 0, 210, 297);
  }
  return URL.createObjectURL(doc.output('blob'));
}

/* ---- Onglet d'attente ---- */

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Couleur de marque lue sur le document de l'application (variables CSS posées par PlatformContext). */
function couleurApp(nom, defaut) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : defaut;
  } catch {
    return defaut;
  }
}

/**
 * Remplit l'onglet ouvert par la page (`window.open('', '_blank')`) avec une
 * page d'attente : logo de la plateforme (repris du menu de l'application),
 * anneau animé, libellé, étape en cours et barre de progression, aux couleurs
 * de marque. Les identifiants pdf-* sont mis à jour par progressionOnglet.
 * Sans effet si l'onglet est absent (popup bloquée).
 * @param {Window|null} win
 * @param {string} libelle  p. ex. « Génération du PDF… »
 */
export function ecrireOngletAttente(win, libelle = 'Génération du PDF…') {
  if (!win) return;
  const primaire = couleurApp('--primary', '#1c428a');
  const secondaire = couleurApp('--secondary', '#f6db14');
  const logo = document.querySelector('img.brand-logo')?.src || '';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(libelle)}</title>
<style>
  :root { --p: ${primaire}; --s: ${secondaire}; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; padding: 16px;
    background: radial-gradient(circle at 50% 0%, #ffffff 0%, #eef2f9 70%);
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: #1f2937;
  }
  .carte {
    width: min(420px, 100%); background: #fff; border-radius: 20px; padding: 34px 30px 28px; text-align: center;
    box-shadow: 0 20px 60px rgba(28, 66, 138, 0.12); animation: apparait 0.45s ease-out;
  }
  .logo { display: block; max-height: 56px; max-width: 220px; margin: 0 auto 24px; }
  .anneau { position: relative; width: 78px; height: 78px; margin: 0 auto 22px; }
  .anneau::before { content: ''; position: absolute; inset: 0; border-radius: 50%; border: 5px solid #e6eaf3; }
  .anneau::after {
    content: ''; position: absolute; inset: 0; border-radius: 50%; border: 5px solid transparent;
    border-top-color: var(--p); border-right-color: var(--p); animation: tourne 1s linear infinite;
  }
  .anneau svg { position: absolute; inset: 0; margin: auto; width: 30px; height: 30px; fill: var(--p); animation: pulse 1.6s ease-in-out infinite; }
  h1 { font-size: 1.15rem; font-weight: 700; margin: 0 0 6px; }
  .etape { color: #6b7280; font-size: 0.95rem; min-height: 1.4em; margin: 0 0 18px; }
  .piste { height: 8px; background: #e9edf5; border-radius: 999px; overflow: hidden; }
  .barre { height: 100%; width: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--p), var(--s)); transition: width 0.5s ease; }
  .barre.indet { width: 35%; animation: glisse 1.4s ease-in-out infinite; }
  .astuce { margin: 18px 0 0; font-size: 0.8rem; color: #9ca3af; }
  @keyframes tourne { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.12); opacity: 1; } }
  @keyframes apparait { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes glisse { from { margin-left: -35%; } to { margin-left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .anneau::after, .anneau svg, .barre.indet, .carte { animation: none; } }
</style></head>
<body>
  <div class="carte">
    ${logo ? `<img class="logo" src="${escHtml(logo)}" alt="" />` : ''}
    <div class="anneau"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 12h8v2H8zm0 4h8v2H8z"/></svg></div>
    <h1 id="pdf-lib">${escHtml(libelle)}</h1>
    <p class="etape" id="pdf-etape">Préparation du document</p>
    <div class="piste"><div class="barre indet" id="pdf-barre"></div></div>
    <p class="astuce">Le document s'ouvrira dans cet onglet.</p>
  </div>
</body></html>`;
  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch {
    /* onglet inaccessible : l'attente reste muette */
  }
}

/**
 * Callback de progression pour l'onglet d'attente (ecrireOngletAttente) :
 * met à jour l'étape (« Page 3 / 12 »), la barre et le titre de l'onglet.
 * Sur un onglet sans page d'attente (texte brut), remplace le texte du corps.
 * Sans effet si l'onglet est absent ou fermé.
 * @param {Window|null} win
 * @param {string} libelle
 * @param {string} unite  'page' | 'étiquette' | 'ticket'
 */
export function progressionOnglet(win, libelle = 'Génération du PDF…', unite = 'page') {
  const Unite = unite.charAt(0).toUpperCase() + unite.slice(1);
  return (fait, total) => {
    if (!win || win.closed) return;
    try {
      const d = win.document;
      const etape = d.getElementById('pdf-etape');
      if (!etape) {
        d.body.textContent = total > 1 ? `${libelle} ${unite} ${fait} / ${total}` : libelle;
        return;
      }
      d.getElementById('pdf-lib').textContent = libelle;
      etape.textContent = `${Unite} ${fait} / ${total}`;
      const barre = d.getElementById('pdf-barre');
      barre.classList.remove('indet');
      // La barre reflète l'unité en cours (à mi-chemin) : 1 / 3 → 17 %, 3 / 3 → 83 %.
      barre.style.width = `${Math.round(((fait - 0.5) / Math.max(total, 1)) * 100)}%`;
      d.title = total > 1 ? `${fait} / ${total} · ${libelle}` : libelle;
    } catch {
      /* onglet inaccessible : la progression est purement indicative */
    }
  };
}
