const pool = require('../config/db');
const { hashPassword } = require('../utils/password');

const MAX_PAGE_SIZE = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Page admin "Nouveaux clients" (/admin/nouveaux-clients, service
 * NOUVEAUX_CLIENTS) — demandes de création de compte client envoyées depuis la
 * page publique /register (table legacy delevery_new_customers, admin legacy :
 * admin/files/new_customer.php).
 *
 * Statuts (new_customers_statut) :
 *  - 0 : en attente (seule valeur listée par l'ancien admin) ;
 *  - 1 : refusée — valeur du "delete" legacy, qui servait aussi à retirer les
 *    demandes déjà acceptées à la main : les lignes historiques en statut 1
 *    mélangent donc refus et acceptations d'avant ce dashboard ;
 *  - 2 : acceptée par ce dashboard (invisible pour l'ancien admin, qui ne
 *    liste que le statut 0 — sans risque pour lui).
 *
 * Particularité du schéma legacy : le CIN de la demande est stocké dans
 * new_customers_brand (recopié dans customers_cin à l'acceptation).
 */

const STATUTS = { PENDING: 0, REFUSED: 1, ACCEPTED: 2 };
const STATUT_LABELS = { 0: 'PENDING', 1: 'REFUSED', 2: 'ACCEPTED' };

/**
 * GET /api/nouveaux-clients — liste paginée des demandes.
 * Query : page, pageSize, search (nom, magasin, téléphones, email, ville,
 * CIN, RIB, site web) et statut (PENDING par défaut | ACCEPTED | REFUSED |
 * ALL). Renvoie aussi le nombre de demandes en attente (compteur d'onglet).
 */
async function listDemandes(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    let statut = String(req.query.statut || 'PENDING').trim().toUpperCase();
    if (statut !== 'ALL' && !(statut in STATUTS)) statut = 'PENDING';

    const where = [];
    const params = [];
    if (statut !== 'ALL') {
      where.push('new_customers_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (search) {
      // Mêmes colonnes cherchées que la datatable legacy (+ téléphone personnel).
      where.push(`(new_customers_name LIKE ? OR new_customers_store LIKE ?
                   OR new_customers_phone LIKE ? OR new_customers_phone_personal LIKE ?
                   OR new_customers_email LIKE ? OR new_customers_city LIKE ?
                   OR new_customers_address LIKE ? OR new_customers_brand LIKE ?
                   OR new_customers_rib LIKE ? OR new_customers_website LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM delevery_new_customers ${whereSql}`,
      params
    );

    const offset = (page - 1) * pageSize;
    // new_customers_time est un timestamp unix stocké en varchar → tri numérique.
    const [rows] = await pool.query(
      `SELECT new_customers_id AS id, new_customers_name AS name,
              new_customers_store AS store, new_customers_phone AS phone,
              new_customers_phone_personal AS phone_personal,
              new_customers_email AS email, new_customers_address AS address,
              new_customers_city AS city, new_customers_website AS website,
              new_customers_brand AS cin, new_customers_rib AS rib,
              new_customers_statut AS statut, new_customers_time AS time
         FROM delevery_new_customers
         ${whereSql}
         ORDER BY CAST(new_customers_time AS UNSIGNED) DESC, new_customers_id DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const [[{ pending }]] = await pool.query(
      `SELECT COUNT(*) AS pending FROM delevery_new_customers WHERE new_customers_statut = 0`
    );

    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        store: r.store,
        phone: r.phone,
        phone_personal: r.phone_personal,
        email: r.email,
        address: r.address,
        city: r.city,
        website: r.website,
        cin: r.cin,
        rib: r.rib,
        statut: STATUT_LABELS[Number(r.statut)] || 'REFUSED',
        time: Number(r.time) || 0
      })),
      pending: Number(pending) || 0,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/nouveaux-clients/villes — référentiel des villes de ramassage pour
 * la modale d'acceptation (même source que /api/clients/filtres, dupliqué ici
 * car le service NOUVEAUX_CLIENTS n'implique pas l'accès au service CLIENTS).
 */
async function listVilles(req, res, next) {
  try {
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    res.json({ villes });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/nouveaux-clients/:id/accepter — crée le compte marchand à partir
 * de la demande (équivalent du lien "+" legacy qui préremplissait le
 * formulaire de création de client), puis passe la demande en statut 2.
 * body { name, cin, email, phone, address, pickupCity } : champs relus depuis
 * la modale (préremplis avec la demande, modifiables par l'admin). Le mot de
 * passe choisi par le client à l'inscription est conservé : hash bcrypt
 * recopié tel quel ; les demandes legacy stockées en clair sont hachées ici.
 * Magasin, ville (texte), tél personnel, site web et RIB sont recopiés de la
 * demande.
 */
async function accepterDemande(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
  }
  try {
    const [[demande]] = await pool.query(
      `SELECT new_customers_name AS name, new_customers_store AS store,
              new_customers_phone AS phone, new_customers_phone_personal AS phone_personal,
              new_customers_email AS email, new_customers_password AS password,
              new_customers_address AS address, new_customers_city AS city,
              new_customers_website AS website, new_customers_brand AS cin,
              new_customers_rib AS rib
         FROM delevery_new_customers
        WHERE new_customers_id = ? AND new_customers_statut = 0
        LIMIT 1`,
      [id]
    );
    if (!demande) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }

    const name = String(req.body?.name || '').trim();
    const cin = String(req.body?.cin || '').trim();
    const email = String(req.body?.email || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const address = String(req.body?.address || '').trim();
    const pickupCity = parseInt(req.body?.pickupCity, 10);

    if (!name || name.length > 100) {
      return res.status(400).json({ message: 'Nom complet requis (100 caractères max).' });
    }
    if (!cin || cin.length > 100) {
      return res.status(400).json({ message: 'CIN requis (100 caractères max).' });
    }
    if (!email || email.length > 100 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    if (phone.length < 6 || phone.length > 50) {
      return res.status(400).json({ message: 'Numéro de téléphone invalide.' });
    }
    if (!address || address.length > 250) {
      return res.status(400).json({ message: 'Adresse requise (250 caractères max).' });
    }
    if (!Number.isInteger(pickupCity)) {
      return res.status(400).json({ message: 'Veuillez choisir la ville de ramassage.' });
    }
    const [[ville]] = await pool.query(
      `SELECT ville_id FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
      [pickupCity]
    );
    if (!ville) return res.status(400).json({ message: 'Ville de ramassage introuvable.' });

    // Seul l'email est identifiant de connexion : il doit être unique.
    // Le téléphone peut être partagé entre plusieurs comptes.
    const [[dup]] = await pool.query(
      `SELECT customers_id FROM delevery_customers
        WHERE LOWER(customers_email) = LOWER(?)
        LIMIT 1`,
      [email]
    );
    if (dup) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte client.' });
    }

    const storedPassword = String(demande.password || '');
    const password = storedPassword.startsWith('$2')
      ? storedPassword // demande créée par la nouvelle page /register : déjà bcrypt
      : await hashPassword(storedPassword); // demande legacy stockée en clair

    // La demande est réclamée AVANT l'insertion : deux acceptations
    // simultanées ne peuvent pas créer deux comptes.
    const [claim] = await pool.query(
      `UPDATE delevery_new_customers SET new_customers_statut = 2
        WHERE new_customers_id = ? AND new_customers_statut = 0`,
      [id]
    );
    if (claim.affectedRows === 0) {
      return res.status(409).json({ message: 'Demande déjà traitée.' });
    }

    try {
      const [result] = await pool.query(
        `INSERT INTO delevery_customers
           (customers_name, customers_cin, customers_store, customers_email,
            customers_phone, customers_phone_personal, customers_password,
            customers_address, customers_city, customers_website, customers_rib,
            customers_pickup_city, customers_active, customers_verified,
            customers_time, customers_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        [
          name,
          cin,
          String(demande.store || '').trim().slice(0, 100),
          email,
          phone,
          String(demande.phone_personal || '').trim() || phone,
          password,
          address,
          String(demande.city || '').trim().slice(0, 125),
          String(demande.website || '').trim().slice(0, 50),
          String(demande.rib || '').trim().slice(0, 50),
          pickupCity,
          // customers_time legacy : timestamp unix en secondes, stocké en varchar.
          String(Math.floor(Date.now() / 1000)),
          Number(req.user.id) || null
        ]
      );
      res.status(201).json({ id, customers_id: result.insertId });
    } catch (err) {
      // Création du compte échouée : la demande redevient en attente.
      await pool.query(
        `UPDATE delevery_new_customers SET new_customers_statut = 0
          WHERE new_customers_id = ? AND new_customers_statut = 2`,
        [id]
      );
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/nouveaux-clients/:id/refuser — refuse la demande : statut 1,
 * même valeur que le "delete" de l'ancien admin (la ligne reste en base).
 */
async function refuserDemande(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }
    const [result] = await pool.query(
      `UPDATE delevery_new_customers SET new_customers_statut = 1
        WHERE new_customers_id = ? AND new_customers_statut = 0`,
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }
    res.json({ id });
  } catch (err) {
    next(err);
  }
}

module.exports = { listDemandes, listVilles, accepterDemande, refuserDemande };
