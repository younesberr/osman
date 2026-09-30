/*
 * Tickets vides en PDF (pages admin Tickets vides > transport / clients).
 *
 * Même construction que les étiquettes colis (utils/etiquettes.js) : chaque
 * ticket 100 × 100 mm est bâti en DOM hors écran, converti en image
 * (html2canvas) puis posé dans le PDF (jsPDF) — format « 100 » (une page par
 * ticket, imprimante thermique) ou « a4 » (4 tickets par page, traits de
 * découpe). Les codes ne sont PAS enregistrés en base (comme le legacy) :
 * ils n'existent que sur le papier jusqu'au scan / à la saisie du colis.
 *
 *  - Ticket transport (tickets_transport.php) : case expéditeur, flèche,
 *    QR + code en clair, case destinataire. QR seul, comme le legacy.
 *  - Ticket client (tickets_vendeurs.php) : étiquette colis VIERGE, même
 *    maquette que l'étiquette remplie (logo, QR, cases arabes, expéditeur /
 *    destinataire / marchandise en lignes pointillées à remplir à la main,
 *    prix, code-barres CODE128 + code).
 */

import { ignorerHorsHost } from './pdfCapture';
import { BRAND } from '../config/brand';

const LABEL_PX = 500;

const STYLE = `
.tkt {
  width: ${LABEL_PX}px; height: ${LABEL_PX}px; box-sizing: border-box;
  padding: 12px 16px; background: #fff; color: #000;
  font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.35;
  display: flex; flex-direction: column; gap: 10px;
}
.tkt-box { border: 2px solid #000; border-radius: 14px; padding: 8px 12px; background: #fff; overflow: hidden; }

/* ---- Ticket transport ---- */
.tkt-societe { min-height: 92px; }
.tkt-societe-role { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; }
.tkt-societe-nom { font-size: 21px; font-weight: 800; margin-top: 2px; overflow-wrap: break-word; }
.tkt-societe-sub { font-size: 14px; margin-top: 2px; }
.tkt-mid { flex: 1; display: flex; align-items: center; justify-content: center; gap: 18px; }
.tkt-arrow { width: 46px; }
.tkt-arrow svg { width: 46px; height: 84px; fill: #000; }
.tkt-qr { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.tkt-qr img { width: 150px; height: 150px; }
.tkt-code { font-size: 17px; font-weight: 700; letter-spacing: 1px; text-align: center; }

/* ---- Ticket client (vierge) ---- */
.tkt-logo { height: 56px; display: flex; align-items: center; justify-content: center; flex: none; }
.tkt-logo img { max-height: 56px; max-width: 300px; }
.tkt-logo-txt { font-size: 30px; font-weight: 800; color: ${BRAND.colorPrimary}; letter-spacing: 1px; }
.tkt-logo-txt span { color: ${BRAND.colorSecondary}; }
.tkt-cols { flex: 1; display: flex; gap: 10px; min-height: 0; }
.tkt-left { width: 148px; display: flex; flex-direction: column; gap: 8px; }
.tkt-left .tkt-box { flex-shrink: 0; padding: 6px 8px; }
.tkt-qr-small { display: flex; align-items: center; justify-content: center; }
.tkt-qr-small img { width: 92px; height: 92px; }
.tkt-ar { direction: rtl; text-align: center; font-weight: 700; font-size: 13px; }
.tkt-ar-choix { direction: rtl; display: flex; justify-content: center; gap: 14px; font-weight: 400; font-size: 13px; margin-top: 2px; }
.tkt-ar-choix span::before { content: ""; display: inline-block; width: 12px; height: 12px; border: 1.5px solid #000; border-radius: 3px; margin-left: 5px; vertical-align: -2px; }
.tkt-right { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.tkt-fill { flex: 1; }
.tkt-titre { font-weight: 700; }
.tkt-titre small { font-weight: 400; color: #4b5563; }
.tkt-ligne { border-bottom: 1.5px dashed #333; height: 24px; margin-top: 6px; display: flex; align-items: flex-end; font-size: 13px; color: #374151; }
.tkt-bottom { display: flex; gap: 10px; align-items: stretch; height: 76px; flex: none; }
.tkt-prix { width: 116px; border: 2px solid #000; border-radius: 40px; display: flex; align-items: center; justify-content: center; text-align: center; font-weight: 700; font-size: 16px; }
.tkt-bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px 10px; }
.tkt-bar canvas { width: 100%; height: 38px; }
.tkt-bar-code { font-size: 18px; font-weight: 600; letter-spacing: 4px; white-space: nowrap; }
`;

/** Échappe le texte injecté dans le HTML des tickets. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const ARROW = `<svg viewBox="0 0 24 44"><path d="M12 0v34M12 44l-8-12h16z"/><rect x="10.5" y="0" width="3" height="34"/></svg>`;

/** Case société (expéditeur ou destinataire) d'un ticket transport. */
function societeBoxHtml(role, societe) {
  const s = societe || {};
  return `
<div class="tkt-box tkt-societe">
  <div class="tkt-societe-role">${esc(role)}</div>
  <div class="tkt-societe-nom">${esc(s.nom || '')}</div>
  <div class="tkt-societe-sub">${esc([s.ville, s.telephone].filter(Boolean).join(' — '))}</div>
</div>`;
}

/** Ticket transport : expéditeur → QR + code → destinataire. */
function ticketTransportHtml(ticket) {
  return `
<div class="tkt">
  ${societeBoxHtml('Expéditeur', ticket.exp)}
  <div class="tkt-mid">
    <div class="tkt-arrow">${ARROW}</div>
    <div class="tkt-qr">
      <img alt="" />
      <div class="tkt-code">${esc(ticket.code)}</div>
    </div>
    <div class="tkt-arrow">${ARROW}</div>
  </div>
  ${societeBoxHtml('Destinataire', ticket.dest)}
</div>`;
}

/** Ticket client vierge : maquette de l'étiquette colis, lignes à remplir. */
function ticketClientHtml(code, logoDataUrl) {
  const logo = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="" />`
    : `<div class="tkt-logo-txt">${BRAND.logoText.main}<span> ${BRAND.logoText.sub}</span></div>`;
  const choix = `<div class="tkt-ar-choix"><span>نعم</span><span>لا</span></div>`;
  return `
<div class="tkt">
  <div class="tkt-logo">${logo}</div>
  <div class="tkt-cols">
    <div class="tkt-left">
      <div class="tkt-box tkt-qr-small"><img alt="" /></div>
      <div class="tkt-box tkt-ar">يـسـمـح بالـفـتـح${choix}</div>
      <div class="tkt-box tkt-ar">Echange / استبدال${choix}</div>
    </div>
    <div class="tkt-right">
      <div class="tkt-box">
        <div class="tkt-titre">Expéditeur <small>| المرسل</small></div>
        <div class="tkt-ligne">Nom :</div>
        <div class="tkt-ligne">Téléphone :</div>
      </div>
      <div class="tkt-box tkt-fill">
        <div class="tkt-titre">Destinataire <small>| المرسل اليه</small></div>
        <div class="tkt-ligne">Nom :</div>
        <div class="tkt-ligne">Téléphone :</div>
        <div class="tkt-ligne">Ville :</div>
        <div class="tkt-ligne">Adresse :</div>
      </div>
      <div class="tkt-box">
        <div class="tkt-titre">Marchandise / Note</div>
        <div class="tkt-ligne"></div>
      </div>
    </div>
  </div>
  <div class="tkt-bottom">
    <div class="tkt-prix">Prix :<br />........ DH</div>
    <div class="tkt-box tkt-bar">
      <canvas></canvas>
      <div class="tkt-bar-code">${esc(code)}</div>
    </div>
  </div>
</div>`;
}

/** Précharge le logo plateforme ; null (repli texte) s'il est absent ou en erreur. */
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

/** Capture chaque ticket rendu en image PNG puis assemble le PDF ; onProgress(n° du ticket, total) facultatif. */
async function buildPdf(renders, format, onProgress) {
  const [{ jsPDF }, html2canvasMod, QRCode, JsBarcodeMod] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
    import('qrcode'),
    import('jsbarcode')
  ]);
  const html2canvas = html2canvasMod.default;
  const JsBarcode = JsBarcodeMod.default;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    const images = [];
    for (let i = 0; i < renders.length; i += 1) {
      const render = renders[i];
      if (onProgress) onProgress(i + 1, renders.length);
      const wrap = document.createElement('div');
      wrap.innerHTML = render.html;
      const tkt = wrap.firstElementChild;
      host.appendChild(tkt);

      const qrImg = tkt.querySelector('.tkt-qr img, .tkt-qr-small img');
      if (qrImg) {
        qrImg.src = await QRCode.toDataURL(render.code, {
          margin: 0,
          width: 300,
          errorCorrectionLevel: 'M'
        });
      }
      const barCanvas = tkt.querySelector('.tkt-bar canvas');
      if (barCanvas) {
        JsBarcode(barCanvas, render.code, {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          width: 3,
          height: 90
        });
      }

      const shot = await html2canvas(tkt, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        ignoreElements: ignorerHorsHost(host)
      });
      images.push(shot.toDataURL('image/png'));
      host.removeChild(tkt);
    }

    let doc;
    if (format === 'a4') {
      // 4 tickets de 100 mm par page A4 (210 × 297), grille centrée + traits de découpe.
      doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const x0 = (210 - 200) / 2;
      const y0 = (297 - 200) / 2;
      images.forEach((img, i) => {
        const k = i % 4;
        if (i > 0 && k === 0) doc.addPage();
        const x = x0 + (k % 2) * 100;
        const y = y0 + Math.floor(k / 2) * 100;
        // 'FAST' : jsPDF ré-encode chaque PNG en JavaScript (deflate niveau 1 au lieu de 4).
        doc.addImage(img, 'PNG', x, y, 100, 100, undefined, 'FAST');
        doc.setDrawColor(190);
        doc.setLineDashPattern([2, 2], 0);
        doc.rect(x, y, 100, 100);
        doc.setLineDashPattern([], 0);
      });
    } else {
      doc = new jsPDF({ unit: 'mm', format: [100, 100] });
      images.forEach((img, i) => {
        if (i > 0) doc.addPage([100, 100]);
        doc.addImage(img, 'PNG', 0, 0, 100, 100, undefined, 'FAST');
      });
    }
    return URL.createObjectURL(doc.output('blob'));
  } finally {
    document.body.removeChild(host);
  }
}

/**
 * Génère le PDF de tickets transport et renvoie une URL blob.
 * @param {{tickets: {code, exp, dest}[], format: 'a4'|'100'}} options
 *   exp / dest : { nom, ville, telephone } ;
 *   onProgress : facultatif, appelé avant chaque ticket (n° du ticket, total).
 */
export async function genererTicketsTransportPdf({ tickets, format, onProgress }) {
  return buildPdf(
    tickets.map((t) => ({ code: t.code, html: ticketTransportHtml(t) })),
    format,
    onProgress
  );
}

/**
 * Génère le PDF de tickets clients vierges et renvoie une URL blob.
 * @param {{codes: string[], logoUrl?: string, format: 'a4'|'100'}} options
 *   onProgress : facultatif, appelé avant chaque ticket (n° du ticket, total).
 */
export async function genererTicketsClientsPdf({ codes, logoUrl, format, onProgress }) {
  const logo = await preloadLogo(logoUrl);
  return buildPdf(
    codes.map((code) => ({ code, html: ticketClientHtml(code, logo) })),
    format,
    onProgress
  );
}
