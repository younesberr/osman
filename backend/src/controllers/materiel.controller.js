const pool = require('../config/db');
const { listMarqueRows } = require('./config.controller');

/*
 * Matériel de la société (page /admin/materiel — service MATERIEL, fonctions
 * 1 et 2 uniquement) : catalogue, stock et mouvements du matériel interne.
 *
 * Tables neuves delevery_materiel* (sql/2026-08-25_materiel.sql) :
 *  - delevery_materiel             : catalogue + stock principal (mt_qte) ;
 *  - delevery_materiel_agence      : stock affecté par agence (emballage /
 *    consommable), une ligne par couple (matériel, agence) ;
 *  - delevery_materiel_mvnt        : journal des mouvements (qté positive,
 *    direction portée par le type) ;
 *  - delevery_materiel_affectation : affectations non-consommables à une
 *    agence ou à une personne, avec récupérations partielles.
 *
 * Quatre types d'article (mt_type), avec des circuits différents :
 *  - auto            : stock principal ; sortie = consommation sur un véhicule
 *    du parc (delevery_logistique_moyen), visible sur la fiche logistique ;
 *  - emballage / consommable : stock principal + stock par agence ; vendus aux
 *    clients via Frais supplémentaires clients (fraisClients.controller, qui
 *    utilise les helpers de vente exportés ici) ;
 *  - non_consommable : affecté (AGENCE ou USER) puis récupéré, par quantité.
 *
 * Toute écriture de stock passe par une transaction qui verrouille D'ABORD la
 * ligne delevery_materiel FOR UPDATE (sérialise les mouvements d'un article),
 * puis la ligne delevery_materiel_agence concernée — même pattern que
 * stock.controller (delevery_product / delevery_product_mvnt).
 */

const MATERIEL_TYPES = [
  { code: 'auto', label: 'Auto' },
  { code: 'emballage', label: 'Emballage' },
  { code: 'consommable', label: 'Consommable' },
  { code: 'non_consommable', label: 'Non consommable' }
];

/* Types vendables aux clients via Frais supplémentaires clients. */
const VENDABLE_TYPES = ['emballage', 'consommable'];

/* Types de mouvement du journal ; sens = effet sur le stock concerné
 * (badge entrée / sortie côté frontend). */
const MVNT_TYPES = [
  { code: 'entree', label: 'Entrée stock', sens: 'entree' },
  { code: 'sortie', label: 'Sortie stock', sens: 'sortie' },
  { code: 'transfert_agence', label: 'Transfert vers agence', sens: 'sortie' },
  { code: 'retour_agence', label: 'Retour agence', sens: 'entree' },
  { code: 'vente', label: 'Vente client', sens: 'sortie' },
  { code: 'consommation', label: 'Consommation véhicule', sens: 'sortie' },
  { code: 'affectation', label: 'Affectation', sens: 'sortie' },
  { code: 'recuperation', label: 'Récupération', sens: 'entree' }
];

const AFFECTATION_DIMENSIONS = ['AGENCE', 'USER'];

const MAX_MVNT = 1000;
const MAX_QTE = 9999999;

/** "AAAA-MM-JJ" valide → la chaîne, sinon null. */
function parseDay(value) {
  const v = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
  return v;
}

/** Quantité : entier 1..9 999 999, sinon null. */
function parseQte(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTE) return null;
  return n;
}

/** Prix DH (2 décimales max) : '' → null, invalide → undefined. */
function parsePrix(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return undefined;
  return Math.round(n * 100) / 100;
}

/** Articles actifs vendables (emballage / consommable) pour la modale des
 * frais clients : { id, nom, prix }. Consommé par fraisClients.controller. */
async function listArticlesVendables() {
  const [rows] = await pool.query(
    `SELECT mt_id AS id, mt_nom AS nom, mt_prix_vente AS prix
       FROM delevery_materiel
      WHERE mt_active = 1 AND mt_type IN (?)
      ORDER BY mt_nom`,
    [VENDABLE_TYPES]
  );
  return rows.map((r) => ({ ...r, prix: r.prix == null ? null : Number(r.prix) }));
}

/* ------------------------------------------------------------------ */
/* Helpers de vente (transaction ouverte par fraisClients.controller). */
/* ------------------------------------------------------------------ */

/**
 * Débite le stock agence pour une vente (frais client « emballage »).
 * Verrouille l'article puis la ligne agence ; retourne { error } (stock
 * insuffisant, article invalide) ou { nom } (nom de l'article → frais_titre).
 */
async function debiterStockVente(conn, materielId, agenceId, quantite) {
  const [[article]] = await conn.query(
    `SELECT mt_nom, mt_type, mt_active FROM delevery_materiel
      WHERE mt_id = ? FOR UPDATE`,
    [materielId]
  );
  if (!article || !VENDABLE_TYPES.includes(article.mt_type) || Number(article.mt_active) !== 1) {
    return { error: "Article d'emballage introuvable ou désactivé." };
  }
  const [[ligne]] = await conn.query(
    `SELECT ma_qte FROM delevery_materiel_agence
      WHERE ma_materiel = ? AND ma_agence = ? FOR UPDATE`,
    [materielId, agenceId]
  );
  const dispo = Number(ligne?.ma_qte) || 0;
  if (dispo < quantite) {
    return {
      error: `Stock insuffisant en agence : ${dispo} disponible(s), impossible d'en vendre ${quantite}.`
    };
  }
  await conn.query(
    `UPDATE delevery_materiel_agence SET ma_qte = ma_qte - ?, ma_updated_at = NOW()
      WHERE ma_materiel = ? AND ma_agence = ?`,
    [quantite, materielId, agenceId]
  );
  return { nom: article.mt_nom };
}

/** Trace le mouvement « vente » lié au frais (une vente = un frais réel). */
async function tracerMouvementVente(conn, materielId, agenceId, quantite, fraisId, userId) {
  await conn.query(
    `INSERT INTO delevery_materiel_mvnt
       (mm_materiel, mm_type, mm_qte, mm_agence, mm_frais, mm_date, mm_by)
     VALUES (?, 'vente', ?, ?, ?, NOW(), ?)`,
    [materielId, quantite, agenceId, fraisId, Number(userId)]
  );
}

/**
 * Restitue le stock agence d'un frais « emballage » modifié / supprimé
 * (statut 0 uniquement, verrou métier côté fraisClients.controller) et
 * supprime le mouvement « vente » lié : un frais Nouveau est un brouillon,
 * le journal garde l'invariant « 1 vente = 1 frais réel ».
 */
async function restituerStockVente(conn, frais) {
  if (!frais.materiel_id || !frais.agence_id || !frais.quantite) return;
  await conn.query(`SELECT mt_id FROM delevery_materiel WHERE mt_id = ? FOR UPDATE`, [
    frais.materiel_id
  ]);
  await conn.query(
    `INSERT INTO delevery_materiel_agence (ma_materiel, ma_agence, ma_qte, ma_updated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE ma_qte = ma_qte + VALUES(ma_qte), ma_updated_at = NOW()`,
    [frais.materiel_id, frais.agence_id, Number(frais.quantite)]
  );
  await conn.query(
    `DELETE FROM delevery_materiel_mvnt WHERE mm_frais = ? AND mm_type = 'vente'`,
    [frais.id]
  );
}

/* ------------------------------------------------------------------ */
/* Référentiels.                                                      */
/* ------------------------------------------------------------------ */

/** Libellés des moyens logistiques : { id, label } — "VL · Marque — immat". */
async function listMoyensOptions() {
  const [rows] = await pool.query(
    `SELECT lm_id, lm_type, lm_marque_id, lm_immat, lm_immat_ww, lm_chassis
       FROM delevery_logistique_moyen
      ORDER BY lm_id DESC`
  );
  const marques = new Map();
  for (const m of await listMarqueRows()) marques.set(m.id, m.marque);
  return rows.map((r) => {
    const marque = marques.get(Number(r.lm_marque_id)) || `Marque n°${r.lm_marque_id}`;
    const numero = r.lm_immat || r.lm_immat_ww || r.lm_chassis;
    return { id: r.lm_id, label: `${String(r.lm_type).toUpperCase()} · ${marque} — ${numero}` };
  });
}

/**
 * GET /api/materiel/filtres — listes de valeurs : types d'article, types de
 * mouvement, agences actives, personnes actives (cibles d'affectation) et
 * véhicules du parc (consommation matériel auto).
 */
async function listFiltres(req, res, next) {
  try {
    const [[agences], [users], moyens] = await Promise.all([
      pool.query(
        `SELECT agence_id AS id, agence_name AS nom FROM delevery_agences
          WHERE agence_active = 1 ORDER BY agence_name`
      ),
      pool.query(
        `SELECT users_id AS id, users_name AS nom, users_type AS type
           FROM delevery_users
          WHERE users_active = 1 AND users_parent_id IS NULL
          ORDER BY users_name`
      ),
      listMoyensOptions()
    ]);
    res.json({ types: MATERIEL_TYPES, mvntTypes: MVNT_TYPES, agences, users, moyens });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Catalogue.                                                         */
/* ------------------------------------------------------------------ */

/**
 * GET /api/materiel — tout le catalogue avec le stock principal, le total en
 * agences et le total affecté (non consommable). Filtrage par onglet (type)
 * côté frontend.
 */
async function listMateriels(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT m.mt_id AS id, m.mt_type AS type, m.mt_nom AS nom,
              m.mt_reference AS reference, m.mt_unite AS unite,
              m.mt_prix_achat AS prix_achat, m.mt_prix_vente AS prix_vente,
              m.mt_seuil_alerte AS seuil_alerte, m.mt_qte AS qte,
              m.mt_active AS active,
              DATE_FORMAT(m.mt_created_at, '%d/%m/%Y %H:%i') AS created_at,
              DATE_FORMAT(m.mt_updated_at, '%d/%m/%Y %H:%i') AS updated_at,
              (SELECT IFNULL(SUM(ma.ma_qte), 0)
                 FROM delevery_materiel_agence ma
                WHERE ma.ma_materiel = m.mt_id) AS stock_agences,
              (SELECT IFNULL(SUM(af.maf_qte - af.maf_qte_recuperee), 0)
                 FROM delevery_materiel_affectation af
                WHERE af.maf_materiel = m.mt_id AND af.maf_statut = 'affecte') AS affecte
         FROM delevery_materiel m
        ORDER BY m.mt_nom`
    );
    res.json({
      rows: rows.map((r) => ({
        ...r,
        prix_achat: r.prix_achat == null ? null : Number(r.prix_achat),
        prix_vente: r.prix_vente == null ? null : Number(r.prix_vente),
        qte: Number(r.qte),
        stock_agences: Number(r.stock_agences),
        affecte: Number(r.affecte),
        active: Number(r.active)
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Valide un article { nom, reference, unite, prixAchat, prixVente,
 * seuilAlerte } pour le type donné ; { error } ou valeurs prêtes à insérer.
 */
function parseArticle(body, type) {
  const nom = String(body?.nom || '').trim();
  if (!nom) return { error: "Veuillez saisir le nom de l'article." };
  if (nom.length > 150) return { error: 'Nom trop long (150 caractères max).' };
  const reference = String(body?.reference || '').trim();
  if (reference.length > 100) return { error: 'Référence trop longue (100 caractères max).' };
  const unite = String(body?.unite || '').trim();
  if (unite.length > 30) return { error: 'Unité trop longue (30 caractères max).' };
  const prixAchat = parsePrix(body?.prixAchat);
  if (prixAchat === undefined) {
    return { error: "Prix d'achat invalide (DH, 2 décimales max)." };
  }
  const prixVente = parsePrix(body?.prixVente);
  if (prixVente === undefined) {
    return { error: 'Prix de vente invalide (DH, 2 décimales max).' };
  }
  if (VENDABLE_TYPES.includes(type) && !(prixVente > 0)) {
    return { error: 'Le prix de vente est obligatoire pour un article vendable (emballage / consommable).' };
  }
  const seuilRaw = String(body?.seuilAlerte ?? '').trim();
  let seuilAlerte = 0;
  if (seuilRaw) {
    seuilAlerte = Number(seuilRaw);
    if (!Number.isInteger(seuilAlerte) || seuilAlerte < 0 || seuilAlerte > MAX_QTE) {
      return { error: "Seuil d'alerte invalide (entier positif attendu)." };
    }
  }
  return { nom, reference, unite, prixAchat, prixVente, seuilAlerte };
}

/** Le nom est-il déjà pris par un autre article du même type ? */
async function nomExiste(type, nom, excludeId = 0) {
  const [[row]] = await pool.query(
    `SELECT mt_id FROM delevery_materiel
      WHERE mt_type = ? AND mt_nom = ? AND mt_id <> ? LIMIT 1`,
    [type, nom, excludeId]
  );
  return Boolean(row);
}

/** Charge un article par id ; null si introuvable. */
async function loadArticle(id) {
  const articleId = parseInt(id, 10);
  if (!Number.isInteger(articleId) || articleId <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT mt_id AS id, mt_type AS type, mt_nom AS nom, mt_qte AS qte,
            mt_active AS active
       FROM delevery_materiel WHERE mt_id = ? LIMIT 1`,
    [articleId]
  );
  return row || null;
}

/**
 * POST /api/materiel — body { type, nom, reference, unite, prixAchat,
 * prixVente, seuilAlerte }. Le stock démarre à 0 (mouvement « Entrée »).
 */
async function createMateriel(req, res, next) {
  try {
    const type = String(req.body?.type || '').trim();
    if (!MATERIEL_TYPES.some((t) => t.code === type)) {
      return res.status(400).json({ message: "Veuillez choisir le type de l'article." });
    }
    const values = parseArticle(req.body, type);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await nomExiste(type, values.nom)) {
      return res.status(409).json({ message: 'Un article de ce type porte déjà ce nom.' });
    }
    const [result] = await pool.query(
      `INSERT INTO delevery_materiel
         (mt_type, mt_nom, mt_reference, mt_unite, mt_prix_achat, mt_prix_vente,
          mt_seuil_alerte, mt_created_by, mt_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        type,
        values.nom,
        values.reference,
        values.unite,
        values.prixAchat,
        values.prixVente,
        values.seuilAlerte,
        Number(req.user.id)
      ]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/materiel/:id — mêmes champs que la création, SANS le type (figé :
 * le changer corromprait la sémantique des stocks agence / affectations).
 */
async function updateMateriel(req, res, next) {
  try {
    const article = await loadArticle(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article introuvable.' });
    const values = parseArticle(req.body, article.type);
    if (values.error) return res.status(400).json({ message: values.error });
    if (await nomExiste(article.type, values.nom, article.id)) {
      return res.status(409).json({ message: 'Un article de ce type porte déjà ce nom.' });
    }
    await pool.query(
      `UPDATE delevery_materiel
          SET mt_nom = ?, mt_reference = ?, mt_unite = ?, mt_prix_achat = ?,
              mt_prix_vente = ?, mt_seuil_alerte = ?, mt_updated_at = NOW()
        WHERE mt_id = ?`,
      [
        values.nom,
        values.reference,
        values.unite,
        values.prixAchat,
        values.prixVente,
        values.seuilAlerte,
        article.id
      ]
    );
    res.json({ id: article.id });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/materiel/:id/statut — body { active: 0 | 1 }. */
async function setMaterielStatut(req, res, next) {
  try {
    const article = await loadArticle(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article introuvable.' });
    const active = Number(req.body?.active) ? 1 : 0;
    await pool.query(
      `UPDATE delevery_materiel SET mt_active = ?, mt_updated_at = NOW() WHERE mt_id = ?`,
      [active, article.id]
    );
    res.json({ active });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/materiel/:id — uniquement un article vierge (aucun mouvement,
 * aucune affectation, stock principal à 0) ; sinon on désactive.
 */
async function deleteMateriel(req, res, next) {
  try {
    const article = await loadArticle(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article introuvable.' });
    const [[usage]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM delevery_materiel_mvnt WHERE mm_materiel = ?) AS mvnts,
         (SELECT COUNT(*) FROM delevery_materiel_affectation WHERE maf_materiel = ?) AS affectations`,
      [article.id, article.id]
    );
    if (Number(usage.mvnts) || Number(usage.affectations) || Number(article.qte) !== 0) {
      return res.status(400).json({
        message: 'Cet article a des mouvements, des affectations ou du stock : désactivez-le plutôt.'
      });
    }
    await pool.query(`DELETE FROM delevery_materiel_agence WHERE ma_materiel = ?`, [article.id]);
    await pool.query(`DELETE FROM delevery_materiel WHERE mt_id = ?`, [article.id]);
    res.json({ id: article.id });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Mouvements de stock.                                               */
/* ------------------------------------------------------------------ */

/* Types de mouvement saisissables depuis la page, par type d'article
 * (« vente » est réservé aux frais clients, « affectation » /
 * « recuperation » passent par les endpoints d'affectation). */
const MVNT_PAR_TYPE = {
  auto: ['entree', 'sortie', 'consommation'],
  emballage: ['entree', 'sortie', 'transfert_agence', 'retour_agence'],
  consommable: ['entree', 'sortie', 'transfert_agence', 'retour_agence'],
  non_consommable: ['entree', 'sortie']
};

/**
 * POST /api/materiel/:id/mouvements — body { type, qte, agence?, moyen?,
 * commentaire? }. Transaction : verrou de l'article puis de la ligne agence,
 * garde « stock insuffisant », mise à jour des stocks et trace au journal.
 */
async function createMouvement(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const article = await loadArticle(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article introuvable.' });
    if (Number(article.active) !== 1) {
      return res.status(400).json({ message: 'Article désactivé : réactivez-le pour saisir un mouvement.' });
    }

    const type = String(req.body?.type || '').trim();
    if (!(MVNT_PAR_TYPE[article.type] || []).includes(type)) {
      return res.status(400).json({ message: "Type de mouvement invalide pour ce type d'article." });
    }
    const qte = parseQte(req.body?.qte);
    if (qte === null) {
      return res.status(400).json({ message: 'Quantité invalide (entier positif attendu).' });
    }
    const commentaire = String(req.body?.commentaire || '').trim();
    if (commentaire.length > 255) {
      return res.status(400).json({ message: 'Commentaire trop long (255 caractères max).' });
    }

    let agenceId = null;
    if (type === 'transfert_agence' || type === 'retour_agence') {
      agenceId = parseInt(req.body?.agence, 10);
      if (!Number.isInteger(agenceId) || agenceId <= 0) {
        return res.status(400).json({ message: "Veuillez sélectionner l'agence." });
      }
      const [[agence]] = await pool.query(
        `SELECT agence_id FROM delevery_agences
          WHERE agence_id = ? AND agence_active = 1 LIMIT 1`,
        [agenceId]
      );
      if (!agence) return res.status(400).json({ message: 'Agence introuvable ou désactivée.' });
    }

    let moyenId = null;
    if (type === 'consommation') {
      moyenId = parseInt(req.body?.moyen, 10);
      if (!Number.isInteger(moyenId) || moyenId <= 0) {
        return res.status(400).json({ message: 'Veuillez sélectionner le véhicule.' });
      }
      const [[moyen]] = await pool.query(
        `SELECT lm_id FROM delevery_logistique_moyen WHERE lm_id = ? LIMIT 1`,
        [moyenId]
      );
      if (!moyen) return res.status(400).json({ message: 'Véhicule introuvable.' });
    }

    await conn.beginTransaction();

    // Verrouille l'article : sérialise tous les mouvements de cet article.
    const [[verrou]] = await conn.query(
      `SELECT mt_qte FROM delevery_materiel WHERE mt_id = ? FOR UPDATE`,
      [article.id]
    );
    const stock = Number(verrou.mt_qte);

    const sortiePrincipal = type === 'sortie' || type === 'transfert_agence' || type === 'consommation';
    if (sortiePrincipal && stock < qte) {
      await conn.rollback();
      return res.status(400).json({
        message: `Stock insuffisant : ${stock} disponible(s), impossible d'en sortir ${qte}.`
      });
    }

    if (type === 'retour_agence') {
      const [[ligne]] = await conn.query(
        `SELECT ma_qte FROM delevery_materiel_agence
          WHERE ma_materiel = ? AND ma_agence = ? FOR UPDATE`,
        [article.id, agenceId]
      );
      const dispo = Number(ligne?.ma_qte) || 0;
      if (dispo < qte) {
        await conn.rollback();
        return res.status(400).json({
          message: `Stock insuffisant en agence : ${dispo} disponible(s), impossible d'en retourner ${qte}.`
        });
      }
      await conn.query(
        `UPDATE delevery_materiel_agence SET ma_qte = ma_qte - ?, ma_updated_at = NOW()
          WHERE ma_materiel = ? AND ma_agence = ?`,
        [qte, article.id, agenceId]
      );
    }
    if (type === 'transfert_agence') {
      await conn.query(
        `INSERT INTO delevery_materiel_agence (ma_materiel, ma_agence, ma_qte, ma_updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE ma_qte = ma_qte + VALUES(ma_qte), ma_updated_at = NOW()`,
        [article.id, agenceId, qte]
      );
    }

    const delta = type === 'entree' || type === 'retour_agence' ? qte : -qte;
    await conn.query(`UPDATE delevery_materiel SET mt_qte = mt_qte + ? WHERE mt_id = ?`, [
      delta,
      article.id
    ]);
    await conn.query(
      `INSERT INTO delevery_materiel_mvnt
         (mm_materiel, mm_type, mm_qte, mm_agence, mm_moyen, mm_commentaire, mm_date, mm_by)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [article.id, type, qte, agenceId, moyenId, commentaire, Number(req.user.id)]
    );

    await conn.commit();
    res.status(201).json({ message: 'Mouvement enregistré.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/** GET /api/materiel/:id/agences — stock de l'article par agence. */
async function listStockAgences(req, res, next) {
  try {
    const article = await loadArticle(req.params.id);
    if (!article) return res.status(404).json({ message: 'Article introuvable.' });
    const [rows] = await pool.query(
      `SELECT ma.ma_agence AS agence_id, a.agence_name AS agence, ma.ma_qte AS qte
         FROM delevery_materiel_agence ma
         LEFT JOIN delevery_agences a ON a.agence_id = ma.ma_agence
        WHERE ma.ma_materiel = ? AND ma.ma_qte <> 0
        ORDER BY a.agence_name`,
      [article.id]
    );
    res.json({ rows: rows.map((r) => ({ ...r, qte: Number(r.qte) })) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/materiel/mouvements — historique du journal (onglet Historique).
 * Query : materiel (mt_id), typeMateriel, mvnt (type de mouvement), agence.
 */
async function listMouvements(req, res, next) {
  try {
    const where = ['1 = 1'];
    const params = [];
    const materiel = parseInt(req.query.materiel, 10) || 0;
    if (materiel) {
      where.push('v.mm_materiel = ?');
      params.push(materiel);
    }
    const typeMateriel = String(req.query.typeMateriel || '').trim();
    if (MATERIEL_TYPES.some((t) => t.code === typeMateriel)) {
      where.push('m.mt_type = ?');
      params.push(typeMateriel);
    }
    const mvnt = String(req.query.mvnt || '').trim();
    if (MVNT_TYPES.some((t) => t.code === mvnt)) {
      where.push('v.mm_type = ?');
      params.push(mvnt);
    }
    const agence = parseInt(req.query.agence, 10) || 0;
    if (agence) {
      where.push('v.mm_agence = ?');
      params.push(agence);
    }

    const [rows] = await pool.query(
      `SELECT v.mm_id AS id, v.mm_materiel AS materiel_id, m.mt_nom AS materiel,
              m.mt_type AS type_materiel, m.mt_unite AS unite,
              v.mm_type AS mvnt, v.mm_qte AS qte,
              a.agence_name AS agence, v.mm_frais AS frais_id,
              cu.users_name AS cible_user, v.mm_commentaire AS commentaire,
              DATE_FORMAT(v.mm_date, '%d/%m/%Y %H:%i') AS date,
              u.users_name AS par,
              y.lm_id AS moyen_id, y.lm_type AS moyen_type,
              y.lm_marque_id AS moyen_marque_id, y.lm_immat AS moyen_immat,
              y.lm_immat_ww AS moyen_immat_ww, y.lm_chassis AS moyen_chassis
         FROM delevery_materiel_mvnt v
         JOIN delevery_materiel m        ON m.mt_id = v.mm_materiel
         LEFT JOIN delevery_agences a    ON a.agence_id = v.mm_agence
         LEFT JOIN delevery_users u      ON u.users_id = v.mm_by
         LEFT JOIN delevery_users cu     ON cu.users_id = v.mm_user
         LEFT JOIN delevery_logistique_moyen y ON y.lm_id = v.mm_moyen
        WHERE ${where.join(' AND ')}
        ORDER BY v.mm_id DESC
        LIMIT ${MAX_MVNT}`,
      params
    );

    const marques = new Map();
    for (const m of await listMarqueRows()) marques.set(m.id, m.marque);
    res.json({
      rows: rows.map((r) => {
        let moyen = '';
        if (r.moyen_id) {
          const marque = marques.get(Number(r.moyen_marque_id)) || `Marque n°${r.moyen_marque_id}`;
          const numero = r.moyen_immat || r.moyen_immat_ww || r.moyen_chassis;
          moyen = `${String(r.moyen_type).toUpperCase()} · ${marque} — ${numero}`;
        }
        return {
          id: r.id,
          materiel_id: r.materiel_id,
          materiel: r.materiel,
          type_materiel: r.type_materiel,
          unite: r.unite,
          mvnt: r.mvnt,
          qte: Number(r.qte),
          agence: r.agence || '',
          moyen,
          cible_user: r.cible_user || '',
          frais_id: r.frais_id,
          commentaire: r.commentaire,
          date: r.date,
          par: r.par || ''
        };
      })
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/* Affectations non-consommables.                                     */
/* ------------------------------------------------------------------ */

/**
 * GET /api/materiel/affectations — query : materiel, dimension (AGENCE |
 * USER), statut (affecte | recupere). Cible résolue (agence ou personne).
 */
async function listAffectations(req, res, next) {
  try {
    const where = ['1 = 1'];
    const params = [];
    const materiel = parseInt(req.query.materiel, 10) || 0;
    if (materiel) {
      where.push('af.maf_materiel = ?');
      params.push(materiel);
    }
    const dimension = String(req.query.dimension || '').trim();
    if (AFFECTATION_DIMENSIONS.includes(dimension)) {
      where.push('af.maf_dimension = ?');
      params.push(dimension);
    }
    const statut = String(req.query.statut || '').trim();
    if (statut === 'affecte' || statut === 'recupere') {
      where.push('af.maf_statut = ?');
      params.push(statut);
    }

    const [rows] = await pool.query(
      `SELECT af.maf_id AS id, af.maf_materiel AS materiel_id, m.mt_nom AS materiel,
              af.maf_dimension AS dimension, af.maf_cible_id AS cible_id,
              COALESCE(a.agence_name, cu.users_name, '') AS cible,
              af.maf_qte AS qte, af.maf_qte_recuperee AS qte_recuperee,
              af.maf_reference AS reference,
              DATE_FORMAT(af.maf_date_affectation, '%d/%m/%Y')  AS date_affectation,
              DATE_FORMAT(af.maf_date_recuperation, '%d/%m/%Y') AS date_recuperation,
              af.maf_statut AS statut, af.maf_commentaire AS commentaire
         FROM delevery_materiel_affectation af
         JOIN delevery_materiel m     ON m.mt_id = af.maf_materiel
         LEFT JOIN delevery_agences a ON af.maf_dimension = 'AGENCE' AND a.agence_id = af.maf_cible_id
         LEFT JOIN delevery_users cu  ON af.maf_dimension = 'USER'   AND cu.users_id = af.maf_cible_id
        WHERE ${where.join(' AND ')}
        ORDER BY af.maf_id DESC
        LIMIT ${MAX_MVNT}`,
      params
    );
    res.json({
      rows: rows.map((r) => ({
        ...r,
        qte: Number(r.qte),
        qte_recuperee: Number(r.qte_recuperee),
        date_recuperation: r.date_recuperation || ''
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/materiel/affectations — body { materiel, dimension, cible, qte,
 * reference?, date, commentaire? }. Transaction : verrou article, garde stock,
 * ligne d'affectation + mouvement « affectation ».
 */
async function createAffectation(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const article = await loadArticle(req.body?.materiel);
    if (!article || article.type !== 'non_consommable' || Number(article.active) !== 1) {
      return res.status(400).json({ message: 'Article non consommable introuvable ou désactivé.' });
    }
    const dimension = String(req.body?.dimension || '').trim();
    if (!AFFECTATION_DIMENSIONS.includes(dimension)) {
      return res.status(400).json({ message: 'Veuillez choisir la cible (agence ou personne).' });
    }
    const cibleId = parseInt(req.body?.cible, 10);
    if (!Number.isInteger(cibleId) || cibleId <= 0) {
      return res.status(400).json({
        message: dimension === 'AGENCE' ? "Veuillez sélectionner l'agence." : 'Veuillez sélectionner la personne.'
      });
    }
    if (dimension === 'AGENCE') {
      const [[agence]] = await pool.query(
        `SELECT agence_id FROM delevery_agences
          WHERE agence_id = ? AND agence_active = 1 LIMIT 1`,
        [cibleId]
      );
      if (!agence) return res.status(400).json({ message: 'Agence introuvable ou désactivée.' });
    } else {
      const [[cible]] = await pool.query(
        `SELECT users_id FROM delevery_users
          WHERE users_id = ? AND users_active = 1 LIMIT 1`,
        [cibleId]
      );
      if (!cible) return res.status(400).json({ message: 'Personne introuvable ou désactivée.' });
    }
    const qte = parseQte(req.body?.qte);
    if (qte === null) {
      return res.status(400).json({ message: 'Quantité invalide (entier positif attendu).' });
    }
    const reference = String(req.body?.reference || '').trim();
    if (reference.length > 100) {
      return res.status(400).json({ message: 'Référence trop longue (100 caractères max).' });
    }
    const date = parseDay(req.body?.date);
    if (!date) return res.status(400).json({ message: "Veuillez saisir la date d'affectation." });
    const commentaire = String(req.body?.commentaire || '').trim();
    if (commentaire.length > 255) {
      return res.status(400).json({ message: 'Commentaire trop long (255 caractères max).' });
    }

    await conn.beginTransaction();
    const [[verrou]] = await conn.query(
      `SELECT mt_qte FROM delevery_materiel WHERE mt_id = ? FOR UPDATE`,
      [article.id]
    );
    const stock = Number(verrou.mt_qte);
    if (stock < qte) {
      await conn.rollback();
      return res.status(400).json({
        message: `Stock insuffisant : ${stock} disponible(s), impossible d'en affecter ${qte}.`
      });
    }
    await conn.query(`UPDATE delevery_materiel SET mt_qte = mt_qte - ? WHERE mt_id = ?`, [
      qte,
      article.id
    ]);
    const [result] = await conn.query(
      `INSERT INTO delevery_materiel_affectation
         (maf_materiel, maf_dimension, maf_cible_id, maf_qte, maf_reference,
          maf_date_affectation, maf_commentaire, maf_created_by, maf_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [article.id, dimension, cibleId, qte, reference, date, commentaire, Number(req.user.id)]
    );
    await conn.query(
      `INSERT INTO delevery_materiel_mvnt
         (mm_materiel, mm_type, mm_qte, mm_agence, mm_user, mm_affectation,
          mm_commentaire, mm_date, mm_by)
       VALUES (?, 'affectation', ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        article.id,
        qte,
        dimension === 'AGENCE' ? cibleId : null,
        dimension === 'USER' ? cibleId : null,
        result.insertId,
        commentaire,
        Number(req.user.id)
      ]
    );

    await conn.commit();
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * POST /api/materiel/affectations/:id/recuperation — body { qte, date,
 * commentaire? }. Récupération partielle : cumule maf_qte_recuperee, repasse
 * le stock au principal, statut « recupere » quand tout est rendu.
 */
async function createRecuperation(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const affectationId = parseInt(req.params.id, 10);
    const [[apercu]] = await pool.query(
      `SELECT maf_materiel FROM delevery_materiel_affectation WHERE maf_id = ? LIMIT 1`,
      [Number.isInteger(affectationId) && affectationId > 0 ? affectationId : 0]
    );
    if (!apercu) return res.status(404).json({ message: 'Affectation introuvable.' });

    const qte = parseQte(req.body?.qte);
    if (qte === null) {
      return res.status(400).json({ message: 'Quantité invalide (entier positif attendu).' });
    }
    const date = parseDay(req.body?.date);
    if (!date) return res.status(400).json({ message: 'Veuillez saisir la date de récupération.' });
    const commentaire = String(req.body?.commentaire || '').trim();
    if (commentaire.length > 255) {
      return res.status(400).json({ message: 'Commentaire trop long (255 caractères max).' });
    }

    await conn.beginTransaction();
    // Verrou article d'abord (même ordre que partout), puis ligne d'affectation.
    await conn.query(`SELECT mt_id FROM delevery_materiel WHERE mt_id = ? FOR UPDATE`, [
      apercu.maf_materiel
    ]);
    const [[affectation]] = await conn.query(
      `SELECT maf_id AS id, maf_materiel AS materiel_id, maf_dimension AS dimension,
              maf_cible_id AS cible_id, maf_qte AS qte, maf_qte_recuperee AS recuperee
         FROM delevery_materiel_affectation
        WHERE maf_id = ? FOR UPDATE`,
      [affectationId]
    );
    if (!affectation) {
      await conn.rollback();
      return res.status(404).json({ message: 'Affectation introuvable.' });
    }
    const restant = Number(affectation.qte) - Number(affectation.recuperee);
    if (qte > restant) {
      await conn.rollback();
      return res.status(400).json({
        message: `Quantité supérieure au restant affecté (${restant}).`
      });
    }

    const statut = qte === restant ? 'recupere' : 'affecte';
    await conn.query(
      `UPDATE delevery_materiel_affectation
          SET maf_qte_recuperee = maf_qte_recuperee + ?, maf_date_recuperation = ?,
              maf_statut = ?, maf_updated_at = NOW()
        WHERE maf_id = ?`,
      [qte, date, statut, affectation.id]
    );
    await conn.query(`UPDATE delevery_materiel SET mt_qte = mt_qte + ? WHERE mt_id = ?`, [
      qte,
      affectation.materiel_id
    ]);
    await conn.query(
      `INSERT INTO delevery_materiel_mvnt
         (mm_materiel, mm_type, mm_qte, mm_agence, mm_user, mm_affectation,
          mm_commentaire, mm_date, mm_by)
       VALUES (?, 'recuperation', ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        affectation.materiel_id,
        qte,
        affectation.dimension === 'AGENCE' ? affectation.cible_id : null,
        affectation.dimension === 'USER' ? affectation.cible_id : null,
        affectation.id,
        commentaire,
        Number(req.user.id)
      ]
    );

    await conn.commit();
    res.json({ id: affectation.id, statut });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ */
/* Onglets « Matériel(s) » des fiches (montés sur d'autres routeurs). */
/* ------------------------------------------------------------------ */

/**
 * GET /api/logistiques/:id/materiels — consommations de matériel auto du
 * véhicule (onglet Matériels de la fiche moyen logistique).
 */
async function listMaterielsMoyen(req, res, next) {
  try {
    const moyenId = parseInt(req.params.id, 10);
    if (!Number.isInteger(moyenId) || moyenId <= 0) {
      return res.status(404).json({ message: 'Moyen logistique introuvable.' });
    }
    const [rows] = await pool.query(
      `SELECT v.mm_id AS id, m.mt_nom AS materiel, m.mt_unite AS unite,
              v.mm_qte AS qte, v.mm_commentaire AS commentaire,
              DATE_FORMAT(v.mm_date, '%d/%m/%Y %H:%i') AS date,
              u.users_name AS par
         FROM delevery_materiel_mvnt v
         JOIN delevery_materiel m   ON m.mt_id = v.mm_materiel
         LEFT JOIN delevery_users u ON u.users_id = v.mm_by
        WHERE v.mm_type = 'consommation' AND v.mm_moyen = ?
        ORDER BY v.mm_id DESC
        LIMIT 500`,
      [moyenId]
    );
    res.json({ rows: rows.map((r) => ({ ...r, qte: Number(r.qte), par: r.par || '' })) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/materiel et /api/livreurs/:id/materiel — affectations
 * de matériel non consommable de la personne (onglet Matériel(s) des fiches).
 */
async function listMaterielsUser(req, res, next) {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }
    const [rows] = await pool.query(
      `SELECT af.maf_id AS id, m.mt_nom AS materiel, af.maf_reference AS reference,
              af.maf_qte AS qte, af.maf_qte_recuperee AS qte_recuperee,
              DATE_FORMAT(af.maf_date_affectation, '%d/%m/%Y')  AS date_affectation,
              DATE_FORMAT(af.maf_date_recuperation, '%d/%m/%Y') AS date_recuperation,
              af.maf_statut AS statut, af.maf_commentaire AS commentaire
         FROM delevery_materiel_affectation af
         JOIN delevery_materiel m ON m.mt_id = af.maf_materiel
        WHERE af.maf_dimension = 'USER' AND af.maf_cible_id = ?
        ORDER BY af.maf_id DESC`,
      [userId]
    );
    res.json({
      rows: rows.map((r) => ({
        ...r,
        qte: Number(r.qte),
        qte_recuperee: Number(r.qte_recuperee),
        date_recuperation: r.date_recuperation || ''
      }))
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listArticlesVendables,
  debiterStockVente,
  tracerMouvementVente,
  restituerStockVente,
  listFiltres,
  listMateriels,
  createMateriel,
  updateMateriel,
  setMaterielStatut,
  deleteMateriel,
  createMouvement,
  listStockAgences,
  listMouvements,
  listAffectations,
  createAffectation,
  createRecuperation,
  listMaterielsMoyen,
  listMaterielsUser
};
