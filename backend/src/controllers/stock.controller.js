const path = require('path');
const fs = require('fs');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const {
  getAgenceScope,
  villeInAgenceSql,
  parcelInAgence,
  clientDansAgence,
  produitDansAgence
} = require('../utils/agenceScope');

/*
 * Gestion de stock > Inventaire — produits en stock (delevery_product).
 * Les colonnes product_ref, product_qte, product_qte_attente, product_rayonnage,
 * product_statut, product_created_at et product_created_by sont des extensions ORTALOG
 * ajoutées à la table legacy (migrations SQL à exécuter manuellement,
 * l'utilisateur MySQL de l'app n'ayant pas ALTER).
 * Le nom du magasin vient de delevery_customers (customers_store).
 */

const PRODUCT_UPLOAD_DIR = path.join(UPLOADS_ROOT, 'products');

function ensureProductUploadDir() {
  fs.mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
  return PRODUCT_UPLOAD_DIR;
}

const LIST_SQL = `
  SELECT p.product_id        AS id,
         p.product_customer  AS clientId,
         c.customers_store   AS magasin,
         c.customers_name    AS clientNom,
         p.product_name      AS nom,
         p.product_ref       AS ref,
         p.product_qte       AS stock,
         p.product_qte_attente AS stockAttente,
         p.product_rayonnage AS position,
         p.product_statut    AS active
    FROM delevery_product p
    LEFT JOIN delevery_customers c ON c.customers_id = p.product_customer`;

/**
 * GET /api/stock/inventaire — tous les produits avec magasin, réf, stock, position, statut.
 * Employés type 3/4/6 : uniquement les produits des clients de leur agence.
 */
async function listInventaire(req, res, next) {
  try {
    const agenceScope = await getAgenceScope(req.user);
    const where = agenceScope !== null ? ` WHERE ${villeInAgenceSql('c.customers_pickup_city')}` : '';
    const params = agenceScope !== null ? [agenceScope] : [];
    const [rows] = await pool.query(`${LIST_SQL}${where} ORDER BY p.product_id DESC`, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** Vrai si l'employé est restreint par agence et que le produit n'en fait pas partie. */
async function produitHorsAgence(req, productId) {
  const agenceScope = await getAgenceScope(req.user);
  return agenceScope !== null && !(await produitDansAgence(productId, agenceScope));
}

/** URL publique de l'image d'un produit (product_pic stocke le nom de fichier). */
function productImageUrl(pic) {
  if (!pic) return null;
  return /^https?:\/\//i.test(pic) ? pic : `/uploads/products/${pic}`;
}

const DETAIL_SQL = `
  SELECT p.product_id        AS id,
         p.product_customer  AS clientId,
         c.customers_store   AS magasin,
         c.customers_name    AS clientNom,
         p.product_name      AS nom,
         p.product_ref       AS ref,
         p.product_desc      AS description,
         p.product_pic       AS pic,
         p.product_qte       AS stock,
         p.product_rayonnage AS position,
         p.product_statut    AS active
    FROM delevery_product p
    LEFT JOIN delevery_customers c ON c.customers_id = p.product_customer
   WHERE p.product_id = ?`;

/** GET /api/stock/produits/:id — détail d'un produit (fiche + modale info). */
async function getProduit(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    if (await produitHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const [rows] = await pool.query(DETAIL_SQL, [id]);
    if (!rows.length) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const { pic, ...produit } = rows[0];
    res.json({ ...produit, imageUrl: productImageUrl(pic) });
  } catch (err) {
    next(err);
  }
}

/** GET /api/stock/magasins — clients pour la liste déroulante (enseigne, sinon nom). */
async function listMagasins(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT customers_id AS id,
              COALESCE(NULLIF(TRIM(customers_store), ''), customers_name) AS label
         FROM delevery_customers
        ORDER BY label`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/* Positions de stock configurées (Configuration > Options > Position),
   stockées dans delevery_configs comme les banques/formes juridiques. */
const POSITIONS_VAR = 'ws_config_stock_positions';

/** GET /api/stock/positions — positions actives pour les formulaires produit et le filtre inventaire. */
async function listPositions(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT configs_val AS position
         FROM delevery_configs
        WHERE configs_var = ? AND configs_active = 1
        ORDER BY configs_val`,
      [POSITIONS_VAR]
    );
    res.json(rows.map((r) => r.position));
  } catch (err) {
    next(err);
  }
}

/** Supprime le fichier uploadé si la création échoue (pas de fichier orphelin). */
function dropUploadedFile(file) {
  if (file) fs.promises.unlink(file.path).catch(() => {});
}

/** Position envoyée par un formulaire produit : trim + majuscules, null si vide. */
function normalisePosition(position) {
  return String(position || '').trim().toUpperCase() || null;
}

/**
 * Vrai si la position est acceptable : parmi les positions configurées actives,
 * ou déjà la position actuelle du produit (position historique retirée de la
 * configuration).
 */
async function positionConnue(position, positionActuelle = null) {
  if (positionActuelle && position === String(positionActuelle).trim().toUpperCase()) {
    return true;
  }
  const [[pos]] = await pool.query(
    `SELECT configs_id FROM delevery_configs
      WHERE configs_var = ? AND configs_val = ? AND configs_active = 1 LIMIT 1`,
    [POSITIONS_VAR, position]
  );
  return Boolean(pos);
}

const POSITION_INCONNUE_MSG =
  'Position inconnue : ajoutez-la dans Configuration > Options > Position.';

/**
 * POST /api/stock/produits — crée un produit (multipart : champs + image facultative).
 * Champs : magasinId (obligatoire), nom (obligatoire), ref, position (facultative,
 * parmi les positions configurées, enregistrée dans product_rayonnage), description.
 * created_at = NOW(), created_by = employé connecté (jamais fourni par le front).
 */
async function createProduit(req, res, next) {
  try {
    const { magasinId, nom, ref, position, description } = req.body || {};

    const clientId = Number(magasinId);
    if (!magasinId || !Number.isInteger(clientId) || clientId <= 0) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du magasin est obligatoire.' });
    }
    const nomTrim = String(nom || '').trim();
    if (!nomTrim) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du produit est obligatoire.' });
    }

    const [clients] = await pool.query(
      'SELECT customers_id FROM delevery_customers WHERE customers_id = ? LIMIT 1',
      [clientId]
    );
    if (!clients.length) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Magasin inconnu.' });
    }

    // Types 3/4/6 : création possible uniquement pour un client de leur agence.
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null && !(await clientDansAgence(clientId, agenceScope))) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Magasin inconnu.' });
    }

    const positionTrim = normalisePosition(position);
    if (positionTrim && !(await positionConnue(positionTrim))) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: POSITION_INCONNUE_MSG });
    }

    // Colonnes legacy sans valeur métier ici : variante abandonnée (0),
    // réception non renseignée (0), timestamp UNIX comme l'ancien système.
    const [result] = await pool.query(
      `INSERT INTO delevery_product
         (product_customer, product_name, product_desc, product_pic, product_variant,
          product_added_time, product_received, product_received_time, product_received_by,
          product_ref, product_qte, product_rayonnage, product_statut,
          product_created_at, product_created_by)
       VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, ?, 0, ?, 1, NOW(), ?)`,
      [
        clientId,
        nomTrim,
        String(description || '').trim(),
        req.file ? req.file.filename : '',
        Math.floor(Date.now() / 1000),
        String(ref || '').trim() || null,
        positionTrim,
        req.user?.id || null
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Produit créé.' });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/** Supprime une ancienne image produit du disque (nom de fichier simple uniquement). */
function deleteProductFile(filename) {
  if (!filename || filename.includes('/') || filename.includes('\\')) return;
  fs.promises.unlink(path.join(PRODUCT_UPLOAD_DIR, filename)).catch(() => {});
}

/**
 * PUT /api/stock/produits/:id — met à jour un produit (multipart, comme la création).
 * Position : facultative, parmi les positions configurées (ou la position actuelle
 * du produit si elle a été retirée de la configuration), dans product_rayonnage.
 * Image : nouveau fichier = remplacement, removeImage=1 = suppression, sinon inchangée ;
 * l'ancien fichier est supprimé du disque après remplacement/suppression.
 */
async function updateProduit(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const { magasinId, nom, ref, position, description, removeImage } = req.body || {};

    const clientId = Number(magasinId);
    if (!magasinId || !Number.isInteger(clientId) || clientId <= 0) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du magasin est obligatoire.' });
    }
    const nomTrim = String(nom || '').trim();
    if (!nomTrim) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du produit est obligatoire.' });
    }

    const [clients] = await pool.query(
      'SELECT customers_id FROM delevery_customers WHERE customers_id = ? LIMIT 1',
      [clientId]
    );
    if (!clients.length) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Magasin inconnu.' });
    }

    // Types 3/4/6 : le produit et le magasin cible doivent être de leur agence.
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      if (!(await produitDansAgence(id, agenceScope))) {
        dropUploadedFile(req.file);
        return res.status(404).json({ message: 'Produit introuvable.' });
      }
      if (!(await clientDansAgence(clientId, agenceScope))) {
        dropUploadedFile(req.file);
        return res.status(400).json({ message: 'Magasin inconnu.' });
      }
    }

    const [produits] = await pool.query(
      'SELECT product_pic, product_rayonnage FROM delevery_product WHERE product_id = ? LIMIT 1',
      [id]
    );
    if (!produits.length) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const positionTrim = normalisePosition(position);
    if (positionTrim && !(await positionConnue(positionTrim, produits[0].product_rayonnage))) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: POSITION_INCONNUE_MSG });
    }

    const ancienPic = produits[0].product_pic || '';
    let pic = ancienPic;
    if (req.file) {
      pic = req.file.filename;
    } else if (String(removeImage || '') === '1') {
      pic = '';
    }

    await pool.query(
      `UPDATE delevery_product
          SET product_customer = ?, product_name = ?, product_desc = ?,
              product_ref = ?, product_rayonnage = ?, product_pic = ?
        WHERE product_id = ?`,
      [
        clientId,
        nomTrim,
        String(description || '').trim(),
        String(ref || '').trim() || null,
        positionTrim,
        pic,
        id
      ]
    );

    if (ancienPic && ancienPic !== pic) deleteProductFile(ancienPic);

    res.json({ message: 'Produit enregistré.' });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/** PATCH /api/stock/produits/:id/statut — active (1) ou désactive (0) un produit. */
async function setProduitStatut(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    if (await produitHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const active = Number(req.body?.active) === 1 ? 1 : 0;
    const [result] = await pool.query(
      'UPDATE delevery_product SET product_statut = ? WHERE product_id = ?',
      [active, id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    res.json({ active });
  } catch (err) {
    next(err);
  }
}

/* Libellés stockés dans delevery_product_mvnt.mvnt_type. Les types
   'colis envoyé' / 'colis supprimé' sont écrits par parcels.controller
   (création / suppression d'un colis de stock) et 'colis retourné' par
   bonsRetourClient.controller (réception d'un bon retour client : produits
   réintégrés, colis « Retourné au stock »). */
const MVNT_TYPES = { entree: 'entrer stock', sortie: 'sortir stock' };

/**
 * POST /api/stock/produits/:id/mouvements — entrée ou sortie de stock exceptionnelle
 * faite directement par un utilisateur (le flux normal passe par le client).
 * Body : type ('entree' | 'sortie'), qte (> 0), motif (obligatoire).
 * La position du produit (product_rayonnage) se gère sur la fiche produit.
 * Transaction : met à jour delevery_product.product_qte puis trace le mouvement
 * dans delevery_product_mvnt (mvnt_qte signée : positive = entrée, négative = sortie ;
 * mvnt_type = 'entrer stock' | 'sortir stock' ; mvnt_statut = 1, appliqué immédiatement ;
 * mvnt_by / mvnt_commentaire réservés au flux client, donc NULL ici).
 */
async function createMouvement(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    if (await produitHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const { type, qte, motif } = req.body || {};
    if (type !== 'entree' && type !== 'sortie') {
      return res.status(400).json({ message: 'Type de mouvement invalide.' });
    }
    const quantite = Number(qte);
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ message: 'La quantité doit être un nombre entier supérieur à 0.' });
    }
    const motifTrim = String(motif || '').trim();
    if (!motifTrim) {
      return res.status(400).json({ message: 'Le motif est obligatoire.' });
    }

    await conn.beginTransaction();

    // Verrouille la ligne produit le temps de la transaction (stock cohérent).
    const [produits] = await conn.query(
      'SELECT product_qte FROM delevery_product WHERE product_id = ? FOR UPDATE',
      [id]
    );
    if (!produits.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const stockActuel = Number(produits[0].product_qte) || 0;
    const qteSignee = type === 'entree' ? quantite : -quantite;
    const nouveauStock = stockActuel + qteSignee;
    if (nouveauStock < 0) {
      await conn.rollback();
      return res.status(400).json({
        message: `Stock insuffisant : ${stockActuel} disponible(s), impossible d'en sortir ${quantite}.`
      });
    }

    await conn.query('UPDATE delevery_product SET product_qte = ? WHERE product_id = ?', [
      nouveauStock,
      id
    ]);
    await conn.query(
      `INSERT INTO delevery_product_mvnt
         (id_product, mvnt_qte, mvnt_type, mvnt_statut, mvnt_date, mvnt_by, mvnt_commentaire, mvnt_validate_by, mvnt_note)
       VALUES (?, ?, ?, 1, NOW(), NULL, NULL, ?, ?)`,
      [id, qteSignee, MVNT_TYPES[type], req.user?.id || null, motifTrim]
    );

    await conn.commit();
    res.status(201).json({ stock: nouveauStock, message: 'Mouvement enregistré.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/*
 * Dashboard client — mêmes opérations que l'inventaire admin mais toujours
 * scopées sur le client connecté (product_customer = req.user.id) : un client
 * ne voit et ne modifie que ses propres produits, sans choix de magasin.
 */

/** GET /api/stock/client/produits — produits du client connecté. */
async function listClientProduits(req, res, next) {
  try {
    const [rows] = await pool.query(
      `${LIST_SQL} WHERE p.product_customer = ? ORDER BY p.product_id DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/** GET /api/stock/client/produits/:id — détail d'un produit du client connecté. */
async function getClientProduit(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const [rows] = await pool.query(`${DETAIL_SQL} AND p.product_customer = ?`, [id, req.user.id]);
    if (!rows.length) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const { pic, ...produit } = rows[0];
    res.json({ ...produit, imageUrl: productImageUrl(pic) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/stock/client/produits — le client crée un produit pour son propre
 * magasin (multipart, comme la création admin mais sans magasinId).
 * product_created_by reste NULL : la colonne référence un employé ;
 * product_created_member = membre d'équipe du client le cas échéant.
 */
async function createClientProduit(req, res, next) {
  try {
    const { nom, ref, description } = req.body || {};
    const nomTrim = String(nom || '').trim();
    if (!nomTrim) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du produit est obligatoire.' });
    }

    const [result] = await pool.query(
      `INSERT INTO delevery_product
         (product_customer, product_name, product_desc, product_pic, product_variant,
          product_added_time, product_received, product_received_time, product_received_by,
          product_ref, product_qte, product_rayonnage, product_statut,
          product_created_at, product_created_by, product_created_member)
       VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, ?, 0, NULL, 1, NOW(), NULL, ?)`,
      [
        req.user.id,
        nomTrim,
        String(description || '').trim(),
        req.file ? req.file.filename : '',
        Math.floor(Date.now() / 1000),
        String(ref || '').trim() || null,
        Number(req.user?.memberId) || null
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Produit créé.' });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/**
 * PUT /api/stock/client/produits/:id — le client modifie un de ses produits
 * (multipart, comme la mise à jour admin mais sans changement de magasin).
 */
async function updateClientProduit(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const { nom, ref, description, removeImage } = req.body || {};
    const nomTrim = String(nom || '').trim();
    if (!nomTrim) {
      dropUploadedFile(req.file);
      return res.status(400).json({ message: 'Le nom du produit est obligatoire.' });
    }

    const [produits] = await pool.query(
      'SELECT product_pic FROM delevery_product WHERE product_id = ? AND product_customer = ? LIMIT 1',
      [id, req.user.id]
    );
    if (!produits.length) {
      dropUploadedFile(req.file);
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const ancienPic = produits[0].product_pic || '';
    let pic = ancienPic;
    if (req.file) {
      pic = req.file.filename;
    } else if (String(removeImage || '') === '1') {
      pic = '';
    }

    await pool.query(
      `UPDATE delevery_product
          SET product_name = ?, product_desc = ?, product_ref = ?, product_pic = ?
        WHERE product_id = ? AND product_customer = ?`,
      [nomTrim, String(description || '').trim(), String(ref || '').trim() || null, pic, id, req.user.id]
    );

    if (ancienPic && ancienPic !== pic) deleteProductFile(ancienPic);

    res.json({ message: 'Produit enregistré.' });
  } catch (err) {
    dropUploadedFile(req.file);
    next(err);
  }
}

/** PATCH /api/stock/client/produits/:id/statut — active/désactive un produit du client. */
async function setClientProduitStatut(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    const active = Number(req.body?.active) === 1 ? 1 : 0;
    const [result] = await pool.query(
      'UPDATE delevery_product SET product_statut = ? WHERE product_id = ? AND product_customer = ?',
      [active, id, req.user.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }
    res.json({ active });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/stock/client/produits/:id/mouvements — entrée/sortie de stock faite
 * par le client (flux normal) : le mouvement n'est PAS appliqué au stock mais
 * cumulé (signé) dans product_qte_attente et tracé avec mvnt_statut = 0 ;
 * il sera répercuté sur product_qte à la validation par un utilisateur
 * (POST /api/stock/mouvements/:id/valider). mvnt_by = client,
 * mvnt_commentaire = commentaire facultatif.
 */
async function createClientMouvement(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const { type, qte, commentaire } = req.body || {};
    if (type !== 'entree' && type !== 'sortie') {
      return res.status(400).json({ message: 'Type de mouvement invalide.' });
    }
    const quantite = Number(qte);
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ message: 'La quantité doit être un nombre entier supérieur à 0.' });
    }
    const commentaireTrim = String(commentaire || '').trim();

    await conn.beginTransaction();

    // Verrouille la ligne produit le temps de la transaction (stock cohérent).
    const [produits] = await conn.query(
      'SELECT product_qte, product_qte_attente FROM delevery_product WHERE product_id = ? AND product_customer = ? FOR UPDATE',
      [id, req.user.id]
    );
    if (!produits.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const stockActuel = Number(produits[0].product_qte) || 0;
    const attenteActuelle = Number(produits[0].product_qte_attente) || 0;
    const qteSignee = type === 'entree' ? quantite : -quantite;
    // Sortie : le stock projeté (stock + mouvements en attente) ne peut pas être négatif.
    if (stockActuel + attenteActuelle + qteSignee < 0) {
      await conn.rollback();
      return res.status(400).json({
        message: `Stock insuffisant : ${stockActuel} disponible(s) (${attenteActuelle} en attente), impossible d'en sortir ${quantite}.`
      });
    }
    const nouvelleAttente = attenteActuelle + qteSignee;

    await conn.query('UPDATE delevery_product SET product_qte_attente = ? WHERE product_id = ?', [
      nouvelleAttente,
      id
    ]);
    await conn.query(
      `INSERT INTO delevery_product_mvnt
         (id_product, mvnt_qte, mvnt_type, mvnt_statut, mvnt_date, mvnt_by, mvnt_member, mvnt_commentaire, mvnt_validate_by, mvnt_note)
       VALUES (?, ?, ?, 0, NOW(), ?, ?, ?, NULL, NULL)`,
      [id, qteSignee, MVNT_TYPES[type], req.user.id, Number(req.user?.memberId) || null, commentaireTrim || null]
    );

    await conn.commit();
    res.status(201).json({
      stockAttente: nouvelleAttente,
      message: 'Mouvement enregistré, en attente de validation.'
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * POST /api/stock/produits/:id/valider-attente — validation par un utilisateur
 * du stock en attente d'un produit (badge rouge de l'inventaire).
 * Body : qteRecue (1 à |attente|), annulerReste (0|1).
 * Applique la quantité reçue à product_qte (dans le sens du stock en attente :
 * entrée si attente positive, sortie si négative), retire du product_qte_attente
 * (mis à 0 si annulerReste), et trace un mouvement validé de type
 * 'entrer stock' / 'sortir stock' avec le commentaire « validation de stock ».
 * Quand l'attente retombe à 0, les mouvements clients encore en attente du
 * produit sont clôturés (mvnt_statut = 1) pour ne pas rester « En attente ».
 */
async function validerAttente(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    if (await produitHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const quantite = Number(req.body?.qteRecue);
    const annulerReste = Number(req.body?.annulerReste) === 1;
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ message: 'La quantité doit être un nombre entier supérieur à 0.' });
    }

    await conn.beginTransaction();

    // Verrouille la ligne produit le temps de la transaction (stock cohérent).
    const [produits] = await conn.query(
      'SELECT product_qte, product_qte_attente FROM delevery_product WHERE product_id = ? FOR UPDATE',
      [id]
    );
    if (!produits.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Produit introuvable.' });
    }

    const stockActuel = Number(produits[0].product_qte) || 0;
    const attente = Number(produits[0].product_qte_attente) || 0;
    if (attente === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Aucun stock en attente pour ce produit.' });
    }
    if (quantite > Math.abs(attente)) {
      await conn.rollback();
      return res.status(400).json({
        message: `La quantité validée ne peut pas dépasser le stock en attente (${Math.abs(attente)}).`
      });
    }

    const sens = attente > 0 ? 1 : -1;
    const qteSignee = sens * quantite;
    const nouveauStock = stockActuel + qteSignee;
    if (nouveauStock < 0) {
      await conn.rollback();
      return res.status(400).json({
        message: `Stock insuffisant : ${stockActuel} disponible(s), impossible d'en sortir ${quantite}.`
      });
    }
    const nouvelleAttente = annulerReste ? 0 : attente - qteSignee;

    await conn.query(
      'UPDATE delevery_product SET product_qte = ?, product_qte_attente = ? WHERE product_id = ?',
      [nouveauStock, nouvelleAttente, id]
    );
    await conn.query(
      `INSERT INTO delevery_product_mvnt
         (id_product, mvnt_qte, mvnt_type, mvnt_statut, mvnt_date, mvnt_by, mvnt_commentaire, mvnt_validate_by, mvnt_note)
       VALUES (?, ?, ?, 1, NOW(), NULL, 'validation de stock', ?, NULL)`,
      [id, qteSignee, sens > 0 ? MVNT_TYPES.entree : MVNT_TYPES.sortie, req.user?.id || null]
    );
    // Plus rien en attente : les demandes clients restantes sont clôturées.
    if (nouvelleAttente === 0) {
      await conn.query(
        'UPDATE delevery_product_mvnt SET mvnt_statut = 1, mvnt_validate_by = ? WHERE id_product = ? AND mvnt_statut = 0',
        [req.user?.id || null, id]
      );
    }

    await conn.commit();
    res.json({ stock: nouveauStock, stockAttente: nouvelleAttente, message: 'Stock validé.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
}

/*
 * Liste des mouvements (pages admin "Mouvement produits" et client
 * "Mouvement stock"). withMember : ajoute le nom du membre d'équipe client à
 * l'origine du mouvement (mvnt_member → delevery_customer_members) ; la
 * variante sans membre sert de repli tant que la migration
 * sql/2026-08-23_equipe-client-colonnes-attribution.sql n'est pas exécutée.
 */
function mvntListSql(withMember) {
  return `
  SELECT m.id_product_mvnt  AS id,
         c.customers_store  AS magasin,
         c.customers_name   AS clientNom,
         p.product_name     AS produit,
         p.product_ref      AS ref,
         COALESCE(m.mvnt_type, IF(m.mvnt_qte >= 0, '${MVNT_TYPES.entree}', '${MVNT_TYPES.sortie}')) AS type,
         m.mvnt_statut      AS statut,
         m.mvnt_qte         AS qte,
         m.mvnt_date        AS date,
         COALESCE(NULLIF(TRIM(cb.customers_store), ''), cb.customers_name) AS mouvementPar,
         ${withMember ? 'mb.member_name' : 'NULL'} AS mouvementParMembre,
         m.mvnt_commentaire AS commentaire,
         u.users_name       AS validePar,
         m.mvnt_note        AS note
    FROM delevery_product_mvnt m
    LEFT JOIN delevery_product   p  ON p.product_id = m.id_product
    LEFT JOIN delevery_customers c  ON c.customers_id = p.product_customer
    LEFT JOIN delevery_customers cb ON cb.customers_id = m.mvnt_by
    ${withMember ? 'LEFT JOIN delevery_customer_members mb ON mb.member_id = m.mvnt_member' : ''}
    LEFT JOIN delevery_users     u  ON u.users_id = m.mvnt_validate_by`;
}

const MVNT_ORDER_SQL = ' ORDER BY m.mvnt_date DESC, m.id_product_mvnt DESC';

/** Exécute la liste des mouvements avec repli si la migration équipe n'est pas passée. */
async function queryMouvements(whereSql, params) {
  try {
    const [rows] = await pool.query(mvntListSql(true) + whereSql + MVNT_ORDER_SQL, params);
    return rows;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
    const [rows] = await pool.query(mvntListSql(false) + whereSql + MVNT_ORDER_SQL, params);
    return rows;
  }
}

/**
 * GET /api/stock/mouvements — tous les mouvements de stock (page Mouvement produits) :
 * magasin + produit concernés, type, quantité signée, date, client à l'origine
 * du mouvement (mvnt_by), commentaire client, utilisateur validant (mvnt_validate_by)
 * et note utilisateur. Le type retombe sur le signe de mvnt_qte pour les
 * mouvements enregistrés avant l'ajout de la colonne mvnt_type.
 * Employés type 3/4/6 : uniquement les mouvements des produits des clients de leur agence.
 */
async function listMouvements(req, res, next) {
  try {
    const agenceScope = await getAgenceScope(req.user);
    const where = agenceScope !== null ? ` WHERE ${villeInAgenceSql('c.customers_pickup_city')}` : '';
    const params = agenceScope !== null ? [agenceScope] : [];
    res.json(await queryMouvements(where, params));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stock/client/mouvements — mêmes colonnes que la page admin mais
 * uniquement les mouvements validés (mvnt_statut = 1) des produits du client
 * connecté : les mouvements en attente ou refusés ne sont pas exposés.
 */
async function listClientMouvements(req, res, next) {
  try {
    res.json(await queryMouvements(' WHERE p.product_customer = ? AND m.mvnt_statut = 1', [req.user.id]));
  } catch (err) {
    next(err);
  }
}

/*
 * Gestion de stock > Colis en attente — colis créés depuis le stock
 * (parcel_from_stock = 1) pas encore ramassés (parcel_status = WAITING_PICKUP) :
 * code, magasin, destinataire + téléphone, ville + adresse, commentaire, date
 * de création (parcel_time : timestamp unix en secondes, colonne texte).
 */
const COLIS_ATTENTE_SQL = `
  SELECT p.parcel_id       AS id,
         p.parcel_code     AS code,
         c.customers_store AS magasin,
         c.customers_name  AS clientNom,
         p.parcel_receiver AS destinataire,
         p.parcel_phone    AS telephone,
         t.nom_ville       AS ville,
         p.parcel_address  AS adresse,
         p.parcel_note     AS commentaire,
         CAST(p.parcel_time AS UNSIGNED) AS dateCreation
    FROM delevery_parcel p
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
    LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city`;

/**
 * GET /api/stock/colis-en-attente — colis de stock en attente de ramassage.
 * Employés type 3/4/6 : uniquement les colis de leur agence.
 */
async function listColisEnAttente(req, res, next) {
  try {
    const where = ["p.parcel_from_stock = 1", "p.parcel_status = 'WAITING_PICKUP'"];
    const params = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const [rows] = await pool.query(
      `${COLIS_ATTENTE_SQL} WHERE ${where.join(' AND ')} ORDER BY CAST(p.parcel_time AS UNSIGNED) ASC, p.parcel_id ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stock/colis-en-attente/:id/produits — produits du colis pour la
 * modale info (delevery_parcel_content : une ligne par unité → quantités groupées).
 */
async function getColisEnAttenteProduits(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Colis invalide.' });
    const where = ['p.parcel_id = ?', 'p.parcel_from_stock = 1'];
    const params = [id];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }
    const [[parcel]] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code FROM delevery_parcel p WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    const [produits] = await pool.query(
      `SELECT parcel_content_product_name AS produit,
              COALESCE(NULLIF(parcel_content_variant_name, ''), '') AS variante,
              COUNT(*) AS qty
         FROM delevery_parcel_content
        WHERE parcel_content_parcel_id = ?
        GROUP BY parcel_content_product_name, COALESCE(NULLIF(parcel_content_variant_name, ''), '')
        ORDER BY parcel_content_product_name`,
      [parcel.parcel_id]
    );
    res.json({ code: parcel.parcel_code, produits });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listInventaire,
  listMagasins,
  listPositions,
  listMouvements,
  listColisEnAttente,
  getColisEnAttenteProduits,
  getProduit,
  createProduit,
  updateProduit,
  setProduitStatut,
  createMouvement,
  validerAttente,
  listClientProduits,
  listClientMouvements,
  getClientProduit,
  createClientProduit,
  updateClientProduit,
  setClientProduitStatut,
  createClientMouvement,
  ensureProductUploadDir
};
