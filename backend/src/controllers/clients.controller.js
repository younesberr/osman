const pool = require('../config/db');
const { getAgenceScope, clientDansAgence } = require('../utils/agenceScope');
const { hashPassword } = require('../utils/password');

const MAX_PAGE_SIZE = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Page Clients (/admin/clients) — comptes marchands de delevery_customers.
 * Références legacy :
 *  - ville de ramassage : customers_pickup_city → delevery_tarifs.ville_id ;
 *  - agence : ville → zone (delevery_tarifs.zone) → delevery_zone.zone_agence_id ;
 *  - forme juridique : customers_company_type → delevery_configs
 *    (configs_var = 'ws_config_companies_type', stocké en varchar, parfois vide) ;
 *  - banque : customers_bank → delevery_configs (configs_var = 'ws_config_banks_name').
 */

const FROM_SQL = `
    FROM delevery_customers c
    LEFT JOIN delevery_tarifs t   ON t.ville_id = c.customers_pickup_city
    LEFT JOIN delevery_zone z     ON z.zone_id = t.zone
    LEFT JOIN delevery_agences ag ON ag.agence_id = z.zone_agence_id
    LEFT JOIN delevery_configs cf ON cf.configs_var = 'ws_config_companies_type'
                                 AND cf.configs_id = CAST(NULLIF(c.customers_company_type, '') AS UNSIGNED)
    LEFT JOIN delevery_configs cb ON cb.configs_var = 'ws_config_banks_name'
                                 AND cb.configs_id = CAST(NULLIF(c.customers_bank, '') AS UNSIGNED)`;

/*
 * Statistiques colis par client (delevery_parcel.parcel_customer) :
 * "en cours" = tout statut non final (ni livré ni retourné), y compris les
 * colis pas encore ramassés (NEW_PARCEL, WAITING_PICKUP) — vue client,
 * contrairement à la page Livreurs qui ne compte que les colis en circuit.
 */
const STATS_JOIN_SQL = `
    LEFT JOIN (
      SELECT parcel_customer,
             COUNT(*) AS colis_total,
             SUM(parcel_status = 'DELIVERED') AS colis_livres,
             SUM(parcel_status IN ('NEW_PARCEL','WAITING_PICKUP','PICKED_UP','SENT','RECEIVED','DISTRIBUTION','IN_PROGRESS')) AS colis_en_cours,
             SUM(parcel_status = 'RETURNED') AS colis_retournes
        FROM delevery_parcel
       GROUP BY parcel_customer
    ) pstats ON pstats.parcel_customer = c.customers_id`;

/* Colonnes de tri autorisées (taux = part du total des colis du client). */
const SORTS = {
  nb_colis: 'IFNULL(pstats.colis_total, 0)',
  taux_livraison: '(pstats.colis_livres / NULLIF(pstats.colis_total, 0))',
  taux_retour: '(pstats.colis_retournes / NULLIF(pstats.colis_total, 0))'
};

/* Filtres oui/non : nom de query param → expression SQL (colonnes parfois NULL). */
const FLAG_FILTERS = {
  customTarif: 'IFNULL(c.customers_custom_tarif, 0)',
  verified: 'IFNULL(c.customers_verified, 0)',
  livreurShow: 'IFNULL(c.customers_livreur, 0)',
  active: 'IFNULL(c.customers_active, 0)'
};

/**
 * GET /api/clients — liste paginée pour la datatable.
 * Query : page, pageSize, search (magasin, nom, CIN, tél personnel, tél magasin),
 * ville (ville_id de ramassage), agence (agence_id via zone de la ville), forme
 * (configs_id de la forme juridique), customTarif / verified / livreurShow /
 * active (1|0), sortBy (voir SORTS) et sortDir (asc|desc).
 */
async function listClients(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
    const search = String(req.query.search || '').trim().slice(0, 100);
    const ville = parseInt(req.query.ville, 10);
    const agence = parseInt(req.query.agence, 10);
    const forme = parseInt(req.query.forme, 10);

    const sortExpr = SORTS[String(req.query.sortBy || '')];
    const sortDir = String(req.query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderSql = sortExpr ? `${sortExpr} ${sortDir}, c.customers_id DESC` : 'c.customers_id DESC';

    const where = ['1 = 1'];
    const params = [];
    // Types 3/4/6 : uniquement les clients dont la ville de ramassage est
    // rattachée à leur agence (via la jointure zone → agence de FROM_SQL).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      where.push('z.zone_agence_id = ?');
      params.push(agenceScope);
    }
    if (search) {
      where.push(`(c.customers_store LIKE ? OR c.customers_name LIKE ? OR c.customers_cin LIKE ?
                   OR c.customers_phone_personal LIKE ? OR c.customers_phone LIKE ?)`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (Number.isInteger(ville)) {
      where.push('c.customers_pickup_city = ?');
      params.push(ville);
    }
    if (Number.isInteger(agence)) {
      where.push('ag.agence_id = ?');
      params.push(agence);
    }
    if (Number.isInteger(forme)) {
      where.push('cf.configs_id = ?');
      params.push(forme);
    }
    for (const [param, expr] of Object.entries(FLAG_FILTERS)) {
      const value = String(req.query[param] || '').trim();
      if (value === '1' || value === '0') {
        where.push(`${expr} = ?`);
        params.push(Number(value));
      }
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM_SQL} ${whereSql}`, params);

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT c.customers_id, c.customers_store, c.customers_name, c.customers_cin,
              c.customers_phone, c.customers_phone_personal, c.customers_city,
              c.customers_address, c.customers_rib, c.customers_active,
              IFNULL(c.customers_custom_tarif, 0) AS custom_tarif,
              IFNULL(c.customers_verified, 0)     AS verified,
              IFNULL(c.customers_livreur, 0)      AS livreur_show,
              IFNULL(c.customers_stock, 0)        AS stock,
              t.nom_ville     AS ville_ramassage,
              z.zone_name     AS zone,
              ag.agence_name  AS agence,
              cf.configs_val  AS forme_juridique,
              cb.configs_val  AS banque,
              IFNULL(pstats.colis_total, 0)     AS colis_total,
              IFNULL(pstats.colis_livres, 0)    AS colis_livres,
              IFNULL(pstats.colis_en_cours, 0)  AS colis_en_cours,
              IFNULL(pstats.colis_retournes, 0) AS colis_retournes
         ${FROM_SQL}
         ${STATS_JOIN_SQL}
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      rows: rows.map((r) => ({
        customers_id: r.customers_id,
        store: r.customers_store,
        name: r.customers_name,
        cin: r.customers_cin,
        phone: r.customers_phone,
        phone_personal: r.customers_phone_personal,
        city: r.customers_city,
        address: r.customers_address,
        rib: r.customers_rib,
        banque: r.banque,
        ville_ramassage: r.ville_ramassage,
        zone: r.zone,
        agence: r.agence,
        forme_juridique: r.forme_juridique,
        custom_tarif: Number(r.custom_tarif) === 1 ? 1 : 0,
        verified: Number(r.verified),
        livreur_show: Number(r.livreur_show),
        stock: Number(r.stock) === 1 ? 1 : 0,
        active: Number(r.customers_active),
        colis_total: Number(r.colis_total),
        colis_livres: Number(r.colis_livres),
        colis_en_cours: Number(r.colis_en_cours),
        colis_retournes: Number(r.colis_retournes)
      })),
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
 * GET /api/clients/filtres — listes des filtres : villes de ramassage
 * (référentiel delevery_tarifs), agences et formes juridiques actives.
 */
async function listFiltres(req, res, next) {
  try {
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    const [agences] = await pool.query(
      `SELECT agence_id, agence_name FROM delevery_agences ORDER BY agence_name`
    );
    const [formes] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs
        WHERE configs_var = 'ws_config_companies_type' AND configs_active = 1
        ORDER BY configs_val`
    );
    res.json({ villes, agences, formes });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/clients — modale "Ajouter nouveau client".
 * body { name, cin, email, phone, password, passwordConfirm, address, pickupCity }.
 * Le téléphone saisi est le téléphone de connexion : le login client matche
 * customers_email OU customers_phone, on le stocke donc dans customers_phone
 * (et aussi dans customers_phone_personal, champ affiché "personnel").
 */
async function createClient(req, res, next) {
  try {
    const name = String(req.body?.name || '').trim();
    const cin = String(req.body?.cin || '').trim();
    const email = String(req.body?.email || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');
    const passwordConfirm = String(req.body?.passwordConfirm || '');
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
    if (password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (password !== passwordConfirm) {
      return res.status(400).json({ message: 'La confirmation ne correspond pas au mot de passe.' });
    }
    if (!address || address.length > 250) {
      return res.status(400).json({ message: 'Adresse requise (250 caractères max).' });
    }
    if (!Number.isInteger(pickupCity)) {
      return res.status(400).json({ message: 'Veuillez choisir la ville de ramassage.' });
    }

    const [[ville]] = await pool.query(
      `SELECT t.ville_id, z.zone_agence_id
         FROM delevery_tarifs t
         LEFT JOIN delevery_zone z ON z.zone_id = t.zone
        WHERE t.ville_id = ? LIMIT 1`,
      [pickupCity]
    );
    if (!ville) return res.status(400).json({ message: 'Ville de ramassage introuvable.' });
    // Types 3/4/6 : la ville choisie doit appartenir à l'agence de l'employé,
    // sinon le client créé serait invisible dans sa propre liste.
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null && Number(ville.zone_agence_id) !== agenceScope) {
      return res.status(400).json({ message: "Cette ville de ramassage n'appartient pas à votre agence." });
    }

    // Seul l'email est identifiant de connexion : il doit être unique.
    // Le téléphone peut être partagé entre plusieurs comptes.
    const [[dup]] = await pool.query(
      `SELECT customers_id FROM delevery_customers
        WHERE LOWER(customers_email) = LOWER(?)
        LIMIT 1`,
      [email]
    );
    if (dup) return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });

    const [result] = await pool.query(
      `INSERT INTO delevery_customers
         (customers_name, customers_cin, customers_email, customers_phone,
          customers_phone_personal, customers_password, customers_address,
          customers_pickup_city, customers_active, customers_verified,
          customers_time, customers_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [
        name,
        cin,
        email,
        phone,
        phone,
        await hashPassword(password),
        address,
        pickupCity,
        // customers_time legacy : timestamp unix en secondes, stocké en varchar.
        String(Math.floor(Date.now() / 1000)),
        Number(req.user.id) || null
      ]
    );
    res.status(201).json({ customers_id: result.insertId });
  } catch (err) {
    next(err);
  }
}

/** Vrai si l'employé est restreint par agence et que le client n'en fait pas partie. */
async function clientHorsAgence(req, clientId) {
  const agenceScope = await getAgenceScope(req.user);
  return agenceScope !== null && !(await clientDansAgence(clientId, agenceScope));
}

/** Met à jour une colonne 0/1 d'un client ; renvoie 404 si le client n'existe pas. */
async function setFlag(res, id, column, value) {
  const [result] = await pool.query(
    `UPDATE delevery_customers SET ${column} = ? WHERE customers_id = ?`,
    [value, id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ message: 'Client introuvable.' });
  }
  return null;
}

/** PATCH /api/clients/:id/active — body { active: 0|1 }. */
async function setActive(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const active = Number(req.body?.active);
    if (!Number.isInteger(id) || ![0, 1].includes(active)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    if (await clientHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }
    if (await setFlag(res, id, 'customers_active', active)) return;
    res.json({ customers_id: id, active });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/clients/:id/verified — body { verified: 0|1 }. */
async function setVerified(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const verified = Number(req.body?.verified);
    if (!Number.isInteger(id) || ![0, 1].includes(verified)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    if (await clientHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }
    if (await setFlag(res, id, 'customers_verified', verified)) return;
    res.json({ customers_id: id, verified });
  } catch (err) {
    next(err);
  }
}

/** État renvoyé par GET et PATCH /api/clients/:id/options (null si client inconnu). */
async function lireOptions(id) {
  const [[row]] = await pool.query(
    `SELECT IFNULL(customers_livreur, 0)          AS livreur_show,
            IFNULL(customers_stock, 0)            AS stock,
            IFNULL(customers_default_open, 0)     AS default_open,
            IFNULL(customers_default_essayage, 0) AS default_essayage
       FROM delevery_customers WHERE customers_id = ?`,
    [id]
  );
  if (!row) return null;
  return {
    customers_id: id,
    livreur_show: Number(row.livreur_show),
    // customers_stock (varchar '0'/'1') : 1 = Gestion stock dans le menu client.
    stock: Number(row.stock) === 1 ? 1 : 0,
    // Options par défaut des nouveaux colis (mêmes colonnes que /client/configuration) :
    // default_open = 1 → ouverture interdite par défaut ; default_essayage = 1 → essayage autorisé.
    default_open: Number(row.default_open),
    default_essayage: Number(row.default_essayage)
  };
}

/**
 * GET /api/clients/:id/options — état de la modale "Options" (flags du
 * compte, cf. setOptions).
 */
async function getOptions(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    if (await clientHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }
    const etat = await lireOptions(id);
    if (!etat) return res.status(404).json({ message: 'Client introuvable.' });
    res.json(etat);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/clients/:id/options — modale "Options" :
 * body { livreurShow?: 0|1, stock?: 0|1, defaultOpen?: 0|1,
 *        defaultEssayage?: 0|1 } (au moins un champ).
 *  - livreurShow → customers_livreur (voir n° livreur) ;
 *  - stock → customers_stock (stock autorisé : sans lui, pas de menu
 *    « Gestion stock » côté client, cf. hasClientAccess ; désactivé par défaut) ;
 *  - defaultOpen / defaultEssayage → customers_default_open /
 *    customers_default_essayage (section « Options par défaut » : valeurs par
 *    défaut des cases « interdire l'ouverture » / « interdire l'essayage »
 *    d'un nouveau colis, mêmes colonnes que /client/configuration ;
 *    default_essayage = 1 signifie essayage autorisé ; ouverture interdite par
 *    défaut → essayage interdit d'office, comme updateMyConfig).
 */
async function setOptions(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    if (await clientHorsAgence(req, id)) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }

    const sets = [];
    const params = [];
    for (const [field, column] of [
      ['livreurShow', 'customers_livreur'],
      ['stock', 'customers_stock'],
      ['defaultOpen', 'customers_default_open'],
      ['defaultEssayage', 'customers_default_essayage']
    ]) {
      if (req.body?.[field] === undefined) continue;
      const value = Number(req.body[field]);
      if (![0, 1].includes(value)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) {
      return res.status(400).json({ message: 'Aucune modification envoyée.' });
    }

    const [result] = await pool.query(
      `UPDATE delevery_customers SET ${sets.join(', ')} WHERE customers_id = ?`,
      [...params, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Client introuvable.' });
    }
    // Ouverture interdite par défaut → essayage interdit par défaut aussi
    // (customers_default_essayage = 0), quelle que soit la valeur envoyée.
    await pool.query(
      `UPDATE delevery_customers SET customers_default_essayage = 0
        WHERE customers_id = ? AND IFNULL(customers_default_open, 0) = 1`,
      [id]
    );

    const etat = await lireOptions(id);
    if (!etat) return res.status(404).json({ message: 'Client introuvable.' });
    res.json(etat);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/clients/me/config — préférences du client connecté (page
 * /client/configuration) : default_open et default_essayage.
 */
async function getMyConfig(req, res, next) {
  try {
    const [[row]] = await pool.query(
      `SELECT IFNULL(customers_default_open, 0)      AS default_open,
              IFNULL(customers_default_essayage, 0)  AS default_essayage
         FROM delevery_customers WHERE customers_id = ?`,
      [Number(req.user.id)]
    );
    if (!row) return res.status(404).json({ message: 'Compte introuvable.' });
    res.json({
      default_open: Number(row.default_open),
      default_essayage: Number(row.default_essayage)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/clients/me/config — body { defaultOpen?, defaultEssayage? }
 * (0|1, au moins un champ). Renvoie l'état à jour.
 */
async function updateMyConfig(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const sets = [];
    const params = [];
    for (const [field, column] of [
      ['defaultOpen', 'customers_default_open'],
      ['defaultEssayage', 'customers_default_essayage']
    ]) {
      if (req.body?.[field] === undefined) continue;
      const value = Number(req.body[field]);
      if (![0, 1].includes(value)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) {
      return res.status(400).json({ message: 'Aucune modification envoyée.' });
    }

    if (sets.length) {
      const [result] = await pool.query(
        `UPDATE delevery_customers SET ${sets.join(', ')} WHERE customers_id = ?`,
        [...params, customerId]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Compte introuvable.' });
      }
      // Ouverture interdite par défaut → essayage interdit par défaut aussi
      // (customers_default_essayage = 0), quelle que soit la valeur envoyée.
      await pool.query(
        `UPDATE delevery_customers SET customers_default_essayage = 0
          WHERE customers_id = ? AND IFNULL(customers_default_open, 0) = 1`,
        [customerId]
      );
    }
    return getMyConfig(req, res, next);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listClients,
  listFiltres,
  createClient,
  setActive,
  setVerified,
  setOptions,
  getOptions,
  getMyConfig,
  updateMyConfig
};
