/*
 * Bon de retour livreur en PDF (page admin Bons de retour > Livreur).
 *
 * Même principe que utils/bonEnvoiPdf.js : chaque page A4 est construite en
 * DOM hors écran (rendu correct de l'arabe éventuel des adresses), convertie
 * en image par html2canvas puis posée dans le PDF (jsPDF) :
 *  - l'image « Page en-tête » (configuration / plateforme) sert d'arrière-plan
 *    pleine page ; une marge haute réserve la place du logo de l'en-tête ;
 *  - encadré des informations du bon (référence, date, livreur, nombre de
 *    colis) puis tableau des colis (N°, code / magasin, date de réception,
 *    ville / adresse, statut avant ajout au bon), réparti sur autant de pages
 *    que nécessaire (en-tête de tableau répété) ;
 *  - pied de page : numérotation en bas à droite + informations société.
 * Les librairies sont chargées à la demande.
 */

import { pagesVersPdf } from './pdfCapture';

import { statutLabel } from './statuts';

// Page A4 rendue à 5 px / mm (1050 × 1485 px), capturée à l'échelle ECHELLE_A4 (utils/pdfCapture.js : 1,5 ≈ 190 dpi).
const PAGE_W = 1050;
const PAGE_H = 1485;
const PAD_TOP = 240; // ≈ 48 mm : le texte ne touche pas le logo de l'en-tête.
const PAD_SIDE = 60; // ≈ 12 mm
const PAD_BOTTOM = 170; // ≈ 34 mm : réservé au pied de page.
const BLEU = '#1c428a'; // Bleu du papier à en-tête (texte du pied posé sur la bande jaune).

const STYLE = `
.bp-page {
  position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; box-sizing: border-box;
  padding: ${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px; background: #fff no-repeat center / 100% 100%;
  color: #000; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.4;
}
.bp-content { height: 100%; overflow: hidden; }
.bp-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
.bp-info { display: flex; gap: 14px; border: 2px solid #1f2937; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; background: #fff; }
.bp-info-item { flex: 1; }
.bp-info-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 4px; }
.bp-info-value { font-size: 19px; font-weight: 700; }
.bp-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
/* white-space: normal — le DOM du PDF est construit dans le document de
   l'application, dont le style global « th, td » impose nowrap : sans cette
   annulation, le contenu des cellules déborderait de sa colonne. */
.bp-table th, .bp-table td { border: 1px solid #374151; padding: 7px 9px; text-align: left; vertical-align: top; white-space: normal; }
.bp-table th { background: #eef1f6; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; }
.bp-cell { white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.bp-sub { font-size: 13px; color: #4b5563; white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.bp-num { text-align: center; }
.bp-code { font-weight: 700; overflow-wrap: break-word; word-break: break-word; }
.bp-empty { text-align: center; color: #4b5563; }
.bp-footer { position: absolute; left: ${PAD_SIDE}px; right: ${PAD_SIDE}px; bottom: 18px; color: ${BLEU}; }
.bp-footer-nom { display: inline-block; font-size: 21px; font-weight: 800; border-bottom: 2px solid ${BLEU}; padding-bottom: 2px; margin-bottom: 6px; }
.bp-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; font-size: 13px; font-weight: 700; }
.bp-footer-item { display: inline-flex; align-items: center; gap: 6px; }
.bp-footer-item svg { width: 15px; height: 15px; fill: ${BLEU}; flex: none; }
.bp-footer-regs { margin-top: 5px; font-size: 12px; font-weight: 700; }
.bp-pagenum { position: absolute; right: ${PAD_SIDE}px; bottom: 10px; font-size: 12px; color: ${BLEU}; }
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

/** Précharge l'image d'en-tête ; renvoie null (page blanche) si absente ou en erreur. */
function preloadEntete(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(url);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/* Icônes du pied de page (remplissage hérité de .bp-footer-item svg). */
const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  tel: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>',
  web: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3a15.5 15.5 0 0 0-1.2-5.4A8 8 0 0 1 19.9 11zM12 4c.9 1.2 1.7 3.5 1.9 7h-3.8c.2-3.5 1-5.8 1.9-7zM4.1 13h3c.1 1.9.5 3.8 1.2 5.4A8 8 0 0 1 4.1 13zm3-2h-3a8 8 0 0 1 4.2-5.4A15.5 15.5 0 0 0 7.1 11zm4.9 9c-.9-1.2-1.7-3.5-1.9-7h3.8c-.2 3.5-1 5.8-1.9 7zm3.7-1.6c.7-1.6 1.1-3.5 1.2-5.4h3a8 8 0 0 1-4.2 5.4z"/></svg>'
};

/** Pied de page façon papier à en-tête (nom souligné, icônes, identifiants) ; '' si tout est vide. */
function footerHtml(societe) {
  const s = societe || {};
  const nom = [s.nom, s.formeJuridique].filter(Boolean).join(' ');
  const tel = [s.telFixe, s.telMobile].filter(Boolean).join(' / ');
  const items = [
    s.siege && { icon: ICONS.pin, text: s.siege },
    tel && { icon: ICONS.tel, text: tel },
    s.email && { icon: ICONS.mail, text: s.email },
    s.website && { icon: ICONS.web, text: s.website }
  ].filter(Boolean);
  const regs = [
    s.rc && `R.C : ${s.rc}`,
    s.ifFiscal && `I.F : ${s.ifFiscal}`,
    s.ice && `ICE : ${s.ice}`,
    s.cnss && `CNSS : ${s.cnss}`
  ]
    .filter(Boolean)
    .join('  -  ');
  if (!nom && !items.length && !regs) return '';
  return `
<div class="bp-footer">
  ${nom ? `<div class="bp-footer-nom">${esc(nom)}</div>` : ''}
  ${
    items.length
      ? `<div class="bp-footer-row">${items
          .map((it) => `<span class="bp-footer-item">${it.icon}<span>${esc(it.text)}</span></span>`)
          .join('')}</div>`
      : ''
  }
  ${regs ? `<div class="bp-footer-regs">${esc(regs)}</div>` : ''}
</div>`;
}

/** Encadré des informations du bon, présent sur la première page uniquement. */
function infoBoxHtml(bon, nbColis) {
  const livreur = [bon.livreur_name, bon.zone].filter(Boolean).join(' — ');
  return `
<div class="bp-title">Bon de retour livreur${bon.livreur_name ? ` — ${esc(bon.livreur_name)}` : ''}</div>
<div class="bp-info">
  <div class="bp-info-item">
    <div class="bp-info-label">Référence du bon</div>
    <div class="bp-info-value">${esc(bon.ref || '—')}</div>
  </div>
  <div class="bp-info-item">
    <div class="bp-info-label">Date du bon</div>
    <div class="bp-info-value">${esc(formatDate(bon.time))}</div>
  </div>
  <div class="bp-info-item">
    <div class="bp-info-label">Livreur</div>
    <div class="bp-info-value">${esc(livreur || '—')}</div>
  </div>
  <div class="bp-info-item">
    <div class="bp-info-label">Nombre de colis</div>
    <div class="bp-info-value">${nbColis}</div>
  </div>
</div>`;
}

const TABLE_HEAD = `
<colgroup>
  <col style="width:52px" /><col style="width:200px" /><col style="width:170px" /><col /><col style="width:210px" />
</colgroup>
<thead>
  <tr><th class="bp-num">N°</th><th>Code de colis</th><th>Date de réception</th><th>Ville</th><th>Statut</th></tr>
</thead>`;

function rowHtml(parcel, numero) {
  const dateReception = Number(parcel.received) === 1 ? formatDate(parcel.received_time) : '—';
  const statut = parcel.statut_avant ? statutLabel(parcel.statut_avant) : 'En cours';
  return `
<tr>
  <td class="bp-num">${numero}</td>
  <td>
    <div class="bp-code">${esc(parcel.code || '—')}</div>
    <div class="bp-sub">${esc(parcel.magasin || '—')}</div>
  </td>
  <td><div class="bp-cell">${esc(dateReception)}</div></td>
  <td>
    <div class="bp-cell">${esc(parcel.ville || '—')}</div>
    <div class="bp-sub">${esc(parcel.adresse || '—')}</div>
  </td>
  <td><div class="bp-cell">${esc(statut)}</div></td>
</tr>`;
}

/** Crée une page (fond en-tête + pied de page HTML) et son tableau ; renvoie { page, content, tbody }. */
function buildPage(host, enteteUrl, footer, withInfoBox, bon, nbColis) {
  const page = document.createElement('div');
  page.className = 'bp-page';
  if (enteteUrl) page.style.backgroundImage = `url("${enteteUrl}")`;
  page.innerHTML = `
<div class="bp-content">
  ${withInfoBox ? infoBoxHtml(bon, nbColis) : ''}
  <table class="bp-table">${TABLE_HEAD}<tbody></tbody></table>
</div>
${footer}
<div class="bp-pagenum"></div>`;
  host.appendChild(page);
  return { page, content: page.querySelector('.bp-content'), tbody: page.querySelector('tbody') };
}

/**
 * Génère le PDF du bon de retour livreur et renvoie une URL blob à ouvrir
 * dans un onglet.
 * @param {{bon: {ref, time, livreur_name, zone}, parcels: object[], societe: object}} options
 *   societe : réponse de GET /platform/societe (champs texte + entete).
 *   onProgress : facultatif, appelé avant chaque capture de page (n° de page, total).
 */
export async function genererBonRetourLivreurPdf({ bon, parcels, societe, onProgress }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  const entete = await preloadEntete(societe?.entetePdf || societe?.entete);
  const footer = footerHtml(societe);
  // L'API renvoie les colis du plus récent au plus ancien : le document les
  // numérote dans l'ordre d'ajout au bon (1 = premier colis ajouté).
  const rows = [...(parcels || [])].reverse();

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-11000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    // Remplissage page par page : une ligne qui déborde part sur la page suivante.
    const pages = [];
    let current = buildPage(host, entete, footer, true, bon, rows.length);
    pages.push(current);

    if (!rows.length) {
      current.tbody.innerHTML = `<tr><td colspan="5" class="bp-empty">Aucun colis dans ce bon.</td></tr>`;
    }
    rows.forEach((parcel, i) => {
      current.tbody.insertAdjacentHTML('beforeend', rowHtml(parcel, i + 1));
      const overflow = current.content.scrollHeight > current.content.clientHeight;
      // Une ligne seule sur sa page est conservée même trop haute (cas extrême).
      if (overflow && current.tbody.children.length > 1) {
        const row = current.tbody.lastElementChild;
        current = buildPage(host, entete, footer, false, bon, rows.length);
        pages.push(current);
        current.tbody.appendChild(row);
      }
    });

    pages.forEach((p, i) => {
      p.page.querySelector('.bp-pagenum').textContent = `Page ${i + 1} / ${pages.length}`;
    });

    // « await » indispensable : le finally ci-dessous retire host du DOM et doit attendre la fin des captures.
    return await pagesVersPdf({ jsPDF, html2canvas, host, pages: pages.map((p) => p.page), onProgress });
  } finally {
    document.body.removeChild(host);
  }
}
