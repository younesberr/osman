const pool = require('../config/db');
const { getAgenceScope, parcelInAgence, agenceIdFromVille } = require('../utils/agenceScope');
const {
  resolveClientFees,
  resoudreNouveauCode,
  renommerCodeMouvementsStock
} = require('./parcels.controller');
const {
  isValidPhone,
  PHONE_ERROR,
  normalizePhone,
  phoneVariants,
  formatPhoneAffichage
} = require('../utils/phone');
const { STATUT_CODE_SQL, STATUT_TYPE_SQL } = require('../utils/statutEffectif');
const { hasDemandeEnCours } = require('../utils/remboursement');
const { lireOptionFraisMontant, infoFraisMontant } = require('../utils/fraisMontant');
const {
  STATUT_ATTENTE_REEXPEDITION,
  peutReexpedier,
  enAttenteReexpedition
} = require('../utils/reexpedition');
const {
  STATUT_ATTENTE_CONFIRMATION,
  STATUTS_SCAN_SANS_ADRESSE,
  peutConfirmer,
  enAttenteConfirmation
} = require('../utils/sansAdresse');
const { statutLabel: libelleStatut } = require('../utils/statutLabels');
const {
  PREUVE_MIGRATION,
  preuveUrl,
  supprimerPreuve,
  historyPreuveDisponible,
  historyPreuveSql
} = require('../utils/preuveStatut');

/*
 * Actions de la datatable admin "Colis" : détail de suivi, information colis,
 * modification, réclamation et changement de statut. Employés type 3/4/6 :
 * chaque action est restreinte aux colis de leur agence (utils/agenceScope).
 */

/** Charge un colis visible par l'employé connecté ; renvoie null sinon. */
async function loadAdminParcel(req, columns) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const where = ['p.parcel_id = ?'];
  const params = [id];
  const agenceScope = await getAgenceScope(req.user);
  if (agenceScope !== null) {
    const scope = await parcelInAgence(agenceScope);
    where.push(scope.sql);
    params.push(...scope.params);
  }

  const [[parcel]] = await pool.query(
    `SELECT ${columns}
       FROM delevery_parcel p
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
       LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
       LEFT JOIN delevery_zone z      ON z.zone_id = t.zone
      WHERE ${where.join(' AND ')} LIMIT 1`,
    params
  );
  return parcel || null;
}

/** Vrai si le colis porte un drapeau facture livreur (brouillon ou payée). */
function surFactureLivreur(parcel) {
  return Number(parcel.parcel_paid_livreur) !== 0 || Number(parcel.parcel_refuse_livreur) !== 0;
}

/** Vrai si le colis porte un drapeau facture client (brouillon, enregistrée ou payée). */
function surFactureClient(parcel) {
  return (
    Number(parcel.parcel_invoiced) !== 0 ||
    Number(parcel.parcel_refuse_invoiced) !== 0 ||
    parcel.parcel_situation === 'INVOICED'
  );
}

/** Référence de la facture livreur portant le colis ('' si drapeau legacy sans ligne). */
async function refFactureLivreur(parcelId) {
  const [[facture]] = await pool.query(
    `SELECT pn.payment_note_id AS id, pn.payment_note_ref AS ref
       FROM delevery_pay_parcels pp
       JOIN delevery_payment_note pn ON pn.payment_note_id = pp.pay_parcels_pay
      WHERE pp.pay_parcels_parcel = ? AND pn.payment_note_type = 1 LIMIT 1`,
    [parcelId]
  );
  return facture ? String(facture.ref || '').trim() || `n° ${facture.id}` : '';
}

/** Référence de la facture client portant le colis ('' si drapeau legacy sans ligne). */
async function refFactureClient(parcelId) {
  const [[facture]] = await pool.query(
    `SELECT i.invoice_id AS id, i.invoice_ref AS ref
       FROM delevery_invoice_parcels ip
       JOIN delevery_invoice i ON i.invoice_id = ip.invoice_parcels_invoice
      WHERE ip.invoice_parcels_parcel = ? LIMIT 1`,
    [parcelId]
  );
  return facture ? String(facture.ref || '').trim() || `n° ${facture.id}` : '';
}

/**
 * Message « colis sur la facture livreur … » pour l'action bloquée (« changer
 * son statut », « annuler la livraison »), avec la référence de la facture
 * quand la ligne existe (drapeau legacy sinon).
 */
async function messageFactureLivreur(parcelId, action) {
  const ref = await refFactureLivreur(parcelId);
  return `Ce colis est sur ${ref ? `la facture livreur « ${ref} »` : 'une facture livreur'} : retirez-le d’abord de la facture pour pouvoir ${action}.`;
}

/* Champs de la modale "Modifier colis" (clés de EDIT_FIELDS) qui restent
 * modifiables quand le colis est sur une facture livreur / une facture client. */
const CHAMPS_MODIFIABLES_FACTURE_LIVREUR = ['deliveredFees', 'extraFees', 'returnedFees', 'refusedFees', 'replace'];
const CHAMPS_MODIFIABLES_FACTURE_CLIENT = ['replace'];

/**
 * Verrouillage partiel de la modale "Modifier colis" selon la facturation du
 * colis (un colis livré non facturé reste entièrement modifiable) :
 *  - colis sur une facture client (parcel_invoiced / parcel_refuse_invoiced
 *    ≠ 0, ou situation INVOICED) : seul « Colis à remplacer » reste modifiable ;
 *  - sinon colis sur une facture livreur (parcel_paid_livreur /
 *    parcel_refuse_livreur ≠ 0) : frais de livraison / supplémentaires /
 *    retour / refus et « Colis à remplacer » ;
 *  - sinon : tous les champs.
 * Renvoie { mode: 'full'|'livreur'|'client', fields: [clés modifiables],
 * message } ; le message explique le verrou (affiché en tête de la modale,
 * renvoyé en 409 si un champ verrouillé est modifié).
 */
async function verrouillageModification(parcel) {
  if (surFactureClient(parcel)) {
    const ref = await refFactureClient(parcel.parcel_id);
    return {
      mode: 'client',
      fields: CHAMPS_MODIFIABLES_FACTURE_CLIENT,
      message: `Ce colis est sur ${ref ? `la facture client « ${ref} »` : 'une facture client'} : seul « Colis à remplacer » peut être modifié.`
    };
  }
  if (surFactureLivreur(parcel)) {
    const ref = await refFactureLivreur(parcel.parcel_id);
    return {
      mode: 'livreur',
      fields: CHAMPS_MODIFIABLES_FACTURE_LIVREUR,
      message: `Ce colis est sur ${ref ? `la facture livreur « ${ref} »` : 'une facture livreur'} : seuls les frais (livraison, supplémentaires, retour, refus) et « Colis à remplacer » peuvent être modifiés.`
    };
  }
  return { mode: 'full', fields: EDIT_FIELDS.map((f) => f.key), message: '' };
}

/**
 * Motif de blocage total de la modification d'un colis (modale "Modifier
 * colis"), ou null si la modification est permise (éventuellement partielle,
 * voir verrouillageModification) :
 *  - colis retourné (RETURNED) : à retirer du bon de retour client puis du bon
 *    de retour livreur (le retrait le repasse IN_PROGRESS) ; un colis reçu ne
 *    peut plus être retiré, donc plus jamais modifié ;
 *  - colis échange livré en circuit retour (DELIVERED + statut second du
 *    circuit) : même règle, il est engagé sur un bon de retour.
 * Les tables des bons de retour peuvent ne pas exister avant leurs migrations :
 * elles sont alors ignorées (message générique).
 */
async function motifModificationBloquee(parcel) {
  const enCircuitRetour =
    parcel.parcel_status === 'DELIVERED' &&
    STATUTS_CIRCUIT_RETOUR.includes(String(parcel.parcel_status_second || '').trim());
  if (parcel.parcel_status === 'RETURNED' || enCircuitRetour) {
    const etapes = [];
    try {
      const [[bonClient]] = await pool.query(
        `SELECT b.rnc_ref AS ref
           FROM delevery_rnc_parcels cp
           JOIN delevery_return_note_client b ON b.rnc_id = cp.rnc_parcels_rnc
          WHERE cp.rnc_parcels_parcel = ? LIMIT 1`,
        [parcel.parcel_id]
      );
      if (bonClient) etapes.push(`du bon de retour client « ${bonClient.ref} »`);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    try {
      const [[bonLivreur]] = await pool.query(
        `SELECT rn.return_note_ref AS ref
           FROM delevery_rn_parcels rp
           JOIN delevery_return_note rn ON rn.return_note_id = rp.rn_parcels_rn
          WHERE rp.rn_parcels_parcel = ? LIMIT 1`,
        [parcel.parcel_id]
      );
      if (bonLivreur) etapes.push(`du bon de retour livreur « ${bonLivreur.ref} »`);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
    const prefixe = enCircuitRetour ? 'Colis échange en circuit de retour' : 'Colis retourné';
    if (!etapes.length) return `${prefixe} : il ne peut pas être modifié.`;
    return `${prefixe} : retirez-le d’abord ${etapes.join(' puis ')} pour pouvoir le modifier.`;
  }

  return null;
}

/* Marqueurs legacy d'une ligne d'historique "colis modifié" (sans statut) :
 * exclus du suivi admin, remplacés par les entrées détaillées de
 * delevery_parcel_modification (utilisateur + champs modifiés). */
const EDIT_DATA_MARKERS = ['EDITED', 'PARCEL_EDITED', 'UPDATED', 'MODIFIED'];

/* Code statut affiché d'une étape d'historique : la ligne de facturation
 * client (situation INVOICED avec statut DELIVERED / REFUSE répété, sans
 * statut second) s'affiche « Facturé », comme le statut effectif du tableau
 * colis ; sinon statut second si renseigné, sinon statut. */
const HISTORY_STATUT_SQL = `CASE
    WHEN h.parcel_history_situation = 'INVOICED'
         AND h.parcel_history_status IN ('DELIVERED', 'REFUSE')
         AND COALESCE(h.parcel_history_status_second, '') = ''
      THEN 'INVOICED'
    WHEN COALESCE(h.parcel_history_status_second, '') <> '' THEN h.parcel_history_status_second
    ELSE COALESCE(h.parcel_history_status, '') END`;

/**
 * GET /api/parcels/:id/suivi — modale admin "Détail de suivi" : même timeline
 * que la version client (delevery_parcel_history) avec en plus, pour chaque
 * étape, le nom de l'utilisateur (parcel_history_by → delevery_users), et les
 * modifications du colis (delevery_parcel_modification : date, utilisateur,
 * champs modifiés), fusionnées chronologiquement (kind = 'statut' | 'modif').
 */
async function getParcelSuivi(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, `p.parcel_id, p.parcel_code, p.parcel_livreur`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    res.json(await chargerSuiviColis(parcel));
  } catch (err) {
    next(err);
  }
}

/**
 * Contenu de la modale « Détail de suivi » d'un colis déjà chargé (parcel_id,
 * parcel_code, parcel_livreur) : { code, livreur, entries }. Partagé entre
 * l'admin (GET /parcels/:id/suivi, ci-dessus) et le livreur pour ses propres
 * colis (GET /livreurs/me/colis/:id/suivi, livreurColis.controller).
 */
async function chargerSuiviColis(parcel) {
  let livreur = null;
  if (Number(parcel.parcel_livreur) > 0) {
    const [[row]] = await pool.query(
      `SELECT u.users_name AS name,
              CASE WHEN IFNULL(u.users_is_salarie, 0) = 1 THEN
                COALESCE(
                  (SELECT u2.users_phone FROM delevery_users u2
                    WHERE (u2.users_id = COALESCE(u.users_parent_id, u.users_id)
                           OR u2.users_parent_id = COALESCE(u.users_parent_id, u.users_id))
                      AND u2.users_type = 5 AND COALESCE(u2.users_phone, '') <> ''
                    LIMIT 1),
                  u.users_phone)
              ELSE u.users_phone END AS phone
         FROM delevery_users u
        WHERE u.users_id = ? LIMIT 1`,
      [Number(parcel.parcel_livreur)]
    );
    if (row?.name) livreur = { name: row.name, phone: row.phone || null };
  }

  // preuve : photo jointe au changement de statut (NULL sans la migration
  // sql/2026-09-02_preuve-statut.sql), lien « Voir la preuve » en face du statut.
  const preuveSql = await historyPreuveSql();

  // parcel_history_member > 0 : action faite par un membre de l'équipe du
  // client (nom du membre affiché en plus). Fallback si la migration
  // sql/2026-08-23_equipe-client-colonnes-attribution.sql n'est pas passée.
  let histoRows;
  try {
    [histoRows] = await pool.query(
      `SELECT h.parcel_history_id AS id,
            ${HISTORY_STATUT_SQL} AS status,
            h.parcel_history_situation AS situation,
            h.parcel_history_data AS data,
            h.parcel_history_comment AS comment,
            h.parcel_history_time AS time,
            ${preuveSql} AS preuve,
            sc.color AS status_color,
            u.users_name AS user,
            mb.member_name AS member
       FROM delevery_parcel_history h
       LEFT JOIN delevery_users u ON u.users_id = h.parcel_history_by
       LEFT JOIN delevery_customer_members mb
         ON mb.member_id = h.parcel_history_member AND h.parcel_history_member > 0
       LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                    FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
         ON sc.parcel_statut_code = ${HISTORY_STATUT_SQL}
      WHERE h.parcel_history_parcel = ?
      ORDER BY h.parcel_history_time ASC, h.parcel_history_id ASC`,
      [parcel.parcel_id]
    );
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
    [histoRows] = await pool.query(
      `SELECT h.parcel_history_id AS id,
            ${HISTORY_STATUT_SQL} AS status,
            h.parcel_history_situation AS situation,
            h.parcel_history_data AS data,
            h.parcel_history_comment AS comment,
            h.parcel_history_time AS time,
            ${preuveSql} AS preuve,
            sc.color AS status_color,
            u.users_name AS user
       FROM delevery_parcel_history h
       LEFT JOIN delevery_users u ON u.users_id = h.parcel_history_by
       LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                    FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
         ON sc.parcel_statut_code = ${HISTORY_STATUT_SQL}
      WHERE h.parcel_history_parcel = ?
      ORDER BY h.parcel_history_time ASC, h.parcel_history_id ASC`,
      [parcel.parcel_id]
    );
  }

  // modif_customer > 0 : modification faite par le client depuis son
  // dashboard (nom du magasin affiché à la place de l'utilisateur) ;
  // modif_member > 0 : par un membre de son équipe (nom du membre en plus).
  let modifRows;
  try {
    [modifRows] = await pool.query(
      `SELECT m.modif_id AS id, m.modif_time AS time, m.modif_changes AS changes,
              COALESCE(NULLIF(u.users_name, ''), NULLIF(c.customers_store, ''), c.customers_name) AS user,
              CASE WHEN m.modif_customer > 0 THEN 1 ELSE 0 END AS by_client,
              mb.member_name AS member
         FROM delevery_parcel_modification m
         LEFT JOIN delevery_users u ON u.users_id = m.modif_user AND m.modif_user > 0
         LEFT JOIN delevery_customers c ON c.customers_id = m.modif_customer AND m.modif_customer > 0
         LEFT JOIN delevery_customer_members mb
           ON mb.member_id = m.modif_member AND m.modif_member > 0
        WHERE m.modif_parcel = ?
        ORDER BY m.modif_time ASC, m.modif_id ASC`,
      [parcel.parcel_id]
    );
  } catch (err) {
    // Colonne modif_member pas encore migrée
    // (sql/2026-08-23_equipe-client-colonnes-attribution.sql).
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') throw err;
    try {
      [modifRows] = await pool.query(
        `SELECT m.modif_id AS id, m.modif_time AS time, m.modif_changes AS changes,
                COALESCE(NULLIF(u.users_name, ''), NULLIF(c.customers_store, ''), c.customers_name) AS user,
                CASE WHEN m.modif_customer > 0 THEN 1 ELSE 0 END AS by_client
           FROM delevery_parcel_modification m
           LEFT JOIN delevery_users u ON u.users_id = m.modif_user AND m.modif_user > 0
           LEFT JOIN delevery_customers c ON c.customers_id = m.modif_customer AND m.modif_customer > 0
          WHERE m.modif_parcel = ?
          ORDER BY m.modif_time ASC, m.modif_id ASC`,
        [parcel.parcel_id]
      );
    } catch (err2) {
      // Colonne modif_customer pas encore migrée
      // (sql/2026-08-20_etiquettes-impression-edit-client.sql).
      if (err2.code !== 'ER_BAD_FIELD_ERROR') throw err2;
      [modifRows] = await pool.query(
        `SELECT m.modif_id AS id, m.modif_time AS time, m.modif_changes AS changes,
                u.users_name AS user, 0 AS by_client
           FROM delevery_parcel_modification m
           LEFT JOIN delevery_users u ON u.users_id = m.modif_user
          WHERE m.modif_parcel = ?
          ORDER BY m.modif_time ASC, m.modif_id ASC`,
        [parcel.parcel_id]
      );
    }
  }

  const entries = [
    ...histoRows
      // Lignes legacy "colis modifié" sans statut : couvertes par les entrées
      // détaillées de delevery_parcel_modification.
      .filter((h) => h.status || !EDIT_DATA_MARKERS.includes(String(h.data || '').trim()))
      .map((h) => ({ ...h, kind: 'statut', id: `h${h.id}` })),
    ...modifRows.map((m) => {
      let changes = [];
      try {
        changes = JSON.parse(m.changes) || [];
      } catch {
        changes = [];
      }
      return {
        kind: 'modif',
        id: `m${m.id}`,
        time: m.time,
        user: m.user,
        by_client: Number(m.by_client) === 1 ? 1 : 0,
        member: m.member || null,
        changes
      };
    })
  ].sort((a, b) => (a.time - b.time) || String(a.id).localeCompare(String(b.id)));

  return { code: parcel.parcel_code, livreur, entries };
}

/**
 * GET /api/parcels/:id/details — modale admin "Information colis" : mêmes
 * détails que la version client (destinataire, téléphone, ville, adresse,
 * prix, commentaire, marchandise / produits de stock) + zone et livreur, et
 * le bloc expéditeur (client : magasin, nom, téléphone, ville de ramassage,
 * adresse) affiché dans la section gauche de la modale. Sert aussi la modale
 * "Réclamation" (client, livreur, zone, ville de destination).
 */
async function getParcelDetails(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_receiver, p.parcel_phone, p.parcel_address,
       p.parcel_price, p.parcel_crbt_zero, p.parcel_note, p.parcel_product_name,
       p.parcel_product_qty, p.parcel_from_stock, p.parcel_customer, p.parcel_livreur,
       t.nom_ville AS ville, z.zone_name AS zone`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    let produits = [];
    if (Number(parcel.parcel_from_stock) === 1) {
      const [rows] = await pool.query(
        `SELECT parcel_content_product_name AS produit,
                COALESCE(NULLIF(parcel_content_variant_name, ''), '') AS variante,
                COUNT(*) AS qty
           FROM delevery_parcel_content
          WHERE parcel_content_parcel_id = ?
          GROUP BY parcel_content_product_name, COALESCE(NULLIF(parcel_content_variant_name, ''), '')
          ORDER BY parcel_content_product_name`,
        [parcel.parcel_id]
      );
      produits = rows;
    }

    let expediteur = null;
    if (Number(parcel.parcel_customer) > 0) {
      const [[client]] = await pool.query(
        `SELECT c.customers_store AS store, c.customers_name AS nom,
                c.customers_phone AS phone, c.customers_email AS email,
                c.customers_address AS adresse, tv.nom_ville AS ville_ramassage
           FROM delevery_customers c
           LEFT JOIN delevery_tarifs tv ON tv.ville_id = c.customers_pickup_city
          WHERE c.customers_id = ? LIMIT 1`,
        [Number(parcel.parcel_customer)]
      );
      expediteur = client || null;
    }

    let livreur = null;
    if (Number(parcel.parcel_livreur) > 0) {
      const [[row]] = await pool.query(
        `SELECT users_name AS name FROM delevery_users WHERE users_id = ? LIMIT 1`,
        [Number(parcel.parcel_livreur)]
      );
      if (row?.name) livreur = row.name;
    }

    res.json({
      parcel_code: parcel.parcel_code,
      parcel_receiver: parcel.parcel_receiver,
      parcel_phone: parcel.parcel_phone,
      ville: parcel.ville,
      zone: parcel.zone,
      livreur,
      parcel_address: parcel.parcel_address,
      parcel_price: parcel.parcel_price,
      crbt: Number(parcel.parcel_crbt_zero) === 1 ? 0 : Number(parcel.parcel_price) || 0,
      parcel_note: parcel.parcel_note,
      parcel_from_stock: Number(parcel.parcel_from_stock) === 1 ? 1 : 0,
      parcel_product_name: parcel.parcel_product_name,
      parcel_product_qty: parcel.parcel_product_qty,
      produits,
      expediteur
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/:id/edit — données de la modale "Modifier colis" : valeurs
 * actuelles du colis + villes de destination actives + villes de ramassage
 * (matrice tarifaire, sans doublons). 409 si la modification est bloquée
 * (colis retourné : motifModificationBloquee). `lock` = verrouillage partiel
 * selon la facturation (verrouillageModification : mode, champs modifiables,
 * message) — la modale désactive les champs hors `lock.fields`.
 * code_editable = 1 (colis en attente de ramassage, sans verrou) : la modale
 * affiche le champ « Code colis » (voir resoudreNouveauCode).
 */
async function getParcelEditData(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_status_second,
       p.parcel_situation, p.parcel_customer, p.parcel_receiver, p.parcel_phone, p.parcel_city,
       p.parcel_address, p.parcel_note, p.parcel_price,
       p.parcel_delivered_fees, p.parcel_extra_fees, p.parcel_returned_fees,
       p.parcel_refused_fees, p.parcel_replace, p.parcel_ramassage_city,
       COALESCE(p.parcel_paid_livreur, 0)     AS parcel_paid_livreur,
       COALESCE(p.parcel_refuse_livreur, 0)   AS parcel_refuse_livreur,
       COALESCE(p.parcel_invoiced, 0)         AS parcel_invoiced,
       COALESCE(p.parcel_refuse_invoiced, 0)  AS parcel_refuse_invoiced`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    // Blocage dès l'ouverture de la modale (colis retourné).
    const blocage = await motifModificationBloquee(parcel);
    if (blocage) return res.status(409).json({ message: blocage });
    const lock = await verrouillageModification(parcel);
    // Frais supp automatiques au-delà de 2 500 DH (option du client du colis) :
    // la modale réajuste le champ « Frais supplémentaires » quand le prix change.
    const optionFrais = await lireOptionFraisMontant(Number(parcel.parcel_customer) || 0);

    const [[cities], [pickupCities]] = await Promise.all([
      pool.query(
        `SELECT ville_id AS id, nom_ville AS label
           FROM delevery_tarifs
          WHERE statut = 1
          ORDER BY nom_ville`
      ),
      pool.query(
        `SELECT DISTINCT m.pickup_ville_id AS id, t.nom_ville AS label
           FROM delevery_tarifs_matrix m
           JOIN delevery_tarifs t ON t.ville_id = m.pickup_ville_id
          ORDER BY t.nom_ville`
      )
    ]);

    res.json({
      parcel_code: parcel.parcel_code,
      receiver: parcel.parcel_receiver || '',
      phone: parcel.parcel_phone || '',
      city: Number(parcel.parcel_city) || 0,
      address: parcel.parcel_address || '',
      note: parcel.parcel_note || '',
      price: Number(parcel.parcel_price) || 0,
      deliveredFees: Number(parcel.parcel_delivered_fees) || 0,
      extraFees: Number(parcel.parcel_extra_fees) || 0,
      returnedFees: Number(parcel.parcel_returned_fees) || 0,
      refusedFees: Number(parcel.parcel_refused_fees) || 0,
      replace: Number(parcel.parcel_replace) === 1 ? 1 : 0,
      pickupCity: Number(parcel.parcel_ramassage_city) || 0,
      code_editable: parcel.parcel_status === 'WAITING_PICKUP' && lock.mode === 'full' ? 1 : 0,
      frais_montant: infoFraisMontant(optionFrais.actif),
      cities,
      pickupCities,
      lock
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/:id/tarif?city=ID&pickupCity=ID — frais recalculés pour la
 * modale "Modifier colis" quand l'admin change la ville de destination ou de
 * ramassage : même cascade que la création côté client (resolveClientFees,
 * avec le client du colis) : tarif personnalisé du client → ligne « Autre » du
 * client → matrice ramassage → destination → tarif par défaut de la destination.
 */
async function getParcelTarif(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, `p.parcel_id, p.parcel_customer`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    const city = parseInt(req.query.city, 10);
    const pickupCity = parseInt(req.query.pickupCity, 10);
    if (!Number.isInteger(city) || city <= 0 || !Number.isInteger(pickupCity) || pickupCity <= 0) {
      return res.status(400).json({ message: 'Villes invalides.' });
    }

    const [[customer]] = await pool.query(
      `SELECT IFNULL(customers_custom_tarif, 0) AS custom_tarif
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [Number(parcel.parcel_customer) || 0]
    );

    const fees = await resolveClientFees(
      Number(parcel.parcel_customer) || 0,
      customer?.custom_tarif || 0,
      pickupCity,
      city
    );
    if (!fees) {
      return res.status(404).json({ message: 'Aucun tarif trouvé pour cette ville.' });
    }
    res.json(fees);
  } catch (err) {
    next(err);
  }
}

/** Libellés français des champs éditables (trace des modifications). */
const EDIT_FIELDS = [
  { key: 'receiver', col: 'parcel_receiver', label: 'Destinataire' },
  { key: 'phone', col: 'parcel_phone', label: 'Téléphone' },
  { key: 'city', col: 'parcel_city', label: 'Ville' },
  { key: 'address', col: 'parcel_address', label: 'Adresse' },
  { key: 'note', col: 'parcel_note', label: 'Commentaire' },
  { key: 'price', col: 'parcel_price', label: 'Prix' },
  { key: 'deliveredFees', col: 'parcel_delivered_fees', label: 'Frais de livraison' },
  { key: 'extraFees', col: 'parcel_extra_fees', label: 'Frais supplémentaires' },
  { key: 'returnedFees', col: 'parcel_returned_fees', label: 'Frais de retour' },
  { key: 'refusedFees', col: 'parcel_refused_fees', label: 'Frais de refus' },
  { key: 'replace', col: 'parcel_replace', label: 'Colis à remplacer' },
  { key: 'pickupCity', col: 'parcel_ramassage_city', label: 'Ville de ramassage' }
];

/** Entier ≥ 0 (frais), sinon null. */
function parseFee(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999) return null;
  return Math.round(n);
}

/**
 * PUT /api/parcels/:id — modale "Modifier colis".
 * Body : { code?, receiver, phone, city, address, note, price, deliveredFees,
 * extraFees, returnedFees, refusedFees, replace: 0|1, pickupCity }.
 * Refusé (409) si le colis est retourné (motifModificationBloquee, même
 * règle qu'à l'ouverture de la modale). Colis sur une facture client / livreur
 * (verrouillageModification) : seuls les champs autorisés peuvent changer,
 * 409 si un champ verrouillé diffère de la valeur actuelle.
 * `code` (code colis) : modifiable seulement en attente de ramassage
 * (WAITING_PICKUP, statut revérifié dans le WHERE de l'UPDATE) — unicité
 * contrôlée, mouvements de stock renommés (resoudreNouveauCode /
 * renommerCodeMouvementsStock) ; réponse { code_modifie: 1, parcel_code }.
 * Le changement de ville de ramassage change aussi l'agence du colis :
 * parcel_agence = agence de la zone de la nouvelle ville (agenceIdFromVille).
 * Dans une même transaction : instantané des anciennes valeurs dans la table
 * legacy delevery_parcel_edit (+ parcel_edited = 1, compatibilité production),
 * trace détaillée (date, utilisateur, champs modifiés ancien → nouveau) dans
 * delevery_parcel_modification (affichée dans le détail de suivi admin), et
 * ligne d'historique legacy data = 'EDITED' (suivi client).
 */
async function updateParcel(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_customer, p.parcel_situation, p.parcel_status,
       p.parcel_status_second,
       p.parcel_receiver, p.parcel_phone, p.parcel_city, p.parcel_address,
       p.parcel_note, p.parcel_price, p.parcel_delivered_fees, p.parcel_extra_fees,
       p.parcel_returned_fees, p.parcel_refused_fees, p.parcel_replace,
       p.parcel_ramassage_city, t.nom_ville AS ville,
       COALESCE(p.parcel_paid_livreur, 0)     AS parcel_paid_livreur,
       COALESCE(p.parcel_refuse_livreur, 0)   AS parcel_refuse_livreur,
       COALESCE(p.parcel_invoiced, 0)         AS parcel_invoiced,
       COALESCE(p.parcel_refuse_invoiced, 0)  AS parcel_refuse_invoiced`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    // Colis retourné : modification interdite (même contrôle qu'à l'ouverture
    // de la modale, revérifié à l'écriture).
    const blocage = await motifModificationBloquee(parcel);
    if (blocage) return res.status(409).json({ message: blocage });

    // Verrouillage partiel selon la facturation (facture client / facture
    // livreur) : les champs hors `verrou.fields` doivent rester inchangés.
    const verrou = await verrouillageModification(parcel);
    const modifiable = (key) => verrou.fields.includes(key);

    // Code colis : modifiable seulement en attente de ramassage (un colis
    // WAITING_PICKUP n'est jamais facturé : hors verrou) — traité à part des
    // EDIT_FIELDS, dont le verrou dépend de la facturation et non du statut.
    const codeRes = await resoudreNouveauCode(parcel, req.body?.code);
    if (codeRes.error) return res.status(codeRes.status).json({ message: codeRes.error });
    const ancienCode = String(parcel.parcel_code || '');
    const nouveauCode = codeRes.code;
    const codeModifie = codeRes.modifie;

    const ancien = {
      receiver: parcel.parcel_receiver || '',
      phone: parcel.parcel_phone || '',
      city: Number(parcel.parcel_city) || 0,
      address: parcel.parcel_address || '',
      note: parcel.parcel_note || '',
      price: Number(parcel.parcel_price) || 0,
      deliveredFees: Number(parcel.parcel_delivered_fees) || 0,
      extraFees: Number(parcel.parcel_extra_fees) || 0,
      returnedFees: Number(parcel.parcel_returned_fees) || 0,
      refusedFees: Number(parcel.parcel_refused_fees) || 0,
      replace: Number(parcel.parcel_replace) === 1 ? 1 : 0,
      pickupCity: Number(parcel.parcel_ramassage_city) || 0
    };

    // Valeurs demandées, normalisées comme à l'enregistrement.
    const demande = {
      receiver: String(req.body?.receiver || '').trim().slice(0, 250),
      phone: String(req.body?.phone || '').trim().slice(0, 50),
      city: parseInt(req.body?.city, 10),
      address: String(req.body?.address || '').trim().slice(0, 2000),
      note: String(req.body?.note || '').trim().slice(0, 2000),
      price: Number(req.body?.price),
      deliveredFees: parseFee(req.body?.deliveredFees),
      extraFees: parseFee(req.body?.extraFees),
      returnedFees: parseFee(req.body?.returnedFees),
      refusedFees: parseFee(req.body?.refusedFees),
      replace: Number(req.body?.replace) === 1 ? 1 : 0,
      pickupCity: parseInt(req.body?.pickupCity, 10)
    };

    // Champ verrouillé modifié (modale ouverte avant la facturation du colis,
    // ou requête forgée) : refusé avec le motif du verrou.
    for (const f of EDIT_FIELDS) {
      if (modifiable(f.key) || req.body?.[f.key] === undefined) continue;
      if (String(demande[f.key]).trim() !== String(ancien[f.key]).trim()) {
        return res.status(409).json({ message: verrou.message });
      }
    }

    // Valeurs enregistrées : champs verrouillés conservés tels quels.
    const nouveau = {};
    for (const f of EDIT_FIELDS) {
      nouveau[f.key] = modifiable(f.key) ? demande[f.key] : ancien[f.key];
    }
    const {
      receiver,
      phone,
      city,
      address,
      note,
      price,
      deliveredFees,
      extraFees,
      returnedFees,
      refusedFees,
      replace,
      pickupCity
    } = nouveau;

    // Validation des seuls champs modifiables (un champ verrouillé garde sa
    // valeur actuelle, même si elle ne passerait plus la validation).
    if (modifiable('receiver') && !receiver) {
      return res.status(400).json({ message: 'Le nom du destinataire est obligatoire.' });
    }
    if (modifiable('phone')) {
      if (!phone) return res.status(400).json({ message: 'Le téléphone du destinataire est obligatoire.' });
      if (!isValidPhone(phone)) return res.status(400).json({ message: PHONE_ERROR });
    }
    if (modifiable('city') && (!Number.isInteger(city) || city <= 0)) {
      return res.status(400).json({ message: 'Veuillez sélectionner une ville de destination.' });
    }
    if (modifiable('address') && !address) {
      return res.status(400).json({ message: "L'adresse est obligatoire." });
    }
    if (modifiable('pickupCity') && (!Number.isInteger(pickupCity) || pickupCity <= 0)) {
      return res.status(400).json({ message: 'Veuillez sélectionner une ville de ramassage.' });
    }
    if (modifiable('price') && (!Number.isFinite(price) || price < 0 || price > 99999999)) {
      return res.status(400).json({ message: 'Prix invalide (montant positif attendu).' });
    }
    if ([deliveredFees, extraFees, returnedFees, refusedFees].some((f) => f === null)) {
      return res.status(400).json({ message: 'Frais invalides (montants positifs attendus).' });
    }

    // Noms des villes (trace ancien → nouveau, réponse) : recherchés seulement
    // pour une ville modifiable, la ville actuelle du colis étant conservée sinon.
    let destVille = { nom_ville: parcel.ville || '' };
    if (modifiable('city')) {
      const [[v]] = await pool.query(
        `SELECT nom_ville FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
        [city]
      );
      if (!v) return res.status(400).json({ message: 'Ville de destination introuvable.' });
      destVille = v;
    }
    let pickupVille = null;
    let oldPickupNom = '';
    if (modifiable('pickupCity')) {
      const [[v]] = await pool.query(
        `SELECT nom_ville FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
        [pickupCity]
      );
      if (!v) return res.status(400).json({ message: 'Ville de ramassage introuvable.' });
      pickupVille = v;
      // Nom de l'ancienne ville de ramassage (pour la trace ancien → nouveau).
      if (ancien.pickupCity > 0) {
        const [[old]] = await pool.query(
          `SELECT nom_ville FROM delevery_tarifs WHERE ville_id = ? LIMIT 1`,
          [ancien.pickupCity]
        );
        oldPickupNom = old?.nom_ville || String(ancien.pickupCity);
      }
    }

    // Champs modifiés (villes et oui/non tracés par libellé, pas par id).
    const changes = [];
    for (const f of EDIT_FIELDS) {
      if (String(ancien[f.key]) === String(nouveau[f.key])) continue;
      let oldVal = ancien[f.key];
      let newVal = nouveau[f.key];
      if (f.key === 'city') {
        oldVal = parcel.ville || String(oldVal || '—');
        newVal = destVille.nom_ville;
      } else if (f.key === 'pickupCity') {
        oldVal = oldPickupNom || '—';
        newVal = pickupVille.nom_ville;
      } else if (f.key === 'replace') {
        oldVal = oldVal === 1 ? 'Oui' : 'Non';
        newVal = newVal === 1 ? 'Oui' : 'Non';
      }
      changes.push({ field: f.key, label: f.label, old: String(oldVal), new: String(newVal) });
    }
    if (codeModifie) {
      changes.unshift({ field: 'code', label: 'Code colis', old: ancienCode, new: nouveauCode });
    }
    if (!changes.length) {
      return res.status(400).json({ message: 'Aucune modification détectée.' });
    }

    // Agence de la ville de ramassage (ville → zone → agence) : suit le
    // changement de ville de ramassage (champ modifiable seulement).
    const agenceId = modifiable('pickupCity') ? await agenceIdFromVille(pickupCity) : null;

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Instantané legacy des anciennes valeurs (delevery_parcel_edit).
      await conn.query(
        `INSERT INTO delevery_parcel_edit
           (parcel_edit_code, parcel_edit_receiver, parcel_edit_phone, parcel_edit_district,
            parcel_edit_price, parcel_edit_address, parcel_edit_note, parcel_edit_customer,
            parcel_edit_time)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
        [
          parcel.parcel_code || '',
          ancien.receiver,
          ancien.phone,
          Math.round(ancien.price),
          ancien.address,
          ancien.note,
          Number(parcel.parcel_customer) || 0,
          now
        ]
      );

      // Trace détaillée pour le suivi admin (qui, quand, quels champs).
      await conn.query(
        `INSERT INTO delevery_parcel_modification
           (modif_parcel, modif_user, modif_time, modif_changes)
         VALUES (?, ?, ?, ?)`,
        [parcel.parcel_id, Number(req.user.id) || 0, now, JSON.stringify(changes)]
      );

      // Ligne d'historique legacy (affichée "Colis modifié" côté client).
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_data, parcel_history_time, parcel_history_by)
         VALUES (?, 0, ?, '', 'EDITED', ?, ?)`,
        [parcel.parcel_id, parcel.parcel_situation || '', now, Number(req.user.id) || 0]
      );

      // parcel_agence n'est resynchronisée que si la ville de ramassage est
      // modifiable (colis facturé : agence conservée). Changement de code :
      // statut revérifié dans le WHERE (colis ramassé entre l'ouverture de la
      // modale et l'enregistrement → aucune ligne touchée, refus).
      const [result] = await conn.query(
        `UPDATE delevery_parcel
            SET ${codeModifie ? 'parcel_code = ?, ' : ''}parcel_receiver = ?, parcel_phone = ?,
                parcel_city = ?, parcel_address = ?,
                parcel_note = ?, parcel_price = ?, parcel_delivered_fees = ?,
                parcel_extra_fees = ?, parcel_returned_fees = ?, parcel_refused_fees = ?,
                parcel_replace = ?, parcel_ramassage_city = ?,
                ${modifiable('pickupCity') ? 'parcel_agence = ?,' : ''}
                parcel_edited = 1, parcel_last_update = ?
          WHERE parcel_id = ?${codeModifie ? " AND parcel_status = 'WAITING_PICKUP'" : ''}`,
        [
          ...(codeModifie ? [nouveauCode] : []),
          receiver,
          phone,
          city,
          address,
          note,
          String(price),
          deliveredFees,
          extraFees,
          returnedFees,
          refusedFees,
          replace,
          pickupCity,
          ...(modifiable('pickupCity') ? [agenceId ? String(agenceId) : ''] : []),
          now,
          parcel.parcel_id
        ]
      );
      if (codeModifie) {
        if (!result.affectedRows) {
          await conn.rollback();
          return res.status(409).json({
            message: 'Le code colis ne peut plus être modifié : ce colis a déjà été ramassé.'
          });
        }
        await renommerCodeMouvementsStock(conn, parcel.parcel_id, ancienCode, nouveauCode);
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Champs affichés dans la ligne de la datatable, pour mise à jour immédiate.
    res.json({
      parcel_id: parcel.parcel_id,
      parcel_receiver: receiver,
      parcel_phone: phone,
      parcel_price: String(price),
      ville: destVille.nom_ville,
      // Adresse : affichée sous la ville sur la page « Sans adresse ».
      parcel_address: address,
      // Code (éventuellement nouveau) + indicateur pour la modale de
      // confirmation « Vous avez modifié le code colis ».
      parcel_code: nouveauCode,
      code_modifie: codeModifie ? 1 : 0
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/:id/reclamation — modale admin "Réclamation" : enregistre
 * dans delevery_reclamation_suivre les infos du colis (client, livreur, zone,
 * ville de destination) + commentaire facultatif, statut EN_COURS,
 * reclamation_user = employé connecté.
 */
async function createParcelReclamation(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_customer, p.parcel_livreur,
       t.nom_ville AS ville, z.zone_name AS zone, c.customers_store AS magasin`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    let livreur = '';
    if (Number(parcel.parcel_livreur) > 0) {
      const [[row]] = await pool.query(
        `SELECT users_name AS name FROM delevery_users WHERE users_id = ? LIMIT 1`,
        [Number(parcel.parcel_livreur)]
      );
      livreur = row?.name || '';
    }

    const commentaire = String(req.body?.commentaire || '').trim().slice(0, 5000);
    const infos = [
      `Client : ${parcel.magasin || '—'}`,
      `Livreur : ${livreur || '—'}`,
      `Zone : ${parcel.zone || '—'}`,
      `Ville de destination : ${parcel.ville || '—'}`
    ].join('\n');
    const texte = commentaire ? `${infos}\n\nCommentaire : ${commentaire}` : infos;

    const [recl] = await pool.query(
      `INSERT INTO delevery_reclamation_suivre
         (reclamation_parcel, reclamation_titre, reclamation_text, reclamation_statut,
          reclamation_user, reclamation_time)
       VALUES (?, ?, ?, 'EN_COURS', ?, ?)`,
      [
        parcel.parcel_id,
        `Réclamation colis ${parcel.parcel_code || parcel.parcel_id}`,
        texte,
        Number(req.user.id) || 0,
        Math.floor(Date.now() / 1000)
      ]
    );

    res.status(201).json({ parcel_id: parcel.parcel_id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/:id/remboursement — modale admin "Demande remboursement" :
 * mêmes règles que la version client (colis DELIVERED, pas un colis de
 * remboursement, pas de demande en attente ou acceptée — utils/remboursement)
 * mais sans plafond — l'admin peut demander un montant supérieur au montant du
 * colis. Body { montant, recuperer: 0|1, commentaire? }. La demande est
 * enregistrée dans delevery_remboursement (PENDING) au nom du client du colis
 * et traitée sur la page admin Remboursement ; le colis original n'est pas
 * marqué parcel_is_remb.
 */
async function createParcelRemboursement(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_is_remb,
       p.parcel_price, p.parcel_crbt_zero, p.parcel_customer`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status !== 'DELIVERED' || Number(parcel.parcel_is_remb) === 1) {
      return res.status(400).json({ message: 'Ce colis ne peut pas faire l’objet d’un remboursement.' });
    }
    if (await hasDemandeEnCours(parcel.parcel_id)) {
      return res.status(400).json({ message: 'Une demande de remboursement est déjà en cours pour ce colis.' });
    }

    const montantReel = Number(parcel.parcel_crbt_zero) === 1 ? 0 : Number(parcel.parcel_price) || 0;
    const montant = Number(req.body?.montant);
    const recuperer = Number(req.body?.recuperer) === 1 ? 1 : 0;
    const commentaire = String(req.body?.commentaire || '').trim().slice(0, 2000);
    if (!Number.isFinite(montant) || montant <= 0) {
      return res.status(400).json({ message: 'Montant à rembourser invalide.' });
    }

    const [remb] = await pool.query(
      `INSERT INTO delevery_remboursement
         (remb_parcel_id, remb_parcel_code, remb_customer, remb_member, remb_montant_reel,
          remb_montant, remb_recuperer_colis, remb_commentaire, remb_statut, remb_time)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        parcel.parcel_id,
        parcel.parcel_code || '',
        Number(parcel.parcel_customer) || 0,
        montantReel,
        montant,
        recuperer,
        commentaire,
        Math.floor(Date.now() / 1000)
      ]
    );

    res.status(201).json({ parcel_id: parcel.parcel_id, remb_demande: 1 });
  } catch (err) {
    next(err);
  }
}

/* Statuts seconds du circuit retour (posés avec parcel_status = RETURNED par
 * les bons de retour livreur / client) : réservés à ce circuit, jamais
 * proposés ni acceptés par la modale "Changer statut". */
const STATUTS_CIRCUIT_RETOUR = [
  'EXPEDIE_AGENCE_PRINCIPALE',
  'RECU_PAR_AGENCE',
  'RETURNED_TO_CUSTOMER',
  'RECU_BY_CUSTOMER',
  'RETURNED_TO_STOCK'
];

/**
 * GET /api/parcels/statuts/actifs — statuts actifs proposés par la modale
 * "Changer statut" : uniquement les statuts seconds (type 3, ceux de la
 * distribution), parcel_statut_active = 1, hors circuit retour. « Attente
 * réexpédition » (WAITING_RESHIP) n'est proposé qu'aux employés de type 1-4 :
 * un livreur (GET /livreurs/me/colis/statuts/actifs) ou un ramasseur ne le
 * voit jamais (utils/reexpedition). « Attente confirmation »
 * (WAITING_CONFIRMATION) n'est jamais proposé : il n'est posé que par le scan
 * de la page « Sans adresse » (utils/sansAdresse).
 */
async function listActiveStatuts(req, res, next) {
  try {
    const exclus = peutReexpedier(req.user)
      ? [...STATUTS_CIRCUIT_RETOUR, STATUT_ATTENTE_CONFIRMATION]
      : [...STATUTS_CIRCUIT_RETOUR, STATUT_ATTENTE_REEXPEDITION, STATUT_ATTENTE_CONFIRMATION];
    // Libellé français joint (même source que /parcels/statuts/libelles) :
    // évite un second appel aux intégrations API des livreurs.
    const [rows] = await pool.query(
      `SELECT s.parcel_statut_code AS code, s.parcel_statut_type AS type,
              s.parcel_statut_color AS color,
              COALESCE(st.string_text, s.parcel_statut_code) AS nom
         FROM delevery_parcel_statut s
         LEFT JOIN (SELECT string_ref, MIN(string_text) AS string_text
                      FROM delevery_string
                     WHERE string_lang = 'fr'
                     GROUP BY string_ref) st
           ON st.string_ref COLLATE utf8mb4_unicode_ci = s.parcel_statut_name
        WHERE s.parcel_statut_active = 1 AND s.parcel_statut_type = 3
          AND s.parcel_statut_code NOT IN (?)
        ORDER BY s.parcel_statut_id`,
      [exclus]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/* Statuts au commentaire livreur obligatoire / à date obligatoire. */
const STATUTS_COMMENT_OBLIGATOIRE = ['REFUSE', 'CANCELED'];
const STATUTS_AVEC_DATE = ['PROGRAMMER', 'POSTPONED'];

/* Statuts (bruts) d'un colis dont le statut peut être changé depuis la modale. */
const STATUTS_CHANGEABLES = ['DISTRIBUTION', 'IN_PROGRESS'];

/* Colonnes du colis nécessaires au changement de statut (admin et livreur). */
const COLONNES_CHANGEMENT_STATUT = `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_status_second,
       p.parcel_situation, p.parcel_livreur, p.parcel_report_time,
       COALESCE(p.parcel_paid_livreur, 0)   AS parcel_paid_livreur,
       COALESCE(p.parcel_refuse_livreur, 0) AS parcel_refuse_livreur`;

/**
 * POST /api/parcels/:id/statut — modale "Changer statut", réservée aux colis
 * en distribution (parcel_status = DISTRIBUTION ou IN_PROGRESS). Un colis déjà
 * livré est refusé : sa livraison s'annule via POST /:id/non-livre ("Colis non
 * livré").
 * Body : { statut (type 3 uniquement), commentaire?, date? (AAAA-MM-JJ) }.
 * Commentaire du livreur facultatif mais obligatoire pour REFUSE / CANCELED ;
 * remplacé par une date (obligatoire) pour PROGRAMMER / POSTPONED, stockée en
 * "JJ/MM/AAAA" dans parcel_report_time (convention legacy).
 * DELIVERED est un statut principal : parcel_status = DELIVERED sans statut
 * second (+ parcel_delivery_time / parcel_delivered_by). Les autres statuts
 * type 3 → parcel_status = IN_PROGRESS + parcel_status_second (mêmes règles
 * que l'affichage). Ligne d'historique avec commentaire, utilisateur et
 * livreur affecté. Refusé (409) si le colis est sur une facture livreur :
 * il doit d'abord en être retiré (cohérence de la ligne de facture).
 * « Attente réexpédition » (WAITING_RESHIP) : réservé aux types 1-4, et un
 * colis qui le porte est verrouillé (403) pour les types 5 et 6 — il repart
 * ensuite par un bon d'envoi (utils/reexpedition).
 */
async function changeParcelStatut(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, COLONNES_CHANGEMENT_STATUT);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    return appliquerChangementStatut(req, res, next, parcel);
  } catch (err) {
    next(err);
  }
}

/*
 * Cœur du changement de statut, partagé entre la modale admin
 * (changeParcelStatut) et le dashboard livreur (changerStatutMonColis) :
 * l'appelant charge le colis (COLONNES_CHANGEMENT_STATUT) selon son propre
 * scope, cette fonction applique toutes les règles et répond elle-même.
 */
async function appliquerChangementStatut(req, res, next, parcel) {
  try {
    // Colis sur une facture livreur (ex. refusé facturé) : statut verrouillé,
    // la ligne de facture doit rester cohérente avec le colis.
    if (surFactureLivreur(parcel)) {
      return res.status(409).json({
        message: await messageFactureLivreur(parcel.parcel_id, 'changer son statut')
      });
    }
    const estLivre =
      parcel.parcel_status === 'DELIVERED' ||
      (parcel.parcel_status === 'IN_PROGRESS' &&
        String(parcel.parcel_status_second || '').trim() === 'DELIVERED');
    if (estLivre) {
      return res.status(400).json({
        message: 'Colis livré : utilisez « Colis non livré » pour annuler la livraison.'
      });
    }
    if (!STATUTS_CHANGEABLES.includes(parcel.parcel_status)) {
      return res.status(400).json({
        message: 'Le statut ne peut être changé que pour un colis en distribution.'
      });
    }
    // Colis en attente de réexpédition : statut verrouillé pour le livreur
    // (et le ramasseur) — il attend son bon d'envoi ; seuls les types 1-4
    // peuvent encore le changer.
    if (
      enAttenteReexpedition(parcel.parcel_status, parcel.parcel_status_second) &&
      !peutReexpedier(req.user)
    ) {
      return res.status(403).json({
        message:
          "Colis en attente de réexpédition : son statut est verrouillé par l'administration."
      });
    }
    // Colis en attente de confirmation (scan « Sans adresse ») : même verrou
    // pour le livreur et le ramasseur ; seuls les types 1-4 le font évoluer.
    if (
      enAttenteConfirmation(parcel.parcel_status, parcel.parcel_status_second) &&
      !peutConfirmer(req.user)
    ) {
      return res.status(403).json({
        message:
          "Colis en attente de confirmation : son statut est verrouillé par l'administration."
      });
    }

    const code = String(req.body?.statut || '').trim().slice(0, 50);
    if (!code) return res.status(400).json({ message: 'Veuillez sélectionner un statut.' });
    // Statuts du circuit retour : posés uniquement par les bons de retour.
    if (STATUTS_CIRCUIT_RETOUR.includes(code)) {
      return res.status(400).json({ message: 'Statut introuvable ou inactif.' });
    }
    // « Attente confirmation » : posé uniquement par le scan de la page Sans adresse.
    if (code === STATUT_ATTENTE_CONFIRMATION) {
      return res.status(400).json({
        message:
          'Statut « Attente confirmation » réservé au scan de la page Colis besoin d\'attention › Sans adresse.'
      });
    }
    // « Attente réexpédition » : réservé aux employés de type 1-4 (jamais
    // proposé aux types 5 et 6 par /statuts/actifs, refusé ici si forcé).
    if (code === STATUT_ATTENTE_REEXPEDITION && !peutReexpedier(req.user)) {
      return res.status(403).json({
        message: "Statut « Attente réexpédition » réservé à l'administration."
      });
    }

    const [[statut]] = await pool.query(
      `SELECT parcel_statut_code AS code, parcel_statut_type AS type,
              parcel_statut_color AS color
         FROM delevery_parcel_statut
        WHERE parcel_statut_code = ? AND parcel_statut_active = 1
          AND parcel_statut_type = 3
        LIMIT 1`,
      [code]
    );
    if (!statut) return res.status(400).json({ message: 'Statut introuvable ou inactif.' });

    const commentaire = String(req.body?.commentaire || '').trim().slice(0, 2000);
    if (STATUTS_COMMENT_OBLIGATOIRE.includes(code) && !commentaire) {
      return res.status(400).json({
        message: 'Le commentaire du livreur est obligatoire pour ce statut.'
      });
    }

    // Preuve photo (champ multipart « preuve », facultatif, middleware
    // handlePreuveUpload) : URL gardée sur la ligne d'historique et affichée
    // dans le détail de suivi admin / client. Refusée tant que la colonne
    // parcel_history_preuve n'existe pas (le fichier reçu est alors retiré du
    // disque par le middleware, comme après tout refus).
    const preuveOk = await historyPreuveDisponible();
    let preuve = null;
    if (req.file) {
      if (!preuveOk) {
        return res.status(400).json({
          message: `L'ajout d'une preuve est indisponible : migration ${PREUVE_MIGRATION} à exécuter.`
        });
      }
      preuve = preuveUrl(req.file.filename);
    }

    // Date programmée / reportée : reçue en AAAA-MM-JJ, stockée en JJ/MM/AAAA.
    let reportTime = null;
    let reportUnix = null;
    if (STATUTS_AVEC_DATE.includes(code)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.body?.date || '').trim());
      if (!m) return res.status(400).json({ message: 'La date est obligatoire pour ce statut.' });
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ message: 'Date invalide.' });
      }
      reportTime = `${m[3]}/${m[2]}/${m[1]}`;
      reportUnix = Math.floor(d.getTime() / 1000);
    }

    // DELIVERED = statut principal (parcel_status, sans statut second) ; les
    // autres statuts type 3 : parcel_status = IN_PROGRESS, comme l'affichage.
    const newStatus = code === 'DELIVERED' ? 'DELIVERED' : 'IN_PROGRESS';
    const newSecond = code === 'DELIVERED' ? '' : code;

    const sets = ['parcel_status = ?', 'parcel_status_second = ?', 'parcel_last_update = ?'];
    const now = Math.floor(Date.now() / 1000);
    const setParams = [newStatus, newSecond, now];
    if (code === 'DELIVERED') {
      sets.push('parcel_delivery_time = ?', 'parcel_delivered_by = ?');
      setParams.push(now, Number(parcel.parcel_livreur) || 0);
    }
    if (reportTime !== null) {
      sets.push('parcel_report_time = ?');
      setParams.push(reportTime);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_parcel SET ${sets.join(', ')} WHERE parcel_id = ?`,
        [...setParams, parcel.parcel_id]
      );
      // parcel_history_data : date programmée en timestamp unix (convention legacy).
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_status_second, parcel_history_comment,
            parcel_history_data, parcel_history_time, parcel_history_livreur, parcel_history_by
            ${preuveOk ? ', parcel_history_preuve' : ''})
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?${preuveOk ? ', ?' : ''})`,
        [
          parcel.parcel_id,
          parcel.parcel_situation || '',
          newStatus,
          newSecond,
          commentaire,
          reportUnix !== null ? String(reportUnix) : '',
          now,
          Number(parcel.parcel_livreur) || 0,
          Number(req.user.id) || 0,
          ...(preuveOk ? [preuve] : [])
        ]
      );
      await conn.commit();
      // Fichier référencé en base : le middleware ne doit plus le retirer.
      res.locals.preuveEnregistree = true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Statut effectif affiché dans la ligne (la situation INVOICED prime).
    const effectif = parcel.parcel_situation === 'INVOICED' ? 'INVOICED' : code;
    res.json({
      parcel_id: parcel.parcel_id,
      parcel_code: parcel.parcel_code,
      parcel_status: newStatus,
      statut: effectif,
      statut_color: effectif === code ? statut.color : null,
      report_time: reportTime,
      preuve
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/parcels/:id — suppression d'un colis encore en attente de
 * ramassage (parcel_status = WAITING_PICKUP), après confirmation côté
 * navigateur. Dans une même transaction : pour un colis de stock, le stock des
 * produits est restauré (mouvement « colis supprimé » tracé) et le contenu du
 * colis supprimé ; l'historique et les traces de modification sont supprimés
 * avec le colis.
 */
async function deleteParcel(req, res, next) {
  try {
    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_customer, p.parcel_from_stock`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status !== 'WAITING_PICKUP') {
      return res.status(400).json({
        message: 'Seul un colis en attente de ramassage peut être supprimé.'
      });
    }

    // Preuves photo des changements de statut : fichiers retirés du disque
    // une fois la suppression validée.
    let preuves = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Colis de stock : restaure les quantités déduites à la création
      // (une ligne de contenu par unité) et trace le mouvement.
      if (Number(parcel.parcel_from_stock) === 1) {
        const [contenus] = await conn.query(
          `SELECT parcel_content_product_id AS product_id, COUNT(*) AS qty
             FROM delevery_parcel_content
            WHERE parcel_content_parcel_id = ?
            GROUP BY parcel_content_product_id
            ORDER BY parcel_content_product_id`,
          [parcel.parcel_id]
        );
        for (const c of contenus) {
          if (!Number(c.product_id)) continue;
          await conn.query(
            `UPDATE delevery_product SET product_qte = product_qte + ? WHERE product_id = ?`,
            [Number(c.qty), Number(c.product_id)]
          );
          await conn.query(
            `INSERT INTO delevery_product_mvnt
               (id_product, mvnt_qte, mvnt_type, mvnt_date, mvnt_by, mvnt_commentaire, mvnt_validate_by, mvnt_note)
             VALUES (?, ?, 'colis supprimé', NOW(), ?, NULL, NULL, ?)`,
            [Number(c.product_id), Number(c.qty), Number(req.user.id) || 0, parcel.parcel_code || '']
          );
        }
        await conn.query(
          `DELETE FROM delevery_parcel_content WHERE parcel_content_parcel_id = ?`,
          [parcel.parcel_id]
        );
      }

      if (await historyPreuveDisponible()) {
        const [rows] = await conn.query(
          `SELECT parcel_history_preuve AS preuve FROM delevery_parcel_history
            WHERE parcel_history_parcel = ? AND COALESCE(parcel_history_preuve, '') <> ''`,
          [parcel.parcel_id]
        );
        preuves = rows.map((r) => r.preuve);
      }
      await conn.query(`DELETE FROM delevery_parcel_history WHERE parcel_history_parcel = ?`, [
        parcel.parcel_id
      ]);
      await conn.query(`DELETE FROM delevery_parcel_modification WHERE modif_parcel = ?`, [
        parcel.parcel_id
      ]);
      await conn.query(`DELETE FROM delevery_parcel WHERE parcel_id = ?`, [parcel.parcel_id]);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    preuves.forEach(supprimerPreuve);

    res.json({ parcel_id: parcel.parcel_id, deleted: true });
  } catch (err) {
    next(err);
  }
}

/* Types d'employé autorisés à annuler une livraison ("Colis non livré"). */
const NON_LIVRE_TYPES = [1, 2];

/** Vrai si la ligne d'historique correspond au statut effectif DELIVERED. */
function isHistoDelivered(h) {
  const second = String(h.parcel_history_status_second || '').trim();
  const status = String(h.parcel_history_status || '').trim();
  return second === 'DELIVERED' || (!second && status === 'DELIVERED');
}

/**
 * POST /api/parcels/:id/non-livre — bouton "Colis non livré", réservé aux
 * employés type 1 / 2 : supprime le statut "Livré" d'un colis (les lignes
 * d'historique DELIVERED en fin de parcours) et remet le colis au statut
 * précédent (dernière ligne d'historique non livrée ; DISTRIBUTION à défaut).
 * Refusé si le colis est déjà facturé (parcel_situation = INVOICED) ou s'il
 * est sur une facture livreur (retrait de la facture obligatoire d'abord).
 */
async function revertDelivered(req, res, next) {
  try {
    if (req.user.kind !== 'employee' || !NON_LIVRE_TYPES.includes(Number(req.user.role))) {
      return res.status(403).json({ message: 'Action réservée aux administrateurs.' });
    }

    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_status, p.parcel_status_second, p.parcel_situation,
       COALESCE(p.parcel_paid_livreur, 0)   AS parcel_paid_livreur,
       COALESCE(p.parcel_refuse_livreur, 0) AS parcel_refuse_livreur`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });

    const estLivre =
      parcel.parcel_status === 'DELIVERED' ||
      (parcel.parcel_status === 'IN_PROGRESS' &&
        String(parcel.parcel_status_second || '').trim() === 'DELIVERED');
    if (!estLivre) {
      return res.status(400).json({ message: 'Ce colis n’est pas au statut « Livré ».' });
    }
    if (parcel.parcel_situation === 'INVOICED') {
      return res.status(400).json({ message: 'Colis déjà facturé : livraison non annulable.' });
    }
    // Colis payé / à payer au livreur : la livraison ne peut pas être annulée
    // tant qu'il est sur la facture livreur.
    if (surFactureLivreur(parcel)) {
      return res.status(409).json({
        message: await messageFactureLivreur(parcel.parcel_id, 'annuler la livraison')
      });
    }
    // Colis échange livré engagé sur un bon de retour : la livraison ne peut
    // pas être annulée tant que la marchandise échangée est en circuit retour.
    if (STATUTS_CIRCUIT_RETOUR.includes(String(parcel.parcel_status_second || '').trim())) {
      return res.status(409).json({
        message:
          'Colis échange en circuit de retour : retirez-le du bon de retour avant d’annuler la livraison.'
      });
    }

    // parcel_history_preuve : photo jointe à la livraison, retirée du disque
    // avec la ligne d'historique supprimée (absente sans la migration).
    const preuveOk = await historyPreuveDisponible();
    const [histo] = await pool.query(
      `SELECT parcel_history_id, parcel_history_status, parcel_history_status_second
              ${preuveOk ? ', parcel_history_preuve' : ''}
         FROM delevery_parcel_history
        WHERE parcel_history_parcel = ?
        ORDER BY parcel_history_time ASC, parcel_history_id ASC`,
      [parcel.parcel_id]
    );

    // Dernière étape non livrée = statut auquel revenir ; les lignes DELIVERED
    // qui la suivent sont supprimées de l'historique.
    let previous = null;
    for (const h of histo) {
      if (!isHistoDelivered(h)) previous = h;
    }
    const newStatus = String(previous?.parcel_history_status || '').trim() || 'DISTRIBUTION';
    const newSecond = String(previous?.parcel_history_status_second || '').trim();
    const deleteIds = histo
      .filter(
        (h) =>
          isHistoDelivered(h) &&
          (!previous || Number(h.parcel_history_id) > Number(previous.parcel_history_id))
      )
      .map((h) => h.parcel_history_id);

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (deleteIds.length) {
        await conn.query(`DELETE FROM delevery_parcel_history WHERE parcel_history_id IN (?)`, [
          deleteIds
        ]);
      }
      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_status = ?, parcel_status_second = ?, parcel_delivery_time = 0,
                parcel_delivered_by = 0, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [newStatus, newSecond, now, parcel.parcel_id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    histo
      .filter((h) => deleteIds.includes(h.parcel_history_id))
      .forEach((h) => supprimerPreuve(h.parcel_history_preuve));

    // Statut effectif après retour (mêmes règles que l'affichage de la liste).
    const effectif = newStatus === 'IN_PROGRESS' && newSecond ? newSecond : newStatus;
    const [[color]] = await pool.query(
      `SELECT MIN(parcel_statut_color) AS color
         FROM delevery_parcel_statut WHERE parcel_statut_code = ?`,
      [effectif]
    );
    res.json({
      parcel_id: parcel.parcel_id,
      parcel_status: newStatus,
      statut: effectif,
      statut_color: color?.color || null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/parcels/livreurs/actifs — livreurs actifs (users_type = 5,
 * users_active = 1) proposés par la modale « Changer livreur » de la
 * datatable Colis : [{ id, label }], triés par nom.
 */
async function listLivreursActifs(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT users_id AS id, users_name AS label
         FROM delevery_users
        WHERE users_type = '5' AND users_active = 1
        ORDER BY users_name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/:id/livreur — bouton « Changer livreur » (employés
 * type 1 / 2, requireRole sur la route), body { livreurId } : réaffecte un
 * colis déjà affecté (parcel_livreur > 0) à un autre livreur actif. Refusé
 * pour un colis retourné (parcel_status = RETURNED, « Retourné au stock »
 * compris), pour un colis échange livré en circuit de retour (DELIVERED +
 * statut second de STATUTS_CIRCUIT_RETOUR) et si le colis est sur une
 * facture livreur (payé / à payer à l'ancien livreur). Trace une ligne
 * d'historique data = LIVREUR_CHANGED (ancien →
 * nouveau livreur en commentaire, parcel_history_livreur = nouveau livreur),
 * affichée « Livreur changé » dans le suivi. Le lien avec le bon de
 * distribution en cours (delevery_dis_parcels) n'est pas modifié.
 */
async function changerLivreur(req, res, next) {
  try {
    const livreurId = parseInt(req.body?.livreurId, 10);
    if (!Number.isInteger(livreurId) || livreurId <= 0) {
      return res.status(400).json({ message: 'Choisissez un livreur.' });
    }

    const parcel = await loadAdminParcel(
      req,
      `p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_status_second, p.parcel_situation,
       COALESCE(p.parcel_livreur, 0)        AS parcel_livreur,
       COALESCE(p.parcel_paid_livreur, 0)   AS parcel_paid_livreur,
       COALESCE(p.parcel_refuse_livreur, 0) AS parcel_refuse_livreur`
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (Number(parcel.parcel_livreur) <= 0) {
      return res.status(400).json({ message: 'Ce colis n’est affecté à aucun livreur.' });
    }
    if (parcel.parcel_status === 'RETURNED') {
      return res.status(400).json({ message: 'Colis retourné : le livreur ne peut plus être changé.' });
    }
    if (
      parcel.parcel_status === 'DELIVERED' &&
      STATUTS_CIRCUIT_RETOUR.includes(String(parcel.parcel_status_second || '').trim())
    ) {
      return res.status(400).json({
        message: 'Colis échange en circuit de retour : le livreur ne peut plus être changé.'
      });
    }
    if (Number(parcel.parcel_livreur) === livreurId) {
      return res.status(400).json({ message: 'Ce colis est déjà affecté à ce livreur.' });
    }
    if (surFactureLivreur(parcel)) {
      return res.status(409).json({
        message: await messageFactureLivreur(parcel.parcel_id, 'changer le livreur')
      });
    }

    const [[nouveau]] = await pool.query(
      `SELECT users_id, users_name
         FROM delevery_users
        WHERE users_id = ? AND users_type = '5' AND users_active = 1
        LIMIT 1`,
      [livreurId]
    );
    if (!nouveau) return res.status(400).json({ message: 'Livreur introuvable ou désactivé.' });
    const [[ancien]] = await pool.query(
      `SELECT users_name FROM delevery_users WHERE users_id = ? LIMIT 1`,
      [Number(parcel.parcel_livreur)]
    );

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_livreur = ?, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [livreurId, now, parcel.parcel_id]
      );
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_data, parcel_history_comment,
            parcel_history_time, parcel_history_by, parcel_history_livreur)
         VALUES (?, 0, ?, '', 'LIVREUR_CHANGED', ?, ?, ?, ?)`,
        [
          parcel.parcel_id,
          parcel.parcel_situation || '',
          `${ancien?.users_name || '—'} → ${nouveau.users_name}`,
          now,
          Number(req.user.id) || 0,
          livreurId
        ]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({
      parcel_id: parcel.parcel_id,
      parcel_livreur: livreurId,
      livreur: nouveau.users_name
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/:id/annuler-ramassage — bouton "Annuler ramassage" de la
 * datatable admin : un colis ramassé (PICKED_UP) revient en attente de
 * ramassage (WAITING_PICKUP). Les lignes d'historique PICKED_UP (la ligne
 * « Ramassé » du suivi) sont supprimées et parcel_pickup_time remis à 0,
 * exactement l'inverse du ramassage par scan.
 */
async function annulerRamassage(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, `p.parcel_id, p.parcel_status`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    if (parcel.parcel_status !== 'PICKED_UP') {
      return res.status(400).json({
        message: 'Seul un colis au statut « Ramassé » peut revenir en attente de ramassage.'
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `DELETE FROM delevery_parcel_history
          WHERE parcel_history_parcel = ? AND parcel_history_status = 'PICKED_UP'`,
        [parcel.parcel_id]
      );
      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_status = 'WAITING_PICKUP', parcel_pickup_time = 0, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [now, parcel.parcel_id]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [[color]] = await pool.query(
      `SELECT MIN(parcel_statut_color) AS color
         FROM delevery_parcel_statut WHERE parcel_statut_code = 'WAITING_PICKUP'`
    );
    res.json({
      parcel_id: parcel.parcel_id,
      parcel_status: 'WAITING_PICKUP',
      statut: 'WAITING_PICKUP',
      statut_color: color?.color || null
    });
  } catch (err) {
    next(err);
  }
}

/*
 * Suivi de retour (étapes 1 / 2 / 3) : colis « en circulation » sans mise à
 * jour récente, mêmes règles que l'ancien système (retour_suivre_etapeN) :
 * colis IN_PROGRESS dont le sous-statut n'est pas une attente volontaire
 * (Reporté, Programmé, Client intéressé, Relance nouveau client, En attente
 * de relance), ou colis livrés à remplacer dont l'échange n'est pas encore
 * retourné (parcel_replace = 1 et parcel_returned_livreur = 0).
 */
const SUIVI_RETOUR_ETAPES = {
  1: { min: 2, max: 7 }, // sans mise à jour depuis 2 à 7 jours
  2: { min: 7, max: 30 }, // depuis 7 à 30 jours
  3: { min: 30, max: null } // depuis plus de 30 jours
};

/* Types d'employé autorisés à consulter l'étape 3 (comme l'ancien système). */
const SUIVI_RETOUR_ETAPE3_TYPES = [1, 2];

/* Sous-statuts d'attente volontaire : colis exclus du suivi de retour
 * (dont « Attente réexpédition », qui repart par un bon d'envoi). */
const SOUS_STATUTS_ATTENTE = [
  'POSTPONED',
  'PROGRAMMER',
  'CLIENT_INTERESE',
  'RELENCE_NEW_CLIENT',
  'WAIT_RELANCE',
  STATUT_ATTENTE_REEXPEDITION
];

/**
 * GET /api/parcels/suivi-retour?etape=1|2|3 — liste complète (sans
 * pagination, comme l'ancien système) triée de la plus ancienne mise à jour à
 * la plus récente. Employés type 3/4/6 : restreint aux colis de leur agence et
 * à l'étape 3 interdite. `now` (timestamp serveur) sert au calcul des jours
 * écoulés côté frontend.
 */
async function listSuiviRetour(req, res, next) {
  try {
    const etapeNum = parseInt(req.query.etape, 10);
    const etape = SUIVI_RETOUR_ETAPES[etapeNum];
    if (!etape) return res.status(400).json({ message: 'Étape invalide.' });
    if (
      etapeNum === 3 &&
      (req.user.kind !== 'employee' || !SUIVI_RETOUR_ETAPE3_TYPES.includes(Number(req.user.role)))
    ) {
      return res.status(403).json({ message: 'Étape réservée aux administrateurs.' });
    }

    const now = Math.floor(Date.now() / 1000);
    // Colis échange livré déjà engagé sur un bon de retour (statut second du
    // circuit) : plus rien à suivre, le circuit le trace.
    const where = [
      `((p.parcel_status = 'IN_PROGRESS' AND COALESCE(p.parcel_status_second, '') NOT IN (?))
        OR (p.parcel_status = 'DELIVERED' AND p.parcel_replace = '1' AND p.parcel_returned_livreur = '0'
            AND COALESCE(p.parcel_status_second, '') NOT IN (?)))`,
      'p.parcel_last_update > 0',
      'p.parcel_last_update <= ?'
    ];
    const params = [SOUS_STATUTS_ATTENTE, STATUTS_CIRCUIT_RETOUR, now - etape.min * 86400];
    if (etape.max) {
      where.push('p.parcel_last_update > ?');
      params.push(now - etape.max * 86400);
    }
    // Types 3/4/6 : uniquement les colis de leur agence (comme la liste Colis).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      where.push(scope.sql);
      params.push(...scope.params);
    }

    const [rows] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_replace,
              p.parcel_status_second AS sous_statut, s.parcel_statut_color AS sous_statut_color,
              p.parcel_last_update, p.parcel_livreur,
              c.customers_store AS magasin, t.nom_ville AS ville, l.users_name AS livreur
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = p.parcel_status_second AND s.parcel_statut_type = 3
        WHERE ${where.join(' AND ')}
        ORDER BY p.parcel_last_update ASC`,
      params
    );

    res.json({ rows, now });
  } catch (err) {
    next(err);
  }
}

/*
 * Colis besoin d'attention : mêmes groupes de statuts que l'ancien système
 * (colis_bloques), répartis sur deux pages :
 * - « alerte » (Colis alerte 00H00) : colis dont le dernier changement de
 *   statut date d'avant minuit du jour courant (on a dépassé 00h00 du jour
 *   suivant le changement) ; Programmés / Reportés : à partir de 00h00 du
 *   jour suivant la date programmée (convention de l'ancien système) ;
 * - « suivre » (Colis à suivre) : dès le changement de statut, sans délai,
 *   y compris les colis passés RETURNED dont le dernier statut avant le
 *   retour est un des statuts de la page.
 */
const ATTENTION_ALERTE = {
  relance: ['RELENCE_NEW_CLIENT', 'CLIENT_INTERESE', 'WAIT_RELANCE'],
  programme: ['PROGRAMMER', 'POSTPONED']
};
const ATTENTION_SUIVRE = {
  verifier: ['OUT_OF_AREA', 'ERR', 'EN_VOYAGE'],
  sans_reponse: ['NOANSWER', 'DEUX', 'TROIS', 'BV', 'UNREACHABLE'],
  annule: ['CANCELED', 'REFUSE']
};

/* Statuts seconds d'un colis RETURNED encore dans le circuit de retour du
   nouveau système (le sous-statut d'avant retour est alors conservé dans
   delevery_rn_parcels.rn_parcels_status_before) ; RECU_BY_CUSTOMER = retour
   terminé, exclu. */
const STATUTS_CIRCUIT_EN_COURS = [
  'EXPEDIE_AGENCE_PRINCIPALE',
  'RECU_PAR_AGENCE',
  'RETURNED_TO_CITY_RAMASSAGE',
  'RECU_VILLE_RAMASSAGE',
  'RETURNED_TO_CUSTOMER'
];

/* parcel_report_time est stocké en "JJ/MM/AAAA" (legacy) ou "AAAA-MM-JJ". */
const REPORT_DATE_SQL = `CASE WHEN p.parcel_report_time REGEXP '^[0-9]{4}-'
       THEN STR_TO_DATE(p.parcel_report_time, '%Y-%m-%d')
       ELSE STR_TO_DATE(p.parcel_report_time, '%d/%m/%Y') END`;

/* Dernier commentaire livreur non vide de l'historique du colis ; les lignes
   du circuit de retour (statut RETURNED, messages système « Expédier vers
   client »…) sont ignorées pour garder le vrai commentaire du livreur. */
const COMMENTAIRE_SQL = `(SELECT h.parcel_history_comment
       FROM delevery_parcel_history h
      WHERE h.parcel_history_parcel = p.parcel_id
        AND COALESCE(h.parcel_history_comment, '') <> ''
        AND COALESCE(h.parcel_history_status, '') <> 'RETURNED'
      ORDER BY h.parcel_history_time DESC, h.parcel_history_id DESC
      LIMIT 1)`;

/* Colis non marqué « traité » (table legacy delevery_parcel_verified, partagée
   avec l'ancien système) : un colis marqué est exclu de la page « à suivre »
   tant que son statut n'a pas rebougé depuis le marquage ; si son statut
   change à nouveau (parcel_last_update > verified_time), il réapparaît. */
const NON_TRAITE_SQL = ` AND NOT EXISTS (SELECT 1 FROM delevery_parcel_verified v
      WHERE v.parcel_id = p.parcel_id AND v.verified_time > p.parcel_last_update)`;

/** Groupe (onglet) d'un code statut dans une config de page ; null si absent. */
function attentionGroupe(code, groupes) {
  return Object.keys(groupes).find((g) => groupes[g].includes(code)) || null;
}

/**
 * GET /api/parcels/attention?page=alerte|suivre — liste complète (sans
 * pagination, comme l'ancien système colis_bloques) triée de la plus ancienne
 * mise à jour à la plus récente. Chaque ligne porte son groupe (onglet) ; les
 * compteurs et filtres (recherche, livreur, onglet) sont appliqués côté
 * frontend. Employés type 3/4/6 : restreint aux colis de leur agence.
 */
async function listColisAttention(req, res, next) {
  try {
    const page = req.query.page === 'suivre' ? 'suivre' : 'alerte';
    const now = Math.floor(Date.now() / 1000);

    let scopeSql = '';
    const scopeParams = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      scopeSql = ` AND ${scope.sql}`;
      scopeParams.push(...scope.params);
    }

    const selectCols = `p.parcel_id, p.parcel_code, p.parcel_status,
              CASE WHEN p.parcel_status = 'IN_PROGRESS' THEN p.parcel_status_second
                   ELSE p.parcel_status END AS statut,
              sc.color AS statut_color, p.parcel_report_time AS report_time,
              p.parcel_last_update, p.parcel_livreur,
              c.customers_store AS magasin, t.nom_ville AS ville, l.users_name AS livreur`;
    const joins = `LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur
         LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                      FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
           ON sc.parcel_statut_code = CASE WHEN p.parcel_status = 'IN_PROGRESS'
                THEN p.parcel_status_second ELSE p.parcel_status END`;

    let rows;
    if (page === 'alerte') {
      // Minuit du jour courant : dès 00h00, les colis dont le statut n'a pas
      // bougé depuis la veille (ou avant) passent en alerte.
      const minuit = new Date();
      minuit.setHours(0, 0, 0, 0);
      const midnight = Math.floor(minuit.getTime() / 1000);

      [rows] = await pool.query(
        `SELECT ${selectCols}
           FROM delevery_parcel p
           ${joins}
          WHERE (
                 (p.parcel_status = 'IN_PROGRESS' AND p.parcel_status_second IN (?)
                    AND p.parcel_last_update > 0 AND p.parcel_last_update < ?)
              OR (p.parcel_status = 'DISTRIBUTION'
                    AND p.parcel_last_update > 0 AND p.parcel_last_update < ?)
              OR (p.parcel_status = 'IN_PROGRESS' AND p.parcel_status_second IN (?)
                    AND COALESCE(${REPORT_DATE_SQL} < CURDATE(),
                                 (p.parcel_last_update > 0 AND p.parcel_last_update < ?)))
                )${scopeSql}
          ORDER BY p.parcel_last_update ASC`,
        [
          ATTENTION_ALERTE.relance,
          midnight,
          midnight,
          ATTENTION_ALERTE.programme,
          midnight,
          ...scopeParams
        ]
      );
      rows.forEach((r) => {
        r.groupe =
          r.parcel_status === 'DISTRIBUTION'
            ? 'distribution'
            : attentionGroupe(r.statut, ATTENTION_ALERTE);
      });
    } else {
      const statutsSuivre = Object.values(ATTENTION_SUIVRE).flat();

      // Colonnes supplémentaires de la page « à suivre » : adresse, zone de la
      // ville de livraison et dernier commentaire livreur de l'historique.
      const colsSuivre = `, p.parcel_address AS adresse, z.zone_name AS zone,
              ${COMMENTAIRE_SQL} AS commentaire`;
      const joinZone = ` LEFT JOIN delevery_zone z ON z.zone_id = t.zone`;

      // Colis actifs : dès le changement de statut, sans délai.
      const [actifs] = await pool.query(
        `SELECT ${selectCols}${colsSuivre}
           FROM delevery_parcel p
           ${joins}${joinZone}
          WHERE p.parcel_status = 'IN_PROGRESS' AND p.parcel_status_second IN (?)${NON_TRAITE_SQL}${scopeSql}
          ORDER BY p.parcel_last_update ASC`,
        [statutsSuivre, ...scopeParams]
      );
      actifs.forEach((r) => {
        r.groupe = attentionGroupe(r.statut, ATTENTION_SUIVRE);
      });

      // Colis RETURNED dont le retour n'est pas terminé (pas encore remis au
      // client : parcel_returned_customer <> 2, convention du circuit legacy)
      // et dont le dernier statut avant le retour est un statut de la page :
      // affichés « Retourné (statut avant) ». Le sous-statut d'avant retour
      // reste dans parcel_status_second (convention legacy).
      const [[retColor]] = await pool.query(
        `SELECT MIN(parcel_statut_color) AS color
           FROM delevery_parcel_statut WHERE parcel_statut_code = 'RETURNED'`
      );
      const selectColsRetour = `p.parcel_id, p.parcel_code, p.parcel_status,
              'RETURNED' AS statut, NULL AS statut_color,
              p.parcel_report_time AS report_time,
              p.parcel_last_update, p.parcel_livreur,
              c.customers_store AS magasin, t.nom_ville AS ville, l.users_name AS livreur`;
      const joinsRetour = `LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
           LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur`;
      const [retournes] = await pool.query(
        `SELECT ${selectColsRetour}${colsSuivre}, p.parcel_status_second AS statut_avant
           FROM delevery_parcel p
           ${joinsRetour}${joinZone}
          WHERE p.parcel_status = 'RETURNED' AND p.parcel_status_second IN (?)
            AND COALESCE(p.parcel_returned_customer, 0) <> 2${NON_TRAITE_SQL}${scopeSql}
          ORDER BY p.parcel_last_update ASC`,
        [statutsSuivre, ...scopeParams]
      );

      // Colis mis dans le circuit de retour par le nouveau système :
      // parcel_status_second est remplacé par le statut du circuit, le
      // sous-statut d'avant retour est dans delevery_rn_parcels (dernier ajout
      // à un bon de retour livreur).
      const [enCircuit] = await pool.query(
        `SELECT ${selectColsRetour}${colsSuivre}, rn.rn_parcels_status_before AS statut_avant
           FROM delevery_parcel p
           JOIN delevery_rn_parcels rn ON rn.rn_parcels_id = (
                SELECT rn2.rn_parcels_id
                  FROM delevery_rn_parcels rn2
                 WHERE rn2.rn_parcels_parcel = p.parcel_id
                 ORDER BY rn2.rn_parcels_time DESC, rn2.rn_parcels_id DESC
                 LIMIT 1)
           ${joinsRetour}${joinZone}
          WHERE p.parcel_status = 'RETURNED' AND p.parcel_status_second IN (?)
            AND rn.rn_parcels_status_before IN (?)${NON_TRAITE_SQL}${scopeSql}
          ORDER BY p.parcel_last_update ASC`,
        [STATUTS_CIRCUIT_EN_COURS, statutsSuivre, ...scopeParams]
      );

      [...retournes, ...enCircuit].forEach((r) => {
        r.statut_color = retColor?.color || null;
        r.groupe = attentionGroupe(r.statut_avant, ATTENTION_SUIVRE);
      });

      rows = [...actifs, ...retournes, ...enCircuit].sort(
        (a, b) => Number(a.parcel_last_update) - Number(b.parcel_last_update)
      );
    }

    res.json({ rows, now });
  } catch (err) {
    next(err);
  }
}

/*
 * Page « Programmé doublé » (fonctions 1-2) : colis encore en distribution
 * (DISTRIBUTION / IN_PROGRESS) dont les programmations — lignes d'historique
 * Programmé / Reporté — sont anormales :
 * - « +1 jour » : colis actuellement programmé / reporté dont la date
 *   programmée tombe au moins PROGRAMMATION_JOURS_MIN jour(s) après le jour
 *   où le statut a été posé (ex. posé le 16/09 pour le 17/09 ou plus tard) ;
 * - « double » : colis programmé / reporté au moins deux fois depuis sa
 *   création, quel que soit son statut actuel ;
 * - « +30 jours distribution » : colis expédié depuis au moins
 *   DISTRIBUTION_JOURS_MIN jours (parcel_sent_time) et toujours ni livré ni
 *   retourné — y compris ceux encore Envoyé / Reçu, jamais remis en
 *   distribution (les deux premiers onglets restent limités aux colis en
 *   distribution).
 * Les ré-envois d'une même programmation (double clic, relance réseau :
 * lignes d'historique à quelques secondes d'intervalle) comptent pour une
 * seule programmation (tranches de PROGRAMMATION_TRANCHE_SEC secondes).
 */
const PROGRAMMATION_STATUTS = ['PROGRAMMER', 'POSTPONED'];
const PROGRAMMATION_JOURS_MIN = 1;
const PROGRAMMATION_TRANCHE_SEC = 600;
const DISTRIBUTION_JOURS_MIN = 30;
/* Statuts principaux d'un colis expédié et non terminé (ni livré ni retourné). */
const STATUTS_EN_DISTRIBUTION = ['DISTRIBUTION', 'IN_PROGRESS'];
const STATUTS_EXPEDIE_NON_TERMINE = ['SENT', 'RECEIVED', ...STATUTS_EN_DISTRIBUTION];

/** Minuit local du jour d'un timestamp unix (secondes). */
function jourLocal(ts) {
  const d = new Date(Number(ts) * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** parcel_report_time ("JJ/MM/AAAA" legacy ou "AAAA-MM-JJ") → Date locale à minuit, ou null. */
function parseReportDate(value) {
  const v = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

/**
 * GET /api/parcels/attention/programmes — liste complète (sans pagination,
 * comme les autres pages Colis besoin d'attention) des colis « +1 jour »,
 * « double » et / ou « +30 jours distribution ». Chaque ligne porte ses
 * drapeaux plus_un_jour / double / plus_30_jours, l'écart en jours entre le
 * jour de programmation et la date programmée (jours), le nombre de
 * programmations et la date de la dernière, et les jours écoulés depuis
 * l'expédition (jours_expedition). Les colis
 * marqués « traité » (POST /:id/traiter, même marqueur que la page Colis à
 * suivre) sont exclus tant que leur statut n'a pas rebougé. Employés type
 * 3/4/6 : restreint aux colis de leur agence (route réservée aux types 1-2,
 * gardé par cohérence avec les autres pages).
 */
async function listColisProgrammes(req, res, next) {
  try {
    const now = Math.floor(Date.now() / 1000);

    let scopeSql = '';
    const scopeParams = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      scopeSql = ` AND ${scope.sql}`;
      scopeParams.push(...scope.params);
    }

    // Sous-requêtes corrélées sur l'index parcel_history_parcel : quelques
    // milliers de colis actifs, pas de balayage de l'historique complet.
    const [rows] = await pool.query(
      `SELECT x.* FROM (
         SELECT p.parcel_id, p.parcel_code, p.parcel_status,
                CASE WHEN p.parcel_status = 'IN_PROGRESS' THEN p.parcel_status_second
                     ELSE p.parcel_status END AS statut,
                sc.color AS statut_color, p.parcel_report_time AS report_time,
                p.parcel_last_update, p.parcel_sent_time, p.parcel_livreur,
                c.customers_store AS magasin, tr.nom_ville AS ville_ramassage,
                t.nom_ville AS ville, l.users_name AS livreur,
                (SELECT MAX(h.parcel_history_time) FROM delevery_parcel_history h
                  WHERE h.parcel_history_parcel = p.parcel_id
                    AND h.parcel_history_status_second IN (?)) AS derniere_programmation,
                (SELECT COUNT(DISTINCT FLOOR(h.parcel_history_time / ?))
                   FROM delevery_parcel_history h
                  WHERE h.parcel_history_parcel = p.parcel_id
                    AND h.parcel_history_status_second IN (?)) AS nb_programmations
           FROM delevery_parcel p
           LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
           LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
           LEFT JOIN delevery_tarifs tr   ON tr.ville_id = p.parcel_ramassage_city
           LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur
           LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                        FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
             ON sc.parcel_statut_code = CASE WHEN p.parcel_status = 'IN_PROGRESS'
                  THEN p.parcel_status_second ELSE p.parcel_status END
          WHERE p.parcel_status IN (?)${NON_TRAITE_SQL}${scopeSql}
       ) x
       WHERE x.nb_programmations > 0
          OR (x.parcel_sent_time > 0 AND x.parcel_sent_time <= ?)
       ORDER BY x.derniere_programmation DESC, x.parcel_id DESC`,
      [
        PROGRAMMATION_STATUTS,
        PROGRAMMATION_TRANCHE_SEC,
        PROGRAMMATION_STATUTS,
        STATUTS_EXPEDIE_NON_TERMINE,
        ...scopeParams,
        now - DISTRIBUTION_JOURS_MIN * 86400
      ]
    );

    const result = [];
    rows.forEach((r) => {
      const enDistribution = STATUTS_EN_DISTRIBUTION.includes(r.parcel_status);
      const programme = PROGRAMMATION_STATUTS.includes(r.statut);
      const dateProgrammee = programme ? parseReportDate(r.report_time) : null;
      r.jours =
        dateProgrammee && r.derniere_programmation
          ? Math.round((dateProgrammee - jourLocal(r.derniere_programmation)) / 86400000)
          : null;
      r.nb_programmations = Number(r.nb_programmations) || 0;
      r.plus_un_jour = enDistribution && r.jours !== null && r.jours >= PROGRAMMATION_JOURS_MIN;
      r.double = enDistribution && r.nb_programmations >= 2;
      const sent = Number(r.parcel_sent_time) || 0;
      r.jours_expedition = sent > 0 ? Math.floor((now - sent) / 86400) : null;
      r.plus_30_jours = r.jours_expedition !== null && r.jours_expedition >= DISTRIBUTION_JOURS_MIN;
      if (r.plus_un_jour || r.double || r.plus_30_jours) result.push(r);
    });

    res.json({ rows: result, now });
  } catch (err) {
    next(err);
  }
}

/*
 * Page « Sans adresse » (/admin/sans-adresse, menu à part, service
 * COLIS_SANS_ADRESSE) : colis scannés en agence faute d'adresse exploitable,
 * en attente de confirmation du destinataire (utils/sansAdresse). Statut
 * « Attente confirmation » posé uniquement par le
 * scan de cette page ; la liste montre les colis qui le portent, du plus
 * ancien scan au plus récent, avec les colonnes empilées de la page (magasin
 * sous le code, téléphone sous le destinataire, adresse sous la ville, zone
 * sous le livreur).
 */
const SANS_ADRESSE_SELECT = `p.parcel_id, p.parcel_code, p.parcel_status,
              '${STATUT_ATTENTE_CONFIRMATION}' AS statut, sc.color AS statut_color,
              p.parcel_receiver, p.parcel_phone, p.parcel_address AS adresse,
              p.parcel_price, p.parcel_report_time AS report_time,
              p.parcel_last_update, p.parcel_livreur,
              c.customers_store AS magasin, t.nom_ville AS ville, z.zone_name AS zone,
              l.users_name AS livreur`;
const SANS_ADRESSE_JOINS = `LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_zone z      ON z.zone_id = t.zone
         LEFT JOIN delevery_users l     ON l.users_id = p.parcel_livreur
         LEFT JOIN (SELECT MIN(parcel_statut_color) AS color
                      FROM delevery_parcel_statut
                     WHERE parcel_statut_code = '${STATUT_ATTENTE_CONFIRMATION}') sc
           ON 1 = 1`;
const SANS_ADRESSE_WHERE = `p.parcel_status = 'IN_PROGRESS'
            AND p.parcel_status_second = '${STATUT_ATTENTE_CONFIRMATION}'`;

/**
 * GET /api/parcels/sans-adresse — colis en « Attente confirmation »
 * (liste complète, sans pagination, triée du plus récent scan au plus ancien ;
 * recherche et filtre livreur côté frontend). Employés type 3/4 :
 * restreint aux colis de leur agence (getAgenceScope).
 */
async function listColisSansAdresse(req, res, next) {
  try {
    let scopeSql = '';
    const scopeParams = [];
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      scopeSql = ` AND ${scope.sql}`;
      scopeParams.push(...scope.params);
    }
    const [rows] = await pool.query(
      `SELECT ${SANS_ADRESSE_SELECT}
         FROM delevery_parcel p
         ${SANS_ADRESSE_JOINS}
        WHERE ${SANS_ADRESSE_WHERE}${scopeSql}
        ORDER BY p.parcel_last_update DESC, p.parcel_id DESC`,
      scopeParams
    );
    res.json({ rows, now: Math.floor(Date.now() / 1000) });
  } catch (err) {
    next(err);
  }
}

/* Commentaire de la ligne d'historique posée par le scan « Sans adresse ». */
const COMMENTAIRE_SANS_ADRESSE = 'Colis sans adresse : en attente de confirmation du destinataire.';

/**
 * POST /api/parcels/sans-adresse/scan — body { code } (parcel_code
 * ou code interne, douchette ou caméra). Le colis passe parcel_status =
 * IN_PROGRESS + parcel_status_second = WAITING_CONFIRMATION avec une ligne
 * d'historique.
 * Refusé (409, son d'erreur côté page) : colis introuvable (404), hors agence
 * (403), pas reçu en agence / en distribution (livré, retourné, ramassé…),
 * déjà en attente de confirmation, sur une facture livreur, ou en attente de
 * réexpédition pour un employé qui ne peut pas la lever. Réponse : la ligne
 * complète du colis (mêmes colonnes que la liste) pour l'insérer en tête du
 * tableau sans recharger.
 */
async function scanSansAdresse(req, res, next) {
  try {
    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const [[parcel]] = await pool.query(
      `SELECT ${COLONNES_CHANGEMENT_STATUT}, c.customers_store AS magasin,
              p.parcel_receiver, t.nom_ville AS ville
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
        WHERE p.parcel_code = ? OR p.parcel_code_interne = ?
        LIMIT 1`,
      [code, code]
    );
    if (!parcel) {
      return res.status(404).json({ message: `Colis « ${code} » introuvable.` });
    }
    const info = {
      code: parcel.parcel_code,
      receiver: parcel.parcel_receiver,
      ville: parcel.ville,
      magasin: parcel.magasin
    };

    // Types 3/4/6 : uniquement les colis de leur agence (mêmes règles que la liste).
    const agenceScope = await getAgenceScope(req.user);
    if (agenceScope !== null) {
      const scope = await parcelInAgence(agenceScope);
      const [[visible]] = await pool.query(
        `SELECT 1 AS ok FROM delevery_parcel p WHERE p.parcel_id = ? AND ${scope.sql} LIMIT 1`,
        [parcel.parcel_id, ...scope.params]
      );
      if (!visible) {
        return res.status(403).json({
          message: `Colis « ${parcel.parcel_code} » hors de votre agence.`,
          parcel: info
        });
      }
    }

    if (enAttenteConfirmation(parcel.parcel_status, parcel.parcel_status_second)) {
      return res.status(409).json({
        message: `Colis « ${parcel.parcel_code} » déjà en attente de confirmation.`,
        parcel: info
      });
    }
    const estLivre =
      parcel.parcel_status === 'DELIVERED' ||
      (parcel.parcel_status === 'IN_PROGRESS' &&
        String(parcel.parcel_status_second || '').trim() === 'DELIVERED');
    if (
      estLivre ||
      parcel.parcel_situation === 'INVOICED' ||
      !STATUTS_SCAN_SANS_ADRESSE.includes(parcel.parcel_status)
    ) {
      const actuel =
        parcel.parcel_situation === 'INVOICED'
          ? 'INVOICED'
          : parcel.parcel_status === 'IN_PROGRESS' && parcel.parcel_status_second
            ? parcel.parcel_status_second
            : parcel.parcel_status;
      return res.status(409).json({
        message:
          `Colis « ${parcel.parcel_code} » non admis : seuls les colis reçus en agence ou en ` +
          `distribution peuvent être scannés (statut actuel : ${await libelleStatut(actuel)}).`,
        parcel: info
      });
    }
    // Colis sur une facture livreur : statut verrouillé (cohérence de la facture).
    if (surFactureLivreur(parcel)) {
      return res.status(409).json({
        message: await messageFactureLivreur(parcel.parcel_id, 'le scanner sans adresse'),
        parcel: info
      });
    }
    // Attente de réexpédition : seuls les types 1-4 peuvent la lever.
    if (
      enAttenteReexpedition(parcel.parcel_status, parcel.parcel_status_second) &&
      !peutReexpedier(req.user)
    ) {
      return res.status(403).json({
        message: `Colis « ${parcel.parcel_code} » en attente de réexpédition : statut verrouillé par l'administration.`,
        parcel: info
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE delevery_parcel
            SET parcel_status = 'IN_PROGRESS', parcel_status_second = ?, parcel_last_update = ?
          WHERE parcel_id = ?`,
        [STATUT_ATTENTE_CONFIRMATION, now, parcel.parcel_id]
      );
      await conn.query(
        `INSERT INTO delevery_parcel_history
           (parcel_history_parcel, parcel_history_city, parcel_history_situation,
            parcel_history_status, parcel_history_status_second, parcel_history_comment,
            parcel_history_data, parcel_history_time, parcel_history_livreur, parcel_history_by)
         VALUES (?, 0, ?, 'IN_PROGRESS', ?, ?, '', ?, ?, ?)`,
        [
          parcel.parcel_id,
          parcel.parcel_situation || '',
          STATUT_ATTENTE_CONFIRMATION,
          COMMENTAIRE_SANS_ADRESSE,
          now,
          Number(parcel.parcel_livreur) || 0,
          Number(req.user.id) || 0
        ]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [[row]] = await pool.query(
      `SELECT ${SANS_ADRESSE_SELECT}
         FROM delevery_parcel p
         ${SANS_ADRESSE_JOINS}
        WHERE p.parcel_id = ?
        LIMIT 1`,
      [parcel.parcel_id]
    );
    res.json({
      message: `Colis « ${parcel.parcel_code} » en attente de confirmation.`,
      parcel: info,
      row: row || null
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/parcels/:id/traiter — page « Colis à suivre » : marque le colis
 * comme traité (table legacy delevery_parcel_verified, partagée avec l'ancien
 * système ; ne change pas le statut du colis). Le colis disparaît de la page
 * tant que son statut ne rebouge pas ; un nouveau changement de statut
 * (parcel_last_update > verified_time) le fait réapparaître automatiquement.
 */
async function marquerColisTraite(req, res, next) {
  try {
    const parcel = await loadAdminParcel(req, `p.parcel_id`);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    await pool.query(
      `REPLACE INTO delevery_parcel_verified (parcel_id, verified_by, verified_time)
       VALUES (?, ?, ?)`,
      [parcel.parcel_id, Number(req.user.id) || 0, Math.floor(Date.now() / 1000)]
    );
    res.json({ parcel_id: parcel.parcel_id });
  } catch (err) {
    next(err);
  }
}

/*
 * Modale « Autres adresses » de la page « Sans adresse » : colis antérieurs
 * du même destinataire, retrouvés par son numéro de téléphone (mêmes formes
 * de stockage que le taux de livraison du destinataire — utils/phone.js
 * phoneVariants, index idx_parcel_phone), tous clients confondus et sans
 * restriction d'agence : le but est de retrouver une adresse exploitable, où
 * que le colis ait été livré. Le colis courant est exclu de la liste.
 */
const AUTRES_ADRESSES_LIMITE = 50;

/**
 * GET /api/parcels/sans-adresse/destinataire?phone=…&exclude=<parcel_id> —
 * { rows, total, phone } : pour chaque colis, code, magasin, ville, adresse,
 * statut effectif (+ couleur), date de création et, pour un colis livré, la
 * date de livraison (dernière ligne d'historique DELIVERED, index
 * idx_history_status_parcel_time ; null pour un colis legacy sans historique).
 * Du plus récent au plus ancien, AUTRES_ADRESSES_LIMITE lignes au plus ;
 * total = nombre réel de colis du numéro. Numéro : au moins 9 chiffres (les
 * numéros legacy sans le 0 initial sont acceptés), comparé sur ses 9 derniers.
 */
async function listAutresAdressesDestinataire(req, res, next) {
  try {
    const phone = String(req.query.phone || '').trim();
    const digits = normalizePhone(phone).replace(/^\+/, '');
    if (!/^\d{9,}$/.test(digits)) {
      return res.status(400).json({ message: 'Numéro de téléphone invalide.' });
    }
    const exclude = parseInt(req.query.exclude, 10);
    const excludeId = Number.isInteger(exclude) && exclude > 0 ? exclude : 0;
    const variants = phoneVariants(phone);

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM delevery_parcel p
        WHERE p.parcel_phone IN (?) AND p.parcel_id <> ?`,
      [variants, excludeId]
    );
    const [rows] = await pool.query(
      `SELECT p.parcel_id, p.parcel_code, p.parcel_status, p.parcel_time,
              p.parcel_receiver, p.parcel_address AS adresse,
              (${STATUT_CODE_SQL}) AS statut, s.parcel_statut_color AS statut_color,
              c.customers_store AS magasin, t.nom_ville AS ville,
              CASE WHEN p.parcel_status = 'DELIVERED' THEN
                (SELECT MAX(h.parcel_history_time)
                   FROM delevery_parcel_history h
                  WHERE h.parcel_history_status = 'DELIVERED'
                    AND h.parcel_history_parcel = p.parcel_id)
              END AS livraison_time
         FROM delevery_parcel p
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_parcel_statut s
           ON s.parcel_statut_code = (${STATUT_CODE_SQL})
          AND s.parcel_statut_type = (${STATUT_TYPE_SQL})
        WHERE p.parcel_phone IN (?) AND p.parcel_id <> ?
        ORDER BY p.parcel_time DESC, p.parcel_id DESC
        LIMIT ?`,
      [variants, excludeId, AUTRES_ADRESSES_LIMITE]
    );
    res.json({ rows, total: Number(total) || 0, phone: formatPhoneAffichage(phone) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getParcelSuivi,
  chargerSuiviColis,
  getParcelDetails,
  getParcelEditData,
  getParcelTarif,
  updateParcel,
  createParcelReclamation,
  createParcelRemboursement,
  listActiveStatuts,
  changeParcelStatut,
  appliquerChangementStatut,
  COLONNES_CHANGEMENT_STATUT,
  deleteParcel,
  revertDelivered,
  listLivreursActifs,
  changerLivreur,
  annulerRamassage,
  listSuiviRetour,
  listColisAttention,
  listColisProgrammes,
  listColisSansAdresse,
  scanSansAdresse,
  listAutresAdressesDestinataire,
  marquerColisTraite,
  // Réutilisés par les compteurs « Colis alerte » / « Sans adresse » de la
  // sidebar (compteursSidebar.controller).
  ATTENTION_ALERTE,
  REPORT_DATE_SQL,
  SANS_ADRESSE_WHERE
};
