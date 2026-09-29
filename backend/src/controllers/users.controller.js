const pool = require('../config/db');
const { hashPassword } = require('../utils/password');
const { computeServices } = require('../utils/typeServices');
const { agenceIdFromVille } = require('../utils/agenceScope');

const MAX_PAGE_SIZE = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const USER_TYPES = ['1', '2', '3', '4', '5', '6'];

/* Valeurs autorisées pour delevery_users.users_type_contrat (filtre page Utilisateurs). */
const TYPES_CONTRAT = ['CDI', 'CDD', 'Stage', 'Interim', 'Anapec'];

/**
 * Répartition entre les deux pages :
 *  - livreurs     = livreurs auto-entrepreneurs (users_type = 5 ET is_salarie = 0) ;
 *  - utilisateurs = tous les autres comptes, y compris les livreurs salariés.
 * users_is_salarie est renseigné à la création (utilisateur = 1, livreur = 0)
 * et par sql/2026-09-04_statut-personnel-defaut.sql pour les comptes existants ;
 * un NULL résiduel (migration non passée) est classé côté utilisateurs.
 * Les comptes secondaires (users_parent_id non NULL, onglet "Comptes" de la
 * fiche) sont exclus des deux listes : une personne = une ligne, et leur
 * activation passe par les endpoints /users/:id/comptes.
 */
const SCOPE_SQL = {
  utilisateurs: 'u.users_parent_id IS NULL AND NOT (u.users_type = 5 AND IFNULL(u.users_is_salarie, 1) = 0)',
  livreurs: 'u.users_parent_id IS NULL AND (u.users_type = 5 AND u.users_is_salarie = 0)'
};

/** Date (objet Date mysql2) → 'AAAA-MM-JJ' en heure locale (toISOString décalerait d'un jour). */
function toDateStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Documents requis selon le statut du compte (delevery_users.users_is_salarie,
 * NULL = statut non défini, documents non suivis) :
 *  - communs : CIN recto + verso ;
 *  - salarié : contrat, RIB, visite médicale ;
 *  - auto-entrepreneur : carte AE, RIB professionnel, contrat de prestation.
 * Le contrat d'un salarié est satisfait par users_contrat_fichier (ex suivi)
 * ou par le fichier du dernier contrat de l'onglet Parcours professionnel
 * (delevery_contrats.contrat_fichier), seul endroit où la fiche utilisateur
 * permet de le téléverser.
 * Expirés = date d'expiration renseignée et antérieure à aujourd'hui
 * (CIN, permis de conduire, visite médicale).
 */
function computeDocs(row) {
  if (row.is_salarie == null) return { manquants: null, expires: null };

  const requis = [
    ['CIN recto', row.cin_fichier_recto],
    ['CIN verso', row.cin_fichier_verso]
  ];
  if (Number(row.is_salarie) === 1) {
    requis.push(
      ['Contrat', row.contrat_fichier || row.parcours_contrat_fichier],
      ['RIB', row.rib_fichier],
      ['Visite médicale', row.visite_medicale]
    );
  } else {
    requis.push(
      ['Carte auto-entrepreneur', row.ae_carte_fichier],
      ['RIB professionnel', row.pro_rib_fichier],
      ['Contrat de prestation', row.contrat_fichier]
    );
  }
  const manquants = requis
    .filter(([, fichier]) => !fichier || !String(fichier).trim())
    .map(([label]) => label);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expires = [
    ['CIN', row.cin_expiration],
    ['Permis de conduire', row.permis_expiration],
    ['Visite médicale', row.visite_medicale_expiration]
  ]
    .filter(([, date]) => date instanceof Date && date < today)
    .map(([label, date]) => ({ label, date: toDateStr(date) }));

  return { manquants, expires };
}

/*
 * Zone et agence dérivées de la ville de fonction (users_ville_id) :
 * ville (delevery_tarifs) → zone (delevery_tarifs.zone → delevery_zone)
 * → agence (zone_agence_id → delevery_agences). Repli sur users_agence_id
 * (colonne legacy) pour les comptes sans ville de fonction.
 */
const FROM_SQL = `
    FROM delevery_users u
    LEFT JOIN delevery_user_types t ON t.user_types_id = u.users_type
    LEFT JOIN delevery_tarifs vf    ON vf.ville_id = u.users_ville_id
    LEFT JOIN delevery_zone vz      ON vz.zone_id = vf.zone
    LEFT JOIN delevery_agences a    ON a.agence_id = COALESCE(vz.zone_agence_id, u.users_agence_id)`;

/*
 * Miroir SQL de computeDocs() pour les filtres "Doc manquants" / "Doc expirés".
 * Les expressions ne renvoient jamais NULL (IFNULL partout) afin que
 * "= 1" (oui) et "= 0" (non) soient complémentaires parmi les comptes suivis ;
 * les comptes non suivis (users_is_salarie NULL) sont exclus des deux réponses.
 */
const DOC_MANQUANT_SQL = `(
       IFNULL(TRIM(u.users_cin_recto_image), '') = ''
    OR IFNULL(TRIM(u.users_cin_verso_image), '') = ''
    OR (IFNULL(u.users_is_salarie, 0) = 1 AND (
            (IFNULL(TRIM(u.users_contrat_fichier), '') = ''
             AND IFNULL(TRIM((SELECT c3.contrat_fichier FROM delevery_contrats c3
                               WHERE c3.contrat_users_id = u.users_id
                               ORDER BY c3.contrat_date_debut DESC, c3.contrat_id DESC LIMIT 1)), '') = '')
         OR IFNULL(TRIM(u.users_rib_image), '') = ''
         OR IFNULL(TRIM(u.users_visite_medicale), '') = ''))
    OR (IFNULL(u.users_is_salarie, 0) <> 1 AND (
            IFNULL(TRIM(u.users_ae_carte_fichier), '') = ''
         OR IFNULL(TRIM(u.users_pro_rib_fichier), '') = ''
         OR IFNULL(TRIM(u.users_contrat_fichier), '') = ''))
  )`;

const DOC_EXPIRE_SQL = `IFNULL(
       u.users_cin_expiration < CURDATE()
    OR u.users_permis_expiration < CURDATE()
    OR u.users_visite_medicale_expiration < CURDATE(), 0)`;

/*
 * Statistiques colis par livreur (page Livreurs uniquement) :
 *  - affectés = tous les colis dont parcel_livreur = le livreur ;
 *  - livrés / retournés / en cours d'après parcel_status.
 */
const LIVREUR_STATS_JOIN_SQL = `
    LEFT JOIN (
      SELECT parcel_livreur,
             COUNT(*) AS colis_affectes,
             SUM(parcel_status = 'DELIVERED') AS colis_livres,
             SUM(parcel_status IN ('PICKED_UP','SENT','RECEIVED','DISTRIBUTION','IN_PROGRESS')) AS colis_en_cours,
             SUM(parcel_status = 'RETURNED') AS colis_retournes
        FROM delevery_parcel
       GROUP BY parcel_livreur
    ) pstats ON pstats.parcel_livreur = u.users_id`;

const LIVREUR_STATS_SELECT_SQL = `,
            u.users_forme_juridique AS forme_juridique,
            IFNULL(pstats.colis_affectes, 0)  AS colis_affectes,
            IFNULL(pstats.colis_livres, 0)    AS colis_livres,
            IFNULL(pstats.colis_en_cours, 0)  AS colis_en_cours,
            IFNULL(pstats.colis_retournes, 0) AS colis_retournes`;

/* Colonnes de tri communes aux pages Utilisateurs et Livreurs. */
const COMMON_SORTS = {
  users_name: 'u.users_name',
  agence: 'a.agence_name'
};

/* Tris propres à la page Utilisateurs (l'ordre alphabétique des codes de
 * fonction correspond à celui des libellés français affichés). */
const USER_SORTS = {
  fonction: 't.user_types_code',
  type_contrat: "NULLIF(TRIM(u.users_type_contrat), '')",
  salaire: 's.salaire_net'
};

/* Tris propres à la page Livreurs (taux = part des colis affectés). */
const LIVREUR_SORTS = {
  zone: 'vz.zone_name',
  forme_juridique: "NULLIF(TRIM(u.users_forme_juridique), '')",
  colis_affectes: 'IFNULL(pstats.colis_affectes, 0)',
  taux_livraison: '(pstats.colis_livres / NULLIF(pstats.colis_affectes, 0))',
  taux_retour: '(pstats.colis_retournes / NULLIF(pstats.colis_affectes, 0))'
};

/**
 * Filtres et tri communs à la liste (listUsers) et à l'export paie (exportPaie).
 * Query : search (nom, téléphone, email, CIN), agence, type, active,
 * docsManquants (1|0), docsExpires (1|0) — voir DOC_MANQUANT_SQL / DOC_EXPIRE_SQL.
 * Zone et agence dérivées de la ville de fonction (voir FROM_SQL) : les filtres
 * agence et zone (livreurs) s'appuient sur cette chaîne.
 * Utilisateurs uniquement : typeContrat (users_type_contrat, voir TYPES_CONTRAT).
 * Livreurs uniquement : zone, forme (forme_juridique).
 * Tri via sortBy et sortDir (asc|desc) : colonnes COMMON_SORTS pour les deux pages,
 * + USER_SORTS (utilisateurs) ou LIVREUR_SORTS (livreurs).
 * Retourne { isLivreurs, whereSql, params, orderSql }.
 */
function buildListQuery(scope, query) {
  const search = String(query.search || '').trim().slice(0, 100);
  const agence = parseInt(query.agence, 10);
  const type = String(query.type || '').trim().slice(0, 5);
  const active = String(query.active || '').trim();
  const docsManquants = String(query.docsManquants || '').trim();
  const docsExpires = String(query.docsExpires || '').trim();
  const isLivreurs = scope === 'livreurs';
  const zone = isLivreurs ? parseInt(query.zone, 10) : NaN;
  const forme = isLivreurs ? String(query.forme || '').trim().slice(0, 100) : '';
  const typeContrat = isLivreurs ? '' : String(query.typeContrat || '').trim();

  const sorts = { ...COMMON_SORTS, ...(isLivreurs ? LIVREUR_SORTS : USER_SORTS) };
  const sortExpr = sorts[String(query.sortBy || '')];
  const sortDir = String(query.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  /* Valeurs absentes (NULL) toujours en fin de liste, quel que soit le sens. */
  const orderSql = sortExpr
    ? `${sortExpr} IS NULL, ${sortExpr} ${sortDir}, u.users_id DESC`
    : 'u.users_id DESC';

  const where = [SCOPE_SQL[scope]];
  const params = [];
  if (search) {
    where.push(`(u.users_name LIKE ? OR u.users_phone LIKE ? OR u.users_email LIKE ?
                 OR u.users_cin LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (Number.isInteger(agence)) {
    where.push('COALESCE(vz.zone_agence_id, u.users_agence_id) = ?');
    params.push(agence);
  }
  if (type && USER_TYPES.includes(type)) {
    where.push('u.users_type = ?');
    params.push(type);
  }
  if (active === '1' || active === '0') {
    where.push('u.users_active = ?');
    params.push(Number(active));
  }
  if (docsManquants === '1' || docsManquants === '0') {
    where.push(`(u.users_is_salarie IS NOT NULL AND ${DOC_MANQUANT_SQL} = ?)`);
    params.push(Number(docsManquants));
  }
  if (docsExpires === '1' || docsExpires === '0') {
    where.push(`(u.users_is_salarie IS NOT NULL AND ${DOC_EXPIRE_SQL} = ?)`);
    params.push(Number(docsExpires));
  }
  if (Number.isInteger(zone)) {
    where.push('vf.zone = ?');
    params.push(zone);
  }
  if (forme) {
    where.push('u.users_forme_juridique = ?');
    params.push(forme);
  }
  if (TYPES_CONTRAT.includes(typeContrat)) {
    where.push('u.users_type_contrat = ?');
    params.push(typeContrat);
  }
  return { isLivreurs, whereSql: `WHERE ${where.join(' AND ')}`, params, orderSql };
}

/*
 * Dernier contrat et dernier salaire du compte (onglet Parcours professionnel) :
 * lignes les plus récentes de delevery_contrats / delevery_salaires.
 */
const LAST_CONTRAT_SALAIRE_JOIN_SQL = `
    LEFT JOIN delevery_contrats c ON c.contrat_id =
      (SELECT c2.contrat_id FROM delevery_contrats c2 WHERE c2.contrat_users_id = u.users_id
        ORDER BY c2.contrat_date_debut DESC, c2.contrat_id DESC LIMIT 1)
    LEFT JOIN delevery_salaires s ON s.salaire_id =
      (SELECT s2.salaire_id FROM delevery_salaires s2 WHERE s2.salaire_users_id = u.users_id
        ORDER BY s2.salaire_date_application DESC, s2.salaire_id DESC LIMIT 1)`;

/**
 * GET /api/users et /api/livreurs — liste paginée pour la datatable admin (voir SCOPE_SQL).
 * Query : page, pageSize + filtres et tri de buildListQuery().
 * Contrat et salaire = dernière ligne de delevery_contrats / delevery_salaires du compte.
 * Livreurs uniquement : stats colis.
 */
function listUsers(scope) {
  return async function (req, res, next) {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);
      const { isLivreurs, whereSql, params, orderSql } = buildListQuery(scope, req.query);

      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${FROM_SQL} ${whereSql}`, params);

      const offset = (page - 1) * pageSize;
      const [rows] = await pool.query(
        `SELECT u.users_id, u.users_name, u.users_phone, u.users_email, u.users_cin,
                u.users_address, u.users_pic, u.users_active, u.users_type, u.users_services,
                u.users_type_contrat,
                t.user_types_code AS type_code,
                vf.nom_ville AS ville_fonction,
                vz.zone_name AS zone,
                a.agence_name AS agence,
                u.users_is_salarie AS is_salarie, u.users_date_recrutement AS date_recrutement,
                u.users_cin_recto_image AS cin_fichier_recto, u.users_cin_verso_image AS cin_fichier_verso,
                u.users_rib_image AS rib_fichier, u.users_contrat_fichier AS contrat_fichier,
                u.users_visite_medicale AS visite_medicale, u.users_ae_carte_fichier AS ae_carte_fichier,
                u.users_pro_rib_fichier AS pro_rib_fichier,
                u.users_cin_expiration AS cin_expiration, u.users_permis_expiration AS permis_expiration,
                u.users_visite_medicale_expiration AS visite_medicale_expiration,
                c.contrat_type AS type_contrat, c.contrat_date_debut AS contrat_debut,
                c.contrat_date_fin AS contrat_fin, c.contrat_fichier AS parcours_contrat_fichier,
                s.salaire_net, s.salaire_declare, s.salaire_date_application AS salaire_date
                ${isLivreurs ? LIVREUR_STATS_SELECT_SQL : ''}
           ${FROM_SQL}
           ${LAST_CONTRAT_SALAIRE_JOIN_SQL}
           ${isLivreurs ? LIVREUR_STATS_JOIN_SQL : ''}
           ${whereSql}
           ORDER BY ${orderSql}
           LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      res.json({
        rows: rows.map((r) => {
          const { manquants, expires } = computeDocs(r);
          return {
            users_id: r.users_id,
            users_name: r.users_name,
            users_phone: r.users_phone,
            users_email: r.users_email,
            users_cin: r.users_cin,
            users_address: r.users_address,
            users_pic: r.users_pic,
            users_active: r.users_active,
            users_type: r.users_type,
            users_type_contrat: r.users_type_contrat,
            type_code: r.type_code,
            services: r.users_services
              ? r.users_services.split(',').map((s) => s.trim()).filter(Boolean)
              : [],
            ville_fonction: r.ville_fonction,
            zone: r.zone,
            agence: r.agence,
            is_salarie: r.is_salarie == null ? null : Number(r.is_salarie),
            date_recrutement: toDateStr(r.date_recrutement),
            type_contrat: r.type_contrat,
            contrat_debut: toDateStr(r.contrat_debut),
            contrat_fin: toDateStr(r.contrat_fin),
            salaire_net: r.salaire_net,
            salaire_declare: r.salaire_declare,
            salaire_date: toDateStr(r.salaire_date),
            docs_manquants: manquants,
            docs_expires: expires,
            ...(isLivreurs && {
              forme_juridique: r.forme_juridique,
              colis_affectes: Number(r.colis_affectes),
              colis_livres: Number(r.colis_livres),
              colis_en_cours: Number(r.colis_en_cours),
              colis_retournes: Number(r.colis_retournes)
            })
          };
        }),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * GET /api/users/export-paie — lignes de l'export « Excel paie » de la page
 * Utilisateurs : mêmes filtres et même tri que la liste (buildListQuery), sans
 * pagination. Le fichier .xlsx est construit côté navigateur.
 * Colonnes : nom complet, agence, type de contrat (users_type_contrat, repli sur
 * le dernier contrat de l'onglet Parcours), salaire actuel (dernier salaire :
 * net + déclaré), banque (delevery_configs 'ws_config_banks_name' via
 * users_bank) et RIB (users_rib).
 */
function exportPaie(scope) {
  return async function (req, res, next) {
    try {
      const { whereSql, params, orderSql } = buildListQuery(scope, req.query);
      const [rows] = await pool.query(
        `SELECT u.users_id, u.users_name,
                a.agence_name AS agence,
                COALESCE(NULLIF(TRIM(u.users_type_contrat), ''), c.contrat_type) AS type_contrat,
                s.salaire_net, s.salaire_declare, s.salaire_date_application AS salaire_date,
                u.users_bank, bk.configs_val AS banque, u.users_rib
           ${FROM_SQL}
           ${LAST_CONTRAT_SALAIRE_JOIN_SQL}
           LEFT JOIN delevery_configs bk
             ON bk.configs_id = u.users_bank AND bk.configs_var = 'ws_config_banks_name'
           ${whereSql}
           ORDER BY ${orderSql}`,
        params
      );
      res.json({
        rows: rows.map((r) => ({
          users_id: r.users_id,
          users_name: r.users_name,
          agence: r.agence,
          type_contrat: r.type_contrat,
          salaire_net: r.salaire_net,
          salaire_declare: r.salaire_declare,
          salaire_date: toDateStr(r.salaire_date),
          /* Banque legacy absente de la configuration : même repli que la fiche. */
          banque: r.banque || (r.users_bank ? `Banque n°${r.users_bank}` : null),
          rib: r.users_rib
        }))
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * GET /api/users/filtres et /api/livreurs/filtres — agences et types pour les filtres.
 * Utilisateurs uniquement : types de contrat (liste fixe TYPES_CONTRAT).
 * Livreurs uniquement : zones et formes juridiques (valeurs distinctes du personnel).
 */
function listFiltres(scope) {
  return async function (req, res, next) {
    try {
      const [agences] = await pool.query(
        `SELECT agence_id, agence_name FROM delevery_agences ORDER BY agence_name`
      );
      const [types] = await pool.query(
        `SELECT user_types_id, user_types_code FROM delevery_user_types ORDER BY user_types_id`
      );
      const extra = {};
      /* Ville de fonction des comptes d'accès (référentiel = delevery_tarifs). */
      const [villes] = await pool.query(
        `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
      );
      extra.villes = villes;
      if (scope !== 'livreurs') {
        extra.typesContrat = TYPES_CONTRAT;
      }
      if (scope === 'livreurs') {
        const [zones] = await pool.query(
          `SELECT zone_id, zone_name FROM delevery_zone ORDER BY zone_name`
        );
        const [formes] = await pool.query(
          `SELECT DISTINCT users_forme_juridique AS forme_juridique FROM delevery_users
            WHERE users_forme_juridique IS NOT NULL AND TRIM(users_forme_juridique) <> ''
            ORDER BY users_forme_juridique`
        );
        extra.zones = zones;
        extra.formes = formes.map((f) => f.forme_juridique);
      }
      res.json({ agences, types, ...extra });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * PATCH /api/users/:id/active et /api/livreurs/:id/active — active/désactive un compte
 * (body { active: 0|1 }). Chaque page ne peut modifier que les comptes de son périmètre.
 */
function setActive(scope) {
  return async function (req, res, next) {
    try {
      const id = parseInt(req.params.id, 10);
      const active = Number(req.body?.active);
      if (!Number.isInteger(id) || ![0, 1].includes(active)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      if (id === Number(req.user.id)) {
        return res.status(400).json({ message: 'Impossible de désactiver votre propre compte.' });
      }

      const [result] = await pool.query(
        `UPDATE delevery_users u
           SET u.users_active = ?
         WHERE u.users_id = ? AND ${SCOPE_SQL[scope]}`,
        [active, id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Utilisateur introuvable.' });
      }
      res.json({ users_id: id, users_active: active });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * POST /api/users et /api/livreurs — crée un compte principal (modales
 * "Nouvel utilisateur" / "Nouveau livreur").
 * Body : users_name, users_cin, users_type (1-6, utilisateurs uniquement),
 * users_ville_id (delevery_tarifs), users_email, users_phone, password.
 * Le login matche users_email OU users_phone : au moins un des deux est requis
 * et chacun doit être libre sur toute la table.
 * users_services = menus par défaut de la fonction (utils/typeServices).
 * Statut personnel (users_is_salarie, documents suivis par la liste) :
 * utilisateur = 1 (salarié) ; livreur = 0 (auto-entrepreneur), avec la fonction
 * forcée à 5 pour que le compte relève du périmètre de la page (voir SCOPE_SQL).
 */
function createUser(scope) {
  return async function (req, res, next) {
    try {
      const isLivreurs = scope === 'livreurs';
      const body = req.body || {};
      const name = String(body.users_name || '').trim();
      const cin = String(body.users_cin || '').trim();
      const type = isLivreurs ? 5 : parseInt(body.users_type, 10);
      const villeRaw = String(body.users_ville_id ?? '').trim();
      const villeId = villeRaw ? parseInt(villeRaw, 10) : null;
      const email = String(body.users_email || '').trim();
      const phone = String(body.users_phone || '').trim();
      const password = String(body.password || '');

      if (!name) return res.status(400).json({ message: 'Le nom complet est obligatoire.' });
      if (name.length > 250) return res.status(400).json({ message: 'Nom trop long (max 250 caractères).' });
      if (cin.length > 50) return res.status(400).json({ message: 'CIN trop long (max 50 caractères).' });
      if (!Number.isInteger(type) || type < 1 || type > 6) {
        return res.status(400).json({ message: 'Fonction invalide.' });
      }
      if (villeRaw && !Number.isInteger(villeId)) {
        return res.status(400).json({ message: 'Ville de fonction invalide.' });
      }
      if (!email) {
        return res.status(400).json({ message: 'Un email est obligatoire pour se connecter.' });
      }
      if (email.length > 250 || !EMAIL_RE.test(email)) {
        return res.status(400).json({ message: 'Adresse email invalide.' });
      }
      if (phone.length > 50) return res.status(400).json({ message: 'Téléphone trop long (max 50 caractères).' });
      if (password.length < 8) {
        return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
      }

      /* Seul l'email est identifiant de connexion : il doit être unique.
         Le téléphone peut être partagé entre plusieurs comptes. */
      const [[dup]] = await pool.query(
        `SELECT users_id FROM delevery_users WHERE LOWER(users_email) = LOWER(?) LIMIT 1`,
        [email]
      );
      if (dup) {
        return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
      }

      const [result] = await pool.query(
        `INSERT INTO delevery_users
           (users_name, users_cin, users_type, users_ville_id, users_agence_id, users_email,
            users_phone, users_password, users_active, users_services, users_is_salarie)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          name,
          cin || null,
          type,
          villeId,
          /* Agence dérivée de la ville de fonction (users_agence_id = miroir legacy). */
          await agenceIdFromVille(villeId),
          email || null,
          phone || null,
          await hashPassword(password),
          computeServices(type),
          isLivreurs ? 0 : 1
        ]
      );
      res.status(201).json({ users_id: result.insertId });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { listUsers, exportPaie, listFiltres, setActive, createUser };
