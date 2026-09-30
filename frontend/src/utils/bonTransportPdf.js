/*
 * Bon de transport en PDF (page admin Transport › Bons de transport).
 *
 * Même construction que le bon d'envoi (utils/bonEnvoiPdf.js) : chaque page
 * A4 est bâtie en DOM hors écran puis photographiée par html2canvas et posée
 * dans le PDF (jsPDF) ; l'image « Page en-tête » sert d'arrière-plan pleine
 * page, le pied de page reprend les informations société.
 *  - encadré des informations du bon (référence, trajet, journée, nombre de
 *    colis) sur la première page ;
 *  - tableau des colis regroupés par ville de destination puis par société
 *    expéditeur : colonnes Ville de destination, Nombre (total de la ville,
 *    cellules fusionnées sur toutes les lignes de la ville), Expéditeur avec
 *    son nombre de colis entre parenthèses, Codes de colis de cet expéditeur
 *    (un code par ligne, jamais coupé) ;
 *  - réparti sur autant de pages que nécessaire : une ville coupée par un
 *    saut de page reprend sur la suivante avec la mention « suite » ; une
 *    ligne d'expéditeur trop haute pour une page voit ses codes répartis sur
 *    plusieurs pages ;
 *  - pied de page : numérotation + informations société, ligne « Total ».
 * Les librairies sont chargées à la demande.
 */

import { pagesVersPdf } from './pdfCapture';
import { BRAND } from '../config/brand';

// Page A4 rendue à 5 px / mm (1050 × 1485 px), capturée à l'échelle ECHELLE_A4 (utils/pdfCapture.js).
const PAGE_W = 1050;
const PAGE_H = 1485;
const PAD_TOP = 240; // ≈ 48 mm : le texte ne touche pas le logo de l'en-tête.
const PAD_SIDE = 60; // ≈ 12 mm
const PAD_BOTTOM = 170; // ≈ 34 mm : réservé au pied de page.
const BLEU = BRAND.colorPrimary; // Couleur principale de la marque (texte du pied de page).
// Coupure d'une ligne d'expéditeur en bas de page : on garde la partie qui
// tient si elle compte au moins ce nombre de codes, sinon la ligne entière
// part sur la page suivante.
const MIN_CODES_COUPURE = 6;

const STYLE = `
.bt-page {
  position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; box-sizing: border-box;
  padding: ${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px; background: #fff no-repeat center / 100% 100%;
  color: #000; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.4;
}
.bt-content { height: 100%; overflow: hidden; }
.bt-title { font-size: 23px; font-weight: 800; margin-bottom: 14px; }
.bt-info { display: flex; gap: 14px; border: 2px solid #1f2937; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; background: #fff; }
.bt-info-item { flex: 1; }
.bt-info-label { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; margin-bottom: 4px; }
.bt-info-value { font-size: 19px; font-weight: 700; }
.bt-info-sub { font-size: 13px; font-weight: 600; color: #4b5563; margin-top: 2px; }
.bt-table { width: 100%; border-collapse: collapse; table-layout: fixed; background: #fff; }
/* white-space: normal — le DOM du PDF est construit dans le document de
   l'application, dont le style global « th, td » impose nowrap. */
.bt-table th, .bt-table td { border: 1px solid #374151; padding: 8px 10px; text-align: left; vertical-align: top; white-space: normal; }
.bt-table th { background: #eef1f6; font-size: 13px; text-transform: uppercase; letter-spacing: 0.4px; }
.bt-cell { white-space: normal; overflow-wrap: break-word; word-break: break-word; }
.bt-ville { font-size: 18px; font-weight: 800; text-transform: uppercase; }
.bt-sub { font-size: 12px; font-weight: 600; color: #4b5563; margin-top: 2px; }
.bt-nb { text-align: center; font-size: 20px; font-weight: 800; }
.bt-exp { font-weight: 700; }
.bt-exp-nb { font-weight: 800; white-space: nowrap; }
.bt-codes { display: flex; flex-direction: column; gap: 3px; }
.bt-code { font-weight: 700; font-size: 15px; white-space: nowrap; }
.bt-total td { background: #eef1f6; font-weight: 800; }
.bt-empty { text-align: center; color: #4b5563; }
.bt-footer { position: absolute; left: ${PAD_SIDE}px; right: ${PAD_SIDE}px; bottom: 18px; color: ${BLEU}; }
.bt-footer-nom { display: inline-block; font-size: 21px; font-weight: 800; border-bottom: 2px solid ${BLEU}; padding-bottom: 2px; margin-bottom: 6px; }
.bt-footer-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 22px; font-size: 13px; font-weight: 700; }
.bt-footer-item { display: inline-flex; align-items: center; gap: 6px; }
.bt-footer-item svg { width: 15px; height: 15px; fill: ${BLEU}; flex: none; }
.bt-footer-regs { margin-top: 5px; font-size: 12px; font-weight: 700; }
.bt-pagenum { position: absolute; right: ${PAD_SIDE}px; bottom: 10px; font-size: 12px; color: ${BLEU}; }
`;

/** Échappe le texte injecté dans le HTML des pages. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function formatJournee(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-');
  return jj ? `${jj}/${mm}/${aaaa}` : '—';
}

/** Plage horaire de la journée du bon : "06:00 → JJ/MM/AAAA 06:00" (lendemain). */
function formatPlage(journee) {
  const [aaaa, mm, jj] = String(journee || '').split('-').map(Number);
  if (!jj) return '';
  const fin = new Date(Date.UTC(aaaa, mm - 1, jj) + 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `06:00 → ${p(fin.getUTCDate())}/${p(fin.getUTCMonth() + 1)}/${fin.getUTCFullYear()} 06:00`;
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

/* Icônes du pied de page (remplissage hérité de .bt-footer-item svg). */
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
<div class="bt-footer">
  ${nom ? `<div class="bt-footer-nom">${esc(nom)}</div>` : ''}
  ${
    items.length
      ? `<div class="bt-footer-row">${items
          .map((it) => `<span class="bt-footer-item">${it.icon}<span>${esc(it.text)}</span></span>`)
          .join('')}</div>`
      : ''
  }
  ${regs ? `<div class="bt-footer-regs">${esc(regs)}</div>` : ''}
</div>`;
}

/** Encadré des informations du bon (première page uniquement). */
function infoBoxHtml(bon, nbColis) {
  const plage = formatPlage(bon.journee);
  return `
<div class="bt-title">Bon de transport</div>
<div class="bt-info">
  <div class="bt-info-item">
    <div class="bt-info-label">Référence du bon</div>
    <div class="bt-info-value">${esc(bon.ref || '—')}</div>
  </div>
  <div class="bt-info-item">
    <div class="bt-info-label">Trajet</div>
    <div class="bt-info-value">${esc(bon.trajet || '—')}</div>
  </div>
  <div class="bt-info-item">
    <div class="bt-info-label">Journée</div>
    <div class="bt-info-value">${esc(formatJournee(bon.journee))}</div>
    ${plage ? `<div class="bt-info-sub">${esc(plage)}</div>` : ''}
  </div>
  <div class="bt-info-item">
    <div class="bt-info-label">Nombre de colis</div>
    <div class="bt-info-value">${nbColis}</div>
  </div>
</div>`;
}

const TABLE_HEAD = `
<colgroup>
  <col style="width:200px" /><col style="width:90px" /><col style="width:230px" /><col />
</colgroup>
<thead>
  <tr><th>Ville de destination</th><th style="text-align:center">Nombre</th><th>Expéditeur</th><th>Codes de colis</th></tr>
</thead>`;

/**
 * Regroupe les colis : ville de destination (tri alphabétique) → société
 * expéditeur (tri alphabétique) → codes dans l'ordre d'ajout au bon.
 * @returns {{ ville: string, ref: string, nb: number, lignes: { societe: string, codes: string[] }[] }[]}
 */
function grouperColis(colis) {
  const villes = new Map();
  // L'API renvoie les colis du plus récent au plus ancien : codes dans l'ordre d'ajout.
  for (const c of [...(colis || [])].reverse()) {
    const ville = c.ville || c.ville_ref || '—';
    const ref = c.ville ? c.ville_ref || '' : '';
    const societe = c.societe_exp || '—';
    const cle = `${ref}|${ville}`;
    if (!villes.has(cle)) villes.set(cle, { ville, ref, nb: 0, societes: new Map() });
    const g = villes.get(cle);
    g.nb += 1;
    if (!g.societes.has(societe)) g.societes.set(societe, []);
    g.societes.get(societe).push(c.code || '—');
  }
  return [...villes.values()]
    .sort((a, b) => a.ville.localeCompare(b.ville, 'fr'))
    .map((g) => ({
      ville: g.ville,
      ref: g.ref,
      nb: g.nb,
      lignes: [...g.societes.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], 'fr'))
        .map(([societe, codes]) => ({ societe, codes }))
    }));
}

/**
 * Ligne du tableau : [ville + nombre (cellules fusionnées, seulement si
 * `avecVille`)] | expéditeur (n) | codes (un par ligne).
 * @param {{ groupe: {ville, ref, nb}, ligne: {societe, codes}, codes: string[],
 *   avecVille: boolean, villeSuite: boolean, expSuite: boolean }} options
 *   ligne.codes = tous les codes de l'expéditeur (pour le « (n) ») ;
 *   codes = ceux effectivement posés sur cette ligne (tranche en cas de coupure).
 */
function rowEl({ groupe, ligne, codes, avecVille, villeSuite, expSuite }) {
  const tr = document.createElement('tr');
  const cellules = [];
  if (avecVille) {
    cellules.push(`
<td>
  <div class="bt-cell bt-ville">${esc(groupe.ville)}</div>
  ${groupe.ref && groupe.ref !== groupe.ville ? `<div class="bt-sub">${esc(groupe.ref)}</div>` : ''}
  ${villeSuite ? '<div class="bt-sub">(suite)</div>' : ''}
</td>
<td class="bt-nb">${groupe.nb}</td>`);
  }
  cellules.push(`
<td>
  <div class="bt-cell bt-exp">${esc(ligne.societe)} <span class="bt-exp-nb">(${ligne.codes.length})</span></div>
  ${expSuite ? '<div class="bt-sub">(suite)</div>' : ''}
</td>
<td><div class="bt-codes">${codes.map((code) => `<span class="bt-code">${esc(code)}</span>`).join('')}</div></td>`);
  tr.innerHTML = cellules.join('');
  return tr;
}

/**
 * Retire des codes en fin de liste de la ligne `tr` jusqu'à ce que la page
 * ne déborde plus (ou qu'il n'en reste que `min`) ; renvoie le nombre gardé.
 */
function couperCodes(tr, nb, min, deborde) {
  const grille = tr.querySelector('.bt-codes');
  let gardes = nb;
  while (gardes > min && deborde()) {
    grille.lastElementChild.remove();
    gardes -= 1;
  }
  return gardes;
}

/** Crée une page (fond en-tête + pied de page HTML) et son tableau ; renvoie { page, content, tbody }. */
function buildPage(host, enteteUrl, footer, withInfoBox, bon, nbColis) {
  const page = document.createElement('div');
  page.className = 'bt-page';
  if (enteteUrl) page.style.backgroundImage = `url("${enteteUrl}")`;
  page.innerHTML = `
<div class="bt-content">
  ${withInfoBox ? infoBoxHtml(bon, nbColis) : ''}
  <table class="bt-table">${TABLE_HEAD}<tbody></tbody></table>
</div>
${footer}
<div class="bt-pagenum"></div>`;
  host.appendChild(page);
  return { page, content: page.querySelector('.bt-content'), tbody: page.querySelector('tbody') };
}

/**
 * Génère le PDF du bon de transport et renvoie une URL blob à ouvrir dans un onglet.
 * @param {{bon: {ref, trajet, journee}, colis: object[], societe: object, onProgress?: Function}} options
 *   colis : réponse de GET /transport/bons/:id (code, societe_exp, ville, ville_ref…).
 *   societe : réponse de GET /platform/societe (champs texte + entete).
 *   onProgress : facultatif, appelé avant chaque capture de page (n° de page, total).
 */
export async function genererBonTransportPdf({ bon, colis, societe, onProgress }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  const entete = await preloadEntete(societe?.entetePdf || societe?.entete);
  const footer = footerHtml(societe);
  const groupes = grouperColis(colis);
  const total = (colis || []).length;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-11000px;top:0;';
  const style = document.createElement('style');
  style.textContent = STYLE;
  host.appendChild(style);
  document.body.appendChild(host);

  try {
    const pages = [];
    let current = buildPage(host, entete, footer, true, bon, total);
    pages.push(current);
    const deborde = () => current.content.scrollHeight > current.content.clientHeight;
    const nouvellePage = () => {
      current = buildPage(host, entete, footer, false, bon, total);
      pages.push(current);
    };

    if (!groupes.length) {
      current.tbody.innerHTML = '<tr><td colspan="4" class="bt-empty">Aucun colis dans ce bon.</td></tr>';
    }

    // Remplissage page par page. Pour chaque ville : les cellules « ville » et
    // « nombre » sont fusionnées (rowspan) sur les lignes d'expéditeurs posées
    // sur la même page ; une ligne qui déborde est coupée sur place si une
    // part suffisante de ses codes tient (MIN_CODES_COUPURE), sinon elle part
    // sur la page suivante, où la ville est rappelée avec « (suite) ». Une
    // ligne seule trop haute voit ses codes coupés : le reste continue sur la
    // page suivante.
    for (const groupe of groupes) {
      let surPage = 0; // lignes du groupe posées sur la page courante
      let fusion = null; // cellules ville / nombre du groupe sur la page courante
      let dejaPose = false; // une partie du groupe est sur une page précédente
      const poserRowspan = (n) => {
        if (!fusion) return;
        fusion.ville.rowSpan = n;
        fusion.nb.rowSpan = n;
      };
      const changerPage = () => {
        if (surPage > 0) dejaPose = true;
        poserRowspan(surPage);
        nouvellePage();
        surPage = 0;
        fusion = null;
      };

      for (const ligne of groupe.lignes) {
        let codes = ligne.codes;
        let expSuite = false;
        while (codes.length) {
          const avecVille = surPage === 0;
          const tr = rowEl({ groupe, ligne, codes, avecVille, villeSuite: avecVille && dejaPose, expSuite });
          current.tbody.appendChild(tr);
          if (avecVille) fusion = { ville: tr.children[0], nb: tr.children[1] };
          poserRowspan(surPage + 1);

          if (!deborde()) {
            surPage += 1;
            codes = [];
            break;
          }
          if (current.tbody.children.length > 1) {
            // Coupure sur place si une part suffisante des codes tient…
            const gardes = couperCodes(tr, codes.length, 0, deborde);
            if (gardes >= MIN_CODES_COUPURE) {
              surPage += 1;
              codes = codes.slice(gardes);
              expSuite = true;
              changerPage();
              continue;
            }
            // … sinon la ligne entière part sur la page suivante (rowspan corrigé).
            tr.remove();
            if (avecVille) fusion = null;
            changerPage();
            continue;
          }
          // Ligne seule sur sa page et trop haute : on retire des codes (au moins
          // un reste) jusqu'à tenir, le reste part sur la page suivante.
          const gardes = couperCodes(tr, codes.length, 1, deborde);
          surPage += 1;
          codes = codes.slice(gardes);
          expSuite = true;
          if (codes.length) changerPage();
        }
      }
      poserRowspan(surPage);
    }

    // Ligne « Total » (part sur une nouvelle page si elle ne tient pas).
    if (groupes.length) {
      const tr = document.createElement('tr');
      tr.className = 'bt-total';
      tr.innerHTML = `<td>Total</td><td class="bt-nb">${total}</td><td colspan="2"></td>`;
      current.tbody.appendChild(tr);
      if (deborde() && current.tbody.children.length > 1) {
        tr.remove();
        nouvellePage();
        current.tbody.appendChild(tr);
      }
    }

    pages.forEach((p, i) => {
      p.page.querySelector('.bt-pagenum').textContent = `Page ${i + 1} / ${pages.length}`;
    });

    // « await » indispensable : le finally ci-dessous retire host du DOM et doit attendre la fin des captures.
    return await pagesVersPdf({ jsPDF, html2canvas, host, pages: pages.map((p) => p.page), onProgress });
  } finally {
    document.body.removeChild(host);
  }
}
