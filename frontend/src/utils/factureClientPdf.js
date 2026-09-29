/*
 * Facture client en PDF (page admin Facturation clients > Factures).
 *
 * Même construction que la facture livreur (utils/factureLivreurPdf.js) :
 * chaque page A4 est bâtie en DOM hors écran puis convertie en image
 * (html2canvas) et posée dans le PDF (jsPDF), avec l'image « Page en-tête »
 * de la plateforme en arrière-plan et le pied de page société.
 *  - encadré des informations en haut à gauche : référence, date, magasin,
 *    client, nombre de colis, total à payer ;
 *  - tableau des colis (N°, code d'envoi, date de livraison, statut, COD,
 *    frais, frais supp de livraison, prix reste), réparti sur autant de pages
 *    que nécessaire, avec une dernière ligne de totaux, puis les frais
 *    supplémentaires, la remise (legacy) et le net à payer ;
 *  - sous le tableau : « Facture arrêtée à la somme de … » (montant en
 *    lettres).
 */

import { pagesVersPdf } from './pdfCapture';

import { statutLabel } from './statuts';
import { montantEnLettres } from './factureLivreurPdf';

const PAGE_W = 1050;
const PAGE_H = 1485;
const PAD_TOP = 240;
const PAD_SIDE = 60;
const PAD_BOTTOM = 170;
const BLEU = '#1c428a';

const STYLE = `
.fp-page {
  position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; box-sizing: border-box;
  padding: ${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px; background: #fff no-repeat center / 100% 100%;
  color: #000; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.4;
}
.fp-content { height: 100%; overflow: hidden; }
.fp-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
/* Encadré en haut à gauche. Bloc à largeur fixe + items inline-block :
   html2canvas ne supporte pas grid, et peint le fond d'un élément
   inline-block PAR-DESSUS ses enfants (encadré vide) — display block requis. */
.fp-info {
  width: 660px; box-sizing: border-box;
  border: 2px solid #1f2937; border-radius: 10px; padding: 6px 18px 16px; margin-bottom: 20px; background: #fff;
}
.fp-info-item { display: inline-block; vertical-align: top; width: 270px; margin: 10px 24px 0 0; }
.fp-info-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 3px; }
.fp-info-value { font-size: 17px; font-weight: 700; }
.fp-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
/* white-space: normal — annule le nowrap global de l'application (cf. bonEnvoiPdf). */
.fp-table th, .fp-table td { border: 1px solid #374151; padding: 6px 8px; text-align: left; vertical-align: top; white-space: normal; }
.fp-table th { background: #eef1f6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
.fp-cell { white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.fp-num { text-align: center; }
.fp-montant { text-align: right; }
.fp-code { font-weight: 700; overflow-wrap: break-word; word-break: break-word; }
.fp-total td { background: #eef1f6; font-weight: 800; }
.fp-empty { text-align: center; color: #4b5563; }
.fp-lettres { margin-top: 16px; font-size: 16px; font-weight: 700; }
.fp-footer { position: absolute; left: ${PAD_SIDE}px; right: ${PAD_SIDE}px; bottom: 18px; color: ${BLEU}; }
.fp-footer-nom { display: inline-block; font-size: 21px; font-weight: 800; border-bottom: 2px solid ${BLEU}; padding-bottom: 2px; margin-bottom: 6px; }
.fp-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; font-size: 13px; font-weight: 700; }
.fp-footer-item { display: inline-flex; align-items: center; gap: 6px; }
.fp-footer-item svg { width: 15px; height: 15px; fill: ${BLEU}; flex: none; }
.fp-footer-regs { margin-top: 5px; font-size: 12px; font-weight: 700; }
.fp-pagenum { position: absolute; right: ${PAD_SIDE}px; bottom: 10px; font-size: 12px; color: ${BLEU}; }
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

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/** Précharge l'image d'en-tête ; null (page blanche) si absente ou en erreur. */
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

/* Icônes du pied de page (mêmes tracés que bonEnvoiPdf). */
const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  tel: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>',
  web: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.9 9h-3a15.5 15.5 0 0 0-1.2-5.4A8 8 0 0 1 19.9 11zM12 4c.9 1.2 1.7 3.5 1.9 7h-3.8c.2-3.5 1-5.8 1.9-7zM4.1 13h3c.1 1.9.5 3.8 1.2 5.4A8 8 0 0 1 4.1 13zm3-2h-3a8 8 0 0 1 4.2-5.4A15.5 15.5 0 0 0 7.1 11zm4.9 9c-.9-1.2-1.7-3.5-1.9-7h3.8c-.2 3.5-1 5.8-1.9 7zm3.7-1.6c.7-1.6 1.1-3.5 1.2-5.4h3a8 8 0 0 1-4.2 5.4z"/></svg>'
};

/** Pied de page façon papier à en-tête ; '' si tout est vide. */
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
<div class="fp-footer">
  ${nom ? `<div class="fp-footer-nom">${esc(nom)}</div>` : ''}
  ${
    items.length
      ? `<div class="fp-footer-row">${items
          .map((it) => `<span class="fp-footer-item">${it.icon}<span>${esc(it.text)}</span></span>`)
          .join('')}</div>`
      : ''
  }
  ${regs ? `<div class="fp-footer-regs">${esc(regs)}</div>` : ''}
</div>`;
}

/** Statut affiché d'une ligne : Livré, ou statut second du colis (Refusé / Annulé). */
function ligneStatut(parcel) {
  if (parcel.line_statut === 'DELIVERED' || parcel.status === 'DELIVERED') return 'Livré';
  return statutLabel(parcel.status_second || 'REFUSE');
}

/** Encadré des informations de la facture (première page uniquement). */
function infoBoxHtml(facture, nbColis, total) {
  const items = [
    ['Référence', facture.ref || '—'],
    ['Date', formatDate(facture.time)],
    ['Magasin', facture.store || '—'],
    ['Client', facture.client_name || '—'],
    ['Nombre de colis', String(nbColis)],
    ['Total à payer', formatMontant(total)]
  ];
  return `
<div class="fp-title">Facture client</div>
<div class="fp-info">
  ${items
    .map(
      ([label, value]) => `<div class="fp-info-item">
    <div class="fp-info-label">${esc(label)}</div>
    <div class="fp-info-value">${esc(value)}</div>
  </div>`
    )
    .join('')}
</div>`;
}

const TABLE_HEAD = `
<colgroup>
  <col style="width:48px" /><col style="width:190px" /><col style="width:130px" /><col style="width:115px" />
  <col style="width:105px" /><col style="width:100px" /><col style="width:110px" /><col />
</colgroup>
<thead>
  <tr><th class="fp-num">N°</th><th>Code d'envoi</th><th>Date de livraison</th><th>Statut</th>
  <th class="fp-montant">COD</th><th class="fp-montant">Frais</th>
  <th class="fp-montant">Frais supp</th>
  <th class="fp-montant">Prix reste</th></tr>
</thead>`;

function rowHtml(parcel, numero) {
  return `
<tr>
  <td class="fp-num">${numero}</td>
  <td class="fp-code">${esc(parcel.code || '—')}</td>
  <td><div class="fp-cell">${esc(formatDate(parcel.statut_time))}</div></td>
  <td><div class="fp-cell">${esc(ligneStatut(parcel))}</div></td>
  <td class="fp-montant">${esc(formatMontant(parcel.crbt))}</td>
  <td class="fp-montant">${esc(formatMontant(parcel.frais))}</td>
  <td class="fp-montant">${esc(formatMontant(parcel.frais_supp))}</td>
  <td class="fp-montant">${esc(formatMontant(parcel.prix))}</td>
</tr>`;
}

function totalRowHtml(totaux) {
  return `
<tr class="fp-total">
  <td colspan="4">Total</td>
  <td class="fp-montant">${esc(formatMontant(totaux.crbt))}</td>
  <td class="fp-montant">${esc(formatMontant(totaux.frais))}</td>
  <td class="fp-montant">${esc(formatMontant(totaux.fraisSupp))}</td>
  <td class="fp-montant">${esc(formatMontant(totaux.prix))}</td>
</tr>`;
}

/** Ligne d'un frais supplémentaire du client (déduit du net à payer). */
function fraisSuppRowHtml(f) {
  const date = f.date_frais ? new Date(f.date_frais * 1000).toLocaleDateString('fr-FR') : '—';
  return `
<tr>
  <td colspan="6">Frais supplémentaire : ${esc(f.titre)} (${esc(date)})</td>
  <td colspan="2" class="fp-montant">- ${esc(formatMontant(f.montant))}</td>
</tr>`;
}

/** Ligne de la remise legacy (déduite du net à payer). */
function remiseRowHtml(remise) {
  return `
<tr>
  <td colspan="6">Remise</td>
  <td colspan="2" class="fp-montant">- ${esc(formatMontant(remise))}</td>
</tr>`;
}

/** Ligne du net à payer (total colis - frais supplémentaires - remise). */
function netRowHtml(net) {
  return `
<tr class="fp-total">
  <td colspan="6">Net à payer</td>
  <td colspan="2" class="fp-montant">${esc(formatMontant(net))}</td>
</tr>`;
}

/** Crée une page (fond en-tête + pied de page) ; { page, content, tbody }. */
function buildPage(host, enteteUrl, footer, withInfoBox, facture, nbColis, total) {
  const page = document.createElement('div');
  page.className = 'fp-page';
  if (enteteUrl) page.style.backgroundImage = `url("${enteteUrl}")`;
  page.innerHTML = `
<div class="fp-content">
  ${withInfoBox ? infoBoxHtml(facture, nbColis, total) : ''}
  <table class="fp-table">${TABLE_HEAD}<tbody></tbody></table>
</div>
${footer}
<div class="fp-pagenum"></div>`;
  host.appendChild(page);
  return { page, content: page.querySelector('.fp-content'), tbody: page.querySelector('tbody') };
}

/**
 * Génère le PDF de la facture client et renvoie une URL blob.
 * @param {{facture: object, parcels: object[], societe: object}} options
 *   facture / parcels : réponse de GET /factures-clients/:id ;
 *   societe : réponse de GET /platform/societe.
 *   onProgress : facultatif, appelé avant chaque capture de page (n° de page, total).
 */
export async function genererFactureClientPdf({ facture, parcels, societe, onProgress }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  const entete = await preloadEntete(societe?.entetePdf || societe?.entete);
  const footer = footerHtml(societe);
  // L'API renvoie les colis du plus récemment ajouté au plus ancien : la
  // facture les numérote dans l'ordre d'ajout (1 = premier colis ajouté).
  const rows = [...(parcels || [])].reverse();
  const totaux = rows.reduce(
    (acc, p) => ({
      crbt: acc.crbt + Number(p.crbt || 0),
      frais: acc.frais + Number(p.frais || 0),
      fraisSupp: acc.fraisSupp + Number(p.frais_supp || 0),
      prix: acc.prix + Number(p.prix || 0)
    }),
    { crbt: 0, frais: 0, fraisSupp: 0, prix: 0 }
  );
  // Frais rattachés (ORTALOG + legacy) et remise : déduits du net à payer.
  const fraisSupp = facture.frais || [];
  const totalFraisSupp = fraisSupp.reduce((acc, f) => acc + Number(f.montant || 0), 0);
  const remise = Number(facture.remise) || 0;
  const net = totaux.prix - totalFraisSupp - remise;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-11000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    const pages = [];
    let current = buildPage(host, entete, footer, true, facture, rows.length, net);
    pages.push(current);

    if (!rows.length) {
      current.tbody.innerHTML = `<tr><td colspan="8" class="fp-empty">Aucun colis dans cette facture.</td></tr>`;
    }
    // Remplissage page par page : une ligne qui déborde part sur la suivante.
    const append = (html) => {
      current.tbody.insertAdjacentHTML('beforeend', html);
      const overflow = current.content.scrollHeight > current.content.clientHeight;
      if (overflow && current.tbody.children.length > 1) {
        const row = current.tbody.lastElementChild;
        current = buildPage(host, entete, footer, false, facture, rows.length, net);
        pages.push(current);
        current.tbody.appendChild(row);
      }
    };
    rows.forEach((parcel, i) => append(rowHtml(parcel, i + 1)));
    if (rows.length) append(totalRowHtml(totaux));
    fraisSupp.forEach((f) => append(fraisSuppRowHtml(f)));
    if (remise > 0) append(remiseRowHtml(remise));
    if (fraisSupp.length || remise > 0) append(netRowHtml(net));

    // Montant en lettres sous le tableau (bascule en page suivante si besoin).
    const lettres = document.createElement('div');
    lettres.className = 'fp-lettres';
    lettres.textContent = `Facture arrêtée à la somme de : ${montantEnLettres(net)}.`;
    current.content.appendChild(lettres);
    if (current.content.scrollHeight > current.content.clientHeight) {
      lettres.remove();
      current = buildPage(host, entete, footer, false, facture, rows.length, net);
      pages.push(current);
      current.content.querySelector('.fp-table').remove();
      current.content.appendChild(lettres);
    }

    pages.forEach((p, i) => {
      p.page.querySelector('.fp-pagenum').textContent = `Page ${i + 1} / ${pages.length}`;
    });

    // « await » indispensable : le finally ci-dessous retire host du DOM et doit attendre la fin des captures.
    return await pagesVersPdf({ jsPDF, html2canvas, host, pages: pages.map((p) => p.page), onProgress });
  } finally {
    document.body.removeChild(host);
  }
}
