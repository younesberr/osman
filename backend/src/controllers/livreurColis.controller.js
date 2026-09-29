/*
 * Colis du livreur connecté — pages /livreur/colis et /livreur/changer-statut.
 * Liste des colis en tournée (parcel_status DISTRIBUTION / IN_PROGRESS),
 * recherche d'un colis par code scanné, changement de statut et détail de
 * suivi, restreints aux colis affectés au compte connecté
 * (parcel_livreur = req.user.id, même convention que le dashboard livreur).
 */
const pool = require('../config/db');
const { STATUT_CODE_SQL, STATUT_TYPE_SQL } = require('./parcels.controller');
const {
  appliquerChangementStatut,
  chargerSuiviColis,
  COLONNES_CHANGEMENT_STATUT
} = require('./parcelsAdmin.controller');
const { messageLivreurTemplate } = require('./config.controller');

/**
 * Colonnes et jointures d'un colis vu par le livreur : la liste en tournée
 * (listMesColis) et la recherche par code scanné (getMonColisParCode)
 * renvoient la même forme, affichée par la même carte côté front
 * (components/LivreurColisCard). CRBT à encaisser : 0 si parcel_crbt_zero,
 * sinon parcel_price.
 */
const SELECT_MON_COLIS = `
  SELECT p.parcel_id, p.parcel_code, p.parcel_status,
         (${STATUT_CODE_SQL}) AS statut,
         s.parcel_statut_color AS statut_color,
         p.parcel_report_time  AS report_time,
         p.parcel_receiver, p.parcel_phone,
         p.parcel_address AS adresse, p.parcel_price,
         CASE WHEN COALESCE(p.parcel_crbt_zero, 0) = 1 THEN 0 ELSE p.parcel_price END AS crbt,
         p.parcel_note, p.parcel_replace, p.parcel_open, p.parcel_essayage,
         t.nom_ville AS ville, z.zone_name AS zone,
         c.customers_store AS magasin
    FROM delevery_parcel p
    LEFT JOIN delevery_customers c ON c.customers_id = p.parcel_customer
    LEFT JOIN delevery_tarifs t    ON t.ville_id = p.parcel_city
    LEFT JOIN delevery_zone z      ON z.zone_id = t.zone
    LEFT JOIN delevery_parcel_statut s
      ON s.parcel_statut_code = (${STATUT_CODE_SQL})
     AND s.parcel_statut_type = (${STATUT_TYPE_SQL})`;

/**
 * GET /api/livreurs/me/colis — tous les colis en tournée du livreur connecté,
 * triés par ville puis zone (ordre de tournée). Pas de pagination serveur :
 * un livreur porte peu de colis, les filtres restent côté client.
 */
async function listMesColis(req, res, next) {
  try {
    const [rows] = await pool.query(
      `${SELECT_MON_COLIS}
        WHERE p.parcel_livreur = ?
          AND p.parcel_status IN ('IN_PROGRESS', 'DISTRIBUTION')
        ORDER BY t.nom_ville ASC, z.zone_name ASC, p.parcel_id ASC`,
      [Number(req.user.id)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/livreurs/me/colis/code/:code — page « Changer statut par scan » du
 * dashboard livreur : le colis désigné par le code lu (QR / code-barres de
 * l'étiquette = parcel_code, ou code interne parcel_code_interne), quel que
 * soit son statut, mais uniquement s'il est affecté au livreur connecté
 * (404 sinon, sans révéler l'existence du colis). Même forme qu'une ligne
 * de listMesColis : la carte et la modale « Changer statut » sont partagées.
 */
async function getMonColisParCode(req, res, next) {
  try {
    const code = String(req.params.code || '').trim().slice(0, 100);
    if (!code) return res.status(404).json({ message: 'Colis introuvable.' });
    const [[parcel]] = await pool.query(
      `${SELECT_MON_COLIS}
        WHERE p.parcel_livreur = ?
          AND (p.parcel_code = ? OR p.parcel_code_interne = ?)
        LIMIT 1`,
      [Number(req.user.id), code, code]
    );
    if (!parcel) {
      return res
        .status(404)
        .json({ message: `Colis « ${code} » introuvable ou non affecté à votre compte.` });
    }
    res.json(parcel);
  } catch (err) {
    next(err);
  }
}

/**
 * Charge un colis affecté au livreur connecté (colonnes du changement de
 * statut par défaut) selon une clause WHERE propre à l'identifiant fourni ;
 * null si le colis n'existe pas ou ne lui est pas affecté.
 */
async function chargerMonColis(req, whereSql, params, columns = COLONNES_CHANGEMENT_STATUT) {
  const [[parcel]] = await pool.query(
    `SELECT ${columns}
       FROM delevery_parcel p
      WHERE (${whereSql}) AND p.parcel_livreur = ?
      LIMIT 1`,
    [...params, Number(req.user.id)]
  );
  return parcel || null;
}

/**
 * POST /api/livreurs/me/colis/:id/statut — changement de statut par le livreur,
 * mêmes règles que la modale admin (appliquerChangementStatut) mais scope
 * réduit à ses propres colis : 404 si le colis ne lui est pas affecté.
 */
async function changerStatutMonColis(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }
    const parcel = await chargerMonColis(req, 'p.parcel_id = ?', [id]);
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    return appliquerChangementStatut(req, res, next, parcel);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/livreurs/me/colis/code/:code/statut — même changement de statut,
 * mais le colis est désigné par son code (parcel_code, ou code interne
 * parcel_code_interne, comme au scan des bons) : c'est la clé qu'utilisent les
 * plateformes des livreurs, qui ne connaissent pas nos parcel_id. Le corps et
 * la réponse sont identiques à la variante par id.
 */
async function changerStatutMonColisParCode(req, res, next) {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(404).json({ message: 'Colis introuvable.' });
    const parcel = await chargerMonColis(
      req,
      'p.parcel_code = ? OR p.parcel_code_interne = ?',
      [code, code]
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    return appliquerChangementStatut(req, res, next, parcel);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/livreurs/me/colis/:id/suivi — modale « Détail suivi » du dashboard
 * livreur : même timeline que la version admin (chargerSuiviColis : historique
 * des statuts avec photos preuve, modifications du colis), restreint aux colis
 * affectés au livreur connecté (404 sinon). Le livreur ne voit ni l'auteur de
 * chaque étape (utilisateur / membre de l'équipe client) ni le téléphone du
 * livreur : ces champs sont retirés ici, avant l'envoi au navigateur.
 */
async function getSuiviMonColis(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ message: 'Colis introuvable.' });
    }
    const parcel = await chargerMonColis(
      req,
      'p.parcel_id = ?',
      [id],
      'p.parcel_id, p.parcel_code, p.parcel_livreur'
    );
    if (!parcel) return res.status(404).json({ message: 'Colis introuvable.' });
    const suivi = await chargerSuiviColis(parcel);
    res.json({
      code: suivi.code,
      livreur: suivi.livreur ? { name: suivi.livreur.name, phone: null } : null,
      entries: suivi.entries.map(({ user, member, ...entry }) => entry)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/livreurs/me/colis/message — modèle du message WhatsApp configuré
 * par l'admin (Configuration > Options), balises non remplacées : le front
 * les substitue avec les données du colis au clic sur « Message WhatsApp ».
 */
async function getMessageColis(req, res, next) {
  try {
    res.json({ template: await messageLivreurTemplate() });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMesColis,
  getMonColisParCode,
  changerStatutMonColis,
  changerStatutMonColisParCode,
  getSuiviMonColis,
  getMessageColis
};
