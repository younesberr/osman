/*
 * Impression des étiquettes colis en PDF (dashboard client).
 *
 * Chaque étiquette (100 × 100 mm) est construite en DOM hors écran — ce qui
 * permet au navigateur de rendre correctement l'arabe — puis convertie en
 * image par html2canvas et posée dans le PDF (jsPDF). Les captures se font
 * par lots (une capture pour 12 étiquettes, découpée ensuite) et le reste de
 * la page est exclu du clone html2canvas : sans cela, chaque étiquette
 * clonait tout le document (datatable comprise), d'où des impressions très
 * lentes dès que plusieurs colis étaient sélectionnés.
 * Formats :
 *  - format "100" : une page 100 × 100 mm par étiquette (imprimante thermique) ;
 *  - format "a4"  : 4 étiquettes par page A4 (grille 2 × 2, traits de découpe).
 * Les librairies sont chargées à la demande (comme xlsx pour l'export Excel).
 */

import { ignorerHorsHost } from './pdfCapture';

// Étiquette rendue à 500 × 500 px (5 px / mm), capturée à l'échelle 2 (≈ 254 dpi).
const LABEL_PX = 500;

const AR_OPEN = ['لا يـسـمـح بـفـتـح الـطـلبـيـة', 'يـسـمـح بـفـتـح الـطـلبـيـة'];
const AR_ESSAYAGE = ['لا يسمح بالقياس او التجربة', 'يسمح بالقياس او التجربة'];

const STYLE = `
.etq {
  width: ${LABEL_PX}px; height: ${LABEL_PX}px; box-sizing: border-box;
  padding: 10px 14px; background: #fff; color: #000;
  font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.35;
  display: flex; flex-direction: column; gap: 8px;
}
.etq-box { border: 2px solid #000; border-radius: 14px; padding: 6px 10px; background: #fff; overflow: hidden; }
.etq-logo { height: 62px; display: flex; align-items: center; justify-content: center; }
.etq-logo img { max-height: 62px; max-width: 320px; }
.etq-logo-txt { font-size: 34px; font-weight: 800; color: #1c428a; letter-spacing: 1px; }
.etq-logo-txt span { color: #f6db14; }
.etq-cols { flex: 1; display: flex; gap: 10px; min-height: 0; }
.etq-left { width: 152px; display: flex; flex-direction: column; gap: 8px; }
.etq-left .etq-box { flex-shrink: 0; }
.etq-qr { padding: 6px; display: flex; align-items: center; justify-content: center; }
.etq-qr img { width: 90px; height: 90px; }
.etq-zone { flex: 1; min-height: 26px; display: flex; align-items: center; justify-content: center; text-align: center; font-weight: 700; font-size: 14px; text-transform: uppercase; }
.etq-ar { direction: rtl; text-align: center; font-weight: 700; font-size: 14px; padding: 4px 6px; }
.etq-echange { direction: ltr; }
.etq-vide { visibility: hidden; }
.etq-right { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.etq-client { flex: 1; }
.etq-bottom { display: flex; gap: 10px; align-items: stretch; height: 78px; }
.etq-crbt { width: 118px; border: 2px solid #000; border-radius: 44px; display: flex; align-items: center; justify-content: center; text-align: center; font-weight: 700; font-size: 17px; }
.etq-bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 5px 10px; }
.etq-bar canvas { width: 100%; height: 40px; }
.etq-code { font-size: 19px; font-weight: 600; letter-spacing: 5px; white-space: nowrap; }
.etq-footer { text-align: center; font-weight: 700; padding: 4px 10px; }
`;

/** Échappe le texte injecté dans le HTML de l'étiquette. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** "0661280962" → "06-61-28-09-62" (les autres formats sont laissés tels quels). */
function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? digits.replace(/(\d{2})(?=\d)/g, '$1-') : String(phone || '');
}

/** Timestamp unix (secondes) → "AAAA-MM-JJ HH:mm" (comme l'étiquette legacy). */
function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Montant contre-remboursement : 0 si le colis est marqué "CRBT zéro". */
function crbtOf(p) {
  if (Number(p.parcel_crbt_zero) === 1) return '0';
  const n = Number(p.parcel_price);
  return Number.isFinite(n) ? String(n) : '0';
}

/**
 * Ligne « Marchandise » du ticket. Colis de stock (stock_produits fourni par
 * l'API) : liste des produits avec position de stock et quantité, au format
 * « A4-timicha(2) | B3-jwipina(1) » ; sinon marchandise saisie sur le colis.
 */
function marchandiseHtml(p) {
  const produits = Array.isArray(p.stock_produits) ? p.stock_produits : null;
  if (produits) {
    const items = produits.map((pr) => {
      const nom = [pr.nom || '', pr.variante || ''].filter(Boolean).join(' ');
      return `${pr.position ? `${esc(pr.position)}-` : ''}${esc(nom)}(${Number(pr.qty) || 0})`;
    });
    return `<b>Produits :</b> ${items.join(' | ') || '—'}`;
  }
  return `<b>Marchandise :</b> ${esc(p.parcel_product_name || '')} (${esc(p.parcel_product_qty || 1)})`;
}

function labelHtml(p, sender, logoDataUrl) {
  // Impression admin : les colis peuvent appartenir à des clients différents,
  // l'expéditeur est alors porté par chaque étiquette (sender_store / sender_phone).
  const store = p.sender_store ?? sender.store;
  const phone = p.sender_phone ?? sender.phone;
  const logo = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="" />`
    : `<div class="etq-logo-txt">ORTALOG<span> LIVRAISON</span></div>`;
  return `
<div class="etq">
  <div class="etq-logo">${logo}</div>
  <div class="etq-cols">
    <div class="etq-left">
      <div class="etq-box etq-qr"><img alt="" /></div>
      <div class="etq-box etq-zone">${esc(p.zone || '')}</div>
      <div class="etq-box etq-ar">${AR_OPEN[Number(p.parcel_open) === 1 ? 1 : 0]}</div>
      <div class="etq-box etq-ar">${AR_ESSAYAGE[Number(p.parcel_essayage) === 1 ? 1 : 0]}</div>
      <div class="etq-box etq-ar etq-echange${Number(p.parcel_replace) === 1 ? '' : ' etq-vide'}">colis échange</div>
    </div>
    <div class="etq-right">
      <div class="etq-box">
        <b>Expéditeur :</b> ${esc(store || '')}<br />
        <b>Téléphone :</b> <b>${esc(formatPhone(phone))}</b><br />
        <b>Date :</b> ${esc(formatDateTime(p.parcel_time))}
      </div>
      <div class="etq-box etq-client">
        <b>Client :</b> ${esc(p.parcel_receiver || '')}<br />
        <b>Téléphone :</b> ${esc(formatPhone(p.parcel_phone))}<br />
        <b>Ville :</b> ${esc(p.ville || '')}<br />
        <b>Adresse :</b> ${esc(p.parcel_address || '')}<br />
        <b>Note :</b> ${esc(p.parcel_note || '')}
      </div>
      <div class="etq-box etq-march">
        ${marchandiseHtml(p)}
      </div>
    </div>
  </div>
  <div class="etq-bottom">
    <div class="etq-crbt">Crbt :<br />${esc(crbtOf(p))} DH</div>
    <div class="etq-box etq-bar">
      <canvas></canvas>
      <div class="etq-code">${esc(p.parcel_code || '')}</div>
    </div>
  </div>
  <div class="etq-box etq-footer">${esc(store || 'ORTALOG')} vous remercie de votre confiance</div>
</div>`;
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

/**
 * Génère le PDF des étiquettes et renvoie une URL blob à ouvrir dans un onglet.
 * @param {{labels: object[], sender: {store, phone}, logoUrl?: string, format: 'a4'|'100'}} options
 *   onProgress : facultatif, appelé avant chaque lot (n° de la dernière étiquette du lot, total).
 */
export async function genererEtiquettesPdf({ labels, sender, logoUrl, format, onProgress }) {
  const [{ jsPDF }, html2canvasMod, QRCode, JsBarcodeMod] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
    import('qrcode'),
    import('jsbarcode')
  ]);
  const html2canvas = html2canvasMod.default;
  const JsBarcode = JsBarcodeMod.default;

  const logo = await preloadLogo(logoUrl);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    // QR codes générés d'un bloc avant le rendu (un await par étiquette sinon).
    const qrCodes = await Promise.all(
      labels.map((p) =>
        QRCode.toDataURL(String(p.parcel_code || p.parcel_id), {
          margin: 0,
          width: 236,
          errorCorrectionLevel: 'M'
        })
      )
    );

    // 12 étiquettes par capture : 12 × 1000 × 1000 px à l'échelle 2, sous la
    // limite de surface canvas la plus basse (Safari, ~16,7 M px).
    const BATCH = 12;
    const images = [];
    for (let start = 0; start < labels.length; start += BATCH) {
      const batch = labels.slice(start, start + BATCH);
      const wrap = document.createElement('div');
      wrap.innerHTML = batch.map((p) => labelHtml(p, sender || {}, logo)).join('');
      host.appendChild(wrap);
      batch.forEach((p, i) => {
        const etq = wrap.children[i];
        etq.querySelector('.etq-qr img').src = qrCodes[start + i];
        JsBarcode(etq.querySelector('.etq-bar canvas'), String(p.parcel_code || p.parcel_id), {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          width: 3,
          height: 90
        });
      });

      if (onProgress) onProgress(Math.min(start + BATCH, labels.length), labels.length);
      const shot = await html2canvas(wrap, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        // Seul host nous intéresse : le reste de la page (datatable, modales…)
        // est écarté du clone interne de html2canvas.
        ignoreElements: ignorerHorsHost(host)
      });
      host.removeChild(wrap);

      const sliceH = shot.height / batch.length;
      for (let i = 0; i < batch.length; i++) {
        const slice = document.createElement('canvas');
        slice.width = shot.width;
        slice.height = Math.round(sliceH);
        slice.getContext('2d').drawImage(
          shot,
          0, Math.round(i * sliceH), shot.width, Math.round(sliceH),
          0, 0, slice.width, slice.height
        );
        images.push(slice.toDataURL('image/png'));
      }
    }

    let doc;
    if (format === 'a4') {
      // 4 étiquettes de 100 mm par page A4 (210 × 297), grille centrée + traits de découpe.
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
