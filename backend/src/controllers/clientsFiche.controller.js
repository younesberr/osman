const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const UPLOADS_ROOT = require('../config/uploadsRoot');
const { hashPassword } = require('../utils/password');
const { getAgenceScope, clientDansAgence } = require('../utils/agenceScope');

/*
 * Fiche client (page /admin/clients/:id) — calquée sur la fiche livreur.
 *  - Onglet "Compte et tarifs" : email / mot de passe (customers_email,
 *    customers_password), facturation (colonnes sql/2026-08-19_fiche-client.sql),
 *    ville de ramassage (customers_pickup_city) + tarifs personnalisés :
 *    table legacy delevery_customer_tarifs (une ligne par ville, montants INT)
 *    et ligne "Autre" (villes non personnalisées) sur customers_delivered_price /
 *    customers_returned_price / customers_refused_price.
 *  - Onglet "Informations" : colonnes delevery_customers réutilisées (identité,
 *    magasin, banque, fichiers CIN/RIB/contrat) + colonnes ajoutées (date de
 *    naissance, localisation, champs société / auto-entrepreneur).
 * customers_company_type et customers_bank stockent le configs_id
 * (delevery_configs) en varchar — règle legacy conservée.
 */

const UPLOAD_DIR = path.join(UPLOADS_ROOT, 'customers');

/* Fichiers de la fiche : champ multipart → colonne delevery_customers.
 * "logo" accepte une image, les autres champs un PDF (voir clients.routes.js). */
const FILE_FIELDS = {
  logo: 'customers_logo',
  cin_recto: 'customers_cin_recto_image',
  cin_verso: 'customers_cin_verso_image',
  rib: 'customers_rib_image',
  contrat: 'customers_contrat_photo',
  rc: 'customers_rc_fichier',
  ae_carte: 'customers_ae_carte_fichier'
};
const IMAGE_FIELDS = ['logo'];

/* Champs texte de l'onglet "Informations" : nom multipart → [colonne, longueur max]. */
const TEXT_FIELDS = {
  customers_name: ['customers_name', 100],
  customers_cin: ['customers_cin', 100],
  customers_phone_personal: ['customers_phone_personal', 50],
  customers_store: ['customers_store', 100],
  customers_phone: ['customers_phone', 50],
  customers_address: ['customers_address', 250],
  customers_pickup_location: ['customers_pickup_location', 255],
  customers_website: ['customers_website', 50],
  customers_company_type: ['customers_company_type', 50],
  customers_ice: ['customers_ice', 50],
  customers_rc: ['customers_rc', 50],
  customers_societe_email: ['customers_societe_email', 250],
  customers_siege_social: ['customers_siege_social', 250],
  customers_ae_numero: ['customers_ae_numero', 100],
  customers_bank: ['customers_bank', 255],
  customers_rib: ['customers_rib', 50]
};

const DATE_FIELDS = ['customers_date_naissance', 'customers_ae_carte_expiration'];

const PERIODES = ['annuelle', 'trimestrielle', 'mensuelle', 'hebdomadaire', 'jours'];
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];
/* Jours de ramassage périodique : la facturation s'arrête au vendredi mais le
 * ramassage se fait aussi le samedi (customers_ramassage_jours,
 * sql/2026-08-26_ramassage-periodicite.sql — demande automatique à 12h00). */
const JOURS_RAMASSAGE = [...JOURS, 'samedi'];

const PERIODE_LABELS = {
  annuelle: 'Annuelle',
  trimestrielle: 'Trimestrielle',
  mensuelle: 'Mensuelle',
  hebdomadaire: 'Hebdomadaire',
  jours: 'Par jour'
};

/* Libellés du détail ancien → nouveau des demandes de modification
 * (delevery_client_fiche_demande) : champs texte / date puis fichiers. */
const INFO_LABELS = {
  customers_name: 'Nom complet',
  customers_cin: 'CIN',
  customers_date_naissance: 'Date de naissance',
  customers_phone_personal: 'N° téléphone personnel',
  customers_store: 'Nom du magasin',
  customers_phone: 'N° téléphone magasin',
  customers_address: 'Adresse de ramassage',
  customers_pickup_location: 'Localisation',
  customers_website: 'Site web',
  customers_company_type: 'Forme juridique',
  customers_ice: 'ICE',
  customers_rc: 'RC',
  customers_societe_email: 'Email société',
  customers_siege_social: 'Siège social',
  customers_ae_numero: "N° d'inscription AE",
  customers_ae_carte_expiration: "Date d'expiration carte AE",
  customers_bank: 'Banque',
  customers_rib: 'RIB',
  logo: 'Logo du brand',
  cin_recto: 'Fichier CIN — recto',
  cin_verso: 'Fichier CIN — verso',
  rib: 'Fichier RIB',
  contrat: 'Contrat',
  rc: 'Fichier RC',
  ae_carte: 'Carte AE'
};

/** Périodicité + jours → libellé lisible : « Par jour (lundi, mardi) ». */
function periodeLabel(periode, jours) {
  if (!periode) return '—';
  const base = PERIODE_LABELS[periode] || periode;
  const js = (jours || []).filter((j) => JOURS.includes(j));
  return js.length ? `${base} (${js.join(', ')})` : base;
}

/** Jours de ramassage périodique → libellé lisible : « lundi, samedi ». */
function ramassageLabel(jours) {
  const js = (jours || []).filter((j) => JOURS_RAMASSAGE.includes(j));
  return js.length ? js.join(', ') : 'Aucun jour (désactivé)';
}

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

/**
 * Jours de ramassage périodique du client (customers_ramassage_jours).
 * [] si la colonne n'est pas encore migrée : la fiche reste consultable.
 */
async function fetchRamassageJours(id) {
  try {
    const [[row]] = await pool.query(
      `SELECT customers_ramassage_jours AS jours FROM delevery_customers
        WHERE customers_id = ? LIMIT 1`,
      [id]
    );
    return row?.jours
      ? String(row.jours).split(',').filter((j) => JOURS_RAMASSAGE.includes(j))
      : [];
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return [];
    throw err;
  }
}

/**
 * Heure de ramassage préférée du client (customers_ramassage_heure,
 * sql/2026-08-27_ramassage-heure.sql), au format 'HH:MM'.
 * '' si non fixée ou si la colonne n'est pas encore migrée.
 */
async function fetchRamassageHeure(id) {
  try {
    const [[row]] = await pool.query(
      `SELECT customers_ramassage_heure AS heure FROM delevery_customers
        WHERE customers_id = ? LIMIT 1`,
      [id]
    );
    return row?.heure ? String(row.heure).slice(0, 5) : '';
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return '';
    throw err;
  }
}

async function fetchFiche(id) {
  const [rows] = await pool.query(
    `SELECT customers_id, customers_name, customers_cin, customers_date_naissance,
            customers_store, customers_logo, customers_phone, customers_phone_personal,
            customers_email, customers_address, customers_website,
            customers_company_type, customers_ice, customers_rc, customers_rc_fichier,
            customers_societe_email, customers_siege_social,
            customers_ae_numero, customers_ae_carte_expiration, customers_ae_carte_fichier,
            customers_bank, customers_rib, customers_rib_image,
            customers_cin_recto_image, customers_cin_verso_image, customers_contrat_photo,
            customers_pickup_city, customers_pickup_location,
            IFNULL(customers_custom_tarif, 0) AS customers_custom_tarif,
            customers_facturation_periode, customers_facturation_jours,
            customers_active, customers_verified, customers_fiche_updated_at,
            t.nom_ville AS ville_ramassage,
            z.zone_name AS zone,
            ag.agence_name AS agence
       FROM delevery_customers
       LEFT JOIN delevery_tarifs t   ON t.ville_id = customers_pickup_city
       LEFT JOIN delevery_zone z     ON z.zone_id = t.zone
       LEFT JOIN delevery_agences ag ON ag.agence_id = z.zone_agence_id
      WHERE customers_id = ?`,
    [id]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    customers_id: r.customers_id,
    customers_name: r.customers_name,
    customers_cin: r.customers_cin,
    customers_date_naissance: toDateStr(r.customers_date_naissance),
    customers_store: r.customers_store,
    customers_logo: r.customers_logo,
    customers_phone: r.customers_phone,
    customers_phone_personal: r.customers_phone_personal,
    customers_email: r.customers_email,
    customers_address: r.customers_address,
    customers_website: r.customers_website,
    customers_company_type: r.customers_company_type,
    customers_ice: r.customers_ice,
    customers_rc: r.customers_rc,
    customers_rc_fichier: r.customers_rc_fichier,
    customers_societe_email: r.customers_societe_email,
    customers_siege_social: r.customers_siege_social,
    customers_ae_numero: r.customers_ae_numero,
    customers_ae_carte_expiration: toDateStr(r.customers_ae_carte_expiration),
    customers_ae_carte_fichier: r.customers_ae_carte_fichier,
    customers_bank: r.customers_bank,
    customers_rib: r.customers_rib,
    customers_rib_image: r.customers_rib_image,
    customers_cin_recto_image: r.customers_cin_recto_image,
    customers_cin_verso_image: r.customers_cin_verso_image,
    customers_contrat_photo: r.customers_contrat_photo,
    customers_pickup_city: r.customers_pickup_city,
    ville_ramassage: r.ville_ramassage,
    zone: r.zone,
    agence: r.agence,
    customers_pickup_location: r.customers_pickup_location,
    customers_custom_tarif: Number(r.customers_custom_tarif) === 1 ? 1 : 0,
    facturation_periode: r.customers_facturation_periode || '',
    facturation_jours: r.customers_facturation_jours
      ? String(r.customers_facturation_jours).split(',').filter((j) => JOURS.includes(j))
      : [],
    ramassage_jours: await fetchRamassageJours(id),
    ramassage_heure: await fetchRamassageHeure(id),
    customers_active: r.customers_active,
    customers_verified: r.customers_verified,
    customers_fiche_updated_at: toDateTimeStr(r.customers_fiche_updated_at)
  };
}

/**
 * Demandes de modification en attente du client (« Ma fiche » →
 * delevery_client_fiche_demande, sql/2026-08-26_demandes-fiche-client.sql).
 * [] si la table n'est pas encore migrée : la fiche reste consultable.
 */
async function fetchDemandes(clientId) {
  try {
    const [rows] = await pool.query(
      `SELECT cfd_id AS id, cfd_type AS type, cfd_payload AS payload,
              cfd_changes AS changes, cfd_time AS time
         FROM delevery_client_fiche_demande
        WHERE cfd_customer = ? AND cfd_statut = 'PENDING'
        ORDER BY cfd_id`,
      [clientId]
    );
    return rows.map((r) => {
      let payload;
      let changes;
      try {
        payload = JSON.parse(r.payload) || {};
      } catch {
        payload = {};
      }
      try {
        changes = JSON.parse(r.changes) || [];
      } catch {
        changes = [];
      }
      return { id: r.id, type: r.type, payload, changes, time: r.time };
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return [];
    throw err;
  }
}

/** Fiche + demandes en attente (affichées côté client et côté admin). */
async function ficheAvecDemandes(id) {
  const fiche = await fetchFiche(id);
  if (!fiche) return null;
  fiche.demandes = await fetchDemandes(id);
  return fiche;
}

/** Supprime les fichiers uploadés d'une demande INFOS jamais appliquée. */
function removeDemandeFiles(payload) {
  for (const p of Object.values(payload?.files || {})) removeOldUpload(p);
}

/** Vrai si l'employé est restreint par agence et que le client n'en fait pas partie. */
async function clientHorsAgence(req, clientId) {
  const agenceScope = await getAgenceScope(req.user);
  return agenceScope !== null && !(await clientDansAgence(clientId, agenceScope));
}

/** Charge la fiche en respectant le périmètre agence ; répond 400/404 si invalide. */
async function ficheAutorisee(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: 'Requête invalide.' });
    return null;
  }
  if (await clientHorsAgence(req, id)) {
    res.status(404).json({ message: 'Client introuvable.' });
    return null;
  }
  const fiche = await fetchFiche(id);
  if (!fiche) {
    res.status(404).json({ message: 'Client introuvable.' });
    return null;
  }
  return fiche;
}

/** GET /api/clients/:id — fiche complète d'un client. */
async function getFiche(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    fiche.demandes = await fetchDemandes(fiche.customers_id);
    res.json(fiche);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/clients/fiche/options — listes du formulaire :
 *  - villes          : delevery_tarifs (référentiel des villes / tarifs personnalisés) ;
 *  - villesRamassage : villes de ramassage distinctes de la matrice tarifaire
 *                      (delevery_tarifs_matrix.pickup_ville_id) ;
 *  - formes          : delevery_configs 'ws_config_companies_type' actives ;
 *  - banques         : delevery_configs 'ws_config_banks_name' actives.
 */
async function getFicheOptions(req, res, next) {
  try {
    const [villes] = await pool.query(
      `SELECT ville_id, nom_ville FROM delevery_tarifs ORDER BY nom_ville`
    );
    const [villesRamassage] = await pool.query(
      `SELECT DISTINCT m.pickup_ville_id AS ville_id, t.nom_ville
         FROM delevery_tarifs_matrix m
         JOIN delevery_tarifs t ON t.ville_id = m.pickup_ville_id
        ORDER BY t.nom_ville`
    );
    const [configs] = await pool.query(
      `SELECT configs_id, configs_var, configs_val FROM delevery_configs
        WHERE configs_var IN ('ws_config_companies_type', 'ws_config_banks_name')
          AND configs_active = 1
        ORDER BY configs_val`
    );
    res.json({
      villes: villes.map((v) => ({ id: v.ville_id, nom: v.nom_ville })),
      villesRamassage: villesRamassage.map((v) => ({ id: v.ville_id, nom: v.nom_ville })),
      formes: configs
        .filter((c) => c.configs_var === 'ws_config_companies_type')
        .map((c) => ({ id: c.configs_id, val: c.configs_val })),
      banques: configs
        .filter((c) => c.configs_var === 'ws_config_banks_name')
        .map((c) => ({ id: c.configs_id, val: String(c.configs_val || '').trim() }))
    });
  } catch (err) {
    next(err);
  }
}

/** L'email de connexion doit être libre (le login se fait par email uniquement). */
async function emailPris(email, excludeId) {
  const [[dup]] = await pool.query(
    `SELECT customers_id FROM delevery_customers
      WHERE customers_id <> ? AND LOWER(customers_email) = LOWER(?)
      LIMIT 1`,
    [excludeId, email]
  );
  return Boolean(dup);
}

/**
 * PUT /api/clients/:id/compte-tarifs — bouton "Enregistrer" de l'onglet
 * "Compte et tarifs" : { customers_email, password?, ramassage_jours: [],
 * ramassage_heure, facturation_periode, facturation_jours: [], pickup_city,
 * custom_tarif }.
 * Mot de passe vide = inchangé. hebdomadaire → exactement un jour ;
 * jours → au moins un jour (lundi…vendredi) ; sinon jours ignorés.
 * ramassage_jours (lundi…samedi) : jours de la demande de ramassage
 * automatique de 12h00, aucun jour = ramassage périodique désactivé.
 * ramassage_heure ('HH:MM') : heure préférée de passage du ramasseur,
 * affichée sur ses cartes de la page Ramassage ; vide = non fixée.
 */
async function updateCompteTarifs(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const id = fiche.customers_id;

    const email = String(req.body?.customers_email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || email.length > 100 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(email, id)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    const periode = String(req.body?.facturation_periode || '').trim();
    if (periode && !PERIODES.includes(periode)) {
      return res.status(400).json({ message: 'Périodicité de facturation invalide.' });
    }
    let jours = null;
    if (periode === 'hebdomadaire' || periode === 'jours') {
      const envoyes = Array.isArray(req.body?.facturation_jours) ? req.body.facturation_jours : [];
      const valides = JOURS.filter((j) => envoyes.includes(j));
      if (periode === 'hebdomadaire' && valides.length !== 1) {
        return res.status(400).json({ message: 'Veuillez choisir le jour de facturation (lundi à vendredi).' });
      }
      if (periode === 'jours' && valides.length === 0) {
        return res.status(400).json({ message: 'Veuillez choisir au moins un jour de facturation.' });
      }
      jours = valides.join(',');
    }

    // Jours de ramassage périodique (lundi…samedi) ; aucun jour = désactivé.
    const ramassageEnvoyes = Array.isArray(req.body?.ramassage_jours)
      ? req.body.ramassage_jours
      : [];
    const ramassageJours = JOURS_RAMASSAGE.filter((j) => ramassageEnvoyes.includes(j));

    // Heure de ramassage préférée ('HH:MM') ; vide = non fixée.
    const heureBrute = String(req.body?.ramassage_heure || '').trim();
    if (heureBrute && !/^([01]\d|2[0-3]):[0-5]\d$/.test(heureBrute)) {
      return res.status(400).json({ message: 'Heure de ramassage invalide.' });
    }
    const ramassageHeure = heureBrute || null;

    let pickupCity = null;
    if (String(req.body?.pickup_city ?? '').trim() !== '') {
      pickupCity = parseInt(req.body.pickup_city, 10);
      if (!Number.isInteger(pickupCity)) {
        return res.status(400).json({ message: 'Requête invalide.' });
      }
      const [[ville]] = await pool.query(
        `SELECT ville_id FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
        [pickupCity]
      );
      if (!ville) return res.status(400).json({ message: 'Ville de ramassage introuvable.' });
    }

    const customTarif = Number(req.body?.custom_tarif);
    if (![0, 1].includes(customTarif)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }

    const sets = [
      'customers_email = ?',
      'customers_facturation_periode = ?',
      'customers_facturation_jours = ?',
      'customers_pickup_city = ?',
      'customers_custom_tarif = ?'
    ];
    const params = [email, periode || null, jours, pickupCity, customTarif];
    if (password) {
      sets.push('customers_password = ?');
      params.push(await hashPassword(password));
    }
    // Colonnes de ramassage issues de migrations distinctes
    // (sql/2026-08-26_ramassage-periodicite.sql puis
    // sql/2026-08-27_ramassage-heure.sql) : à chaque ER_BAD_FIELD_ERROR on
    // retente sans la colonne la plus récente — le reste de l'onglet est
    // enregistré, les champs non migrés sont ignorés.
    const tentatives = [
      {
        extraSets: ['customers_ramassage_jours = ?', 'customers_ramassage_heure = ?'],
        extraParams: [ramassageJours.join(',') || null, ramassageHeure]
      },
      {
        extraSets: ['customers_ramassage_jours = ?'],
        extraParams: [ramassageJours.join(',') || null]
      },
      { extraSets: [], extraParams: [] }
    ];
    for (let i = 0; i < tentatives.length; i += 1) {
      const { extraSets, extraParams } = tentatives[i];
      try {
        await pool.query(
          `UPDATE delevery_customers
              SET ${[...sets, ...extraSets].join(', ')}
            WHERE customers_id = ?`,
          [...params, ...extraParams, id]
        );
        break;
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR' || i === tentatives.length - 1) throw err;
      }
    }
    res.json(await ficheAvecDemandes(id));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/clients/me/compte — espace client « Ma fiche », onglet Compte :
 * l'email de connexion / le mot de passe sont appliqués immédiatement ; la
 * périodicité de facturation demandée (type FACTURATION) et les jours de
 * ramassage périodique demandés (type RAMASSAGE, ramassage_jours) deviennent
 * des demandes à valider par l'admin (delevery_client_fiche_demande) —
 * resaisir les valeurs actuelles annule la demande en attente. Ville de
 * ramassage et tarifs : jamais modifiables ici (gérés par l'admin,
 * updateCompteTarifs).
 */
async function updateCompteSelf(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Client introuvable.' });

    const email = String(req.body?.customers_email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || email.length > 100 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Adresse email invalide.' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (await emailPris(email, id)) {
      return res.status(409).json({ message: 'Cet email est déjà utilisé par un autre compte.' });
    }

    // Périodicité demandée (vide = facturation non touchée).
    const periode = String(req.body?.facturation_periode || '').trim();
    if (periode && !PERIODES.includes(periode)) {
      return res.status(400).json({ message: 'Périodicité de facturation invalide.' });
    }
    let jours = [];
    if (periode === 'hebdomadaire' || periode === 'jours') {
      const envoyes = Array.isArray(req.body?.facturation_jours) ? req.body.facturation_jours : [];
      jours = JOURS.filter((j) => envoyes.includes(j));
      if (periode === 'hebdomadaire' && jours.length !== 1) {
        return res.status(400).json({ message: 'Veuillez choisir le jour de facturation (lundi à vendredi).' });
      }
      if (periode === 'jours' && jours.length === 0) {
        return res.status(400).json({ message: 'Veuillez choisir au moins un jour de facturation.' });
      }
    }
    const facturationChangee =
      Boolean(periode) &&
      (periode !== fiche.facturation_periode ||
        jours.join(',') !== fiche.facturation_jours.join(','));

    // Jours de ramassage périodique demandés (champ absent = non touché) —
    // filtrés sur la liste canonique : ordre normalisé pour la comparaison.
    const ramassageTouche = Array.isArray(req.body?.ramassage_jours);
    const ramassageJours = ramassageTouche
      ? JOURS_RAMASSAGE.filter((j) => req.body.ramassage_jours.includes(j))
      : [];
    const ramassageChange =
      ramassageTouche && ramassageJours.join(',') !== fiche.ramassage_jours.join(',');

    const demandes = await fetchDemandes(id);
    const demandeEnAttente = demandes.find((d) => d.type === 'FACTURATION');
    const demandeRamassage = demandes.find((d) => d.type === 'RAMASSAGE');

    // Demande enregistrée AVANT l'écriture du compte : si la table des
    // demandes n'est pas migrée, rien n'est appliqué du tout.
    if (facturationChangee) {
      try {
        await pool.query(
          `DELETE FROM delevery_client_fiche_demande
            WHERE cfd_customer = ? AND cfd_type = 'FACTURATION' AND cfd_statut = 'PENDING'`,
          [id]
        );
        await pool.query(
          `INSERT INTO delevery_client_fiche_demande
             (cfd_customer, cfd_type, cfd_payload, cfd_changes, cfd_statut, cfd_time)
           VALUES (?, 'FACTURATION', ?, ?, 'PENDING', ?)`,
          [
            id,
            JSON.stringify({ periode, jours }),
            JSON.stringify([
              {
                field: 'facturation',
                label: 'Périodicité de facturation',
                old: periodeLabel(fiche.facturation_periode, fiche.facturation_jours),
                new: periodeLabel(periode, jours)
              }
            ]),
            Math.floor(Date.now() / 1000)
          ]
        );
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return res.status(503).json({
            message: 'Les demandes de modification ne sont pas encore disponibles. Contactez l’administration.'
          });
        }
        throw err;
      }
    } else if (demandeEnAttente && periode) {
      // Périodicité resaisie identique à l'actuelle : la demande n'a plus d'objet.
      await pool.query(`DELETE FROM delevery_client_fiche_demande WHERE cfd_id = ?`, [
        demandeEnAttente.id
      ]);
    }

    // Même logique pour les jours de ramassage périodique (type RAMASSAGE).
    if (ramassageChange) {
      try {
        await pool.query(
          `DELETE FROM delevery_client_fiche_demande
            WHERE cfd_customer = ? AND cfd_type = 'RAMASSAGE' AND cfd_statut = 'PENDING'`,
          [id]
        );
        await pool.query(
          `INSERT INTO delevery_client_fiche_demande
             (cfd_customer, cfd_type, cfd_payload, cfd_changes, cfd_statut, cfd_time)
           VALUES (?, 'RAMASSAGE', ?, ?, 'PENDING', ?)`,
          [
            id,
            JSON.stringify({ jours: ramassageJours }),
            JSON.stringify([
              {
                field: 'ramassage',
                label: 'Périodicité de ramassage',
                old: ramassageLabel(fiche.ramassage_jours),
                new: ramassageLabel(ramassageJours)
              }
            ]),
            Math.floor(Date.now() / 1000)
          ]
        );
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          return res.status(503).json({
            message: 'Les demandes de modification ne sont pas encore disponibles. Contactez l’administration.'
          });
        }
        throw err;
      }
    } else if (demandeRamassage && ramassageTouche) {
      // Jours resaisis identiques aux actuels : la demande n'a plus d'objet.
      await pool.query(`DELETE FROM delevery_client_fiche_demande WHERE cfd_id = ?`, [
        demandeRamassage.id
      ]);
    }

    const sets = ['customers_email = ?'];
    const params = [email];
    if (password) {
      sets.push('customers_password = ?');
      params.push(await hashPassword(password));
    }
    await pool.query(
      `UPDATE delevery_customers SET ${sets.join(', ')} WHERE customers_id = ?`,
      [...params, id]
    );
    res.json(await ficheAvecDemandes(id));
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/clients/me/fiche — espace client « Ma fiche », onglet Informations :
 * rien n'est appliqué directement. Les champs modifiés (diff avec la fiche
 * actuelle) et les fichiers uploadés sont enregistrés comme demande à valider
 * par l'admin (delevery_client_fiche_demande, type INFOS). Une nouvelle
 * demande remplace la précédente (les fichiers en attente non remplacés sont
 * conservés) ; revenir aux valeurs actuelles annule la demande.
 */
async function demanderFicheSelf(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Requête invalide.' });
    const fiche = await fetchFiche(id);
    if (!fiche) return res.status(404).json({ message: 'Client introuvable.' });

    const body = req.body || {};
    const fields = {}; // champ → nouvelle valeur ('' = effacer)
    const files = {}; // champ fichier → /uploads/customers/…
    const changes = [];

    // Libellés des selects (forme juridique, banque) pour le détail ancien → nouveau.
    const [configs] = await pool.query(
      `SELECT configs_id, configs_val FROM delevery_configs
        WHERE configs_var IN ('ws_config_companies_type', 'ws_config_banks_name')`
    );
    const configLabel = (val, prefix) => {
      if (!val) return '—';
      const c = configs.find((x) => String(x.configs_id) === String(val));
      return c ? String(c.configs_val || '').trim() : `${prefix} n°${val}`;
    };

    for (const [field, [, maxLen]] of Object.entries(TEXT_FIELDS)) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim().slice(0, maxLen);
      if ((field === 'customers_name' || field === 'customers_cin') && !value) {
        return res.status(400).json({ message: 'Le nom complet et le CIN sont obligatoires.' });
      }
      if (field === 'customers_societe_email' && value && !EMAIL_RE.test(value)) {
        return res.status(400).json({ message: 'Adresse email de la société invalide.' });
      }
      const actuel = fiche[field] == null ? '' : String(fiche[field]);
      if (value === actuel) continue;
      fields[field] = value;
      let oldVal = actuel;
      let newVal = value;
      if (field === 'customers_company_type') {
        oldVal = configLabel(actuel, 'Forme');
        newVal = configLabel(value, 'Forme');
      } else if (field === 'customers_bank') {
        oldVal = configLabel(actuel, 'Banque');
        newVal = configLabel(value, 'Banque');
      }
      changes.push({ field, label: INFO_LABELS[field] || field, old: oldVal || '—', new: newVal || '—' });
    }

    for (const field of DATE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim();
      if (value && !DATE_RE.test(value)) {
        return res.status(400).json({ message: 'Format de date invalide (AAAA-MM-JJ attendu).' });
      }
      const actuel = fiche[field] == null ? '' : String(fiche[field]);
      if (value === actuel) continue;
      fields[field] = value;
      changes.push({ field, label: INFO_LABELS[field] || field, old: actuel || '—', new: value || '—' });
    }

    for (const [field, column] of Object.entries(FILE_FIELDS)) {
      const file = req.files?.[field]?.[0];
      if (!file) continue;
      const url = `/uploads/customers/${file.filename}`;
      files[field] = url;
      changes.push({
        field,
        label: INFO_LABELS[field] || field,
        old: fiche[column] ? 'Fichier actuel' : '—',
        new: 'Nouveau fichier',
        file: url
      });
    }

    // Une seule demande INFOS en attente : la nouvelle remplace la précédente.
    // Ses fichiers non remplacés sont repris (les inputs fichier ne peuvent pas
    // être pré-remplis côté navigateur), les remplacés sont supprimés du disque.
    const precedente = (await fetchDemandes(id)).find((d) => d.type === 'INFOS');
    if (precedente) {
      for (const [field, url] of Object.entries(precedente.payload.files || {})) {
        if (files[field]) {
          removeOldUpload(url);
          continue;
        }
        files[field] = url;
        changes.push({
          field,
          label: INFO_LABELS[field] || field,
          old: fiche[FILE_FIELDS[field]] ? 'Fichier actuel' : '—',
          new: 'Nouveau fichier',
          file: url
        });
      }
    }

    if (!changes.length) {
      // Valeurs identiques à la fiche actuelle : plus rien à valider.
      if (precedente) {
        await pool.query(`DELETE FROM delevery_client_fiche_demande WHERE cfd_id = ?`, [precedente.id]);
      }
      return res.json(await ficheAvecDemandes(id));
    }

    try {
      if (precedente) {
        await pool.query(`DELETE FROM delevery_client_fiche_demande WHERE cfd_id = ?`, [precedente.id]);
      }
      await pool.query(
        `INSERT INTO delevery_client_fiche_demande
           (cfd_customer, cfd_type, cfd_payload, cfd_changes, cfd_statut, cfd_time)
         VALUES (?, 'INFOS', ?, ?, 'PENDING', ?)`,
        [id, JSON.stringify({ fields, files }), JSON.stringify(changes), Math.floor(Date.now() / 1000)]
      );
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        // Aucune demande enregistrée : les fichiers tout juste uploadés sont nettoyés.
        removeDemandeFiles({ files });
        return res.status(503).json({
          message: 'Les demandes de modification ne sont pas encore disponibles. Contactez l’administration.'
        });
      }
      throw err;
    }
    res.json(await ficheAvecDemandes(id));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/clients/me/demandes/:type — le client annule sa demande en attente. */
async function annulerDemandeSelf(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const type = String(req.params.type || '').toUpperCase();
    if (!Number.isInteger(id) || !['FACTURATION', 'RAMASSAGE', 'INFOS'].includes(type)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const demande = (await fetchDemandes(id)).find((d) => d.type === type);
    if (demande) {
      if (type === 'INFOS') removeDemandeFiles(demande.payload);
      await pool.query(`DELETE FROM delevery_client_fiche_demande WHERE cfd_id = ?`, [demande.id]);
    }
    res.json(await ficheAvecDemandes(id));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/clients/:id/demandes/:demandeId/accepter — applique la demande du
 * client à sa fiche : FACTURATION → périodicité / jours de facturation ;
 * RAMASSAGE → jours de ramassage périodique (customers_ramassage_jours) ;
 * INFOS → champs + fichiers de l'onglet Informations (mêmes règles que la
 * modification directe par l'admin). Valeurs déjà validées à la création de la
 * demande ; re-vérification minimale par sécurité.
 */
async function accepterDemandeFiche(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const demandeId = parseInt(req.params.demandeId, 10);
    if (!Number.isInteger(demandeId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[demande]] = await conn.query(
        `SELECT cfd_id, cfd_type, cfd_payload FROM delevery_client_fiche_demande
          WHERE cfd_id = ? AND cfd_customer = ? AND cfd_statut = 'PENDING'
          LIMIT 1 FOR UPDATE`,
        [demandeId, fiche.customers_id]
      );
      if (!demande) {
        await conn.rollback();
        return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
      }
      let payload;
      try {
        payload = JSON.parse(demande.cfd_payload) || {};
      } catch {
        payload = {};
      }

      if (demande.cfd_type === 'FACTURATION') {
        const periode = String(payload.periode || '');
        const jours = Array.isArray(payload.jours)
          ? payload.jours.filter((j) => JOURS.includes(j))
          : [];
        if (!PERIODES.includes(periode)) {
          await conn.rollback();
          return res.status(400).json({ message: 'Demande invalide (périodicité inconnue).' });
        }
        await conn.query(
          `UPDATE delevery_customers
              SET customers_facturation_periode = ?, customers_facturation_jours = ?
            WHERE customers_id = ?`,
          [
            periode,
            periode === 'hebdomadaire' || periode === 'jours' ? jours.join(',') : null,
            fiche.customers_id
          ]
        );
      } else if (demande.cfd_type === 'RAMASSAGE') {
        const jours = Array.isArray(payload.jours)
          ? JOURS_RAMASSAGE.filter((j) => payload.jours.includes(j))
          : [];
        try {
          await conn.query(
            `UPDATE delevery_customers SET customers_ramassage_jours = ?
              WHERE customers_id = ?`,
            [jours.join(',') || null, fiche.customers_id]
          );
        } catch (err) {
          // customers_ramassage_jours absent : refuser d'accepter plutôt que
          // de marquer la demande appliquée sans rien appliquer.
          if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
          await conn.rollback();
          return res.status(503).json({
            message:
              'La périodicité de ramassage n’est pas encore disponible (migration sql/2026-08-26_ramassage-periodicite.sql à exécuter).'
          });
        }
      } else {
        const sets = [];
        const params = [];
        for (const [field, value] of Object.entries(payload.fields || {})) {
          if (TEXT_FIELDS[field]) {
            const [column, maxLen] = TEXT_FIELDS[field];
            const v = String(value).trim().slice(0, maxLen);
            if ((field === 'customers_name' || field === 'customers_cin') && !v) continue;
            sets.push(`${column} = ?`);
            params.push(v || null);
          } else if (DATE_FIELDS.includes(field)) {
            const v = String(value).trim();
            sets.push(`${field} = ?`);
            params.push(v && DATE_RE.test(v) ? v : null);
          }
        }
        for (const [field, url] of Object.entries(payload.files || {})) {
          const column = FILE_FIELDS[field];
          if (!column || !String(url).startsWith('/uploads/customers/')) continue;
          removeOldUpload(fiche[column]);
          sets.push(`${column} = ?`);
          params.push(url);
        }
        if (sets.length) {
          sets.push('customers_fiche_updated_at = NOW()');
          await conn.query(
            `UPDATE delevery_customers SET ${sets.join(', ')} WHERE customers_id = ?`,
            [...params, fiche.customers_id]
          );
        }
      }

      await conn.query(
        `UPDATE delevery_client_fiche_demande
            SET cfd_statut = 'ACCEPTED', cfd_treated_by = ?, cfd_treated_time = ?
          WHERE cfd_id = ?`,
        [Number(req.user.id) || 0, Math.floor(Date.now() / 1000), demandeId]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.json(await ficheAvecDemandes(fiche.customers_id));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/clients/demandes/en-attente — clients ayant au moins une demande
 * de modification de fiche en attente : bouton + modale de /admin/clients et
 * badge « Clients » de la sidebar admin. Respecte le périmètre agence des
 * employés restreints (via la ville de ramassage, comme la liste des clients).
 * { count, rows: [{ customers_id, store, name, types: [], since }] }.
 */
async function listDemandesEnAttente(req, res, next) {
  try {
    const agenceScope = await getAgenceScope(req.user);
    const where = [`d.cfd_statut = 'PENDING'`];
    const params = [];
    if (agenceScope !== null) {
      where.push('z.zone_agence_id = ?');
      params.push(agenceScope);
    }
    let rows = [];
    try {
      [rows] = await pool.query(
        `SELECT d.cfd_customer AS customers_id,
                c.customers_store AS store, c.customers_name AS name,
                GROUP_CONCAT(DISTINCT d.cfd_type ORDER BY d.cfd_type) AS types,
                MIN(d.cfd_time) AS since
           FROM delevery_client_fiche_demande d
           JOIN delevery_customers c ON c.customers_id = d.cfd_customer
           LEFT JOIN delevery_tarifs t ON t.ville_id = c.customers_pickup_city
           LEFT JOIN delevery_zone z ON z.zone_id = t.zone
          WHERE ${where.join(' AND ')}
          GROUP BY d.cfd_customer, c.customers_store, c.customers_name
          ORDER BY since`,
        params
      );
    } catch (err) {
      // Table pas encore migrée (sql/2026-08-26_demandes-fiche-client.sql) : aucune demande.
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    res.json({
      count: rows.length,
      rows: rows.map((r) => ({
        customers_id: r.customers_id,
        store: r.store,
        name: r.name,
        types: String(r.types || '').split(',').filter(Boolean),
        since: Number(r.since) || 0
      }))
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/clients/:id/demandes/:demandeId/refuser — demande refusée, fiche intacte. */
async function refuserDemandeFiche(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const demandeId = parseInt(req.params.demandeId, 10);
    const [[demande]] = await pool.query(
      `SELECT cfd_id, cfd_type, cfd_payload FROM delevery_client_fiche_demande
        WHERE cfd_id = ? AND cfd_customer = ? AND cfd_statut = 'PENDING' LIMIT 1`,
      [demandeId || 0, fiche.customers_id]
    );
    if (!demande) {
      return res.status(404).json({ message: 'Demande introuvable ou déjà traitée.' });
    }
    // Fichiers en attente jamais appliqués : supprimés au refus.
    if (demande.cfd_type === 'INFOS') {
      try {
        removeDemandeFiles(JSON.parse(demande.cfd_payload));
      } catch {
        /* payload illisible : rien à nettoyer */
      }
    }
    await pool.query(
      `UPDATE delevery_client_fiche_demande
          SET cfd_statut = 'REFUSED', cfd_treated_by = ?, cfd_treated_time = ?
        WHERE cfd_id = ? AND cfd_statut = 'PENDING'`,
      [Number(req.user.id) || 0, Math.floor(Date.now() / 1000), demande.cfd_id]
    );
    res.json(await ficheAvecDemandes(fiche.customers_id));
  } catch (err) {
    next(err);
  }
}

/*
 * Tarifs personnalisés par ville — table legacy delevery_customer_tarifs
 * (montants INT, pas de clé unique customer/ville : upsert manuel).
 * La ligne "Autre" (frais des villes non personnalisées) vit sur les colonnes
 * legacy customers_delivered_price / customers_returned_price /
 * customers_refused_price (varchar). Elle est lue par resolveClientFees
 * (parcels.controller) en 2e niveau de la cascade, uniquement si
 * customers_custom_tarif = 1 et qu'au moins un des trois montants est > 0.
 */

async function fetchTarifs(clientId) {
  const [rows] = await pool.query(
    `SELECT ct.id,
            ct.city_id          AS villeId,
            v.nom_ville         AS ville,
            z.zone_name         AS zone,
            ct.delivered_price  AS fraisLivraison,
            ct.refused_price    AS fraisRefuse,
            ct.returned_price   AS fraisRetour
       FROM delevery_customer_tarifs ct
       LEFT JOIN delevery_tarifs v ON v.ville_id = ct.city_id
       LEFT JOIN delevery_zone z ON z.zone_id = v.zone
      WHERE ct.customer_id = ?
      ORDER BY v.nom_ville`,
    [clientId]
  );
  return rows.map((r) => ({ ...r, ville: r.ville || `Ville n°${r.villeId}` }));
}

/** Frais par défaut du client (ligne "Autre" du tableau des tarifs). */
async function fetchTarifAutre(clientId) {
  const [[r]] = await pool.query(
    `SELECT customers_delivered_price, customers_refused_price, customers_returned_price
       FROM delevery_customers WHERE customers_id = ?`,
    [clientId]
  );
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  return {
    fraisLivraison: num(r?.customers_delivered_price),
    fraisRefuse: num(r?.customers_refused_price),
    fraisRetour: num(r?.customers_returned_price)
  };
}

/** Parse un montant de frais (entier — colonnes legacy INT) ; répond en cas d'erreur. */
function parseFrais(value, label, res) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) {
    res.status(400).json({ message: `${label} invalide (montant positif attendu).` });
    return null;
  }
  return Math.round(n);
}

/** GET /api/clients/:id/tarifs — tarifs par ville + ligne "Autre". */
async function listTarifs(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    res.json({
      tarifs: await fetchTarifs(fiche.customers_id),
      autre: await fetchTarifAutre(fiche.customers_id)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/clients/:id/tarifs/appliquer — bouton "Appliquer" :
 * { villeIds: [], fraisLivraison, fraisRefuse, fraisRetour }.
 * Insère ou met à jour une ligne par ville sélectionnée (les autres villes
 * personnalisées sont conservées).
 */
async function appliquerTarifs(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const id = fiche.customers_id;

    const villeIds = [...new Set(
      (Array.isArray(req.body?.villeIds) ? req.body.villeIds : [])
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isInteger(v))
    )];
    if (villeIds.length === 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner au moins une ville.' });
    }
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;
    const fraisRetour = parseFrais(req.body?.fraisRetour, 'Frais de retour', res);
    if (fraisRetour === null) return;

    const [villes] = await pool.query(
      `SELECT ville_id FROM delevery_tarifs WHERE ville_id IN (?)`,
      [villeIds]
    );
    const connues = new Set(villes.map((v) => v.ville_id));

    for (const villeId of villeIds) {
      if (!connues.has(villeId)) continue;
      const [result] = await pool.query(
        `UPDATE delevery_customer_tarifs
            SET delivered_price = ?, refused_price = ?, returned_price = ?
          WHERE customer_id = ? AND city_id = ?`,
        [fraisLivraison, fraisRefuse, fraisRetour, id, villeId]
      );
      if (result.affectedRows === 0) {
        await pool.query(
          `INSERT INTO delevery_customer_tarifs
             (customer_id, city_id, delivered_price, refused_price, returned_price)
           VALUES (?, ?, ?, ?, ?)`,
          [id, villeId, fraisLivraison, fraisRefuse, fraisRetour]
        );
      }
    }
    res.json({ tarifs: await fetchTarifs(id), autre: await fetchTarifAutre(id) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/clients/:id/tarifs/autre — frais des villes non personnalisées. */
async function updateTarifAutre(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;
    const fraisRetour = parseFrais(req.body?.fraisRetour, 'Frais de retour', res);
    if (fraisRetour === null) return;

    await pool.query(
      `UPDATE delevery_customers
          SET customers_delivered_price = ?, customers_refused_price = ?, customers_returned_price = ?
        WHERE customers_id = ?`,
      [String(fraisLivraison), String(fraisRefuse), String(fraisRetour), fiche.customers_id]
    );
    res.json({ autre: await fetchTarifAutre(fiche.customers_id) });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/clients/:id/tarifs/:tarifId — { fraisLivraison, fraisRefuse, fraisRetour }. */
async function updateTarif(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const tarifId = parseInt(req.params.tarifId, 10);
    if (!Number.isInteger(tarifId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const fraisLivraison = parseFrais(req.body?.fraisLivraison, 'Frais de livraison', res);
    if (fraisLivraison === null) return;
    const fraisRefuse = parseFrais(req.body?.fraisRefuse, 'Frais de refusé', res);
    if (fraisRefuse === null) return;
    const fraisRetour = parseFrais(req.body?.fraisRetour, 'Frais de retour', res);
    if (fraisRetour === null) return;

    const [result] = await pool.query(
      `UPDATE delevery_customer_tarifs
          SET delivered_price = ?, refused_price = ?, returned_price = ?
        WHERE id = ? AND customer_id = ?`,
      [fraisLivraison, fraisRefuse, fraisRetour, tarifId, fiche.customers_id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    const tarifs = await fetchTarifs(fiche.customers_id);
    res.json(tarifs.find((t) => t.id === tarifId));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/clients/:id/tarifs/:tarifId — supprime le tarif d'une ville. */
async function deleteTarif(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const tarifId = parseInt(req.params.tarifId, 10);
    if (!Number.isInteger(tarifId)) {
      return res.status(400).json({ message: 'Requête invalide.' });
    }
    const [result] = await pool.query(
      `DELETE FROM delevery_customer_tarifs WHERE id = ? AND customer_id = ?`,
      [tarifId, fiche.customers_id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Tarif introuvable.' });
    }
    res.json({ id: tarifId });
  } catch (err) {
    next(err);
  }
}

/** Supprime un fichier précédemment uploadé par la fiche (jamais les fichiers legacy). */
function removeOldUpload(value) {
  if (typeof value !== 'string' || !value.startsWith('/uploads/customers/')) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(value));
  fs.unlink(filePath, () => {});
}

/**
 * PUT /api/clients/:id/fiche — enregistre l'onglet "Informations"
 * (multipart/form-data : champs texte + fichiers, voir FILE_FIELDS).
 * Un fichier envoyé remplace l'ancien ; les champs texte absents du corps
 * ne sont pas modifiés, une chaîne vide efface la valeur (NULL).
 */
async function updateFiche(req, res, next) {
  try {
    const fiche = await ficheAutorisee(req, res);
    if (!fiche) return;
    const id = fiche.customers_id;

    const body = req.body || {};
    const sets = [];
    const params = [];

    for (const [field, [column, maxLen]] of Object.entries(TEXT_FIELDS)) {
      if (body[field] === undefined) continue;
      const value = String(body[field]).trim().slice(0, maxLen);
      if ((field === 'customers_name' || field === 'customers_cin') && !value) {
        return res.status(400).json({ message: 'Le nom complet et le CIN sont obligatoires.' });
      }
      if (field === 'customers_societe_email' && value && !EMAIL_RE.test(value)) {
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

    for (const [field, column] of Object.entries(FILE_FIELDS)) {
      const file = req.files?.[field]?.[0];
      if (!file) continue;
      removeOldUpload(fiche[column]);
      sets.push(`${column} = ?`);
      params.push(`/uploads/customers/${file.filename}`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ message: 'Aucune modification envoyée.' });
    }
    sets.push('customers_fiche_updated_at = NOW()');

    await pool.query(
      `UPDATE delevery_customers SET ${sets.join(', ')} WHERE customers_id = ?`,
      [...params, id]
    );
    res.json(await ficheAvecDemandes(id));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getFiche,
  getFicheOptions,
  updateCompteTarifs,
  updateCompteSelf,
  demanderFicheSelf,
  annulerDemandeSelf,
  accepterDemandeFiche,
  refuserDemandeFiche,
  listDemandesEnAttente,
  listTarifs,
  appliquerTarifs,
  updateTarif,
  updateTarifAutre,
  deleteTarif,
  updateFiche,
  ensureUploadDir,
  FILE_FIELDS,
  IMAGE_FIELDS
};
