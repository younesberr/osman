const pool = require('../config/db');
const { emettreEvenement } = require('../services/whatsappRegles');
const {
  getAgenceScope,
  villeInAgenceSql,
  userAgenceSql,
  clientDansAgence
} = require('../utils/agenceScope');

/*
 * Demandes de ramassage — dashboard client (page /client/demande-ramassage)
 * et gestion admin / ramasseur (page /admin/ramassage).
 * Table legacy delevery_pickup_request (partagée avec le système de production
 * PHP), mêmes règles que le legacy : statut initial NEW, maximum 3 demandes
 * NEW simultanées par client, téléphone marocain à 10 chiffres.
 *  - pickup_request_statut : NEW (en attente d'affectation) → RECEIVED
 *    (affectée à un ramasseur) → TREATED (ramassée) ;
 *  - pickup_request_type   : SIMPLE_PARCEL (colis) | STOCK (colis de stock) ;
 *  - pickup_request_affected_to : ramasseur (users_type = 6) auquel la demande
 *    est affectée, 0 = non affectée (colonne legacy, jamais renseignée avant
 *    ORTALOG) ;
 *  - pickup_request_member : membre d'équipe auteur de la demande (0 =
 *    propriétaire / legacy), colonne ajoutée par
 *    sql/2026-08-23_demandes-ramassage-colonne-membre.sql (absence tolérée) ;
 *  - pickup_request_auto   : 1 = demande créée automatiquement à la saisie
 *    d'un colis (une seule demande ouverte NEW / RECEIVED par client ; le
 *    cycle repart quand le ramasseur marque la demande TREATED), colonne
 *    ajoutée par sql/2026-08-24_ramassage-admin-colonne-auto.sql (absence
 *    tolérée : les demandes automatiques ne sont alors pas créées). Les
 *    demandes périodiques (12h00, jours de la fiche client) sont aussi
 *    marquées auto = 1, avec la note NOTE_PERIODIQUE ;
 *  - pickup_request_canceled : 1 = clôturée par « Annuler le ramassage »
 *    (statut TREATED comme un ramassage normal — le legacy ne connaît pas
 *    d'autre statut fermé et le cycle des demandes automatiques repart —
 *    mais affichée « Annulée » dans ORTALOG), colonne ajoutée par
 *    sql/2026-08-27_ramassage-annulation.sql (absence tolérée : le bouton
 *    « Annuler le ramassage » renvoie alors un message d'indisponibilité) ;
 *  - l'admin peut aussi créer une demande manuellement pour un client
 *    (POST /api/demandes-ramassage, ex. ramassage demandé par téléphone).
 */

const STATUTS = { new: 'NEW', received: 'RECEIVED', treated: 'TREATED' };
const CODES = { NEW: 'new', RECEIVED: 'received', TREATED: 'treated' };
const TYPES = ['SIMPLE_PARCEL', 'STOCK'];
const MAX_EN_ATTENTE = 3;
// Plafond de la liste admin (recherche / pagination côté client, comme les bons).
const MAX_DEMANDES = 1000;

/** member_id du membre d'équipe connecté, 0 pour le propriétaire. */
function memberOf(req) {
  return Number(req.user?.memberId) || 0;
}

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000) + (endOfDay ? 86399 : 0);
}

/**
 * Nombre de demandes manuelles encore en attente (NEW) du client — les
 * demandes automatiques ne consomment pas le quota de MAX_EN_ATTENTE.
 */
async function countEnAttente(customerId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM delevery_pickup_request
        WHERE pickup_request_customer = ? AND pickup_request_statut = ?
          AND pickup_request_auto = 0`,
      [customerId, STATUTS.new]
    );
    return Number(row.n) || 0;
  } catch (err) {
    // pickup_request_auto absent (migration pas encore exécutée) : aucune
    // demande automatique ne peut alors exister, l'ancien comptage est juste.
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM delevery_pickup_request
        WHERE pickup_request_customer = ? AND pickup_request_statut = ?`,
      [customerId, STATUTS.new]
    );
    return Number(row.n) || 0;
  }
}

/** Ligne SQL → JSON de l'API (statut en minuscules pour le front). */
function demandeJson(r) {
  return {
    id: r.id,
    type: r.type,
    phone: r.phone || '',
    address: r.address || '',
    note: r.note || '',
    time: Number(r.time) || 0,
    statut: CODES[r.statut] || 'new'
  };
}

/**
 * GET /api/demandes-ramassage/client — demandes du client connecté, les plus
 * récentes d'abord. Query : statut (new | received | treated, '' = tous),
 * type (SIMPLE_PARCEL | STOCK, '' = tous), dateFrom / dateTo (AAAA-MM-JJ,
 * date de la demande).
 */
async function listClientDemandes(req, res, next) {
  try {
    const statut = String(req.query.statut || '').trim();
    const type = String(req.query.type || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    const where = ['pickup_request_customer = ?'];
    const params = [Number(req.user.id)];
    if (STATUTS[statut]) {
      where.push('pickup_request_statut = ?');
      params.push(STATUTS[statut]);
    }
    if (TYPES.includes(type)) {
      where.push('pickup_request_type = ?');
      params.push(type);
    }
    if (dateFrom !== null) {
      where.push('pickup_request_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('pickup_request_time <= ?');
      params.push(dateTo);
    }

    const [rows] = await pool.query(
      `SELECT pickup_request_id AS id, pickup_request_type AS type,
              pickup_request_phone AS phone, pickup_request_address AS address,
              pickup_request_note AS note, pickup_request_time AS time,
              pickup_request_statut AS statut
         FROM delevery_pickup_request
        WHERE ${where.join(' AND ')}
        ORDER BY pickup_request_time DESC, pickup_request_id DESC`,
      params
    );
    res.json(rows.map(demandeJson));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/demandes-ramassage/client/new — préremplissage du formulaire
 * (téléphone / adresse de la fiche client) + quota de demandes en attente.
 */
async function getClientDemandeDefaults(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const [[client]] = await pool.query(
      `SELECT customers_phone AS phone, customers_address AS address
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [customerId]
    );
    res.json({
      phone: client?.phone || '',
      address: client?.address || '',
      enAttente: await countEnAttente(customerId),
      max: MAX_EN_ATTENTE
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/demandes-ramassage/client — nouvelle demande de ramassage.
 * Body : { type, phone, address, note }. Créée en statut NEW ; refusée si le
 * client a déjà MAX_EN_ATTENTE demandes en attente (règle du legacy).
 */
async function createClientDemande(req, res, next) {
  try {
    const customerId = Number(req.user.id);
    const type = String(req.body?.type || '').trim();
    const phone = String(req.body?.phone || '').replace(/[\s.\-/]/g, '');
    const address = String(req.body?.address || '').trim().slice(0, 500);
    const note = String(req.body?.note || '').trim().slice(0, 500);

    if (!TYPES.includes(type)) {
      return res.status(400).json({ message: 'Veuillez choisir le type de ramassage.' });
    }
    if (!/^0[5-8]\d{8}$/.test(phone)) {
      return res.status(400).json({
        message: 'Veuillez saisir un téléphone valide (10 chiffres, ex. 0612345678).'
      });
    }
    if (!address) {
      return res.status(400).json({ message: "L'adresse de ramassage est obligatoire." });
    }
    if (!note) {
      return res.status(400).json({ message: 'La remarque est obligatoire.' });
    }
    if ((await countEnAttente(customerId)) >= MAX_EN_ATTENTE) {
      return res.status(400).json({
        message: `Vous avez déjà ${MAX_EN_ATTENTE} demandes en attente. Veuillez patienter avant d'en envoyer une nouvelle.`
      });
    }

    const now = Math.floor(Date.now() / 1000);
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO delevery_pickup_request
           (pickup_request_customer, pickup_request_type, pickup_request_data_id,
            pickup_request_phone, pickup_request_address, pickup_request_note,
            pickup_request_time, pickup_request_statut, pickup_request_affected_to,
            pickup_request_member)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0, ?)`,
        [customerId, type, phone, address, note, now, STATUTS.new, memberOf(req)]
      );
    } catch (err) {
      // pickup_request_member absent (migration pas encore exécutée) :
      // on enregistre quand même la demande, sans attribution nominative.
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      [result] = await pool.query(
        `INSERT INTO delevery_pickup_request
           (pickup_request_customer, pickup_request_type, pickup_request_data_id,
            pickup_request_phone, pickup_request_address, pickup_request_note,
            pickup_request_time, pickup_request_statut, pickup_request_affected_to)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0)`,
        [customerId, type, phone, address, note, now, STATUTS.new]
      );
    }

    emettreEvenement('RAMASSAGE_CREEE', { demandeId: result.insertId, origine: 'client' });
    res.status(201).json({
      id: result.insertId,
      type,
      phone,
      address,
      note,
      time: now,
      statut: 'new'
    });
  } catch (err) {
    next(err);
  }
}

const NOTE_AUTO = 'Demande automatique (saisie de colis)';

/**
 * Demande de ramassage automatique à la saisie d'un colis NORMAL (création
 * simple ou import, client comme admin) : une seule demande ouverte (NEW /
 * RECEIVED, manuelle ou automatique) par client — le passage du ramasseur
 * récupère tout. Les colis de stock (parcel_from_stock = 1) sont exclus : leur
 * marchandise est déjà en agence, il n'y a rien à ramasser chez le client
 * (les appelants de parcels.controller.js ne l'invoquent pas pour eux).
 * Best-effort appelé APRÈS le commit de la création du colis : n'émet jamais
 * d'exception (la demande ne doit jamais faire échouer la saisie), et
 * abandonne silencieusement si la colonne pickup_request_auto n'existe pas
 * encore (migration sql/2026-08-24_ramassage-admin-colonne-auto.sql).
 */
async function createAutoDemandeRamassage(customerId, memberId = 0) {
  try {
    const [[client]] = await pool.query(
      `SELECT customers_phone AS phone, customers_address AS address
         FROM delevery_customers WHERE customers_id = ? LIMIT 1`,
      [Number(customerId)]
    );
    if (!client) return;

    // Téléphone / adresse de la fiche client, sans validation stricte (une
    // fiche incomplète ne doit pas empêcher la demande).
    const phone = String(client.phone || '').trim().slice(0, 20);
    const address = String(client.address || '').trim().slice(0, 500);
    const now = Math.floor(Date.now() / 1000);

    // Anti-doublon et insertion en un seul statement : rien si le client a
    // déjà une demande ouverte (course résiduelle entre saisies simultanées
    // acceptée : un doublon rare est bénin, le ramasseur traite les deux).
    const insert = (cols, values, params) =>
      pool.query(
        `INSERT INTO delevery_pickup_request (${cols})
          SELECT ${values} FROM DUAL
           WHERE NOT EXISTS (
             SELECT 1 FROM delevery_pickup_request
              WHERE pickup_request_customer = ?
                AND pickup_request_statut IN (?, ?))`,
        [...params, Number(customerId), STATUTS.new, STATUTS.received]
      );
    const base = [Number(customerId), 'SIMPLE_PARCEL', phone, address, NOTE_AUTO, now, STATUTS.new];
    let resultat = null;
    try {
      [resultat] = await insert(
        `pickup_request_customer, pickup_request_type, pickup_request_data_id,
         pickup_request_phone, pickup_request_address, pickup_request_note,
         pickup_request_time, pickup_request_statut, pickup_request_affected_to,
         pickup_request_member, pickup_request_auto`,
        `?, ?, 0, ?, ?, ?, ?, ?, 0, ?, 1`,
        [...base, Number(memberId) || 0]
      );
    } catch (err) {
      // pickup_request_member absent : on retente sans attribution nominative.
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      try {
        [resultat] = await insert(
          `pickup_request_customer, pickup_request_type, pickup_request_data_id,
           pickup_request_phone, pickup_request_address, pickup_request_note,
           pickup_request_time, pickup_request_statut, pickup_request_affected_to,
           pickup_request_auto`,
          `?, ?, 0, ?, ?, ?, ?, ?, 0, 1`,
          base
        );
      } catch (err2) {
        // pickup_request_auto absent : pas de demande automatique tant que la
        // migration n'est pas exécutée (aucune ligne "indistinguable" créée).
        if (err2.code !== 'ER_BAD_FIELD_ERROR') throw err2;
      }
    }
    // CRM WhatsApp : demande réellement créée (NOT EXISTS satisfait).
    if (resultat && resultat.affectedRows > 0) {
      emettreEvenement('RAMASSAGE_CREEE', { demandeId: resultat.insertId, origine: 'auto' });
    }
  } catch (err) {
    console.error('Demande de ramassage automatique non créée :', err.message);
  }
}

/* Jours getDay() → noms français (customers_ramassage_jours, CSV lundi…samedi). */
const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const NOTE_PERIODIQUE = 'Demande automatique (périodicité de ramassage)';

/**
 * Demandes de ramassage périodiques (déclenchées à 12h00 par
 * jobs/ramassagePeriodique.js) : une demande automatique pour chaque client
 * actif dont customers_ramassage_jours (fiche client, section "Ramassage",
 * sql/2026-08-26_ramassage-periodicite.sql) contient le jour courant. Mêmes
 * règles que les demandes automatiques à la saisie d'un colis : une seule
 * demande ouverte (NEW / RECEIVED) par client, et au plus une demande
 * périodique par client et par jour (redémarrage du serveur sans doublon).
 * Best-effort : n'émet jamais d'exception, et abandonne silencieusement si
 * une colonne n'existe pas encore (migrations non exécutées).
 */
async function createDemandesPeriodiques(date = new Date()) {
  try {
    const jour = JOURS_SEMAINE[date.getDay()];
    const debutJour = Math.floor(
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000
    );
    const now = Math.floor(date.getTime() / 1000);

    const insert = (cols, values) =>
      pool.query(
        `INSERT INTO delevery_pickup_request (${cols})
         SELECT ${values}
           FROM delevery_customers c
          WHERE IFNULL(c.customers_active, 0) = 1
            AND FIND_IN_SET(?, IFNULL(c.customers_ramassage_jours, ''))
            AND NOT EXISTS (
              SELECT 1 FROM delevery_pickup_request r
               WHERE r.pickup_request_customer = c.customers_id
                 AND r.pickup_request_statut IN (?, ?))
            AND NOT EXISTS (
              SELECT 1 FROM delevery_pickup_request r2
               WHERE r2.pickup_request_customer = c.customers_id
                 AND r2.pickup_request_note = ?
                 AND r2.pickup_request_time >= ?)`,
        [
          NOTE_PERIODIQUE,
          now,
          STATUTS.new,
          jour,
          STATUTS.new,
          STATUTS.received,
          NOTE_PERIODIQUE,
          debutJour
        ]
      );
    const baseCols = `pickup_request_customer, pickup_request_type, pickup_request_data_id,
       pickup_request_phone, pickup_request_address, pickup_request_note,
       pickup_request_time, pickup_request_statut, pickup_request_affected_to`;
    const baseValues = `c.customers_id, 'SIMPLE_PARCEL', 0,
       LEFT(IFNULL(c.customers_phone, ''), 20),
       LEFT(IFNULL(c.customers_address, ''), 500), ?, ?, ?, 0`;
    let result;
    try {
      [result] = await insert(
        `${baseCols}, pickup_request_member, pickup_request_auto`,
        `${baseValues}, 0, 1`
      );
    } catch (err) {
      // pickup_request_member absent : on retente sans attribution nominative.
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      try {
        [result] = await insert(`${baseCols}, pickup_request_auto`, `${baseValues}, 1`);
      } catch (err2) {
        // pickup_request_auto ou customers_ramassage_jours absent : pas de
        // demandes périodiques tant que les migrations ne sont pas exécutées.
        if (err2.code !== 'ER_BAD_FIELD_ERROR') throw err2;
        return;
      }
    }
    if (result.affectedRows > 0) {
      console.log(`Ramassage périodique (${jour}) : ${result.affectedRows} demande(s) créée(s).`);
      // CRM WhatsApp : un événement par demande créée à l'instant.
      const [creees] = await pool.query(
        'SELECT pickup_request_id FROM delevery_pickup_request WHERE pickup_request_note = ? AND pickup_request_time = ?',
        [NOTE_PERIODIQUE, now]
      );
      for (const d of creees) emettreEvenement('RAMASSAGE_CREEE', { demandeId: d.pickup_request_id, origine: 'periodique' });
    }
  } catch (err) {
    console.error('Demandes de ramassage périodiques non créées :', err.message);
  }
}

/* ---------- Gestion admin / ramasseur (page /admin/ramassage) ---------- */

/**
 * GET /api/demandes-ramassage/clients — clients actifs pour la modale
 * « Nouvelle demande » (téléphone / adresse de la fiche inclus pour le
 * préremplissage du formulaire) ; les types 3 / 4 ne voient que les clients
 * de leur agence (ville de ramassage de la fiche).
 */
async function listClientsAdmin(req, res, next) {
  try {
    const where = ['IFNULL(c.customers_active, 0) = 1'];
    const params = [];
    const scope = await getAgenceScope(req.user);
    if (scope !== null) {
      where.push(villeInAgenceSql('c.customers_pickup_city'));
      params.push(scope);
    }
    const [rows] = await pool.query(
      `SELECT c.customers_id AS id, c.customers_name AS nom,
              c.customers_store AS store, c.customers_phone AS phone,
              c.customers_address AS address
         FROM delevery_customers c
        WHERE ${where.join(' AND ')}
        ORDER BY c.customers_store, c.customers_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/demandes-ramassage — création manuelle d'une demande par un admin
 * (types 1-4) pour un client (ex. ramassage demandé par appel téléphonique),
 * afin de pouvoir l'affecter à un ramasseur. Body : { clientId, type, phone,
 * address, note }. Mêmes règles que la page client (statut NEW, quota de
 * MAX_EN_ATTENTE demandes en attente, téléphone marocain à 10 chiffres), à
 * une exception près : la remarque est facultative. Les types 3 / 4 sont
 * limités aux clients de leur agence.
 */
async function createAdminDemande(req, res, next) {
  try {
    const clientId = parseInt(req.body?.clientId, 10);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un client.' });
    }
    const [[client]] = await pool.query(
      `SELECT customers_id FROM delevery_customers
        WHERE customers_id = ? AND IFNULL(customers_active, 0) = 1 LIMIT 1`,
      [clientId]
    );
    if (!client) {
      return res.status(400).json({ message: 'Client introuvable ou désactivé.' });
    }
    const scope = await getAgenceScope(req.user);
    if (scope !== null && !(await clientDansAgence(clientId, scope))) {
      return res.status(400).json({ message: 'Client introuvable ou désactivé.' });
    }

    const type = String(req.body?.type || '').trim();
    const phone = String(req.body?.phone || '').replace(/[\s.\-/]/g, '');
    const address = String(req.body?.address || '').trim().slice(0, 500);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!TYPES.includes(type)) {
      return res.status(400).json({ message: 'Veuillez choisir le type de ramassage.' });
    }
    if (!/^0[5-8]\d{8}$/.test(phone)) {
      return res.status(400).json({
        message: 'Veuillez saisir un téléphone valide (10 chiffres, ex. 0612345678).'
      });
    }
    if (!address) {
      return res.status(400).json({ message: "L'adresse de ramassage est obligatoire." });
    }
    if ((await countEnAttente(clientId)) >= MAX_EN_ATTENTE) {
      return res.status(400).json({
        message: `Ce client a déjà ${MAX_EN_ATTENTE} demandes en attente. Affectez-les avant d'en créer une nouvelle.`
      });
    }

    const now = Math.floor(Date.now() / 1000);
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO delevery_pickup_request
           (pickup_request_customer, pickup_request_type, pickup_request_data_id,
            pickup_request_phone, pickup_request_address, pickup_request_note,
            pickup_request_time, pickup_request_statut, pickup_request_affected_to,
            pickup_request_member)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0, 0)`,
        [clientId, type, phone, address, note, now, STATUTS.new]
      );
    } catch (err) {
      // pickup_request_member absent (migration pas encore exécutée).
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      [result] = await pool.query(
        `INSERT INTO delevery_pickup_request
           (pickup_request_customer, pickup_request_type, pickup_request_data_id,
            pickup_request_phone, pickup_request_address, pickup_request_note,
            pickup_request_time, pickup_request_statut, pickup_request_affected_to)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, 0)`,
        [clientId, type, phone, address, note, now, STATUTS.new]
      );
    }
    emettreEvenement('RAMASSAGE_CREEE', { demandeId: result.insertId, origine: 'admin', userId: Number(req.user.id) || 0 });
    res.status(201).json({ id: result.insertId, statut: 'new' });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/demandes-ramassage — demandes pour la page /admin/ramassage, les
 * plus récentes d'abord (MAX_DEMANDES max). Query : statut (new | received |
 * treated, '' = tous), type (SIMPLE_PARCEL | STOCK), origine (auto |
 * manuelle), dateFrom / dateTo (AAAA-MM-JJ).
 * Ramasseur (type 6) : uniquement les demandes affectées à son compte.
 * Types 3 / 4 : clients de leur agence (ville de ramassage de la fiche).
 * Réponse : { demandes: [...], counts: { new, received, treated } } — counts
 * calculés avec les mêmes filtres hors statut (onglets / puces de la page).
 */
async function listDemandes(req, res, next) {
  try {
    const role = Number(req.user.role);
    const statut = String(req.query.statut || '').trim();
    const type = String(req.query.type || '').trim();
    const origine = String(req.query.origine || '').trim();
    const dateFrom = dayToUnix(req.query.dateFrom, false);
    const dateTo = dayToUnix(req.query.dateTo, true);

    // Conditions communes (hors statut, qui ne s'applique qu'à la liste).
    const where = [];
    const params = [];
    if (role === 6) {
      where.push('r.pickup_request_affected_to = ?');
      params.push(Number(req.user.id));
    } else {
      const scope = await getAgenceScope(req.user);
      if (scope !== null) {
        where.push(villeInAgenceSql('c.customers_pickup_city'));
        params.push(scope);
      }
    }
    if (TYPES.includes(type)) {
      where.push('r.pickup_request_type = ?');
      params.push(type);
    }
    if (dateFrom !== null) {
      where.push('r.pickup_request_time >= ?');
      params.push(dateFrom);
    }
    if (dateTo !== null) {
      where.push('r.pickup_request_time <= ?');
      params.push(dateTo);
    }

    /**
     * Liste + compteurs par statut, avec ou sans les colonnes optionnelles
     * pickup_request_auto (autoDispo = false : repli "0 AS auto", filtre
     * origine ignoré) et pickup_request_canceled (canceledDispo = false :
     * repli "0 AS canceled").
     */
    async function run(autoDispo, canceledDispo) {
      const w = [...where];
      const p = [...params];
      if (autoDispo && (origine === 'auto' || origine === 'manuelle')) {
        w.push(`IFNULL(r.pickup_request_auto, 0) = ${origine === 'auto' ? 1 : 0}`);
      }
      const wListe = [...w];
      const pListe = [...p];
      if (STATUTS[statut]) {
        wListe.push('r.pickup_request_statut = ?');
        pListe.push(STATUTS[statut]);
      }
      const [rows] = await pool.query(
        `SELECT r.pickup_request_id          AS id,
                r.pickup_request_type        AS type,
                r.pickup_request_phone       AS phone,
                r.pickup_request_address     AS address,
                r.pickup_request_note        AS note,
                r.pickup_request_time        AS time,
                r.pickup_request_statut      AS statut,
                r.pickup_request_affected_to AS affecterId,
                ${autoDispo ? 'IFNULL(r.pickup_request_auto, 0)' : '0'} AS auto,
                ${canceledDispo ? 'IFNULL(r.pickup_request_canceled, 0)' : '0'} AS canceled,
                c.customers_id               AS clientId,
                c.customers_name             AS clientNom,
                c.customers_store            AS clientStore,
                c.customers_phone            AS clientPhone,
                IFNULL(c.customers_verified, 0) AS clientVerifie,
                t.nom_ville                  AS ville,
                ua.users_name                AS affecterNom
           FROM delevery_pickup_request r
           LEFT JOIN delevery_customers c ON c.customers_id = r.pickup_request_customer
           LEFT JOIN delevery_tarifs t    ON t.ville_id = c.customers_pickup_city
           LEFT JOIN delevery_users ua    ON ua.users_id = r.pickup_request_affected_to
          ${wListe.length ? `WHERE ${wListe.join(' AND ')}` : ''}
          ORDER BY r.pickup_request_time DESC, r.pickup_request_id DESC
          LIMIT ${MAX_DEMANDES}`,
        pListe
      );
      const [countRows] = await pool.query(
        `SELECT r.pickup_request_statut AS statut, COUNT(*) AS n
           FROM delevery_pickup_request r
           LEFT JOIN delevery_customers c ON c.customers_id = r.pickup_request_customer
          ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
          GROUP BY r.pickup_request_statut`,
        p
      );
      return { rows, countRows };
    }

    // Colonnes optionnelles issues de migrations distinctes : à chaque
    // ER_BAD_FIELD_ERROR on retente sans la plus récente.
    let data;
    try {
      data = await run(true, true);
    } catch (err) {
      // pickup_request_canceled absent (migration pas encore exécutée).
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      try {
        data = await run(true, false);
      } catch (err2) {
        // pickup_request_auto absent (migration pas encore exécutée).
        if (err2.code !== 'ER_BAD_FIELD_ERROR') throw err2;
        data = await run(false, false);
      }
    }

    // Colis encore en attente de ramassage par client (info carte / tableau).
    const clientIds = [...new Set(data.rows.map((r) => Number(r.clientId)).filter(Boolean))];
    const enAttenteParClient = new Map();
    if (clientIds.length) {
      const [cnt] = await pool.query(
        `SELECT parcel_customer AS clientId, COUNT(*) AS n
           FROM delevery_parcel
          WHERE parcel_status = 'WAITING_PICKUP' AND parcel_customer IN (?)
          GROUP BY parcel_customer`,
        [clientIds]
      );
      for (const row of cnt) enAttenteParClient.set(Number(row.clientId), Number(row.n));
    }

    // Heure de ramassage préférée de la fiche client (customers_ramassage_heure,
    // sql/2026-08-27_ramassage-heure.sql) — affichée sur les cartes du
    // ramasseur ; Map vide si la colonne n'est pas encore migrée.
    const heureParClient = new Map();
    if (clientIds.length) {
      try {
        const [heures] = await pool.query(
          `SELECT customers_id AS clientId, customers_ramassage_heure AS heure
             FROM delevery_customers
            WHERE customers_id IN (?) AND customers_ramassage_heure IS NOT NULL`,
          [clientIds]
        );
        for (const row of heures) {
          heureParClient.set(Number(row.clientId), String(row.heure).slice(0, 5));
        }
      } catch (err) {
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      }
    }

    const counts = { new: 0, received: 0, treated: 0 };
    for (const row of data.countRows) {
      const code = CODES[row.statut];
      if (code) counts[code] = Number(row.n) || 0;
    }

    res.json({
      demandes: data.rows.map((r) => ({
        id: r.id,
        type: r.type,
        phone: r.phone || '',
        address: r.address || '',
        note: r.note || '',
        time: Number(r.time) || 0,
        statut: CODES[r.statut] || 'new',
        auto: Number(r.auto) || 0,
        canceled: Number(r.canceled) || 0,
        clientId: Number(r.clientId) || 0,
        clientNom: r.clientNom || '',
        clientStore: r.clientStore || '',
        clientPhone: r.clientPhone || '',
        clientVerifie: Number(r.clientVerifie) || 0,
        clientRamassageHeure: heureParClient.get(Number(r.clientId)) || '',
        ville: r.ville || '',
        affecterId: Number(r.affecterId) || 0,
        affecterNom: r.affecterNom || '',
        parcelsEnAttente: enAttenteParClient.get(Number(r.clientId)) || 0
      })),
      counts
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/demandes-ramassage/ramasseurs — ramasseurs actifs (comptes
 * principaux, users_type = 6) pour la liste déroulante d'affectation ; les
 * types 3 / 4 ne voient que les ramasseurs de leur agence.
 */
async function listRamasseurs(req, res, next) {
  try {
    const where = [`u.users_active = 1`, `u.users_parent_id IS NULL`, `u.users_type = '6'`];
    const params = [];
    const scope = await getAgenceScope(req.user);
    if (scope !== null) {
      where.push(`${userAgenceSql('u')} = ?`);
      params.push(scope);
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

/** Charge une demande ; null si l'id est invalide ou la demande introuvable. */
async function loadDemande(id) {
  const demandeId = parseInt(id, 10);
  if (!Number.isInteger(demandeId) || demandeId <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT pickup_request_id          AS id,
            pickup_request_customer    AS customer,
            pickup_request_statut      AS statut,
            pickup_request_affected_to AS affecterId
       FROM delevery_pickup_request
      WHERE pickup_request_id = ? LIMIT 1`,
    [demandeId]
  );
  return row || null;
}

/**
 * PATCH /api/demandes-ramassage/:id/affecter — body { userId }. Affecte la
 * demande à un ramasseur actif (statut → RECEIVED « Affectée ») ;
 * réaffectation possible tant que la demande n'est pas traitée. Les types
 * 3 / 4 sont limités aux demandes de leur agence (404 hors périmètre, comme
 * une demande inexistante) et aux ramasseurs de leur agence.
 */
async function affecterDemande(req, res, next) {
  try {
    const demande = await loadDemande(req.params.id);
    if (!demande) return res.status(404).json({ message: 'Demande introuvable.' });

    const scope = await getAgenceScope(req.user);
    if (scope !== null && !(await clientDansAgence(demande.customer, scope))) {
      return res.status(404).json({ message: 'Demande introuvable.' });
    }
    if (demande.statut === STATUTS.treated) {
      return res.status(409).json({ message: 'Cette demande est déjà traitée.' });
    }

    const userId = parseInt(req.body?.userId, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner un ramasseur.' });
    }
    // Mêmes règles que la liste déroulante : ramasseur (type 6) actif, compte
    // principal, dans l'agence de l'appelant si celui-ci est restreint.
    const [[ramasseur]] = await pool.query(
      `SELECT u.users_id AS id, u.users_name AS nom, ${userAgenceSql('u')} AS agence
         FROM delevery_users u
        WHERE u.users_id = ? AND u.users_active = 1
          AND u.users_parent_id IS NULL AND u.users_type = '6'
        LIMIT 1`,
      [userId]
    );
    if (!ramasseur) {
      return res.status(400).json({ message: 'Ramasseur introuvable ou désactivé.' });
    }
    if (scope !== null && Number(ramasseur.agence) !== scope) {
      return res.status(400).json({ message: 'Ce ramasseur n’appartient pas à votre agence.' });
    }

    await pool.query(
      `UPDATE delevery_pickup_request
          SET pickup_request_affected_to = ?, pickup_request_statut = ?
        WHERE pickup_request_id = ?`,
      [ramasseur.id, STATUTS.received, demande.id]
    );
    emettreEvenement('RAMASSAGE_AFFECTEE', { demandeId: demande.id, ramasseurId: ramasseur.id, userId: Number(req.user.id) || 0 });
    res.json({ id: demande.id, statut: 'received', affecterId: ramasseur.id, affecterNom: ramasseur.nom });
  } catch (err) {
    next(err);
  }
}

/**
 * Charge la demande :id et vérifie les droits de clôture (« Ramasser » /
 * « Annuler le ramassage ») : le ramasseur (type 6) est limité aux demandes
 * affectées à son compte (404 sinon), les types 3 / 4 aux clients de leur
 * agence ; les admins peuvent aussi clôturer une demande non affectée
 * (demande obsolète). Répond (404 / 409) et renvoie null si la clôture est
 * impossible, sinon la demande.
 */
async function demandePourCloture(req, res) {
  const demande = await loadDemande(req.params.id);
  if (!demande) {
    res.status(404).json({ message: 'Demande introuvable.' });
    return null;
  }

  if (Number(req.user.role) === 6) {
    if (Number(demande.affecterId) !== Number(req.user.id)) {
      res.status(404).json({ message: 'Demande introuvable.' });
      return null;
    }
  } else {
    const scope = await getAgenceScope(req.user);
    if (scope !== null && !(await clientDansAgence(demande.customer, scope))) {
      res.status(404).json({ message: 'Demande introuvable.' });
      return null;
    }
  }
  if (demande.statut === STATUTS.treated) {
    res.status(409).json({ message: 'Cette demande est déjà traitée.' });
    return null;
  }
  return demande;
}

/**
 * PATCH /api/demandes-ramassage/:id/ramasser — marque la demande « Ramassée »
 * (TREATED) et clôt le cycle : le prochain colis saisi par le client recréera
 * une demande automatique. Le ramasseur affecté reste renseigné (trace de qui
 * a ramassé).
 */
async function ramasserDemande(req, res, next) {
  try {
    const demande = await demandePourCloture(req, res);
    if (!demande) return;

    await pool.query(
      `UPDATE delevery_pickup_request SET pickup_request_statut = ?
        WHERE pickup_request_id = ?`,
      [STATUTS.treated, demande.id]
    );
    emettreEvenement('RAMASSAGE_EFFECTUEE', { demandeId: demande.id, userId: Number(req.user.id) || 0 });
    res.json({ id: demande.id, statut: 'treated' });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/demandes-ramassage/:id/annuler — annule le ramassage du jour :
 * la demande est clôturée en TREATED comme un ramassage normal (la table
 * legacy ne connaît pas d'autre statut fermé, le cycle repart donc à
 * l'identique — le prochain colis saisi par le client recréera une demande
 * automatique) mais marquée pickup_request_canceled = 1, affichée « Annulée »
 * dans ORTALOG. Mêmes droits que « Ramasser ». Refusée si la colonne n'est
 * pas encore migrée, plutôt que d'afficher à tort la demande comme ramassée.
 */
async function annulerDemande(req, res, next) {
  try {
    const demande = await demandePourCloture(req, res);
    if (!demande) return;

    try {
      await pool.query(
        `UPDATE delevery_pickup_request
            SET pickup_request_statut = ?, pickup_request_canceled = 1
          WHERE pickup_request_id = ?`,
        [STATUTS.treated, demande.id]
      );
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      return res.status(409).json({
        message:
          "L'annulation n'est pas encore disponible (migration sql/2026-08-27_ramassage-annulation.sql à exécuter)."
      });
    }
    emettreEvenement('RAMASSAGE_ANNULEE', { demandeId: demande.id, userId: Number(req.user.id) || 0 });
    res.json({ id: demande.id, statut: 'treated', canceled: 1 });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listClientDemandes,
  getClientDemandeDefaults,
  createClientDemande,
  createAutoDemandeRamassage,
  createDemandesPeriodiques,
  listDemandes,
  listClientsAdmin,
  createAdminDemande,
  listRamasseurs,
  affecterDemande,
  ramasserDemande,
  annulerDemande
};
