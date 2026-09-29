/*
 * Facture transport en PDF (pages admin Transport > Facturation).
 *
 * Même construction que la facture livreur (utils/factureLivreurPdf.js) :
 * pages A4 bâties en DOM hors écran puis converties en image (html2canvas)
 * et posées dans le PDF (jsPDF), avec l'image « Page en-tête » de la
 * plateforme en arrière-plan et le pied de page société.
 *
 * Reprend la maquette du legacy transport_facturation.php :
 *  - bloc société facturée (nom, ville, téléphone, ICE, adresse) + encadré
 *    facture (référence, date, nombre de colis, total TTC) ;
 *  - tableau des colis (N°, code, type Envoi/Retour, ville, date de
 *    réception = date du scan, prix HT, TVA 10 %, prix TTC — le tarif stocké
 *    est TTC, taux legacy en dur), trié du plus ancien au plus récent, avec
 *    ligne de totaux. La colonne « Ville » est la ville de destination pour
 *    un envoi et la ville d'expédition pour un retour ;
 *  - « Facture arrêtée à la somme de … » (montant TTC en lettres).
 */

import { pagesVersPdf } from './pdfCapture';

import { montantEnLettres } from './factureLivreurPdf';

const TVA_TAUX = 0.1;

const PAGE_W = 1050;
const PAGE_H = 1485;
const PAD_TOP = 240;
const PAD_SIDE = 60;
const PAD_BOTTOM = 170;
const BLEU = '#1c428a';

const STYLE = `
.ft-page {
  position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; box-sizing: border-box;
  padding: ${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px; background: #fff no-repeat center / 100% 100%;
  color: #000; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.4;
}
.ft-content { height: 100%; overflow: hidden; }
.ft-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
/* Deux blocs côte à côte via un tableau sans bordures : html2canvas ne
   supporte pas grid et peint le fond d'un élément inline-block PAR-DESSUS
   son contenu (valeurs invisibles) — les blocs restent donc en display
   block, posés dans des cellules (cf. le même contournement dans
   factureLivreurPdf.js). */
.ft-blocs { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
.ft-blocs td { vertical-align: top; padding: 0; border: none; white-space: normal; }
.ft-blocs-gap { width: 24px; }
.ft-bloc {
  box-sizing: border-box; min-height: 186px;
  border: 2px solid #1f2937; border-radius: 10px; padding: 12px 18px 16px; background: #fff;
}
.ft-bloc-titre { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 8px; }
.ft-bloc-ligne { margin-top: 4px; white-space: normal; overflow-wrap: break-word; }
.ft-bloc-ligne b { font-weight: 700; }
.ft-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
/* white-space: normal — annule le nowrap global de l'application. */
.ft-table th, .ft-table td { border: 1px solid #374151; padding: 6px 8px; text-align: left; vertical-align: top; white-space: normal; }
.ft-table th { background: #eef1f6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
.ft-cell { white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.ft-num { text-align: center; }
.ft-montant { text-align: right; }
.ft-code { font-weight: 700; overflow-wrap: break-word; word-break: break-word; }
.ft-total td { background: #eef1f6; font-weight: 800; }
.ft-empty { text-align: center; color: #4b5563; }
.ft-lettres { margin-top: 16px; font-size: 16px; font-weight: 700; }
.ft-footer { position: absolute; left: ${PAD_SIDE}px; right: ${PAD_SIDE}px; bottom: 18px; color: ${BLEU}; }
.ft-footer-nom { display: inline-block; font-size: 21px; font-weight: 800; border-bottom: 2px solid ${BLEU}; padding-bottom: 2px; margin-bottom: 6px; }
.ft-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; font-size: 13px; font-weight: 700; }
.ft-footer-item { display: inline-flex; align-items: center; gap: 6px; }
.ft-footer-item svg { width: 15px; height: 15px; fill: ${BLEU}; flex: none; }
.ft-footer-regs { margin-top: 5px; font-size: 12px; font-weight: 700; }
.ft-pagenum { position: absolute; right: ${PAD_SIDE}px; bottom: 10px; font-size: 12px; color: ${BLEU}; }
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

/** Ville en "REF - Nom" comme le legacy. */
function villeLabel(ref, nom) {
  if (!ref && !nom) return '—';
  return [ref, nom].filter(Boolean).join(' - ');
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

/* Icônes du pied de page (mêmes tracés que factureLivreurPdf). */
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
<div class="ft-footer">
  ${nom ? `<div class="ft-footer-nom">${esc(nom)}</div>` : ''}
  ${
    items.length
      ? `<div class="ft-footer-row">${items
          .map((it) => `<span class="ft-footer-item">${it.icon}<span>${esc(it.text)}</span></span>`)
          .join('')}</div>`
      : ''
  }
  ${regs ? `<div class="ft-footer-regs">${esc(regs)}</div>` : ''}
</div>`;
}

/** Blocs société facturée + informations facture (première page uniquement). */
function blocsHtml(facture, societe, nbColis, total) {
  const s = societe || {};
  const lignes = [
    ['Société', s.nom || '—'],
    ['Ville', villeLabel(s.ville_ref, s.ville)],
    ['Téléphone', s.telephone || '—'],
    ['ICE', s.ice || '—'],
    ['Adresse', s.adresse || '—']
  ];
  const infos = [
    ['Facture N°', facture.reference || '—'],
    ['Date', formatDate(facture.created_time)],
    ['Nombre de colis', String(nbColis)],
    ['Total TTC', formatMontant(total)]
  ];
  const bloc = (titre, items) => `
<div class="ft-bloc">
  <div class="ft-bloc-titre">${esc(titre)}</div>
  ${items
    .map(([label, value]) => `<div class="ft-bloc-ligne"><b>${esc(label)} :</b> <span>${esc(value)}</span></div>`)
    .join('')}
</div>`;
  // Facture à gauche, société facturée à droite.
  return `
<div class="ft-title">Facture transport</div>
<table class="ft-blocs"><tbody><tr>
  <td>${bloc('Facture', infos)}</td>
  <td class="ft-blocs-gap"></td>
  <td>${bloc('Société facturée', lignes)}</td>
</tr></tbody></table>`;
}

const TABLE_HEAD = `
<colgroup>
  <col style="width:44px" /><col style="width:220px" /><col style="width:80px" />
  <col style="width:150px" /><col style="width:140px" />
  <col style="width:100px" /><col style="width:90px" /><col />
</colgroup>
<thead>
  <tr><th class="ft-num">N°</th><th>Code</th><th>Type</th>
  <th>Ville</th><th>Date de réception</th>
  <th class="ft-montant">Prix HT</th><th class="ft-montant">TVA (10 %)</th>
  <th class="ft-montant">Prix TTC</th></tr>
</thead>`;

/**
 * Ville affichée sur la facture : destination pour un envoi, expédition
 * (ville de ramassage) pour un retour.
 */
function villeColis(colis) {
  return colis.type_colis === 'retour'
    ? villeLabel(colis.ville_exp_ref, colis.ville_exp)
    : villeLabel(colis.ville_dest_ref, colis.ville_dest);
}

function rowHtml(colis, numero) {
  const ttc = Number(colis.tarif || 0);
  const ht = ttc / (1 + TVA_TAUX);
  return `
<tr>
  <td class="ft-num">${numero}</td>
  <td class="ft-code">${esc(colis.code || '—')}</td>
  <td>${colis.type_colis === 'retour' ? 'Retour' : 'Envoi'}</td>
  <td><div class="ft-cell">${esc(villeColis(colis))}</div></td>
  <td><div class="ft-cell">${esc(formatDate(colis.created_time))}</div></td>
  <td class="ft-montant">${esc(formatMontant(ht))}</td>
  <td class="ft-montant">${esc(formatMontant(ttc - ht))}</td>
  <td class="ft-montant">${esc(formatMontant(ttc))}</td>
</tr>`;
}

function totalRowHtml(total) {
  const ht = total / (1 + TVA_TAUX);
  return `
<tr class="ft-total">
  <td colspan="5">Total</td>
  <td class="ft-montant">${esc(formatMontant(ht))}</td>
  <td class="ft-montant">${esc(formatMontant(total - ht))}</td>
  <td class="ft-montant">${esc(formatMontant(total))}</td>
</tr>`;
}

/** Crée une page (fond en-tête + pied de page) ; { page, content, tbody }. */
function buildPage(host, enteteUrl, footer, withBlocs, facture, societe, nbColis, total) {
  const page = document.createElement('div');
  page.className = 'ft-page';
  if (enteteUrl) page.style.backgroundImage = `url("${enteteUrl}")`;
  page.innerHTML = `
<div class="ft-content">
  ${withBlocs ? blocsHtml(facture, societe, nbColis, total) : ''}
  <table class="ft-table">${TABLE_HEAD}<tbody></tbody></table>
</div>
${footer}
<div class="ft-pagenum"></div>`;
  host.appendChild(page);
  // Cibler le tbody du tableau des colis : les blocs d'informations sont
  // eux-mêmes un <table> (premier tbody de la page).
  return {
    page,
    content: page.querySelector('.ft-content'),
    tbody: page.querySelector('.ft-table tbody')
  };
}

/**
 * Génère le PDF de la facture transport et renvoie une URL blob.
 * @param {{facture: object, societe: object, colis: object[], societePlateforme: object}} options
 *   facture / societe / colis : réponse de GET /transport/factures/:id ;
 *   societePlateforme : réponse de GET /platform/societe.
 *   onProgress : facultatif, appelé avant chaque capture de page (n° de page, total).
 */
export async function genererFactureTransportPdf({ facture, societe, colis, societePlateforme, onProgress }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  const entete = await preloadEntete(societePlateforme?.entetePdf || societePlateforme?.entete);
  const footer = footerHtml(societePlateforme);
  // Comme le legacy : colis du plus ancien au plus récent.
  const rows = [...(colis || [])].sort((a, b) => Number(a.created_time) - Number(b.created_time));
  const total = rows.reduce((acc, c) => acc + Number(c.tarif || 0), 0);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-11000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    const pages = [];
    let current = buildPage(host, entete, footer, true, facture, societe, rows.length, total);
    pages.push(current);

    if (!rows.length) {
      current.tbody.innerHTML = `<tr><td colspan="8" class="ft-empty">Aucun colis dans cette facture.</td></tr>`;
    }
    // Remplissage page par page : une ligne qui déborde part sur la suivante.
    const append = (html) => {
      current.tbody.insertAdjacentHTML('beforeend', html);
      const overflow = current.content.scrollHeight > current.content.clientHeight;
      if (overflow && current.tbody.children.length > 1) {
        const row = current.tbody.lastElementChild;
        current = buildPage(host, entete, footer, false, facture, societe, rows.length, total);
        pages.push(current);
        current.tbody.appendChild(row);
      }
    };
    rows.forEach((c, i) => append(rowHtml(c, i + 1)));
    if (rows.length) append(totalRowHtml(total));

    // Montant en lettres sous le tableau (bascule en page suivante si besoin).
    const lettres = document.createElement('div');
    lettres.className = 'ft-lettres';
    lettres.textContent = `Facture arrêtée à la somme de : ${montantEnLettres(total)}.`;
    current.content.appendChild(lettres);
    if (current.content.scrollHeight > current.content.clientHeight) {
      lettres.remove();
      current = buildPage(host, entete, footer, false, facture, societe, rows.length, total);
      pages.push(current);
      current.content.querySelector('.ft-table').remove();
      current.content.appendChild(lettres);
    }

    pages.forEach((p, i) => {
      p.page.querySelector('.ft-pagenum').textContent = `Page ${i + 1} / ${pages.length}`;
    });

    // « await » indispensable : le finally ci-dessous retire host du DOM et doit attendre la fin des captures.
    return await pagesVersPdf({ jsPDF, html2canvas, host, pages: pages.map((p) => p.page), onProgress });
  } finally {
    document.body.removeChild(host);
  }
}
