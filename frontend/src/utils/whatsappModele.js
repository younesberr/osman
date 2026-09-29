/*
 * Rendu des modèles de message WhatsApp (variables positionnelles {{1}}…{{n}},
 * mise en forme *gras* / _italique_ / ~barré~) pour l'aperçu façon WhatsApp,
 * le compositeur et les règles.
 */

const VARIABLE_RE = /\{\{(\d+)\}\}/g;

/** Numéros de variables présents dans un texte, triés et dédoublonnés. */
export function extraireVariables(texte) {
  const nums = new Set();
  for (const m of String(texte || '').matchAll(VARIABLE_RE)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

/** Nombre de variables (index maximal) d'un corps de modèle. */
export function nbVariables(texte) {
  return extraireVariables(texte).reduce((max, n) => Math.max(max, n), 0);
}

/**
 * Découpe un corps en segments : { type: 'texte', valeur } et
 * { type: 'var', n, valeur (param ou null) } — pour surligner les variables
 * non remplies dans l'aperçu.
 */
export function rendreSegments(corps, params = []) {
  const s = String(corps || '');
  const segments = [];
  let dernier = 0;
  for (const m of s.matchAll(VARIABLE_RE)) {
    if (m.index > dernier) segments.push({ type: 'texte', valeur: s.slice(dernier, m.index) });
    const n = Number(m[1]);
    const v = params[n - 1];
    segments.push({ type: 'var', n, valeur: v == null || v === '' ? null : String(v) });
    dernier = m.index + m[0].length;
  }
  if (dernier < s.length) segments.push({ type: 'texte', valeur: s.slice(dernier) });
  return segments;
}

/** Corps rendu en texte brut ({{n}} conservé si le paramètre manque). */
export function rendreTexte(corps, params = []) {
  return String(corps || '').replace(VARIABLE_RE, (balise, n) => {
    const v = params[Number(n) - 1];
    return v == null || v === '' ? balise : String(v);
  });
}

/**
 * Mise en forme WhatsApp d'un texte : *gras*, _italique_, ~barré~ →
 * [{ style: 'b' | 'i' | 's' | null, texte }]. Simple et tolérante (pas d'imbrication).
 */
export function segmentsMiseEnForme(texte) {
  const out = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  const s = String(texte || '');
  let dernier = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > dernier) out.push({ style: null, texte: s.slice(dernier, m.index) });
    const brut = m[0];
    const style = brut[0] === '*' ? 'b' : brut[0] === '_' ? 'i' : 's';
    out.push({ style, texte: brut.slice(1, -1) });
    dernier = m.index + brut.length;
  }
  if (dernier < s.length) out.push({ style: null, texte: s.slice(dernier) });
  return out;
}

/** Texte des réponses rapides : balises {nom} / {colis} / {code} remplacées par la discussion. */
export function remplacerBalisesReponse(texte, conversation) {
  const valeurs = {
    nom: conversation?.nom || '',
    colis: conversation?.dernierColisCode || '',
    code: conversation?.dernierColisCode || '',
    magasin: conversation?.magasin || ''
  };
  return String(texte || '').replace(/\{(\w+)\}/g, (balise, cle) => (cle in valeurs ? valeurs[cle] : balise));
}
