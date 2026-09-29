const pool = require('../config/db');
const { hashPassword } = require('../utils/password');

/**
 * Endpoints publics de la page d'accueil (aucune authentification) :
 *  - suivi d'un colis par code (lecture seule) ;
 *  - formulaire de contact (INSERT dans la table legacy delevery_home_msg,
 *    messages consultés depuis l'admin de l'ancien site) ;
 *  - demande de création de compte client (INSERT dans la table legacy
 *    delevery_new_customers, statut 0 = en attente — page /register).
 *
 * Reproduit le comportement de l'ancien site PHP (files/action.php action=track
 * et files/home.php) : historique hors situation INVOICED, statut effectif
 * IN_PROGRESS → parcel_history_status_second, libellés français de delevery_string.
 */

/** GET /api/public/track?num=CODE — historique public d'un colis. */
async function track(req, res, next) {
  try {
    const num = String(req.query.num || '').trim();
    if (!num) {
      return res.json({ success: false, message: 'يرجى إدخال رقم التتبع.' });
    }

    const [parcels] = await pool.query(
      'SELECT parcel_id FROM delevery_parcel WHERE parcel_code = ? LIMIT 1',
      [num]
    );
    if (!parcels.length) {
      return res.json({ success: false, message: 'لم يتم العثور على أي طرد بهذا الرقم.' });
    }

    const [history] = await pool.query(
      `SELECT parcel_history_status AS status,
              parcel_history_status_second AS status_second,
              parcel_history_time AS time
         FROM delevery_parcel_history
        WHERE parcel_history_parcel = ?
          AND parcel_history_situation != 'INVOICED'
        ORDER BY parcel_history_time ASC`,
      [parcels[0].parcel_id]
    );

    // Statut effectif de chaque étape, puis libellé (fr) + couleur du référentiel.
    const codes = [
      ...new Set(
        history
          .map((h) => (h.status === 'IN_PROGRESS' && h.status_second ? h.status_second : h.status))
          .filter(Boolean)
      )
    ];

    const byCode = {};
    if (codes.length) {
      const [statuts] = await pool.query(
        `SELECT s.parcel_statut_code AS code,
                s.parcel_statut_color AS color,
                COALESCE(st.string_text, s.parcel_statut_name) AS name
           FROM delevery_parcel_statut s
           LEFT JOIN delevery_string st
             ON st.string_ref COLLATE utf8mb4_unicode_ci = s.parcel_statut_name
            AND st.string_lang = 'fr'
          WHERE s.parcel_statut_code IN (?)
          ORDER BY s.parcel_statut_id ASC`,
        [codes]
      );
      for (const s of statuts) {
        if (!(s.code in byCode)) byCode[s.code] = s;
      }
    }

    const rows = history.map((h) => {
      const code = h.status === 'IN_PROGRESS' && h.status_second ? h.status_second : h.status;
      const statut = byCode[code] || {};
      return {
        name: statut.name || code || '',
        color: statut.color || '#6b7280',
        date: h.time ? new Date(h.time * 1000).toISOString().slice(0, 10) : ''
      };
    });

    res.json({ success: true, code: num, history: rows });
  } catch (err) {
    next(err);
  }
}

/** POST /api/public/contact — enregistre un message dans delevery_home_msg. */
async function contact(req, res, next) {
  try {
    // Honeypot : champ invisible rempli uniquement par les robots → rejet silencieux.
    if (req.body.website) {
      return res.status(201).json({ success: true });
    }

    const { name, city, email, phone, message } = req.body;
    await pool.query(
      `INSERT INTO delevery_home_msg
         (home_msg_name, home_msg_city, home_msg_email, home_msg_phone, home_msg_text, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [name, city || null, email, phone, message]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/public/tarifs/villes — villes de ramassage proposées sur la page
 * tarifs publique : villes distinctes de la matrice tarifaire
 * (delevery_tarifs_matrix), actives dans delevery_tarifs (statut = 1).
 */
async function tarifsVilles(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT m.pickup_ville_id AS id, t.nom_ville AS nom
         FROM delevery_tarifs_matrix m
         JOIN delevery_tarifs t ON t.ville_id = m.pickup_ville_id AND t.statut = 1
        ORDER BY t.nom_ville ASC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/public/tarifs?pickup=ID — tarifs vers toutes les villes actives
 * pour une ville de ramassage, même cascade que la saisie des colis :
 * matrice (pickup, destination) d'abord, puis tarif par défaut de la ville
 * (delevery_tarifs) pour les destinations absentes de la matrice.
 * Les tarifs de la matrice sont listés en premier.
 */
async function tarifs(req, res, next) {
  try {
    const pickup = parseInt(req.query.pickup, 10);
    if (!Number.isInteger(pickup) || pickup <= 0) {
      return res.status(400).json({ message: 'Ville de ramassage invalide.' });
    }

    const [[matrix], [defauts]] = await Promise.all([
      pool.query(
        `SELECT t.ville_id AS id, t.nom_ville AS nom,
                m.frais_livraison AS livraison, m.frais_retour AS retour
           FROM delevery_tarifs_matrix m
           JOIN delevery_tarifs t ON t.ville_id = m.dest_ville_id AND t.statut = 1
          WHERE m.pickup_ville_id = ?
          ORDER BY t.nom_ville ASC`,
        [pickup]
      ),
      pool.query(
        `SELECT t.ville_id AS id, t.nom_ville AS nom,
                t.frais_livraison AS livraison, t.frais_retour AS retour
           FROM delevery_tarifs t
          WHERE t.statut = 1
            AND t.ville_id NOT IN (
              SELECT dest_ville_id FROM delevery_tarifs_matrix WHERE pickup_ville_id = ?)
          ORDER BY t.nom_ville ASC`,
        [pickup]
      )
    ]);

    const toRow = (source) => (r) => ({
      id: r.id,
      nom: r.nom,
      livraison: Number(r.livraison) || 0,
      retour: Number(r.retour) || 0,
      source
    });
    res.json([...matrix.map(toRow('matrix')), ...defauts.map(toRow('default'))]);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/public/register — page publique /register : enregistre une demande
 * de création de compte client dans la table legacy delevery_new_customers
 * (statut 0 = en attente, traitée sur /admin/nouveaux-clients).
 *
 * Mêmes champs que l'ancien formulaire PHP (clients/files/register.php), avec
 * deux différences volontaires :
 *  - le mot de passe est stocké haché en bcrypt (l'ancien site le stockait en
 *    clair) ; il est recopié tel quel dans delevery_customers à l'acceptation ;
 *  - pas d'email d'activation (aucune infrastructure SMTP côté API), donc
 *    new_customers_active reste 0 et active_code '0'.
 * Comme dans le schéma legacy, le CIN est stocké dans new_customers_brand.
 */
async function register(req, res, next) {
  try {
    // Honeypot : champ invisible rempli uniquement par les robots → rejet
    // silencieux ("fax" car le formulaire a un vrai champ site web).
    if (req.body.fax) {
      return res.status(201).json({ success: true });
    }

    const b = req.body;
    const fullname = String(b.fullname || '').trim();
    const storename = String(b.storename || '').trim();
    const cin = String(b.cin || '').trim();
    const email = String(b.email || '').trim();
    const phone = String(b.phone || '').trim();
    const phonePersonal = String(b.phonePersonal || '').trim();
    const city = String(b.city || '').trim();
    const address = String(b.address || '').trim();
    const website = String(b.website || '').trim();
    const rib = String(b.rib || '').trim();

    // Un email de connexion déjà pris par un compte client existant rendrait
    // la demande inacceptable : refus immédiat. Le téléphone peut être partagé.
    const [[compte]] = await pool.query(
      `SELECT customers_id FROM delevery_customers
        WHERE LOWER(customers_email) = LOWER(?)
        LIMIT 1`,
      [email]
    );
    if (compte) {
      return res.status(409).json({
        message: 'يوجد حساب مسجل بالفعل بهذا البريد الإلكتروني. يمكنك تسجيل الدخول مباشرة.'
      });
    }

    const [[demande]] = await pool.query(
      `SELECT new_customers_id FROM delevery_new_customers
        WHERE new_customers_statut = 0
          AND LOWER(new_customers_email) = LOWER(?)
        LIMIT 1`,
      [email]
    );
    if (demande) {
      return res.status(409).json({
        message: 'لديك بالفعل طلب قيد المراجعة بهذا البريد الإلكتروني. سنتواصل معك قريباً.'
      });
    }

    await pool.query(
      `INSERT INTO delevery_new_customers
         (new_customers_name, new_customers_store, new_customers_phone,
          new_customers_email, new_customers_phone_personal, new_customers_password,
          new_customers_address, new_customers_city, new_customers_rc,
          new_customers_website, new_customers_company_type, new_customers_brand,
          new_customers_bank, new_customers_rib, new_customers_statut,
          new_customers_active_code, new_customers_active, new_customers_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, '', ?, 0, '0', 0, ?)`,
      [
        fullname,
        storename,
        phone,
        email,
        phonePersonal,
        await hashPassword(String(b.password || '')),
        address,
        city,
        website,
        cin,
        rib,
        // Timestamp unix en secondes stocké en varchar (schéma legacy).
        String(Math.floor(Date.now() / 1000))
      ]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { track, contact, register, tarifsVilles, tarifs };
