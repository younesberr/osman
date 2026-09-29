/*
 * Export PDF des pages admin "Suivi de retour" (étapes 1 / 2 / 3) : tableau
 * des colis affichés (lignes filtrées, sans la colonne Actions) en A4
 * paysage, même principe que l'ancien système : la table est construite en
 * DOM hors écran puis rendue en image par html2canvas (le navigateur gère
 * lui-même l'arabe : liaisons des lettres + sens droite-à-gauche), et l'image
 * est découpée en tranches verticales, une par page. Les tranches sont posées
 * en JPEG : tableau sur fond blanc, et jsPDF n'a ainsi pas à ré-encoder un PNG
 * en JavaScript (le poste le plus lourd sur les longues listes). Les
 * librairies sont chargées à la demande.
 */

import { ECHELLE_A4, JPEG_QUALITE, ignorerHorsHost } from './pdfCapture';

const HEADERS = ['#', 'Code Colis', 'Client', 'Livreur', 'Ville', 'Sous-Statut', 'Dernière mise à jour', 'Jours'];

/** Échappe le texte injecté dans le HTML de la table. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Table imprimable : en-tête coloré selon l'étape + lignes alternées. */
function buildPrintTable(rows, headerColor) {
  let html =
    '<table style="width:100%;border-collapse:collapse;font-family:Arial,\'Segoe UI\',sans-serif;font-size:12px;"><thead><tr>';
  for (const h of HEADERS) {
    html += `<th style="background:${headerColor};color:#fff;padding:8px 10px;border:1px solid #e2e8f0;text-align:left;white-space:nowrap;">${esc(h)}</th>`;
  }
  html += '</tr></thead><tbody>';
  rows.forEach((cells, i) => {
    html += `<tr style="background:${i % 2 ? '#fafafc' : '#ffffff'};">`;
    for (const cell of cells) {
      html += `<td style="padding:7px 10px;border:1px solid #eef0f4;">${esc(cell)}</td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

/**
 * Génère et télécharge le PDF.
 *  - etape : 1 | 2 | 3 ;
 *  - titre : "Retour à Suivre - Étape N (X jours)" ;
 *  - livreur : libellé du filtre livreur ("Tous les livreurs" si aucun) ;
 *  - headerColor : couleur de l'en-tête de table (thème de l'étape) ;
 *  - rows : lignes déjà filtrées, chaque ligne = tableau de 8 cellules texte.
 */
export async function genererSuiviRetourPdf({ etape, titre, livreur, headerColor, rows }) {
  const [{ jsPDF }, html2canvasMod] = await Promise.all([import('jspdf'), import('html2canvas')]);
  const html2canvas = html2canvasMod.default;

  // Conteneur hors écran rendu par le navigateur (rendu arabe correct).
  const holder = document.createElement('div');
  holder.style.position = 'fixed';
  holder.style.left = '-10000px';
  holder.style.top = '0';
  holder.style.width = '1100px';
  holder.style.background = '#ffffff';
  holder.style.padding = '10px';
  holder.innerHTML = buildPrintTable(rows, headerColor);
  document.body.appendChild(holder);

  try {
    const canvas = await html2canvas(holder, {
      scale: ECHELLE_A4,
      backgroundColor: '#ffffff',
      logging: false,
      ignoreElements: ignorerHorsHost(holder)
    });

    const doc = new jsPDF('l', 'pt', 'a4');
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 40;
    const topOffset = 64;

    doc.setFontSize(14);
    doc.text(titre, margin, 30);
    doc.setFontSize(10);
    doc.text(`Livreur : ${livreur}     -     Édité le ${new Date().toLocaleString('fr-FR')}`, margin, 48);

    const imgW = pageW - margin * 2;
    const imgH = (canvas.height * imgW) / canvas.width;
    const availH = pageH - topOffset - margin;

    if (imgH <= availH) {
      doc.addImage(canvas.toDataURL('image/jpeg', JPEG_QUALITE), 'JPEG', margin, topOffset, imgW, imgH);
    } else {
      // Pagination : l'image est découpée en tranches verticales.
      const pxPerPt = canvas.width / imgW;
      const sliceHpx = availH * pxPerPt;
      let renderedPx = 0;
      let first = true;
      while (renderedPx < canvas.height) {
        const curPx = Math.min(sliceHpx, canvas.height - renderedPx);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = curPx;
        const ctx = pageCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(canvas, 0, renderedPx, canvas.width, curPx, 0, 0, canvas.width, curPx);

        if (!first) doc.addPage();
        doc.addImage(
          pageCanvas.toDataURL('image/jpeg', JPEG_QUALITE),
          'JPEG',
          margin,
          first ? topOffset : margin,
          imgW,
          curPx / pxPerPt
        );
        renderedPx += curPx;
        first = false;
      }
    }

    doc.save(`retour-suivre-etape${etape}.pdf`);
  } finally {
    holder.remove();
  }
}
