const pool = require('../config/db');
const { getAgenceScope, clientDansAgence, villeInAgenceSql } = require('../utils/agenceScope');
const {
  listArticlesVendables,
  debiterStockVente,
  tracerMouvementVente,
  restituerStockVente
} = require('./materiel.controller');

/*
 * Frais supplémentaires clients (page
 * /admin/facturation-clients/frais-supplementaires) — table de l'application
 * delevery_client_frais (sql/2026-08-20_frais-clients.sql +
 * sql/2026-08-25_materiel.sql) : frais saisis manuellement pour un client
 * (delevery_customers), destinés à être repris plus tard dans la facturation
 * clients.
 *
 * Types (frais_type) : emballage | ramassage | retour_express | autre.
 * Pour « emballage », l'article vendu vient du catalogue matériel
 * (delevery_materiel, types emballage / consommable) : frais_materiel_id +
 * frais_agence_id identifient la vente, frais_titre garde le nom de l'article
 * (snapshot) et frais_quantite la quantité. La vente décrémente le stock de
 * l'agence (delevery_materiel_agence) sous transaction et trace un mouvement
 * « vente » ; modification / suppression d'un frais statut 0 restitue le
 * stock. frais_quantite est NULL pour les autres types.
 *
 * Statuts (frais_statut) : 0 = Nouveau (modifiable / supprimable),
 * 1 = Enregistré, 2 = Payé. Un frais enregistré ou payé, ou rattaché à une
 * facture client (frais_facture_id, facturation clients à venir), n'est plus
 * ni modifiable ni supprimable — même principe que les frais livreurs.
 *
 * Employés type 3/4/6 : uniquement les frais des clients dont la ville de
 * ramassage est rattachée à leur agence (même périmètre que la page Clients).
 */

const MAX_FRAIS = 1000;

/* Codes API ↔ codes frais_statut. */
const STATUTS = { new: 0, saved: 1, paid: 2 };

/* Types de frais autorisés (frais_type). */
const TYPES = {
  emballage: 'Emballage',
  ramassage: 'Ramassage',
  retour_express: 'Retour express',
  autre: 'Autre'
};

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Montant > 0 (2 décimales max), sinon null. */
function parseMontant(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 99999999) return null;
  return Math.round(n * 100) / 100;
}

/** Vérifie le client (actif) et son périmètre agence. */
async function checkClient(clientId, user) {
  const [[client]] = await pool.query(
    `SELECT customers_id FROM delevery_customers
      WHERE customers_id = ? AND IFNULL(customers_active, 0) = 1 LIMIT 1`,
    [clientId]
  );
  if (!client) return { error: 'Client introuvable ou désactivé.' };
  const agenceScope = await getAgenceScope(user);
  if (agenceScope !== null && !(await clientDansAgence(clientId, agenceScope))) {
    return { error: 'Client hors de votre agence.' };
  }
  return {};
}

/**
 * Valide le body { client, type, titre, materiel, agence, date, montant,
 * quantite } ; { error } ou valeurs prêtes à insérer. Pour « emballage » :
 * materiel (article du catalogue) + agence (stock décrémenté) + quantité ;
 * le titre (nom de l'article) est résolu à l'enregistrement.
 */
function parseBody(body) {
  const client = parseInt(body?.client, 10);
  if (!Number.isInteger(client) || client <= 0) {
    return { error: 'Veuillez sélectionner un magasin.' };
  }
  const type = String(body?.type || '').trim();
  if (!(type in TYPES)) return { error: 'Veuillez sélectionner le type de frais.' };
  let titre = String(body?.titre || '').trim();
  let materiel = null;
  let agence = null;
  let quantite = null;
  if (type === 'emballage') {
    titre = '';
    materiel = parseInt(body?.materiel, 10);
    if (!Number.isInteger(materiel) || materiel <= 0) {
      return { error: "Veuillez sélectionner le type d'emballage." };
    }
    agence = parseInt(body?.agence, 10);
    if (!Number.isInteger(agence) || agence <= 0) {
      return { error: "Veuillez sélectionner l'agence." };
    }
    quantite = parseInt(body?.quantite, 10);
    if (!Number.isInteger(quantite) || quantite <= 0 || quantite > 99999) {
      return { error: 'Quantité invalide (entier positif attendu).' };
    }
  } else {
    if (!titre) return { error: 'Veuillez saisir le titre du frais.' };
    if (titre.length > 255) return { error: 'Titre trop long (255 caractères max).' };
  }
  const date = dayToUnix(body?.date);
  if (date === null) return { error: 'Veuillez saisir la date du frais.' };
  const montant = parseMontant(body?.montant);
  if (montant === null) return { error: 'Montant invalide (montant positif attendu).' };
  return { client, type, titre, materiel, agence, quantite, date, montant };
}

/**
 * Agence de la vente d'un frais « emballage » : imposée par le périmètre pour
 * les types 3/4/6 (quoi qu'envoie le client), vérifiée active sinon.
 * Mute values.agence ; retourne { error } ou {}.
 */
async function resoudreAgenceVente(user, values) {
  const agenceScope = await getAgenceScope(user);
  if (agenceScope !== null) {
    if (!agenceScope) return { error: "Votre compte n'est rattaché à aucune agence." };
    values.agence = agenceScope;
  }
  const [[agence]] = await pool.query(
    `SELECT agence_id FROM delevery_agences
      WHERE agence_id = ? AND agence_active = 1 LIMIT 1`,
    [values.agence]
  );
  if (!agence) return { error: 'Agence introuvable ou désactivée.' };
  return {};
}

/** Charge un frais avec l'id de son client ; null si introuvable. */
async function loadFrais(id) {
  const fraisId = parseInt(id, 10);
  if (!Number.isInteger(fraisId) || fraisId <= 0) return null;
  const [[frais]] = await pool.query(
    `SELECT frais_id AS id, frais_statut AS statut, frais_client_id AS client_id,
            frais_facture_id AS facture_id, frais_materiel_id AS materiel_id,
            frais_agence_id AS agence_id, frais_quantite AS quantite
       FROM delevery_client_frais
      WHERE frais_id = ? LIMIT 1`,
    [fraisId]
  );
  return frais || null;
}

/** Vrai si le client du frais est hors du périmètre de l'employé (types 3/4/6). */
async function clientInterdit(user, clientId) {
  const agenceScope = await getAgenceScope(user);
  return agenceScope !== null && !(await clientDansAgence(clientId, agenceScope));
}

/** Motif d'interdiction de modification / suppression, ou null si permis :
 * frais enregistré / payé, ou rattaché à une facture client. */
function fraisVerrouille(frais) {
  if (Number(frais.statut) !== STATUTS.new) return 'Ce frais est enregistré ou payé';
  if (frais.facture_id) return 'Ce frais est rattaché à une facture client';
  return null;
}

/**
 * GET /api/frais-clients/filtres — clients actifs (magasin + nom) pour le
 * filtre et la modale d'ajout, restreints à l'agence pour les types 3/4/6 ;
 * articles vendables du catalogue matériel ({ id, nom, prix }) et agences
 * actives pour la vente d'emballage. agenceImposee : agence du connecté
 * (types 3/4/6, select verrouillé côté frontend), null sinon.
 */
async function listFiltres(req, res, next) {
  try {
    const where = ['IFNULL(c.customers_active, 0) = 1'];
    const params = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push(villeInAgenceSql('c.customers_pickup_city'));
      params.push(agenceScope);
    }
    const [clients] = await pool.query(
      `SELECT c.customers_id AS id, c.customers_store AS store, c.customers_name AS nom
         FROM delevery_customers c
        WHERE ${where.join(' AND ')}
        ORDER BY c.customers_store, c.customers_name`,
      params
    );
    let emballages = [];
    try {
      emballages = await listArticlesVendables();
    } catch {
      // Table delevery_materiel absente tant que sql/2026-08-25_materiel.sql
      // n'est pas exécutée : la page reste utilisable, liste vide comme avant.
    }
    const [agences] = await pool.query(
      `SELECT agence_id AS id, agence_name AS nom FROM delevery_agences
        WHERE agence_active = 1 ORDER BY agence_name`
    );
    res.json({ clients, emballages, agences, agenceImposee: agenceScope });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/frais-clients — liste des frais pour la datatable.
 * Query : magasin (customers_id), type (emballage | ramassage | retour_express
 * | autre, '' = tous), statut (new | saved | paid, '' = tous). 1000 frais max,
 * du plus récent au plus ancien. Types 3/4/6 : clients de leur agence.
 */
async function listFrais(req, res, next) {
  try {
    const magasin = parseInt(req.query.magasin, 10) || 0;
    const type = String(req.query.type || '').trim();
    const statut = String(req.query.statut || '').trim();

    const where = ['1 = 1'];
    const params = [];
    if (magasin) {
      where.push('f.frais_client_id = ?');
      params.push(magasin);
    }
    if (type in TYPES) {
      where.push('f.frais_type = ?');
      params.push(type);
    }
    if (statut in STATUTS) {
      where.push('f.frais_statut = ?');
      params.push(STATUTS[statut]);
    }
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push(villeInAgenceSql('c.customers_pickup_city'));
      params.push(agenceScope);
    }

    const [rows] = await pool.query(
      `SELECT f.frais_id          AS id,
              f.frais_type        AS type,
              f.frais_titre       AS titre,
              f.frais_quantite    AS quantite,
              f.frais_materiel_id AS materiel_id,
              f.frais_agence_id   AS agence_id,
              a.agence_name       AS agence,
              f.frais_date        AS date_frais,
              f.frais_montant     AS montant,
              f.frais_statut      AS statut,
              f.frais_added_time  AS added_time,
              f.frais_client_id   AS client_id,
              f.frais_facture_id  AS facture_id,
              c.customers_store   AS store,
              c.customers_name    AS client_name,
              ua.users_name       AS added_by
         FROM delevery_client_frais f
         LEFT JOIN delevery_customers c ON c.customers_id = f.frais_client_id
         LEFT JOIN delevery_agences a   ON a.agence_id = f.frais_agence_id
         LEFT JOIN delevery_users ua    ON ua.users_id = f.frais_added_by
        WHERE ${where.join(' AND ')}
        ORDER BY f.frais_added_time DESC, f.frais_id DESC
        LIMIT ${MAX_FRAIS}`,
      params
    );
    res.json(rows.map((r) => ({ ...r, statut: Number(r.statut), montant: Number(r.montant) })));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/frais-clients — body { client, type, titre, materiel, agence,
 * date, montant, quantite }. Crée un frais au statut « Nouveau » pour le
 * client (actif). Pour « emballage » : transaction qui décrémente le stock
 * agence du catalogue matériel et trace un mouvement « vente ».
 */
async function createFrais(req, res, next) {
  let conn = null;
  try {
    const values = parseBody(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    const check = await checkClient(values.client, req.user);
    if (check.error) return res.status(400).json({ message: check.error });

    const now = Math.floor(Date.now() / 1000);
    if (values.type !== 'emballage') {
      const [result] = await pool.query(
        `INSERT INTO delevery_client_frais
           (frais_client_id, frais_type, frais_titre, frais_quantite, frais_date,
            frais_montant, frais_statut, frais_added_time, frais_added_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          values.client,
          values.type,
          values.titre,
          values.quantite,
          values.date,
          values.montant,
          now,
          Number(req.user.id)
        ]
      );
      return res.status(201).json({ id: result.insertId });
    }

    const agence = await resoudreAgenceVente(req.user, values);
    if (agence.error) return res.status(400).json({ message: agence.error });

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const vente = await debiterStockVente(conn, values.materiel, values.agence, values.quantite);
    if (vente.error) {
      await conn.rollback();
      return res.status(400).json({ message: vente.error });
    }
    const [result] = await conn.query(
      `INSERT INTO delevery_client_frais
         (frais_client_id, frais_type, frais_titre, frais_materiel_id,
          frais_agence_id, frais_quantite, frais_date, frais_montant,
          frais_statut, frais_added_time, frais_added_by)
       VALUES (?, 'emballage', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        values.client,
        vente.nom,
        values.materiel,
        values.agence,
        values.quantite,
        values.date,
        values.montant,
        now,
        Number(req.user.id)
      ]
    );
    await tracerMouvementVente(
      conn,
      values.materiel,
      values.agence,
      values.quantite,
      result.insertId,
      req.user.id
    );
    await conn.commit();
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) conn.release();
  }
}

/**
 * PATCH /api/frais-clients/:id — body { client, type, titre, materiel,
 * agence, date, montant, quantite }. Modifie un frais au statut « Nouveau »
 * uniquement. Transaction : l'ancienne vente d'emballage est restituée
 * (stock + mouvement supprimé), la nouvelle décrémentée le cas échéant.
 */
async function updateFrais(req, res, next) {
  let conn = null;
  try {
    const frais = await loadFrais(req.params.id);
    if (!frais) return res.status(404).json({ message: 'Frais introuvable.' });
    if (await clientInterdit(req.user, frais.client_id)) {
      return res.status(404).json({ message: 'Frais introuvable.' });
    }
    const verrou = fraisVerrouille(frais);
    if (verrou) {
      return res.status(400).json({ message: `${verrou} : modification impossible.` });
    }
    const values = parseBody(req.body);
    if (values.error) return res.status(400).json({ message: values.error });
    const check = await checkClient(values.client, req.user);
    if (check.error) return res.status(400).json({ message: check.error });
    if (values.type === 'emballage') {
      const agence = await resoudreAgenceVente(req.user, values);
      if (agence.error) return res.status(400).json({ message: agence.error });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    await restituerStockVente(conn, frais);
    let titre = values.titre;
    if (values.type === 'emballage') {
      const vente = await debiterStockVente(conn, values.materiel, values.agence, values.quantite);
      if (vente.error) {
        await conn.rollback();
        return res.status(400).json({ message: vente.error });
      }
      titre = vente.nom;
    }
    await conn.query(
      `UPDATE delevery_client_frais
          SET frais_client_id = ?, frais_type = ?, frais_titre = ?,
              frais_materiel_id = ?, frais_agence_id = ?, frais_quantite = ?,
              frais_date = ?, frais_montant = ?
        WHERE frais_id = ?`,
      [
        values.client,
        values.type,
        titre,
        values.materiel,
        values.agence,
        values.quantite,
        values.date,
        values.montant,
        frais.id
      ]
    );
    if (values.type === 'emballage') {
      await tracerMouvementVente(
        conn,
        values.materiel,
        values.agence,
        values.quantite,
        frais.id,
        req.user.id
      );
    }
    await conn.commit();
    res.json({ id: frais.id });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) conn.release();
  }
}

/**
 * DELETE /api/frais-clients/:id — supprime un frais au statut « Nouveau »
 * uniquement. Transaction : la vente d'emballage éventuelle est restituée
 * (stock agence + mouvement « vente » supprimé).
 */
async function deleteFrais(req, res, next) {
  let conn = null;
  try {
    const frais = await loadFrais(req.params.id);
    if (!frais) return res.status(404).json({ message: 'Frais introuvable.' });
    if (await clientInterdit(req.user, frais.client_id)) {
      return res.status(404).json({ message: 'Frais introuvable.' });
    }
    const verrou = fraisVerrouille(frais);
    if (verrou) {
      return res.status(400).json({ message: `${verrou} : suppression impossible.` });
    }
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await restituerStockVente(conn, frais);
    await conn.query(`DELETE FROM delevery_client_frais WHERE frais_id = ?`, [frais.id]);
    await conn.commit();
    res.json({ id: frais.id });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    next(err);
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  listFiltres,
  listFrais,
  createFrais,
  updateFrais,
  deleteFrais
};
