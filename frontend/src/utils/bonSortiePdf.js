/*
 * Bon de sortie de stock en PDF (page admin Gestion de stock > Bon de sortie).
 *
 * Chaque page A4 est construite en DOM hors écran — ce qui permet au
 * navigateur de rendre correctement l'arabe éventuel des noms de produits —
 * puis convertie en image par html2canvas et posée dans le PDF (jsPDF),
 * comme le bon d'envoi (utils/bonEnvoiPdf.js) :
 *  - logo de la plateforme en haut de page (repli texte s'il est absent) ;
 *  - encadré des informations du bon (référence, date de création, affecté à,
 *    nombre de colis, nombre de produits) ;
 *  - tableau des colis (N°, code + magasin, produits « nom (qté) → position »),
 *    réparti sur autant de pages que nécessaire (en-tête de tableau répété) ;
 *  - en bas à droite de la dernière page : nom de l'utilisateur affecté
 *    (zone de signature) ; numérotation des pages en pied.
 * Les librairies sont chargées à la demande.
 */

import { pagesVersPdf } from './pdfCapture';

// Page A4 rendue à 5 px / mm (1050 × 1485 px), capturée à l'échelle ECHELLE_A4 (utils/pdfCapture.js : 1,5 ≈ 190 dpi).
const PAGE_W = 1050;
const PAGE_H = 1485;
const PAD_TOP = 50; // ≈ 10 mm
const PAD_SIDE = 60; // ≈ 12 mm
const PAD_BOTTOM = 60; // ≈ 12 mm

const STYLE = `
.bs-page {
  position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; box-sizing: border-box;
  padding: ${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px; background: #fff;
  color: #000; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.4;
}
.bs-content { height: 100%; overflow: hidden; }
.bs-logo { height: 90px; display: flex; align-items: center; justify-content: center; margin-bottom: 24px; }
.bs-logo img { max-height: 90px; max-width: 420px; }
.bs-logo-txt { font-size: 44px; font-weight: 800; color: #1c428a; letter-spacing: 1px; }
.bs-logo-txt span { color: #f6db14; }
.bs-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
.bs-info { display: flex; flex-wrap: wrap; gap: 14px; border: 2px solid #1f2937; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; background: #fff; }
.bs-info-item { flex: 1; min-width: 150px; }
.bs-info-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 4px; }
.bs-info-value { font-size: 19px; font-weight: 700; overflow-wrap: break-word; }
.bs-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
.bs-table th, .bs-table td { border: 1px solid #374151; padding: 7px 9px; text-align: left; vertical-align: top; }
.bs-table th { background: #eef1f6; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; }
.bs-cell { white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.bs-num { text-align: center; }
.bs-code { font-weight: 700; overflow-wrap: break-word; word-break: break-word; }
.bs-magasin { font-size: 13px; color: #4b5563; }
.bs-produits { margin: 0; padding-left: 18px; }
.bs-produits li { margin: 1px 0; }
.bs-pos { font-weight: 700; }
.bs-empty { text-align: center; color: #4b5563; }
.bs-sign { display: flex; justify-content: flex-end; margin-top: 34px; }
.bs-sign-box { min-width: 300px; text-align: center; }
.bs-sign-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 6px; }
.bs-sign-nom { font-size: 19px; font-weight: 800; border-top: 2px solid #1f2937; padding-top: 8px; }
.bs-pagenum { position: absolute; right: ${PAD_SIDE}px; bottom: 16px; font-size: 12px; color: #4b5563; }
`;

/** Échappe le texte injecté dans le HTML des pages. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Précharge le logo plateforme ; renvoie null (repli texte) s'il est absent ou en erreur. */
function preloadLogo(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(url);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Logo de la plateforme centré en haut de page (repli texte). */
function logoHtml(logoUrl) {
  return `<div class="bs-logo">${
    logoUrl
      ? `<img src="${logoUrl}" alt="" />`
      : '<div class="bs-logo-txt">ORTALOG<span> LIVRAISON</span></div>'
  }</div>`;
}

/** Encadré des informations du bon (première page uniquement). */
function infoBoxHtml(bon, nbColis, nbProduits) {
  return `
<div class="bs-title">Bon de sortie de stock</div>
<div class="bs-info">
  <div class="bs-info-item">
    <div class="bs-info-label">Référence du bon</div>
    <div class="bs-info-value">${esc(bon.ref || '—')}</div>
  </div>
  <div class="bs-info-item">
    <div class="bs-info-label">Date de création</div>
    <div class="bs-info-value">${esc(formatDate(bon.time))}</div>
  </div>
  <div class="bs-info-item">
    <div class="bs-info-label">Bon affecté à</div>
    <div class="bs-info-value">${esc(bon.affecter_name || '—')}</div>
  </div>
  <div class="bs-info-item">
    <div class="bs-info-label">Nombre de colis</div>
    <div class="bs-info-value">${nbColis}</div>
  </div>
  <div class="bs-info-item">
    <div class="bs-info-label">Nombre de produits</div>
    <div class="bs-info-value">${nbProduits}</div>
  </div>
</div>`;
}

const TABLE_HEAD = `
<colgroup>
  <col style="width:52px" /><col style="width:250px" /><col style="width:230px" /><col />
</colgroup>
<thead>
  <tr><th class="bs-num">N°</th><th>Code colis</th><th>Nom magasin</th><th>Produits</th></tr>
</thead>`;

/** Ligne produit : « nom — variante (qté) → position ». */
function produitHtml(produit) {
  const nom = [produit.nom || '—', produit.variante].filter(Boolean).join(' — ');
  return `<li>${esc(nom)} (${Number(produit.qty) || 0})${
    produit.position ? ` <span class="bs-pos">&rarr; ${esc(produit.position)}</span>` : ''
  }</li>`;
}

function rowHtml(parcel, numero) {
  const produits = parcel.produits || [];
  return `
<tr>
  <td class="bs-num">${numero}</td>
  <td class="bs-code">${esc(parcel.code || '—')}</td>
  <td><div class="bs-cell">${esc(parcel.magasin || parcel.clientNom || '—')}</div></td>
  <td>${
    produits.length
      ? `<ul class="bs-produits">${produits.map(produitHtml).join('')}</ul>`
      : '<div class="bs-cell">—</div>'
  }</td>
</tr>`;
}

/** Crée une page et son tableau ; renvoie { page, content, tbody }. */
function buildPage(host, logoUrl, withInfoBox, bon, nbColis, nbProduits) {
  const page = document.createElement('div');
  page.className = 'bs-page';
  page.innerHTML = `
<div class="bs-content">
  ${logoHtml(logoUrl)}
  ${withInfoBox ? infoBoxHtml(bon, nbColis, nbProduits) : ''}
  <table class="bs-table">${TABLE_HEAD}<tbody></tbody></table>
</div>
<div class="bs-pagenum"></div>`;
  host.appendChild(page);
  return { page, content: page.querySelector('.bs-content'), tbody: page.querySelector('tbody') };
}

/** Zone de signature (nom de l'utilisateur affecté), en bas à droite. */
function signHtml(bon) {
  return `
<div class="bs-sign">
  <div class="bs-sign-box">
    <div class="bs-sign-label">Bon affecté à</div>
    <div class="bs-sign-nom">${esc(bon.affecter_name || '—')}</div>
  </div>
</div>`;
}

/**
 * Génère le PDF du bon de sortie et renvoie une URL blob à ouvrir dans un onglet.
 * @param {{bon: {ref, time, affecter_name}, parcels: object[], logoUrl?: string}} options
 *   parcels : colis du bon (GET /bons-sortie/:id), avec leurs produits
 *   [{ nom, variante, qty, position }].
 *   onProgress : facultatif, appelé avant chaque capture de page (n° de page, total).
 */
export async function genererBonSortiePdf({ bon, parcels, logoUrl, onProgress }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  const logo = await preloadLogo(logoUrl);
  // L'API renvoie les colis du plus récent au plus ancien : le document les
  // numérote dans l'ordre d'ajout au bon (1 = premier colis ajouté).
  const rows = [...(parcels || [])].reverse();
  const nbProduits = rows.reduce(
    (total, p) => total + (p.produits || []).reduce((s, pr) => s + (Number(pr.qty) || 0), 0),
    0
  );

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-11000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    // Remplissage page par page : une ligne qui déborde part sur la page suivante.
    const pages = [];
    let current = buildPage(host, logo, true, bon, rows.length, nbProduits);
    pages.push(current);

    if (!rows.length) {
      current.tbody.innerHTML = `<tr><td colspan="4" class="bs-empty">Aucun colis dans ce bon.</td></tr>`;
    }
    rows.forEach((parcel, i) => {
      current.tbody.insertAdjacentHTML('beforeend', rowHtml(parcel, i + 1));
      const overflow = current.content.scrollHeight > current.content.clientHeight;
      // Une ligne seule sur sa page est conservée même trop haute (cas extrême).
      if (overflow && current.tbody.children.length > 1) {
        const row = current.tbody.lastElementChild;
        current = buildPage(host, logo, false, bon, rows.length, nbProduits);
        pages.push(current);
        current.tbody.appendChild(row);
      }
    });

    // Signature en bas de la dernière page ; nouvelle page si elle ne tient pas.
    current.tbody.parentElement.insertAdjacentHTML('afterend', signHtml(bon));
    if (current.content.scrollHeight > current.content.clientHeight) {
      current.content.querySelector('.bs-sign').remove();
      current = buildPage(host, logo, false, bon, rows.length, nbProduits);
      pages.push(current);
      current.tbody.parentElement.remove();
      current.content.insertAdjacentHTML('beforeend', signHtml(bon));
    }

    pages.forEach((p, i) => {
      p.page.querySelector('.bs-pagenum').textContent = `Page ${i + 1} / ${pages.length}`;
    });

    // « await » indispensable : le finally ci-dessous retire host du DOM et doit attendre la fin des captures.
    return await pagesVersPdf({ jsPDF, html2canvas, host, pages: pages.map((p) => p.page), onProgress });
  } finally {
    document.body.removeChild(host);
  }
}
