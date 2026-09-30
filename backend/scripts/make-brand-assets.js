#!/usr/bin/env node
/*
 * Génère les visuels de la marque à partir d'un logo source (PNG transparent,
 * horizontal, emblème à gauche) :
 *   frontend/public/home/header-logo.png   logo 1200 px de large (site public)
 *   frontend/public/home/favicon.png       emblème recadré, 256×256
 *   backend/uploads/branding/logo-osmanexpress.png / icon-osmanexpress.png
 *                                          mêmes fichiers pour l'admin
 *                                          (clés app_platform_logo / _favicon)
 * Usage : node scripts/make-brand-assets.js <logo.png> [part gauche de l'emblème, ex. 0.27]
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..');
const src = path.resolve(process.argv[2] || path.join(ROOT, 'logo.png'));
const EMBLEM_RATIO = Number(process.argv[3] || 0.27);
const PUB = path.join(ROOT, 'frontend', 'public', 'home');
const UP = path.join(ROOT, 'backend', 'uploads', 'branding');
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

(async () => {
  const meta = await sharp(src).metadata();

  // 1. Logo horizontal (1200 px de large, hauteur proportionnelle).
  const logo = await sharp(src).resize({ width: 1200, withoutEnlargement: true }).png().toBuffer();
  const lm = await sharp(logo).metadata();

  // 2. Favicon : partie gauche (emblème), marges transparentes retirées, mise au carré.
  const emblemWidth = Math.round(meta.width * EMBLEM_RATIO);
  const emblem = await sharp(src)
    .extract({ left: 0, top: 0, width: emblemWidth, height: meta.height })
    .trim()
    .png()
    .toBuffer();
  const em = await sharp(emblem).metadata();
  const side = Math.max(em.width, em.height);
  const pad = Math.round(side * 0.06);
  const icon = await sharp(emblem)
    .extend({
      top: Math.floor((side - em.height) / 2) + pad,
      bottom: Math.ceil((side - em.height) / 2) + pad,
      left: Math.floor((side - em.width) / 2) + pad,
      right: Math.ceil((side - em.width) / 2) + pad,
      background: TRANSPARENT
    })
    .resize(256, 256)
    .png()
    .toBuffer();

  fs.mkdirSync(PUB, { recursive: true });
  fs.mkdirSync(UP, { recursive: true });
  fs.writeFileSync(path.join(PUB, 'header-logo.png'), logo);
  fs.writeFileSync(path.join(PUB, 'favicon.png'), icon);
  fs.writeFileSync(path.join(UP, 'logo-osmanexpress.png'), logo);
  fs.writeFileSync(path.join(UP, 'icon-osmanexpress.png'), icon);
  console.log(`Logo ${lm.width}x${lm.height} px, emblème ${em.width}x${em.height} px → favicon 256x256 px.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
