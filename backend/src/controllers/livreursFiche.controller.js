const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { hashPassword } = require('../utils/password');
const { agenceIdFromVille } = require('../utils/agenceScope');

/*
 * Fiche livreur (page /admin/livreurs/:id) — calquée sur la fiche utilisateur.
 * Périmètre = page Livreurs : livreurs auto-entrepreneurs uniquement
 * (même règle que users.controller SCOPE_SQL.livreurs).
 *  - Onglet "Compte" : users_email / users_phone / users_password (section
 *    connexion) + tarifs par ville sur delevery_livreur_tarifs (section tarifs,
 *    sql/2026-08-19_fiche-livreur.sql) ; le bouton Appliquer enregistre aussi
 *    la ville de fonction (users_ville_id). La liste renvoie toutes les villes
 *    actives de la zone de fonction (même sans tarif) : une ville créée après
 *    coup se tarife seule (POST /tarifs) sans réécrire les autres tarifs.
 *  - Onglet "Infos personnelles" : colonnes delevery_users réutilisées
 *    (identité, adresse, forme juridique, fichiers AE/contrat/RIB pro) +
 *    colonnes société ajoutées (users_ice, users_rc, users_rc_fichier,
 *    users_societe_email, users_siege_social, users_ae_numero,
 *    users_ae_carte_expiration, users_garanties_fichier).
 */

const SCOPE_LIVREURS_SQL = 'u.users_parent_id IS NULL AND u.users_type = 5 AND u.users_is_salarie = 0';

/* Périmètre « Ma fiche » livreur : tout compte connecté de fonction Livreur —
 * AE, salarié ou compte secondaire (tous atterrissent sur le dashboard livreur). */
const SCOPE_LIVREUR_CONNECTE_SQL = 'u.users_type = 5';

/* Les fichiers vont dans uploads/users (mêmes colonnes que la fiche utilisateur). */
const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'users');

/* Fichiers de la fiche : champ multipart → colonne delevery_users.
 * rib → users_pro_rib_fichier : colonne suivie par "Doc manquants" pour les AE. */
const FILE_FIELDS = {
  cin_recto: 'users_cin_recto_image',
  cin_verso: 'users_cin_verso_image',
  rc: 'users_rc_fichier',
  ae_carte: 'users_ae_carte_fichier',
  rib: 'users_pro_rib_fichier',
  contrat: 'users_contrat_fichier',
  garanties: 'users_garanties_fichier'
};

/* Champs texte : nom multipart → [colonne, longueur max]. */
const TEXT_FIELDS = {
  users_name: ['users_name', 250],
  users_cin: ['users_cin', 25],
  users_address: ['users_address', 250],
  users_forme_juridique: ['users_forme_juridique', 50],
  users_ice: ['users_ice', 50],
  users_rc: ['users_rc', 50],
  users_societe_email: ['users_societe_email', 250],
  users_siege_social: ['users_siege_social', 250],
  users_ae_numero: ['users_ae_numero', 100],
  users_rib: ['users_rib', 25]
};

const DATE_FIELDS = ['users_date_naissance', 'users_ae_carte_expiration'];
const INT_FIELDS = ['users_city', 'users_bank'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/** Date (objet Date mysql2) → 'AAAA-MM-JJ' en heure locale. */
function toDateStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Datetime → 'AAAA-MM-JJ HH:MM:SS' en heure locale. */
function toDateTimeStr(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function fetchFiche(id, scopeSql = SCOPE_LIVREURS_SQL) {
  const [rows] = await pool.query(
    `SELECT u.users_id, u.users_name, u.users_email, u.users_pic, u.users_active,
            u.users_phone, u.users_ville_id,
            u.users_cin, u.users_date_naissance,
            u.users_cin_recto_image, u.users_cin_verso_image,
            u.users_city, u.users_address,
            u.users_forme_juridique, u.users_ice, u.users_rc, u.users_rc_fichier,
            u.users_societe_email, u.users_siege_social,
            u.users_ae_numero, u.users_ae_carte_expiration, u.users_ae_carte_fichier,
            u.users_bank, u.users_rib, u.users_pro_rib_fichier,
            u.users_contrat_fichier, u.users_garanties_fichier,
            u.users_fiche_updated_at,
            vf.nom_ville AS ville_fonction,
            vz.zone_name AS zone,
            a.agence_name AS agence
       FROM delevery_users u
       LEFT JOIN delevery_tarifs vf ON vf.ville_id = u.users_ville_id
       LEFT JOIN delevery_zone vz   ON vz.zone_id = vf.zone
       LEFT JOIN delevery_agences a ON a.agence_id = COALESCE(vz.zone_agence_id, u.users_agence_id)
      WHERE u.users_id = ? AND ${scopeSql}`,
    [id]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    users_id: r.users_id,
    users_name: r.users_name,
    users_email: r.users_email,
    users_pic: r.users_pic,
    users_active: r.users_active,
    users_phone: r.users_phone,
    users_ville_id: r.users_ville_id,
    ville_fonction: r.ville_fonction,
    zone: r.zone,
    agence: r.agence,
    users_cin: r.users_cin,
    users_date_naissance: toDateStr(r.users_date_naissance),
    users_cin_recto_image: r.users_cin_recto_image,
    users_cin_verso_image: r.users_cin_verso_image,
    users_city: r.users_city,
    users_address: r.users_address,
    users_forme_juridique: r.users_forme_juridique,
    users_ice: r.users_ice,
    users_rc: r.users_rc,
    users_rc_fichier: r.users_rc_fichier,
    users_societe_email: r.users_societe_email,
    users_siege_social: r.users_siege_social,
    users_ae_numero: r.users_ae_numero,
    users_ae_carte_expiration: toDateStr(r.users_ae_carte_expiration),
    users_ae_carte_fichier: r.users_ae_carte_fichier,
    users_bank: r.users_bank,
    users_rib: r.users_rib,
    users_pro_rib_fichier: r.users_pro_rib_fichier,
    users_contrat_fichier: r.users_contrat_fichier,
    users_garanties_fichier: r.users_garanties_fichier,
    users_fiche_updated_at: toDateTimeStr(r.users_fiche_updated_at)
  };
}

async function handleGetFiche(req, res, next, scopeSql) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id, scopeSql);
    if (!fiche) return res.status(404).json({ message: 'Livreur introuvable.' });
    res.json(fiche);
  } catch (err) {
    next(err);
  }
}

/** GET /api/livreurs/:id — fiche complète d'un livreur (périmètre page Livreurs). */
const getFiche = (req, res, next) => handleGetFiche(req, res, next, SCOPE_LIVREURS_SQL);

/** GET /api/livreurs/me — fiche du livreur connecté (« Ma fiche », tout compte livreur). */
const getFicheSelf = (req, res, next) => handleGetFiche(req, res, next, SCOPE_LIVREUR_CONNECTE_SQL);

/**
 * GET /api/livreurs/fiche/options — listes du formulaire :
 *  - villes  : delevery_tarifs (référentiel des villes) ;
 *  - formes  : delevery_configs (configs_var = 'ws_config_companies_type',
 *              actives — section "Formes juridiques" de la page Options) ;
 *  - banques : delevery_configs (configs_var = 'ws_config_banks_name', actives).
 */
async function getFicheOptions(req, res, next) {
  try {
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    const [formes] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs
        WHERE configs_var = 'ws_config_companies_type' AND configs_active = 1
        ORDER BY configs_val`
    );
    const [banques] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs
        WHERE configs_var = 'ws_config_banks_name' AND configs_active = 1
        ORDER BY configs_val`
    );
    res.json({
      villes: villes.map((v) => ({ id: v.ville_id, nom: v.nom_ville })),
      formes: formes.map((f) => ({ id: f.configs_id, val: f.configs_val })),
      banques: banques.map((b) => ({ id: b.configs_id, nom: b.configs_val }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * L'email de connexion doit être libre sur toute la table (le login se fait
 * par email uniquement ; le téléphone peut être partagé entre comptes).
 */
async function emailPris(email, excludeId) {
  if (!email) return false;
  const [[dup]] = await pool.query(
    `SELECT users_id FROM delevery_users
      WHERE users_id <> ? AND LOWER(users_email) = LOWER(?)
      LIMIT 1`,
    [excludeId, email]
  );
  return Boolean(dup);
}

async function handleUpdateCompte(req, res, next, scopeSql) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const current = await fetchFiche(id, scopeSql);
    if (!current) return res.status(404).json({ message: 'Livreur introuvable.' });

    const email = String(req.body?.users_email || '').trim();
    const phone = String(req.body?.users_phone || '').trim();
    const password = String(req.body?.password || '');

    if (!email) {
      return res.status(400).json({ message: 'Un email est obligatoire pour se connecter.' });
    }
    if (email.length > 250 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    if (phone.length > 50) {
      return res.status(400).json({ message: 'Téléphone trop long (max 50 caractères).' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(email, id)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const sets = ['users_email = ?', 'users_phone = ?'];
    const params = [email || null, phone || null];
    if (password) {
      sets.push('users_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(`UPDATE delevery_users SET ${sets.join(', ')} WHERE users_id = ?`, [...params, id]);
    res.json(await fetchFiche(id, scopeSql));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/livreurs/:id/compte — section "Informations de connexion" :
 * { users_email, users_phone, password? } (mot de passe vide = inchangé).
 */
const updateCompte = (req, res, next) => handleUpdateCompte(req, res, next, SCOPE_LIVREURS_SQL);

/** PUT /api/livreurs/me/compte — le livreur connecté modifie SES identifiants. */
const updateCompteSelf = (req, res, next) =>
  handleUpdateCompte(req, res, next, SCOPE_LIVREUR_CONNECTE_SQL);

/** Supprime un fichier précédemment uploadé par la fiche (jamais les fichiers legacy). */
function removeOldUpload(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/users/')) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(value));
  fs.unlink(filePath, () => {});
}

/**
 * PUT /api/livreurs/:id/fiche — enregistre l'onglet "Infos personnelles"
 * (multipart/form-data : champs texte + fichiers, voir FILE_FIELDS).
 * Un fichier envoyé remplace l'ancien ; les champs texte absents du corps
 * ne sont pas modifiés, une chaîne vide efface la valeur (NULL).
 */
async function updateFiche(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });

    const current = await fetchFiche(id);
    if (!current) return res.status(404).json({ message: 'Livreur introuvable.' });

    const body = req.body || {};
    const sets = [];
    const params = [];

    for (const [field, [column, maxLen]] of Object.entries(TEXT_FIELDS)) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim().slice(0, maxLen);
      if ((field === 'users_name' || field === 'users_cin') && !value) {
        return res.status(400).json({ message: 'Le nom complet et le CIN sont obligatoires.' });
      }
      if (field === 'users_societe_email' && value && !EMAIL_RE.test(value)) {
        return res.status(400).json({ message: 'Adresse email de la société invalide.' });
      }
      sets.push(`${column} = ?`);
      params.push(value || null);
    }

    for (const field of DATE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim();
      if (value && !DATE_RE.test(value)) {
        return res.status(400).json({ message: 'Format de date invalide (AAAA-MM-JJ attendu).' });
      }
      sets.push(`${field} = ?`);
      params.push(value || null);
    }

    for (const field of INT_FIELDS) {
      if (body[field] === undefined) continue;
      const raw = String(body[field]).trim();
      const value = parseInt(raw, 10);
      if (raw && !Number.isInteger(value)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      sets.push(`${field} = ?`);
      params.push(raw ? value : null);
    }

    for (const [field, column] of Object.entries(FILE_FIELDS)) {
      const file = req.files?.[field]?.[0];
      if (!file) continue;
      removeOldUpload(current[column]);
      sets.push(`${column} = ?`);
      params.push(`/uploads/users/${file.filename}`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: 'Aucune modification envoyée.' });
    }
    sets.push('users_fiche_updated_at = NOW()');

    await pool.query(`UPDATE delevery_users SET ${sets.join(', ')} WHERE users_id = ?`, [...params, id]);
    res.json(await fetchFiche(id));
  } catch (err) {
    next(err);
  }
}

/**
 * Tarifs du livreur (une ligne par ville), groupés par zone puis ville :
 *  - toutes les villes ayant déjà un tarif (quelle que soit la zone) ;
 *  - PLUS toutes les villes actives de la zone de sa ville de fonction, même
 *    sans tarif (id / frais à null) — une ville créée après « Appliquer »
 *    apparaît ainsi dans la liste et se tarife individuellement sans réécrire
 *    les tarifs des autres villes.
 */
async function fetchTarifs(livreurId) {
  const [[zoneRow]] = await pool.query(
    `SELECT vf.zone
       FROM delevery_users u
       LEFT JOIN delevery_tarifs vf ON vf.ville_id = u.users_ville_id
      WHERE u.users_id = ?`,
    [livreurId]
  );
  const zoneId = zoneRow?.zone ?? null;
  const [rows] = await pool.query(
    `SELECT lt.livreur_tarif_id AS id,
            v.ville_id          AS villeId,
            v.nom_ville         AS ville,
            z.zone_name         AS zone,
            lt.frais_livraison  AS fraisLivraison,
            lt.frais_refuse     AS fraisRefuse
       FROM delevery_tarifs v
       LEFT JOIN delevery_livreur_tarifs lt
              ON lt.livreur_tarif_ville_id = v.ville_id AND lt.livreur_tarif_users_id = ?
       LEFT JOIN delevery_zone z ON z.zone_id = v.zone
      WHERE lt.livreur_tarif_id IS NOT NULL
         ${zoneId != null ? 'OR (v.zone = ? AND v.statut = 1)' : ''}
      ORDER BY z.zone_name, v.nom_ville`,
    zoneId != null ? [livreurId, zoneId] : [livreurId]
  );
  return rows;
}

/** Parse un montant de frais ; renvoie null et répond en cas d'erreur (0 est valide). */
function parseFrais(value, label, res) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) {
    res.status(400).json({ message: `${label} invalide (montant positif attendu).` });
    return null;
  }
  return Math.round(n * 100) / 100;
}

/** GET /api/livreurs/:id/tarifs — tarifs par ville du livreur. */
async function listTarifs(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Livreur introuvable.' });
    res.json({ tarifs: await fetchTarifs(id) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/livreurs/:id/tarifs/appliquer — { villeId, fraisLivraison, fraisRefuse, conserver }.
 * Enregistre la ville comme ville de fonction du livreur (users_ville_id) puis
 * applique les frais à TOUTES les villes actives de la zone de cette ville
 * (les tarifs des autres zones sont conservés). `conserver` (défaut true) :
 * seules les villes SANS tarif sont renseignées, les tarifs existants restent
 * intacts ; `conserver: false` = ancien comportement, tout est réécrit.
 */
async function appliquerTarifs(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Livreur introuvable.' });

    const villeId = parseInt(req.body?.villeId, 10);
    if (!Number.isInteger(villeId)) {
      return res.status(400).json({ message: 'Veuillez sélectionner une ville de fonction.' });
    }
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;
    const conserver = req.body?.conserver !== false && req.body?.conserver !== 'false' && req.body?.conserver !== 0;

    const [[ville]] = await pool.query(
      `SELECT ville_id, zone FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
      [villeId]
    );
    if (!ville) return res.status(400).json({ message: 'Ville introuvable.' });

    /* Villes actives de la zone + la ville choisie elle-même (zone NULL incluse).
       conserver → mise à jour neutre sur les lignes existantes (aucune écrasée). */
    await pool.query(
      `INSERT INTO delevery_livreur_tarifs
         (livreur_tarif_users_id, livreur_tarif_ville_id, frais_livraison, frais_refuse)
       SELECT ?, ville_id, ?, ?
         FROM delevery_tarifs
        WHERE ville_id = ? ${ville.zone != null ? 'OR (zone = ? AND statut = 1)' : ''}
       ON DUPLICATE KEY UPDATE
         ${conserver
           ? 'frais_livraison = frais_livraison, frais_refuse = frais_refuse'
           : 'frais_livraison = VALUES(frais_livraison), frais_refuse = VALUES(frais_refuse)'}`,
      ville.zone != null
        ? [id, fraisLivraison, fraisRefuse, villeId, ville.zone]
        : [id, fraisLivraison, fraisRefuse, villeId]
    );
    /* Agence dérivée de la nouvelle ville de fonction (users_agence_id = miroir legacy). */
    await pool.query(`UPDATE delevery_users SET users_ville_id = ?, users_agence_id = ? WHERE users_id = ?`, [
      villeId,
      await agenceIdFromVille(villeId),
      id
    ]);

    // Zone et agence dérivées de la nouvelle ville de fonction (en-tête de fiche).
    const maj = await fetchFiche(id);
    res.json({
      users_ville_id: villeId,
      ville_fonction: maj.ville_fonction,
      zone: maj.zone,
      agence: maj.agence,
      tarifs: await fetchTarifs(id)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/livreurs/:id/tarifs — { villeId, fraisLivraison, fraisRefuse }.
 * Tarife UNE ville (typiquement une ville créée après « Appliquer », listée
 * sans tarif) sans toucher aux autres villes ni à la ville de fonction.
 * Insertion ou mise à jour si la ville était déjà tarifée.
 */
async function createTarif(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Livreur introuvable.' });

    const villeId = parseInt(req.body?.villeId, 10);
    if (!Number.isInteger(villeId)) {
      return res.status(400).json({ message: 'Ville invalide.' });
    }
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;

    const [[ville]] = await pool.query(
      `SELECT ville_id FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
      [villeId]
    );
    if (!ville) return res.status(400).json({ message: 'Ville introuvable.' });

    await pool.query(
      `INSERT INTO delevery_livreur_tarifs
         (livreur_tarif_users_id, livreur_tarif_ville_id, frais_livraison, frais_refuse)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         frais_livraison = VALUES(frais_livraison),
         frais_refuse = VALUES(frais_refuse)`,
      [id, villeId, fraisLivraison, fraisRefuse]
    );
    const tarifs = await fetchTarifs(id);
    res.status(201).json(tarifs.find((t) => t.villeId === villeId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/livreurs/:id/tarifs/:tarifId — { fraisLivraison, fraisRefuse }. */
async function updateTarif(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const tarifId = parseInt(req.params.tarifId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(tarifId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;

    const [result] = await pool.query(
      `UPDATE delevery_livreur_tarifs
          SET frais_livraison = ?, frais_refuse = ?
        WHERE livreur_tarif_id = ? AND livreur_tarif_users_id = ?`,
      [fraisLivraison, fraisRefuse, tarifId, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    const tarifs = await fetchTarifs(id);
    res.json(tarifs.find((t) => t.id === tarifId));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/livreurs/:id/tarifs/:tarifId — supprime le tarif d'une ville. */
async function deleteTarif(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const tarifId = parseInt(req.params.tarifId, 10);
    if (!Number.isInteger(id) || !Number.isInteger(tarifId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const [result] = await pool.query(
      `DELETE FROM delevery_livreur_tarifs
        WHERE livreur_tarif_id = ? AND livreur_tarif_users_id = ?`,
      [tarifId, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    res.json({ id: tarifId });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getFiche,
  getFicheSelf,
  getFicheOptions,
  updateCompte,
  updateCompteSelf,
  updateFiche,
  listTarifs,
  appliquerTarifs,
  createTarif,
  updateTarif,
  deleteTarif,
  ensureUploadDir,
  FILE_FIELDS
};
