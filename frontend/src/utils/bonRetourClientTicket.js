/*
 * Ticket d'un bon de retour client (100 × 100 mm, imprimante thermique).
 *
 * Porte la référence du bon en clair, en QR et en Code128 (scannés par les
 * modales « Expédier au client » et « Vérifier par scan » — douchette 1D ou
 * caméra), les coordonnées du client (magasin, nom, téléphone, adresse,
 * ville) et le nombre de colis du bon (nombre nu, sans libellé).
 *
 * Même principe que les étiquettes colis (utils/etiquettes.js) : ticket
 * construit en DOM hors écran (rendu correct de l'arabe des adresses),
 * converti en image par html2canvas puis posé dans un PDF jsPDF 100 × 100 mm.
 * Les librairies sont chargées à la demande.
 */

import { ignorerHorsHost } from './pdfCapture';

// Ticket rendu à 500 × 500 px (5 px / mm), capturé à l'échelle 2 (≈ 254 dpi).
const TICKET_PX = 500;

const STYLE = `
.brt {
  width: ${TICKET_PX}px; height: ${TICKET_PX}px; box-sizing: border-box;
  padding: 12px; background: #fff; color: #000;
  font-family: Arial, Helvetica, sans-serif; font-size: 18px; line-height: 1.35;
  display: flex; flex-direction: column; gap: 10px;
}
.brt-box { border: 2px solid #000; border-radius: 14px; padding: 8px 12px; background: #fff; overflow: hidden; box-sizing: border-box; }
.brt-ref { text-align: center; font-size: 29px; font-weight: 800; letter-spacing: 2px; font-family: 'Courier New', Courier, monospace; white-space: nowrap; padding: 10px 6px; }
.brt-cols { flex: 1; display: flex; gap: 10px; min-height: 0; }
.brt-left { width: 236px; display: flex; flex-direction: column; gap: 10px; }
.brt-qr { flex: none; display: flex; align-items: center; justify-content: center; padding: 8px; }
.brt-qr img { width: 196px; height: 196px; }
.brt-count { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 72px; font-weight: 800; }
.brt-client { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.brt-store { font-size: 25px; font-weight: 800; overflow-wrap: break-word; word-break: break-word; }
.brt-nom { font-size: 19px; font-weight: 600; }
.brt-phone { font-size: 24px; font-weight: 800; letter-spacing: 1px; white-space: nowrap; }
.brt-adr { font-size: 19px; overflow-wrap: break-word; word-break: break-word; }
.brt-ville { font-size: 21px; font-weight: 800; text-transform: uppercase; }
.brt-bar { height: 86px; flex: none; display: flex; align-items: center; justify-content: center; padding: 8px 12px; }
.brt-bar canvas { width: 100%; height: 62px; }
`;

/** Échappe le texte injecté dans le HTML du ticket. */
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

function ticketHtml(bon) {
  const store = bon.store || '';
  const nom = bon.client_name || '';
  const nb = Array.isArray(bon.parcels) ? bon.parcels.length : Number(bon.nb_colis) || 0;
  return `
<div class="brt">
  <div class="brt-box brt-ref">${esc(bon.ref || '')}</div>
  <div class="brt-cols">
    <div class="brt-left">
      <div class="brt-box brt-qr"><img alt="" /></div>
      <div class="brt-box brt-count">${nb}</div>
    </div>
    <div class="brt-box brt-client">
      <div class="brt-store">${esc(store || nom || '—')}${
        store && nom && nom !== store ? ` <span class="brt-nom">(${esc(nom)})</span>` : ''
      }</div>
      <div class="brt-phone">${esc(formatPhone(bon.phone))}</div>
      <div class="brt-adr">${esc(bon.address || '')}</div>
      <div class="brt-ville">${esc(bon.ville || '')}</div>
    </div>
  </div>
  <div class="brt-box brt-bar"><canvas></canvas></div>
</div>`;
}

/**
 * Génère le PDF du ticket (une page 100 × 100 mm) et renvoie une URL blob à
 * ouvrir dans un onglet.
 * @param {{bon: {ref, store, client_name, phone, address, ville, parcels?, nb_colis?}}} options
 *   bon : réponse de GET /bons-retour-client/:id (ou ligne de la liste).
 */
export async function genererTicketBonRetourClient({ bon }) {
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
    const wrap = document.createElement('div');
    wrap.innerHTML = ticketHtml(bon);
    const ticket = wrap.firstElementChild;
    host.appendChild(ticket);

    const code = String(bon.ref || bon.id || '');
    ticket.querySelector('.brt-qr img').src = await QRCode.toDataURL(code, {
      margin: 0,
      width: 236,
      errorCorrectionLevel: 'M'
    });
    JsBarcode(ticket.querySelector('.brt-bar canvas'), code, {
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      width: 2,
      height: 90
    });

    const shot = await html2canvas(ticket, {
      scale: 2,
      backgroundColor: '#ffffff',
      logging: false,
      ignoreElements: ignorerHorsHost(host)
    });
    const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
    // 'FAST' : jsPDF ré-encode le PNG en JavaScript (deflate niveau 1 au lieu de 4).
    doc.addImage(shot.toDataURL('image/png'), 'PNG', 0, 0, 100, 100, undefined, 'FAST');
    return URL.createObjectURL(doc.output('blob'));
  } finally {
    document.body.removeChild(host);
  }
}
