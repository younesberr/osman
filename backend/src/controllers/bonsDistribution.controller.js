const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const { getScanSonUrls } = require('../utils/scanSons');
const { getAgenceScope } = require('../utils/agenceScope');
const { statutLabel } = require('../utils/statutLabels');
const { enAttenteReexpedition, pasEnAttenteReexpeditionSql } = require('../utils/reexpedition');

/* Un colis « Attente réexpédition » (IN_PROGRESS + WAITING_RESHIP) n'est pas
 * distribuable : il repart par un bon d'envoi (utils/reexpedition). */
const MOTIF_REEXPEDITION = "en attente de réexpédition : à ajouter à un bon d'envoi.";

/*
 * Bons de distribution (delevery_distribution_note + delevery_dis_parcels,
 * tables partagées avec le legacy) : un bon affecte des colis arrivés en
 * agence (RECEIVED) ou déjà en cours (IN_PROGRESS) d'une même zone de
 * destination à un livreur (distribution_note_delivery, users_type = 5).
 *
 * Statut d'un bon (distribution_note_save) :
 *  - 0 → « Nouveau » (modifiable : ajout / retrait de colis, suppression) ;
 *  - 1 → « Enregistré » (lecture seule, réouverture possible).
 *
 * Ajout d'un colis au bon (mêmes règles que le legacy distribution_note.php) :
 * le colis passe en DISTRIBUTION, en_agence = 0, parcel_livreur = livreur du
 * bon ; l'ancien livreur et l'état en_agence sont mémorisés dans la ligne
 * delevery_dis_parcels (dis_parcels_livreur_before / dis_parcels_was_en_agence)
 * pour être restaurés au retrait. Retrait : DISTRIBUTION → RECEIVED (ou
 * IN_PROGRESS si le colis a un statut second) + suppression de la dernière
 * ligne d'historique DISTRIBUTION. distr_scan trace l'ajout par scanner.
 * Un colis conserve ses anciennes lignes delevery_dis_parcels (historique des
 * bons) : seule la plus récente correspond au bon actif.
 */

const MAX_BONS = 1000;

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/** Charge un bon ; renvoie null si l'id est invalide ou le bon introuvable. */
async function loadBon(id) {
  const bonId = parseInt(id, 10);
  if (!Number.isInteger(bonId) || bonId <= 0) return null;
  const [[bon]] = await pool.query(
    `SELECT dn.distribution_note_id       AS id,
            dn.distribution_note_ref      AS ref,
            dn.distribution_note_time     AS time,
            dn.distribution_note_save     AS save,
            dn.distribution_note_city     AS zone_id,
            z.zone_name                   AS zone,
            dn.distribution_note_delivery AS livreur_id,
            u.users_name                  AS livreur_name,
            u.users_phone                 AS livreur_phone
       FROM delevery_distribution_note dn
       LEFT JOIN delevery_zone z  ON z.zone_id = dn.distribution_note_city
       LEFT JOIN delevery_users u ON u.users_id = dn.distribution_note_delivery
      WHERE dn.distribution_note_id = ? LIMIT 1`,
    [bonId]
  );
  return bon || null;
}

/** Un bon est modifiable tant qu'il n'est pas enregistré. */
function bonEditable(bon) {
  return Number(bon.save) !== 1;
}

/**
 * Colis d'un bon (détail admin ou livreur), du plus récemment ajouté au plus
 * ancien. report_time : date reportée / programmée (parcel_report_time,
 * "JJ/MM/AAAA" ou "AAAA-MM-JJ") ; paid_livreur : drapeau facture livreur
 * (parcel_paid_livreur, 0 = non facturé, 1 = dans une facture brouillon,
 * 2 = facture enregistrée ou payée — voir facturesLivreurs.controller) ;
 * statut_color : couleur du statut effectif (statut second si « En cours »).
 */
async function loadBonParcels(bonId) {
  const [parcels] = await pool.query(
    `SELECT p.parcel_id       AS id,
            p.parcel_code     AS code,
            p.parcel_status   AS status,
            p.parcel_status_second AS status_second,
            p.parcel_report_time AS report_time,
            COALESCE(p.parcel_paid_livreur, 0) AS paid_livreur,
            sc.color          AS statut_color,
            p.parcel_note     AS commentaire,
            p.parcel_address  AS adresse,
            p.parcel_receiver AS destinataire,
            p.parcel_phone    AS telephone,
            p.parcel_price    AS prix,
            p.parcel_replace  AS replace_flag,
            p.parcel_open     AS open_flag,
            p.parcel_essayage AS essayage_flag,
            p.distr_scan      AS scan,
            t.nom_ville       AS ville,
            c.customers_store AS magasin,
            c.customers_name  AS clientNom
       FROM delevery_dis_parcels dp
       JOIN delevery_parcel p ON p.parcel_id = dp.dis_parcels_parcel
       LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
       LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
       LEFT JOIN (SELECT parcel_statut_code, MIN(parcel_statut_color) AS color
                    FROM delevery_parcel_statut GROUP BY parcel_statut_code) sc
         ON sc.parcel_statut_code = CASE WHEN p.parcel_status = 'IN_PROGRESS'
              THEN p.parcel_status_second ELSE p.parcel_status END
      WHERE dp.dis_parcels_dis = ?
      ORDER BY dp.dis_parcels_id DESC`,
    [bonId]
  );
  return parcels;
}

/**
 * Résumé livraison des colis d'un bon (modale « Détail du bon ») :
 *  - livres_payes : colis DELIVERED déjà ajoutés à une facture livreur
 *    (parcel_paid_livreur ≠ 0, brouillon comprise) ;
 *  - livres_non_payes : colis DELIVERED pas encore facturés ;
 *  - reste : autres colis du bon (total − livrés).
 */
function resumeLivraison(parcels) {
  let livresPayes = 0;
  let livresNonPayes = 0;
  for (const p of parcels) {
    if (p.status !== 'DELIVERED') continue;
    if (Number(p.paid_livreur) !== 0) livresPayes += 1;
    else livresNonPayes += 1;
  }
  return {
    total: parcels.length,
    livres_payes: livresPayes,
    livres_non_payes: livresNonPayes,
    reste: parcels.length - livresPayes - livresNonPayes
  };
}

/**
 * Employés type 3/4/6 : ils ne gèrent que les bons des zones de leur agence
 * (delevery_zone.zone_agence_id). Renvoie null (aucune restriction) ou la
 * liste des zone_id autorisés (vide = rien de visible).
 */
async function getZonesAgence(user) {
  const agenceScope = await getAgenceScope(user);
  if (agenceScope === null) return null;
  const [rows] = await pool.query(
    `SELECT zone_id FROM delevery_zone WHERE zone_agence_id = ?`,
    [agenceScope]
  );
  return rows.map((r) => Number(r.zone_id));
}

/** Vrai si la zone est hors du périmètre de l'employé (types 3/4/6). */
function zoneInterdite(zonesAgence, zoneId) {
  return zonesAgence !== null && !zonesAgence.includes(Number(zoneId));
}

/**
 * GET /api/bons-distribution/zones — zones actives avec leur nombre de colis
 * à distribuer (RECEIVED ou IN_PROGRESS, zone de la ville de destination).
 * Sert la modale de création et le filtre par zone. Types 3/4/6 : uniquement
 * les zones de leur agence.
 */
async function listZones(req, res, next) {
  try {
    const zonesAgence = await getZonesAgence(req.user);
    const where = ['z.zone_active = 1'];
    const params = [];
    if (zonesAgence !== null) {
      if (!zonesAgence.length) return res.json([]);
      where.push('z.zone_id IN (?)');
      params.push(zonesAgence);
    }
    const [rows] = await pool.query(
      `SELECT z.zone_id AS id, z.zone_name AS label, COUNT(p.parcel_id) AS dispo
         FROM delevery_zone z
         LEFT JOIN delevery_tarifs t ON t.zone = z.zone_id
         LEFT JOIN delevery_parcel p
           ON p.parcel_city = t.ville_id
          AND p.parcel_status IN ('RECEIVED', 'IN_PROGRESS')
          AND ${pasEnAttenteReexpeditionSql('p')}
        WHERE ${where.join(' AND ')}
        GROUP BY z.zone_id, z.zone_name
        ORDER BY z.zone_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution/livreurs — livreurs actifs (users_type = 5).
 * Query zone : restreint aux livreurs rattachés à la zone — users_city
 * legacy (zone_id ou ville de la zone) ou users_ville_id ORTALOG (ville de
 * la zone). Sans zone : tous (filtre livreur de la liste des bons).
 */
async function listLivreurs(req, res, next) {
  try {
    const zone = parseInt(req.query.zone, 10) || 0;
    const where = ["u.users_active = 1", "u.users_type = '5'"];
    const params = [];
    if (zone) {
      where.push(`(u.users_city = ?
        OR u.users_city IN (SELECT t.ville_id FROM delevery_tarifs t WHERE t.zone = ?)
        OR u.users_ville_id IN (SELECT t.ville_id FROM delevery_tarifs t WHERE t.zone = ?))`);
      params.push(zone, zone, zone);
    }
    const [rows] = await pool.query(
      `SELECT u.users_id AS id, u.users_name AS nom
         FROM delevery_users u
        WHERE ${where.join(' AND ')}
        ORDER BY u.users_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution — liste des bons pour la datatable.
 * Query : zone (zone_id), livreur (users_id), status (new | saved, '' = tous),
 * dateFrom / dateTo (AAAA-MM-JJ, sur la date de création). 1000 bons max, du
 * plus récent au plus ancien (pagination côté client). Types 3/4/6 : bons des
 * zones de leur agence uniquement.
 */
async function listBons(req, res, next) {
  try {
    const zone = parseInt(req.query.zone, 10) || 0;
    const livreur = parseInt(req.query.livreur, 10) || 0;
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = [];
    const params = [];
    const zonesAgence = await getZonesAgence(req.user);
    if (zonesAgence !== null) {
      if (!zonesAgence.length) return res.json([]);
      where.push('dn.distribution_note_city IN (?)');
      params.push(zonesAgence);
    }
    if (zone) {
      where.push('dn.distribution_note_city = ?');
      params.push(zone);
    }
    if (livreur) {
      where.push('dn.distribution_note_delivery = ?');
      params.push(livreur);
    }
    if (status === 'new') where.push('dn.distribution_note_save = 0');
    else if (status === 'saved') where.push('dn.distribution_note_save = 1');
    if (dateFrom !== null) {
      where.push('dn.distribution_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('dn.distribution_note_time <= ?');
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT dn.distribution_note_id       AS id,
              dn.distribution_note_ref      AS ref,
              dn.distribution_note_time     AS time,
              dn.distribution_note_save     AS save,
              dn.distribution_note_city     AS zone_id,
              z.zone_name                   AS zone,
              dn.distribution_note_delivery AS livreur_id,
              u.users_name                  AS livreur_name,
              (SELECT COUNT(*) FROM delevery_dis_parcels dp
                WHERE dp.dis_parcels_dis = dn.distribution_note_id) AS nb_colis
         FROM delevery_distribution_note dn
         LEFT JOIN delevery_zone z  ON z.zone_id = dn.distribution_note_city
         LEFT JOIN delevery_users u ON u.users_id = dn.distribution_note_delivery
         ${whereSql}
         ORDER BY dn.distribution_note_time DESC, dn.distribution_note_id DESC
         LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-distribution — body { zone, livreur }. Crée un bon
 * « Nouveau » pour la zone et le livreur (actif, type 5, rattaché à la zone)
 * et génère sa référence unique au format legacy :
 * BDIS-JJMMAA-0{id}0-{2 chiffres} (l'id du bon la rend unique).
 * Renvoie { id, ref }.
 */
async function createBon(req, res, next) {
  try {
    const zone = parseInt(req.body?.zone, 10);
    const livreur = parseInt(req.body?.livreur, 10);
    if (!Number.isInteger(zone) || zone <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une zone.' });
    }
    if (!Number.isInteger(livreur) || livreur <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un livreur.' });
    }
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, zone)) {
      return res.status(403).json({ message: 'Zone hors de votre agence.' });
    }
    const [[zoneRow]] = await pool.query(
      `SELECT zone_id FROM delevery_zone WHERE zone_id = ? AND zone_active = 1 LIMIT 1`,
      [zone]
    );
    if (!zoneRow) return res.status(400).json({ message: 'Zone introuvable ou désactivée.' });
    // Mêmes règles que la liste déroulante : livreur actif rattaché à la zone.
    const [[livreurRow]] = await pool.query(
      `SELECT u.users_id FROM delevery_users u
        WHERE u.users_id = ? AND u.users_active = 1 AND u.users_type = '5'
          AND (u.users_city = ?
            OR u.users_city IN (SELECT t.ville_id FROM delevery_tarifs t WHERE t.zone = ?)
            OR u.users_ville_id IN (SELECT t.ville_id FROM delevery_tarifs t WHERE t.zone = ?))
        LIMIT 1`,
      [livreur, zone, zone, zone]
    );
    if (!livreurRow) {
      return res.status(400).json({ message: 'Livreur introuvable, désactivé ou hors de cette zone.' });
    }

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_distribution_note
           (distribution_note_ref, distribution_note_delivery, distribution_note_city,
            distribution_note_time, distribution_note_save, distribution_note_by)
         VALUES ('', ?, ?, ?, 0, ?)`,
        [livreur, zone, now, Number(req.user.id)]
      );
      const bonId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `BDIS-${jj}${mm}${aa}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(
        `UPDATE delevery_distribution_note SET distribution_note_ref = ?
          WHERE distribution_note_id = ?`,
        [ref, bonId]
      );
      await conn.commit();
      res.status(201).json({ id: bonId, ref });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution/:id — détail d'un bon : informations (référence,
 * date, zone, livreur, statut) + colis du bon (code, magasin, destinataire,
 * téléphone, ville, adresse, prix, commentaire, options échange / ouverture /
 * essayage, statut colis + couleur, date reportée / programmée, drapeau
 * facture livreur, ajout par scanner), du plus récemment ajouté au plus
 * ancien, + stats (résumé livraison : total, livres_payes, livres_non_payes,
 * reste — voir resumeLivraison). Sert la page de modification, la modale
 * « Détail du bon », le PDF et l'export Excel.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }

    const parcels = await loadBonParcels(bon.id);
    res.json({ ...bon, parcels, stats: resumeLivraison(parcels) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution/livreur — dashboard livreur : bons du livreur
 * connecté uniquement, mêmes colonnes que la liste admin. Query : status
 * (new | saved, '' = tous), dateFrom / dateTo (AAAA-MM-JJ, date de création).
 */
async function listBonsLivreur(req, res, next) {
  try {
    const status = String(req.query.status || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['dn.distribution_note_delivery = ?'];
    const params = [Number(req.user.id)];
    if (status === 'new') where.push('dn.distribution_note_save = 0');
    else if (status === 'saved') where.push('dn.distribution_note_save = 1');
    if (dateFrom !== null) {
      where.push('dn.distribution_note_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('dn.distribution_note_time <= ?');
      params.push(dateTo);
    }

    const [rows] = await pool.query(
      `SELECT dn.distribution_note_id       AS id,
              dn.distribution_note_ref      AS ref,
              dn.distribution_note_time     AS time,
              dn.distribution_note_save     AS save,
              dn.distribution_note_city     AS zone_id,
              z.zone_name                   AS zone,
              dn.distribution_note_delivery AS livreur_id,
              u.users_name                  AS livreur_name,
              (SELECT COUNT(*) FROM delevery_dis_parcels dp
                WHERE dp.dis_parcels_dis = dn.distribution_note_id) AS nb_colis
         FROM delevery_distribution_note dn
         LEFT JOIN delevery_zone z  ON z.zone_id = dn.distribution_note_city
         LEFT JOIN delevery_users u ON u.users_id = dn.distribution_note_delivery
        WHERE ${where.join(' AND ')}
        ORDER BY dn.distribution_note_time DESC, dn.distribution_note_id DESC
        LIMIT ${MAX_BONS}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution/livreur/:id — dashboard livreur : détail d'un bon
 * du livreur connecté (mêmes informations que le détail admin) pour la modale
 * « Détail du bon », le PDF et l'export Excel. Bon d'un autre livreur → 404.
 */
async function getBonLivreur(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon || Number(bon.livreur_id) !== Number(req.user.id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    res.json({ ...bon, parcels: await loadBonParcels(bon.id) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bons-distribution/:id/available — colis ajoutables au bon : statut
 * RECEIVED (reçu en agence) ou IN_PROGRESS (en cours), ville de destination
 * dans la zone du bon et pas déjà dans CE bon (un colis IN_PROGRESS d'un
 * autre bon reste proposable : l'ajout le réaffecte au livreur de ce bon).
 * Recherche, tri et pagination côté client. Renvoie aussi le livreur actuel /
 * l'état « en agence », l'adresse, la date reportée / programmée
 * (parcel_report_time) et le nombre de mises en distribution passées du colis
 * (nb_distributions : lignes DISTRIBUTION de son historique — un retrait du
 * bon supprime la ligne correspondante), affichés dans le tableau.
 */
async function listAvailable(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }

    const [rows] = await pool.query(
      `SELECT p.parcel_id     AS id,
              p.parcel_code   AS code,
              p.parcel_status AS status,
              p.parcel_status_second AS status_second,
              p.en_agence     AS en_agence,
              p.parcel_address AS adresse,
              p.parcel_report_time AS report_time,
              t.nom_ville     AS ville,
              c.customers_store AS magasin,
              ul.users_name   AS livreur_actuel,
              (SELECT COUNT(*) FROM delevery_parcel_history h
                WHERE h.parcel_history_status = 'DISTRIBUTION'
                  AND h.parcel_history_parcel = p.parcel_id) AS nb_distributions
         FROM delevery_parcel p
         JOIN delevery_tarifs t         ON t.ville_id = p.parcel_city
         LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
         LEFT JOIN delevery_users ul    ON ul.users_id = p.parcel_livreur
        WHERE p.parcel_status IN ('RECEIVED', 'IN_PROGRESS') AND t.zone = ?
          AND ${pasEnAttenteReexpeditionSql('p')}
          AND NOT EXISTS (SELECT 1 FROM delevery_dis_parcels dp
                           WHERE dp.dis_parcels_dis = ? AND dp.dis_parcels_parcel = p.parcel_id)
        ORDER BY p.parcel_received_time DESC, p.parcel_id DESC`,
      [bon.zone_id, bon.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Ajoute un colis (déjà chargé et validé RECEIVED / IN_PROGRESS + zone du bon)
 * dans le bon, dans la transaction fournie — mêmes écritures que le legacy :
 * mémorisation de l'ancien livreur et de l'état en_agence dans la ligne
 * delevery_dis_parcels, puis colis → DISTRIBUTION, en_agence = 0, livreur du
 * bon, distr_scan, ligne d'historique DISTRIBUTION (zone du bon + livreur).
 */
async function insertParcelIntoBon(conn, bon, parcel, scan, userId, now) {
  const wasReceived = parcel.status === 'RECEIVED';
  await conn.query(
    `INSERT INTO delevery_dis_parcels
       (dis_parcels_dis, dis_parcels_parcel, dis_parcels_time,
        dis_parcels_was_en_agence, dis_parcels_livreur_before)
     VALUES (?, ?, ?, ?, ?)`,
    [
      bon.id,
      parcel.id,
      now,
      wasReceived ? 1 : Number(parcel.en_agence) || 0,
      wasReceived ? null : parcel.livreur_id || null
    ]
  );
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = 'DISTRIBUTION', en_agence = 0, distr_scan = ?,
            parcel_livreur = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [scan ? 1 : 0, bon.livreur_id, now, parcel.id]
  );
  await conn.query(
    `INSERT INTO delevery_parcel_history
       (parcel_history_parcel, parcel_history_city, parcel_history_situation,
        parcel_history_status, parcel_history_time, parcel_history_by,
        parcel_history_livreur)
     VALUES (?, ?, ?, 'DISTRIBUTION', ?, ?, ?)`,
    [parcel.id, bon.zone_id, parcel.situation, now, userId, bon.livreur_id]
  );
}

/** Charge et verrouille un colis (FOR UPDATE) par id ou par code scanné. */
async function lockParcel(conn, { id, code }) {
  const whereSql = id ? 'p.parcel_id = ?' : '(p.parcel_code = ? OR p.parcel_code_interne = ?)';
  const params = id ? [id] : [code, code];
  const [[parcel]] = await conn.query(
    `SELECT p.parcel_id AS id, p.parcel_code AS code, p.parcel_status AS status,
            p.parcel_status_second AS status_second, p.parcel_situation AS situation,
            p.parcel_livreur AS livreur_id, p.en_agence AS en_agence,
            p.parcel_address AS adresse, p.parcel_report_time AS report_time,
            t.nom_ville AS ville, t.zone AS zone
       FROM delevery_parcel p
       LEFT JOIN delevery_tarifs t ON t.ville_id = p.parcel_city
      WHERE ${whereSql}
      LIMIT 1 FOR UPDATE`,
    params
  );
  return parcel || null;
}

/**
 * POST /api/bons-distribution/:id/parcels — body { ids: [parcel_id], scan? }.
 * Ajout (manuel ou par sélection) de colis au bon : chaque colis doit être
 * RECEIVED ou IN_PROGRESS et dans la zone du bon, les autres sont ignorés
 * avec un motif. Renvoie { added: [...], skipped: [{ code, reason }] }.
 */
async function addParcels(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est enregistré : ajout impossible.' });
    }

    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    )].slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });
    const scan = Boolean(req.body?.scan);

    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const parcelId of ids) {
        const parcel = await lockParcel(conn, { id: parcelId });
        if (!parcel) {
          skipped.push({ code: `#${parcelId}`, reason: 'Colis introuvable.' });
          continue;
        }
        if (parcel.status !== 'RECEIVED' && parcel.status !== 'IN_PROGRESS') {
          skipped.push({ code: parcel.code, reason: `Statut actuel : ${await statutLabel(parcel.status)} (reçu en agence ou en cours attendu).` });
          continue;
        }
        if (enAttenteReexpedition(parcel.status, parcel.status_second)) {
          skipped.push({ code: parcel.code, reason: `Colis ${MOTIF_REEXPEDITION}` });
          continue;
        }
        if (Number(parcel.zone) !== Number(bon.zone_id)) {
          skipped.push({ code: parcel.code, reason: 'Hors zone du bon.' });
          continue;
        }
        // Colis IN_PROGRESS resté rattaché à ce bon : pas de doublon de ligne.
        const [[dejaLie]] = await conn.query(
          `SELECT dis_parcels_id FROM delevery_dis_parcels
            WHERE dis_parcels_dis = ? AND dis_parcels_parcel = ? LIMIT 1`,
          [bon.id, parcel.id]
        );
        if (dejaLie) {
          skipped.push({ code: parcel.code, reason: 'Déjà dans ce bon.' });
          continue;
        }
        await insertParcelIntoBon(conn, bon, parcel, scan, Number(req.user.id), now);
        added.push({ id: parcel.id, code: parcel.code, ville: parcel.ville, scan: scan ? 1 : 0 });
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    for (const a of added) emettreEvenement('STATUT', { parcelId: a.id, code: 'DISTRIBUTION', bonId: bon.id, livreurId: bon.livreur_id, userId: Number(req.user.id) || 0 });
    res.json({ added, skipped });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/bons-distribution/:id/scan — body { code }.
 * Scan d'un code colis (douchette ou caméra) sur la page du bon : le colis
 * doit exister, être RECEIVED ou IN_PROGRESS et dans la zone du bon. La
 * validation se fait dans la transaction, ligne colis verrouillée (FOR
 * UPDATE) : un colis déjà mis en distribution entre-temps par un autre
 * utilisateur est refusé. Messages d'erreur précis pour le retour sonore.
 */
async function scanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est enregistré : ajout impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let addedParcel = null;
    try {
      await conn.beginTransaction();
      const parcel = await lockParcel(conn, { code });
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else if (parcel.status !== 'RECEIVED' && parcel.status !== 'IN_PROGRESS') {
        const [[inBon]] = await conn.query(
          `SELECT dis_parcels_id FROM delevery_dis_parcels
            WHERE dis_parcels_dis = ? AND dis_parcels_parcel = ?
            ORDER BY dis_parcels_id DESC LIMIT 1`,
          [bon.id, parcel.id]
        );
        failure = inBon && parcel.status === 'DISTRIBUTION'
          ? { status: 409, message: `Colis « ${parcel.code} » déjà dans ce bon.` }
          : {
              status: 409,
              message: `Colis « ${parcel.code} » non ajoutable (statut actuel : ${await statutLabel(parcel.status)}).`
            };
      } else if (enAttenteReexpedition(parcel.status, parcel.status_second)) {
        failure = { status: 409, message: `Colis « ${parcel.code} » ${MOTIF_REEXPEDITION}` };
      } else if (Number(parcel.zone) !== Number(bon.zone_id)) {
        failure = {
          status: 409,
          message: `Colis « ${parcel.code} » hors zone du bon (${parcel.ville || 'ville inconnue'}).`
        };
      } else {
        // Colis IN_PROGRESS resté rattaché à ce bon : pas de doublon de ligne.
        const [[dejaLie]] = await conn.query(
          `SELECT dis_parcels_id FROM delevery_dis_parcels
            WHERE dis_parcels_dis = ? AND dis_parcels_parcel = ? LIMIT 1`,
          [bon.id, parcel.id]
        );
        if (dejaLie) {
          failure = { status: 409, message: `Colis « ${parcel.code} » déjà dans ce bon.` };
        } else {
          await insertParcelIntoBon(conn, bon, parcel, true, Number(req.user.id), now);
          addedParcel = { id: parcel.id, code: parcel.code, ville: parcel.ville, scan: 1 };
        }
      }
      if (failure) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (failure) return res.status(failure.status).json({ message: failure.message });
    emettreEvenement('STATUT', { parcelId: addedParcel.id, code: 'DISTRIBUTION', bonId: bon.id, livreurId: bon.livreur_id, userId: Number(req.user.id) || 0 });
    res.json({ message: `Colis « ${addedParcel.code} » ajouté au bon.`, parcel: addedParcel });
  } catch (err) {
    next(err);
  }
}

/**
 * Retire un colis du bon dans la transaction fournie (colis déjà verrouillé,
 * lien dis_parcels chargé) — mêmes écritures que le legacy : restauration de
 * en_agence et de l'ancien livreur, suppression de la ligne dis_parcels et de
 * la dernière ligne d'historique DISTRIBUTION, retour du colis en RECEIVED
 * (ou IN_PROGRESS s'il a un statut second), distr_scan remis à 0.
 */
async function deleteParcelFromBon(conn, parcel, link, now) {
  const newStatus = String(parcel.status_second || '').trim() ? 'IN_PROGRESS' : 'RECEIVED';
  await conn.query(`DELETE FROM delevery_dis_parcels WHERE dis_parcels_id = ?`, [link.link_id]);
  await conn.query(
    `UPDATE delevery_parcel
        SET parcel_status = ?, distr_scan = 0, en_agence = ?,
            parcel_livreur = ?, parcel_last_update = ?
      WHERE parcel_id = ?`,
    [
      newStatus,
      Number(link.was_en_agence) === 1 ? 1 : 0,
      link.livreur_before || null,
      now,
      parcel.id
    ]
  );
  // Annule la trace de mise en distribution : dernière ligne d'historique
  // DISTRIBUTION du colis (les lignes des bons précédents sont conservées).
  await conn.query(
    `DELETE FROM delevery_parcel_history
      WHERE parcel_history_parcel = ? AND parcel_history_status = 'DISTRIBUTION'
      ORDER BY parcel_history_id DESC LIMIT 1`,
    [parcel.id]
  );
  return newStatus;
}

/**
 * Colis retiré tel qu'il réapparaît dans la liste des colis disponibles
 * (mêmes champs que GET /:id/available) : statut restauré, statut second,
 * état « en agence » et livreur restaurés depuis le lien dis_parcels, nombre
 * de mises en distribution passées (la ligne d'historique de ce bon étant
 * déjà supprimée).
 */
async function restoredParcelInfo(conn, parcel, link, status) {
  const enAgence = Number(link.was_en_agence) === 1 ? 1 : 0;
  const [[{ nb }]] = await conn.query(
    `SELECT COUNT(*) AS nb FROM delevery_parcel_history
      WHERE parcel_history_status = 'DISTRIBUTION' AND parcel_history_parcel = ?`,
    [parcel.id]
  );
  let livreurActuel = null;
  if (!enAgence && link.livreur_before) {
    const [[u]] = await conn.query(
      `SELECT users_name AS nom FROM delevery_users WHERE users_id = ? LIMIT 1`,
      [link.livreur_before]
    );
    livreurActuel = u?.nom || null;
  }
  return {
    id: parcel.id,
    code: parcel.code,
    ville: parcel.ville,
    adresse: parcel.adresse || '',
    status,
    status_second: status === 'IN_PROGRESS' ? String(parcel.status_second || '').trim() : '',
    en_agence: enAgence,
    livreur_actuel: livreurActuel,
    report_time: parcel.report_time || '',
    nb_distributions: Number(nb) || 0
  };
}

/**
 * Charge le lien dis_parcels du colis dans le bon et vérifie que ce bon est
 * bien le dernier bon du colis (un colis garde ses anciennes lignes
 * dis_parcels : seule la plus récente est active). Renvoie { link } ou
 * { failure } prêt à renvoyer.
 */
async function checkRemovable(conn, bon, parcel) {
  if (parcel.status !== 'DISTRIBUTION') {
    return {
      failure: {
        status: 409,
        message: `Colis « ${parcel.code} » non retirable (statut actuel : ${await statutLabel(parcel.status)}).`
      }
    };
  }
  const [[link]] = await conn.query(
    `SELECT dis_parcels_id AS link_id, dis_parcels_dis AS bon_id,
            dis_parcels_was_en_agence AS was_en_agence,
            dis_parcels_livreur_before AS livreur_before
       FROM delevery_dis_parcels
      WHERE dis_parcels_parcel = ?
      ORDER BY dis_parcels_id DESC LIMIT 1`,
    [parcel.id]
  );
  if (!link || Number(link.bon_id) !== Number(bon.id)) {
    return { failure: { status: 409, message: `Colis « ${parcel.code} » absent de ce bon.` } };
  }
  return { link };
}

/**
 * POST /api/bons-distribution/:id/scan-retrait — body { code }.
 * Scan d'un code colis (douchette ou caméra) pour le RETIRER du bon : le
 * colis doit être dans ce bon et encore DISTRIBUTION (un colis déjà passé en
 * cours ou livré est refusé). Ligne colis verrouillée (FOR UPDATE) pour
 * éviter les scans concurrents.
 */
async function removeScanParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est enregistré : retrait impossible.' });
    }

    const code = String(req.body?.code || '').trim().slice(0, 100);
    if (!code) return res.status(400).json({ message: 'Code colis manquant.' });

    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let removedParcel = null;
    try {
      await conn.beginTransaction();
      const parcel = await lockParcel(conn, { code });
      if (!parcel) {
        failure = { status: 404, message: `Colis « ${code} » introuvable.` };
      } else {
        const check = await checkRemovable(conn, bon, parcel);
        if (check.failure) {
          failure = check.failure;
        } else {
          const status = await deleteParcelFromBon(conn, parcel, check.link, now);
          removedParcel = await restoredParcelInfo(conn, parcel, check.link, status);
        }
      }
      if (failure) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (failure) return res.status(failure.status).json({ message: failure.message });
    res.json({ message: `Colis « ${removedParcel.code} » retiré du bon.`, parcel: removedParcel });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bons-distribution/:id/parcels/:parcelId — retire un colis du
 * bon : DISTRIBUTION → RECEIVED (ou IN_PROGRESS si statut second), ancien
 * livreur et état en_agence restaurés, dernière ligne d'historique
 * DISTRIBUTION supprimée. Un colis déjà passé en cours n'est pas retirable.
 * Renvoie le colis restauré (mêmes champs que GET /:id/available).
 */
async function removeParcel(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est enregistré : suppression impossible.' });
    }

    const parcelId = parseInt(req.params.parcelId, 10) || 0;
    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    let failure = null;
    let removed = null;
    try {
      await conn.beginTransaction();
      const parcel = await lockParcel(conn, { id: parcelId });
      if (!parcel) {
        failure = { status: 404, message: 'Colis introuvable dans ce bon.' };
      } else {
        const check = await checkRemovable(conn, bon, parcel);
        if (check.failure) {
          failure = check.failure;
        } else {
          const status = await deleteParcelFromBon(conn, parcel, check.link, now);
          removed = await restoredParcelInfo(conn, parcel, check.link, status);
        }
      }
      if (failure) await conn.rollback();
      else await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    if (failure) return res.status(failure.status).json({ message: failure.message });
    res.json(removed);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bons-distribution/:id/save — body { saved: 0|1 }.
 * saved = 1 : bon « Enregistré » (lecture seule), uniquement s'il contient au
 * moins un colis — les colis gardent leur statut (le passage DISTRIBUTION →
 * IN_PROGRESS est fait par le livreur). saved = 0 : rouvre le bon.
 */
async function setSaved(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    const saved = Number(req.body?.saved) === 1 ? 1 : 0;

    if (saved === 1) {
      const [[{ nb }]] = await pool.query(
        `SELECT COUNT(*) AS nb FROM delevery_dis_parcels WHERE dis_parcels_dis = ?`,
        [bon.id]
      );
      if (!nb) {
        return res.status(400).json({ message: 'Ce bon est vide : enregistrement impossible.' });
      }
    }
    await pool.query(
      `UPDATE delevery_distribution_note SET distribution_note_save = ?
        WHERE distribution_note_id = ?`,
      [saved, bon.id]
    );
    if (saved === 1) emettreEvenement('BON_DISTRIBUTION_ENREGISTRE', { bonId: bon.id, livreurId: bon.livreur_id, userId: Number(req.user.id) || 0 });
    res.json({ id: bon.id, save: saved });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/bons-distribution/:id — supprime un bon vide (aucun colis) et
 * non enregistré uniquement.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const zonesAgence = await getZonesAgence(req.user);
    if (zoneInterdite(zonesAgence, bon.zone_id)) {
      return res.status(404).json({ message: 'Bon introuvable.' });
    }
    if (!bonEditable(bon)) {
      return res.status(400).json({ message: 'Ce bon est enregistré : suppression impossible.' });
    }
    const [[{ nb }]] = await pool.query(
      `SELECT COUNT(*) AS nb FROM delevery_dis_parcels WHERE dis_parcels_dis = ?`,
      [bon.id]
    );
    if (nb > 0) {
      return res.status(400).json({ message: 'Ce bon contient des colis : suppression impossible.' });
    }
    await pool.query(`DELETE FROM delevery_distribution_note WHERE distribution_note_id = ?`, [
      bon.id
    ]);
    res.json({ id: bon.id });
  } catch (err) {
    next(err);
  }
}

/** GET /api/bons-distribution/sons — sons de l'étape distribution (Options). */
async function getSons(req, res, next) {
  try {
    const urls = await getScanSonUrls();
    res.json({ success: urls.distribution_success, error: urls.distribution_error });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listZones,
  listLivreurs,
  listBons,
  listBonsLivreur,
  getBonLivreur,
  createBon,
  getBon,
  listAvailable,
  addParcels,
  scanParcel,
  removeScanParcel,
  removeParcel,
  setSaved,
  deleteBon,
  getSons
};
