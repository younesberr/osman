const pool = require('../config/db');
const { graphFetch, MetaApiError, parseJson, tronquer } = require('./whatsapp');

/*
 * Modèles de message WhatsApp (message templates Meta) — page
 * /admin/api-liaison/whatsapp/modeles. Copie locale dans
 * delevery_whatsapp_modele, synchronisée depuis Meta (les modèles se créent
 * dans WhatsApp Manager, jamais depuis ORTALOG) et mise à jour par les
 * webhooks message_template_status_update / message_template_quality_update.
 * Un modèle est « utilisable » s'il est APPROVED, actif localement et sans
 * élément non pris en charge (en-tête média, paramètres nommés, variable dans
 * l'en-tête) — motif stocké dans wamo_motif_rejet préfixé « ORTALOG : ».
 */

const STATUTS_META = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'SUPPRIME_META'];
const PREFIXE_NON_SUPPORTE = 'ORTALOG : ';
const CACHE_MS = 60 * 1000;
const VARIABLE_RE = /\{\{(\d+)\}\}/g;

/** Nombre de variables positionnelles {{1}}…{{n}} (max des index). */
function compterVariables(texte) {
  let max = 0;
  for (const m of String(texte || '').matchAll(VARIABLE_RE)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Corps rendu : {{n}} remplacé par params[n-1] (la balise reste si absente). */
function rendreCorps(corps, params = []) {
  return String(corps || '').replace(VARIABLE_RE, (balise, n) => {
    const v = params[Number(n) - 1];
    return v == null || v === '' ? balise : String(v);
  });
}

/** Texte complet lisible (en-tête + corps + pied) pour le journal et l'aperçu. */
function rendreModele(modele, params = []) {
  const parts = [];
  if (modele.entete) parts.push(String(modele.entete));
  parts.push(rendreCorps(modele.corps, params));
  if (modele.pied) parts.push(String(modele.pied));
  return parts.join('\n');
}

/**
 * Décompose les `components` Meta : { entete, corps, pied, boutons, exemples,
 * nbVariables, nonSupporte (motif ou null) }.
 */
function parserComposants(components) {
  const out = { entete: null, corps: '', pied: null, boutons: [], exemples: [], nbVariables: 0, nonSupporte: null };
  for (const c of components || []) {
    const type = String(c.type || '').toUpperCase();
    if (type === 'HEADER') {
      if (String(c.format || 'TEXT').toUpperCase() === 'TEXT') {
        out.entete = c.text || null;
        if (compterVariables(c.text) > 0 || /\{\{[a-zA-Z_]/.test(c.text || '')) {
          out.nonSupporte = "variable dans l'en-tête non prise en charge";
        }
      } else {
        out.entete = `[${String(c.format).toUpperCase()}]`;
        out.nonSupporte = `en-tête ${String(c.format).toLowerCase()} non pris en charge`;
      }
    } else if (type === 'BODY') {
      out.corps = c.text || '';
      out.nbVariables = compterVariables(c.text);
      if (/\{\{[a-zA-Z_]/.test(out.corps)) {
        out.nonSupporte = 'paramètres nommés ({{nom}}) non pris en charge : utilisez {{1}}, {{2}}…';
        out.nbVariables = 0;
      }
      const ex = c.example?.body_text;
      if (Array.isArray(ex) && Array.isArray(ex[0])) out.exemples = ex[0].map((v) => String(v));
    } else if (type === 'FOOTER') {
      out.pied = c.text || null;
    } else if (type === 'BUTTONS') {
      out.boutons = (c.buttons || []).map((b) => ({
        type: String(b.type || '').toUpperCase(),
        texte: b.text || '',
        url: b.url || null,
        telephone: b.phone_number || null
      }));
      if (out.boutons.some((b) => b.type === 'URL' && /\{\{\d+\}\}/.test(b.url || ''))) {
        out.nonSupporte = 'bouton URL dynamique non pris en charge';
      }
    }
  }
  return out;
}

/** Ligne SQL → objet API. */
function toModele(row) {
  const motif = row.wamo_motif_rejet || '';
  const nonSupporte = motif.startsWith(PREFIXE_NON_SUPPORTE);
  return {
    id: row.wamo_id,
    metaId: row.wamo_meta_id,
    nom: row.wamo_nom,
    langue: row.wamo_langue,
    categorie: row.wamo_categorie,
    statut: row.wamo_statut,
    qualite: row.wamo_qualite,
    entete: row.wamo_entete,
    corps: row.wamo_corps,
    pied: row.wamo_pied,
    boutons: parseJson(row.wamo_boutons) || [],
    nbVariables: Number(row.wamo_nb_variables) || 0,
    exemples: parseJson(row.wamo_exemples) || [],
    mappingDefaut: parseJson(row.wamo_mapping_defaut) || [],
    motifRejet: nonSupporte ? null : motif || null,
    nonSupporte: nonSupporte ? motif.slice(PREFIXE_NON_SUPPORTE.length) : null,
    description: row.wamo_description || '',
    actif: Number(row.wamo_actif) === 1,
    utilisable: row.wamo_statut === 'APPROVED' && Number(row.wamo_actif) === 1 && !nonSupporte,
    syncLe: row.wamo_sync_le,
    createdAt: row.wamo_created_at,
    updatedAt: row.wamo_updated_at,
    nbRegles: Number(row.nb_regles) || 0
  };
}

const SELECT_MODELE = `
  SELECT m.*,
         (SELECT COUNT(*) FROM delevery_whatsapp_regle r
           WHERE r.wamr_modele = m.wamo_nom AND r.wamr_langue = m.wamo_langue) AS nb_regles
    FROM delevery_whatsapp_modele m`;

async function listerModeles({ statut, recherche, utilisables } = {}) {
  const where = [];
  const params = [];
  if (statut && STATUTS_META.includes(statut)) {
    where.push('m.wamo_statut = ?');
    params.push(statut);
  }
  if (recherche) {
    where.push('(m.wamo_nom LIKE ? OR m.wamo_corps LIKE ?)');
    params.push(`%${recherche}%`, `%${recherche}%`);
  }
  const [rows] = await pool.query(
    `${SELECT_MODELE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY m.wamo_statut = 'APPROVED' DESC, m.wamo_nom, m.wamo_langue`,
    params
  );
  const liste = rows.map(toModele);
  return utilisables ? liste.filter((m) => m.utilisable) : liste;
}

async function modeleParId(id) {
  const [[row]] = await pool.query(`${SELECT_MODELE} WHERE m.wamo_id = ? LIMIT 1`, [Number(id)]);
  return row ? toModele(row) : null;
}

const cacheNomLangue = new Map();

/** Modèle par (nom, langue) avec cache 60 s ; null si inconnu localement. */
async function modeleParNomLangue(nom, langue) {
  const cle = `${nom}|${langue}`;
  const hit = cacheNomLangue.get(cle);
  if (hit && hit.expire > Date.now()) return hit.modele;
  const [[row]] = await pool.query(
    `${SELECT_MODELE} WHERE m.wamo_nom = ? AND m.wamo_langue = ? LIMIT 1`,
    [String(nom), String(langue)]
  );
  const modele = row ? toModele(row) : null;
  cacheNomLangue.set(cle, { modele, expire: Date.now() + CACHE_MS });
  return modele;
}

function invaliderCacheModeles() {
  cacheNomLangue.clear();
}

/**
 * Synchronisation depuis Meta : GET /{WABA_ID}/message_templates (paginé).
 * Upsert par (nom, langue) ; les modèles locaux absents chez Meta passent en
 * SUPPRIME_META (jamais supprimés : des règles peuvent y référer).
 * Renvoie { total, crees, maj, disparus }.
 */
async function synchroniserModeles(cfg) {
  if (!cfg.wabaId) {
    throw new MetaApiError('WhatsApp Business Account ID (WABA ID) non renseigné dans la configuration.', { http: 400 });
  }
  const champs = 'id,name,language,status,category,components,quality_score,rejected_reason';
  const modeles = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const path = `${cfg.wabaId}/message_templates?fields=${champs}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const json = await graphFetch(cfg, path);
    for (const t of json.data || []) modeles.push(t);
    after = json.paging?.cursors?.after && json.paging?.next ? json.paging.cursors.after : null;
    if (!after) break;
  }

  const bilan = { total: modeles.length, crees: 0, maj: 0, disparus: 0 };
  const vus = [];
  for (const t of modeles) {
    const nom = tronquer(t.name || '', 100);
    const langue = tronquer(t.language || '', 10);
    if (!nom || !langue) continue;
    vus.push([nom, langue]);
    const c = parserComposants(t.components);
    const motif = c.nonSupporte
      ? tronquer(`${PREFIXE_NON_SUPPORTE}${c.nonSupporte}`, 500)
      : t.rejected_reason && t.rejected_reason !== 'NONE'
        ? tronquer(String(t.rejected_reason), 500)
        : null;
    const qualite = t.quality_score?.score ? tronquer(String(t.quality_score.score), 20) : null;
    const [[existant]] = await pool.query(
      'SELECT wamo_id FROM delevery_whatsapp_modele WHERE wamo_nom = ? AND wamo_langue = ? LIMIT 1',
      [nom, langue]
    );
    const valeurs = [
      t.id ? tronquer(String(t.id), 64) : null,
      tronquer(String(t.category || 'UTILITY').toUpperCase(), 20),
      tronquer(String(t.status || 'PENDING').toUpperCase(), 30),
      qualite,
      c.entete ? tronquer(c.entete, 255) : null,
      c.corps,
      c.pied ? tronquer(c.pied, 255) : null,
      JSON.stringify(c.boutons),
      c.nbVariables,
      JSON.stringify(c.exemples),
      motif
    ];
    if (existant) {
      await pool.query(
        `UPDATE delevery_whatsapp_modele
            SET wamo_meta_id = ?, wamo_categorie = ?, wamo_statut = ?, wamo_qualite = ?,
                wamo_entete = ?, wamo_corps = ?, wamo_pied = ?, wamo_boutons = ?,
                wamo_nb_variables = ?, wamo_exemples = ?, wamo_motif_rejet = ?,
                wamo_sync_le = NOW(), wamo_updated_at = NOW()
          WHERE wamo_id = ?`,
        [...valeurs, existant.wamo_id]
      );
      bilan.maj += 1;
    } else {
      await pool.query(
        `INSERT INTO delevery_whatsapp_modele
           (wamo_meta_id, wamo_categorie, wamo_statut, wamo_qualite, wamo_entete, wamo_corps,
            wamo_pied, wamo_boutons, wamo_nb_variables, wamo_exemples, wamo_motif_rejet,
            wamo_nom, wamo_langue, wamo_sync_le, wamo_created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [...valeurs, nom, langue]
      );
      bilan.crees += 1;
    }
  }
  // Modèles locaux absents de la réponse Meta.
  const [locaux] = await pool.query(
    "SELECT wamo_id, wamo_nom, wamo_langue FROM delevery_whatsapp_modele WHERE wamo_statut <> 'SUPPRIME_META'"
  );
  for (const l of locaux) {
    if (!vus.some(([n, lg]) => n === l.wamo_nom && lg === l.wamo_langue)) {
      await pool.query(
        "UPDATE delevery_whatsapp_modele SET wamo_statut = 'SUPPRIME_META', wamo_sync_le = NOW(), wamo_updated_at = NOW() WHERE wamo_id = ?",
        [l.wamo_id]
      );
      bilan.disparus += 1;
    }
  }
  invaliderCacheModeles();
  return bilan;
}

/** Webhooks message_template_status_update / message_template_quality_update. */
async function appliquerWebhookModele(field, value) {
  const nom = value.message_template_name;
  const langue = value.message_template_language;
  const metaId = value.message_template_id ? String(value.message_template_id) : null;
  if (!nom && !metaId) return;
  const where = metaId ? 'wamo_meta_id = ?' : 'wamo_nom = ? AND wamo_langue = ?';
  const whereParams = metaId ? [metaId] : [nom, langue];
  if (field === 'message_template_status_update') {
    const statut = tronquer(String(value.event || '').toUpperCase(), 30);
    if (!statut) return;
    const raison = value.reason && value.reason !== 'NONE' ? tronquer(String(value.reason), 500) : null;
    await pool.query(
      `UPDATE delevery_whatsapp_modele
          SET wamo_statut = ?,
              wamo_motif_rejet = CASE WHEN ? IS NULL THEN wamo_motif_rejet ELSE ? END,
              wamo_updated_at = NOW()
        WHERE ${where}`,
      [statut, raison, raison, ...whereParams]
    );
  } else if (field === 'message_template_quality_update') {
    const qualite = value.new_quality_score ? tronquer(String(value.new_quality_score), 20) : null;
    await pool.query(`UPDATE delevery_whatsapp_modele SET wamo_qualite = ?, wamo_updated_at = NOW() WHERE ${where}`, [
      qualite,
      ...whereParams
    ]);
  }
  invaliderCacheModeles();
}

/** Champs locaux modifiables : actif, mappingDefaut (tableau), description. */
async function enregistrerModeleLocal(id, { actif, mappingDefaut, description }) {
  const sets = [];
  const params = [];
  if (actif !== undefined) {
    sets.push('wamo_actif = ?');
    params.push(actif ? 1 : 0);
  }
  if (mappingDefaut !== undefined) {
    sets.push('wamo_mapping_defaut = ?');
    params.push(JSON.stringify(Array.isArray(mappingDefaut) ? mappingDefaut : []));
  }
  if (description !== undefined) {
    sets.push('wamo_description = ?');
    params.push(tronquer(String(description ?? '').trim(), 255));
  }
  if (!sets.length) return modeleParId(id);
  sets.push('wamo_updated_at = NOW()');
  await pool.query(`UPDATE delevery_whatsapp_modele SET ${sets.join(', ')} WHERE wamo_id = ?`, [...params, Number(id)]);
  invaliderCacheModeles();
  return modeleParId(id);
}

module.exports = {
  STATUTS_META,
  compterVariables,
  rendreCorps,
  rendreModele,
  parserComposants,
  listerModeles,
  modeleParId,
  modeleParNomLangue,
  invaliderCacheModeles,
  synchroniserModeles,
  appliquerWebhookModele,
  enregistrerModeleLocal
};
