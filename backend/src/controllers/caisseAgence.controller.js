const pool = require('../config/db');
const { getAgenceScope } = require('../utils/agenceScope');
const {
  CAISSE_MIGRATION,
  caisseAgenceSql,
  ajouterEntreeCaisse,
  caisseValidationDisponible,
  caisseArretDisponible
} = require('../utils/caisse');

/*
 * Caisse Agence (page /admin/caisse-agence) — reprise de la page legacy
 * « Dépenses & Recettes » (spent.php) sur la table legacy delevery_spent
 * (partagée avec l'ancien système, colonnes spent_type / spent_validated
 * déjà présentes en production).
 *
 * spent_type : 0 = Dépense, 1 = Recette. spent_validated : 0 = non validé,
 * 1 = validé. spent_time / spent_added_time : timestamps unix stockés en
 * varchar (schéma legacy) ; spent_amount : entier (DH, sans décimales).
 * spent_validated_by / spent_validated_time (sql/2026-09-19_caisse-agence.sql
 * § 1, colonnes additives) : qui a validé et quand ; 0 = inconnu (lignes
 * validées avant la migration). Sans la migration, la validation marche mais
 * le validateur n'est pas enregistré (voir utils/caisse).
 *
 * Rattachement à une agence (utils/caisse) : seules les entrées dont
 * l'auteur est un responsable d'agence (type 3) comptent sur la caisse de
 * son agence ; celles des autres utilisateurs sont « Sans agence » (caisse
 * à part entière, agence_id 0). Même règle pour les entrées automatiques
 * (paiement facture client / facture livreur).
 *
 * Arrêts de caisse (table delevery_caisse_arret, § 2 de la migration) : un
 * arrêt fige le solde d'une caisse à une date (jour inclus) :
 *   solde d'arrêt = solde de l'arrêt précédent + recettes validées −
 *   dépenses validées dont la date d'opération est comprise entre l'arrêt
 *   précédent (exclu) et la date d'arrêt (incluse) ; premier arrêt = depuis
 *   l'origine.
 *  - refusé s'il reste une ligne non validée dans cette période (« ligne
 *    encore à valider ») ou si la date n'est pas au plus tard hier (la
 *    journée doit être terminée : les entrées automatiques du jour sont
 *    datées de maintenant et seraient perdues) ;
 *  - ensuite le solde courant de la caisse = solde d'arrêt + toutes les
 *    lignes (validées ou non) datées après l'arrêt ;
 *  - une ligne validée incluse dans un arrêt n'est plus supprimable ; aucune
 *    ligne ne peut être ajoutée à une date ≤ dernier arrêt de sa caisse ;
 *  - le type 1 peut supprimer le dernier arrêt d'une caisse.
 *
 * Accès (service CAISSE_AGENCE) : type 1 (toujours), type 2 (service coché),
 * type 3 (service par défaut) :
 *  - types 1/2 : voient tout, filtre par agence (ou « Sans agence »),
 *    valident (à l'unité ou en masse), état des caisses et arrêts ;
 *  - type 1 seul : supprime une entrée (hors arrêt) ou le dernier arrêt ;
 *  - type 3    : ne voit que la caisse de son agence (entrées des
 *    responsables de son agence, lui compris), peut seulement ajouter des
 *    entrées.
 */

const MAX_ROWS = 1000;
const MAX_BULK = 500;
const MAX_ARRETS = 500;
const SANS_AGENCE = 0;
const NOM_SANS_AGENCE = 'Sans agence';

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Date du jour "AAAA-MM-JJ" (heure locale serveur), décalée de `delta` jours. */
function dayStr(delta = 0) {
  const d = new Date();
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** "AAAA-MM-JJ" → "JJ/MM/AAAA" (messages). */
function jourFr(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || '');
}

/** Agence de caisse de l'auteur de l'entrée (alias u) : NULL hors type 3. */
const AUTEUR_AGENCE_SQL = caisseAgenceSql('u');

/** Clé de caisse d'une entrée (alias u) : agence_id, 0 = Sans agence. */
const CAISSE_KEY_SQL = `COALESCE(${AUTEUR_AGENCE_SQL}, 0)`;

/** Condition SQL : entrée (alias s, auteur u) rattachée à la caisse `agenceId` (0 = Sans agence). */
function caisseCondition(agenceId) {
  const id = Number(agenceId) || SANS_AGENCE;
  return id === SANS_AGENCE
    ? { sql: `${CAISSE_KEY_SQL} = 0`, params: [] }
    : { sql: `${AUTEUR_AGENCE_SQL} = ?`, params: [id] };
}

/** Valide le body { type, titre, description, montant, date } ; { error } ou valeurs. */
function parseBody(body) {
  const type = Number(body?.type);
  if (type !== 0 && type !== 1) {
    return { error: "Veuillez choisir le type d'entrée (dépense ou recette)." };
  }
  const titre = String(body?.titre || '').trim();
  if (!titre) return { error: 'Veuillez saisir le titre.' };
  if (titre.length > 255) return { error: 'Titre trop long (255 caractères max).' };
  const description = String(body?.description || '').trim();
  if (description.length > 2000) {
    return { error: 'Description trop longue (2000 caractères max).' };
  }
  const montant = Number(body?.montant);
  // delevery_spent.spent_amount est un entier (schéma legacy) : montants en DH sans décimales.
  if (!Number.isInteger(montant) || montant <= 0 || montant > 99999999) {
    return { error: 'Montant invalide (nombre entier de DH attendu).' };
  }
  const date = dayToUnix(body?.date);
  if (date === null) return { error: "Veuillez saisir la date de l'opération." };
  return { type, titre, description, montant, date };
}

/**
 * Périmètre agence de l'appelant : { where: [...], params: [...], scope } à
 * ajouter aux requêtes sur delevery_spent (alias s, auteur joint en u).
 * Type 3 → caisse de son agence uniquement (entrées des responsables
 * d'agence rattachés à cette agence) ; sans agence affectée → rien.
 * Types 1/2 (scope null) → filtre agence facultatif (`agence` : none | <id>).
 */
async function scopeSql(user, agence) {
  const scope = await getAgenceScope(user);
  if (scope !== null) {
    if (!scope) return { where: ['1 = 0'], params: [], scope };
    const cond = caisseCondition(scope);
    return { where: [cond.sql], params: cond.params, scope };
  }
  const filtre = String(agence || '').trim();
  if (filtre === 'none' || /^\d+$/.test(filtre)) {
    const cond = caisseCondition(filtre === 'none' ? SANS_AGENCE : Number(filtre));
    return { where: [cond.sql], params: cond.params, scope };
  }
  return { where: [], params: [], scope };
}

/** Agences actives + « Sans agence » : les caisses arrêtables. */
async function listeCaisses() {
  const [agences] = await pool.query(
    `SELECT agence_id AS id, agence_name AS nom
       FROM delevery_agences
      WHERE agence_active = 1
      ORDER BY agence_name`
  );
  return [
    ...agences.map((a) => ({ id: Number(a.id), nom: a.nom })),
    { id: SANS_AGENCE, nom: NOM_SANS_AGENCE }
  ];
}

/** Nom d'une caisse (agence active ou non, ou « Sans agence »). */
async function nomCaisse(agenceId) {
  const id = Number(agenceId) || SANS_AGENCE;
  if (id === SANS_AGENCE) return NOM_SANS_AGENCE;
  const [[row]] = await pool.query(
    `SELECT agence_name AS nom FROM delevery_agences WHERE agence_id = ? LIMIT 1`,
    [id]
  );
  return row?.nom || `Agence ${id}`;
}

/** Caisse (agence_id, 0 = Sans agence) sur laquelle comptent les entrées d'un employé. */
async function caisseDeUtilisateur(userId) {
  const [[row]] = await pool.query(
    `SELECT ${CAISSE_KEY_SQL} AS agence_id FROM delevery_users u WHERE u.users_id = ? LIMIT 1`,
    [Number(userId) || 0]
  );
  return Number(row?.agence_id) || SANS_AGENCE;
}

/** Dernier arrêt d'une caisse (ou null). `conn` : pool ou connexion de transaction. */
async function dernierArret(conn, agenceId) {
  const [[row]] = await conn.query(
    `SELECT a.arret_id                              AS id,
            DATE_FORMAT(a.arret_date, '%Y-%m-%d')   AS date,
            a.arret_time_fin                        AS time_fin,
            a.arret_solde                           AS solde,
            UNIX_TIMESTAMP(a.arret_created_at)      AS created_time,
            u.users_name                            AS by_name
       FROM delevery_caisse_arret a
       LEFT JOIN delevery_users u ON u.users_id = a.arret_by
      WHERE a.arret_agence_id = ?
      ORDER BY a.arret_time_fin DESC
      LIMIT 1`,
    [Number(agenceId) || SANS_AGENCE]
  );
  if (!row) return null;
  return {
    ...row,
    time_fin: Number(row.time_fin),
    solde: Number(row.solde) || 0,
    created_time: Number(row.created_time) || null
  };
}

/**
 * Mouvements d'une caisse dont la date d'opération est > `apres` et
 * ≤ `jusqua` (timestamps unix, null = sans borne) : sommes toutes lignes et
 * validées seulement, compteurs.
 */
async function mouvements(conn, agenceId, { apres = null, jusqua = null } = {}) {
  const cond = caisseCondition(agenceId);
  const where = [cond.sql];
  const params = [...cond.params];
  if (apres !== null) {
    where.push('CAST(s.spent_time AS UNSIGNED) > ?');
    params.push(apres);
  }
  if (jusqua !== null) {
    where.push('CAST(s.spent_time AS UNSIGNED) <= ?');
    params.push(jusqua);
  }
  const [[row]] = await conn.query(
    `SELECT SUM(CASE WHEN s.spent_type = 1 THEN s.spent_amount ELSE 0 END) AS recettes,
            SUM(CASE WHEN s.spent_type = 0 THEN s.spent_amount ELSE 0 END) AS depenses,
            SUM(CASE WHEN s.spent_type = 1 AND s.spent_validated = 1 THEN s.spent_amount ELSE 0 END)
              AS recettes_validees,
            SUM(CASE WHEN s.spent_type = 0 AND s.spent_validated = 1 THEN s.spent_amount ELSE 0 END)
              AS depenses_validees,
            COUNT(*)                          AS nb_lignes,
            SUM(s.spent_validated = 1)        AS nb_validees,
            SUM(s.spent_validated = 0)        AS nb_non_validees
       FROM delevery_spent s
       LEFT JOIN delevery_users u ON u.users_id = s.spent_by
      WHERE ${where.join(' AND ')}`,
    params
  );
  const n = (v) => Number(v) || 0;
  return {
    recettes: n(row?.recettes),
    depenses: n(row?.depenses),
    recettes_validees: n(row?.recettes_validees),
    depenses_validees: n(row?.depenses_validees),
    nb_lignes: n(row?.nb_lignes),
    nb_validees: n(row?.nb_validees),
    nb_non_validees: n(row?.nb_non_validees)
  };
}

/** 503 si la table des arrêts n'existe pas encore (migration § 2). */
async function arretsOuIndisponible(res) {
  if (await caisseArretDisponible()) return true;
  res.status(503).json({
    message: `Arrêts de caisse indisponibles : exécuter ${CAISSE_MIGRATION} (§ 2, table delevery_caisse_arret).`
  });
  return false;
}

/**
 * GET /api/caisse-agence/filtres — listes des filtres :
 *  - agences actives (types 1/2 uniquement ; un employé restreint à son
 *    agence n'a pas ce filtre) ;
 *  - auteurs : employés ayant saisi au moins une entrée visible par
 *    l'appelant (filtre « Ajouté par ») ;
 *  - validateurs : employés ayant validé au moins une entrée visible
 *    (filtre « Validé par » ; vide sans la migration).
 */
async function listFiltres(req, res, next) {
  try {
    const { where, params, scope } = await scopeSql(req.user, '');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let agences = [];
    if (scope === null) {
      [agences] = await pool.query(
        `SELECT agence_id AS id, agence_name AS nom
           FROM delevery_agences
          WHERE agence_active = 1
          ORDER BY agence_name`
      );
    }

    const [auteurs] = await pool.query(
      `SELECT DISTINCT u.users_id AS id, u.users_name AS nom
         FROM delevery_spent s
         JOIN delevery_users u ON u.users_id = s.spent_by
        ${whereSql}
        ORDER BY u.users_name`,
      params
    );

    let validateurs = [];
    if (await caisseValidationDisponible()) {
      [validateurs] = await pool.query(
        `SELECT DISTINCT v.users_id AS id, v.users_name AS nom
           FROM delevery_spent s
           LEFT JOIN delevery_users u ON u.users_id = s.spent_by
           JOIN delevery_users v ON v.users_id = s.spent_validated_by
          ${whereSql ? `${whereSql} AND` : 'WHERE'} s.spent_validated = 1
          ORDER BY v.users_name`,
        params
      );
    }

    res.json({ agences, auteurs, validateurs });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/caisse-agence — entrées de caisse + totaux de la période.
 * Query : from, to ("AAAA-MM-JJ", '' = sans limite), type (depense | recette),
 * validation (validated | not_validated), agence (none | <id>, types 1/2),
 * auteur (<users_id>), validateur (<users_id>).
 * Totaux (dépenses, recettes, solde) : mêmes filtres SANS le filtre type,
 * comme le legacy (les deux totaux restent affichés).
 * `locked` : 1 si la ligne validée est incluse dans un arrêt de sa caisse
 * (non supprimable).
 */
async function listEntrees(req, res, next) {
  try {
    const where = ['1 = 1'];
    const params = [];

    const from = dayToUnix(req.query.from);
    if (from !== null) {
      where.push('CAST(s.spent_time AS UNSIGNED) >= ?');
      params.push(from);
    }
    const to = dayToUnix(req.query.to);
    if (to !== null) {
      where.push('CAST(s.spent_time AS UNSIGNED) <= ?');
      params.push(to + 86399);
    }

    const validation = String(req.query.validation || '').trim();
    if (validation === 'validated') where.push('s.spent_validated = 1');
    else if (validation === 'not_validated') where.push('s.spent_validated = 0');

    const auteur = String(req.query.auteur || '').trim();
    if (/^\d+$/.test(auteur)) {
      where.push('s.spent_by = ?');
      params.push(Number(auteur));
    }

    const validationOk = await caisseValidationDisponible();
    const validateur = String(req.query.validateur || '').trim();
    if (/^\d+$/.test(validateur)) {
      // Sans la migration, aucun validateur n'est enregistré : liste vide.
      if (!validationOk) {
        return res.json({ rows: [], totaux: { depenses: 0, recettes: 0, solde: 0 } });
      }
      where.push('s.spent_validated = 1 AND s.spent_validated_by = ?');
      params.push(Number(validateur));
    }

    const scope = await scopeSql(req.user, req.query.agence);
    where.push(...scope.where);
    params.push(...scope.params);

    const baseFrom = `FROM delevery_spent s
       LEFT JOIN delevery_users u ON u.users_id = s.spent_by
      WHERE ${where.join(' AND ')}`;

    // Totaux calculés sans le filtre type (les deux cartes restent renseignées).
    const [[totaux]] = await pool.query(
      `SELECT SUM(CASE WHEN s.spent_type = 0 THEN s.spent_amount ELSE 0 END) AS depenses,
              SUM(CASE WHEN s.spent_type = 1 THEN s.spent_amount ELSE 0 END) AS recettes
       ${baseFrom}`,
      params
    );

    const type = String(req.query.type || '').trim();
    let typeSql = '';
    if (type === 'depense') typeSql = 'AND s.spent_type = 0';
    else if (type === 'recette') typeSql = 'AND s.spent_type = 1';

    // Validateur (nom + horodatage) : NULL sans la migration ou pour les
    // lignes validées avant elle (spent_validated_by = 0).
    const validateurSql = validationOk
      ? `(SELECT v.users_name FROM delevery_users v
           WHERE v.users_id = s.spent_validated_by LIMIT 1) AS validated_by,
         NULLIF(s.spent_validated_time, 0)                  AS validated_time,`
      : 'NULL AS validated_by, NULL AS validated_time,';

    // Ligne validée incluse dans un arrêt de sa caisse : verrouillée.
    const lockedSql = (await caisseArretDisponible())
      ? `(s.spent_validated = 1 AND EXISTS (
            SELECT 1 FROM delevery_caisse_arret a
             WHERE a.arret_agence_id = ${CAISSE_KEY_SQL}
               AND a.arret_time_fin >= CAST(s.spent_time AS UNSIGNED))) AS locked,`
      : '0 AS locked,';

    const [rows] = await pool.query(
      `SELECT s.spent_id                           AS id,
              s.spent_title                        AS titre,
              s.spent_desc                         AS description,
              s.spent_amount                       AS montant,
              s.spent_type                         AS type,
              CAST(s.spent_time AS UNSIGNED)       AS date_operation,
              CAST(s.spent_added_time AS UNSIGNED) AS added_time,
              s.spent_validated                    AS validated,
              ${validateurSql}
              ${lockedSql}
              u.users_name                         AS added_by,
              (SELECT ag.agence_name FROM delevery_agences ag
                WHERE ag.agence_id = ${AUTEUR_AGENCE_SQL} LIMIT 1) AS agence
         ${baseFrom} ${typeSql}
        ORDER BY CAST(s.spent_added_time AS UNSIGNED) DESC, s.spent_id DESC
        LIMIT ${MAX_ROWS}`,
      params
    );

    const depenses = Number(totaux?.depenses) || 0;
    const recettes = Number(totaux?.recettes) || 0;
    res.json({
      rows: rows.map((r) => ({
        ...r,
        montant: Number(r.montant) || 0,
        type: Number(r.type),
        validated: Number(r.validated),
        locked: Number(r.locked) ? 1 : 0,
        validated_time: r.validated_time == null ? null : Number(r.validated_time)
      })),
      totaux: { depenses, recettes, solde: recettes - depenses }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/caisse-agence — body { type, titre, description, montant, date }.
 * Ajoute une dépense / recette (types 1, 2 et 3), non validée par défaut ;
 * comptée sur la caisse de l'agence de l'auteur s'il est de type 3, sinon
 * « Sans agence » (règle de lecture, voir utils/caisse).
 * Refusée si la date d'opération est ≤ dernier arrêt de cette caisse.
 */
async function createEntree(req, res, next) {
  try {
    const values = parseBody(req.body);
    if (values.error) return res.status(400).json({ message: values.error });

    if (await caisseArretDisponible()) {
      const agenceId = await caisseDeUtilisateur(req.user.id);
      const dernier = await dernierArret(pool, agenceId);
      if (dernier && values.date <= dernier.time_fin) {
        return res.status(400).json({
          message: `La caisse « ${await nomCaisse(agenceId)} » est arrêtée au ${jourFr(
            dernier.date
          )} : choisissez une date d'opération postérieure.`
        });
      }
    }

    const id = await ajouterEntreeCaisse(pool, {
      type: values.type,
      titre: values.titre,
      description: values.description,
      montant: values.montant,
      date: values.date,
      userId: req.user.id
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
}

/** Charge une entrée par id (avec sa caisse) ; null si introuvable. */
async function loadEntree(id) {
  const entreeId = parseInt(id, 10);
  if (!Number.isInteger(entreeId) || entreeId <= 0) return null;
  const [[entree]] = await pool.query(
    `SELECT s.spent_id                     AS id,
            s.spent_validated              AS validated,
            CAST(s.spent_time AS UNSIGNED) AS date_operation,
            ${CAISSE_KEY_SQL}              AS agence_id
       FROM delevery_spent s
       LEFT JOIN delevery_users u ON u.users_id = s.spent_by
      WHERE s.spent_id = ? LIMIT 1`,
    [entreeId]
  );
  return entree || null;
}

/**
 * Marque validées les entrées `ids` encore non validées, au nom de `user`
 * (validateur + horodatage si la migration est passée). Renvoie
 * { count, validated_by, validated_time } — validated_by / validated_time
 * null sans la migration (le client affiche alors « — »).
 */
async function validerEntrees(ids, user) {
  const now = Math.floor(Date.now() / 1000);
  const tracable = await caisseValidationDisponible();
  const [result] = await pool.query(
    tracable
      ? `UPDATE delevery_spent
            SET spent_validated = 1, spent_validated_by = ?, spent_validated_time = ?
          WHERE spent_id IN (?) AND spent_validated = 0`
      : `UPDATE delevery_spent SET spent_validated = 1
          WHERE spent_id IN (?) AND spent_validated = 0`,
    tracable ? [Number(user.id) || 0, now, ids] : [ids]
  );
  return {
    count: result.affectedRows,
    validated_by: tracable ? user.name || null : null,
    validated_time: tracable ? now : null
  };
}

/**
 * PATCH /api/caisse-agence/:id/valider — marque l'entrée validée
 * (types 1/2 uniquement, comme le legacy).
 */
async function validateEntree(req, res, next) {
  try {
    const entree = await loadEntree(req.params.id);
    if (!entree) return res.status(404).json({ message: 'Entrée introuvable.' });
    const done = await validerEntrees([entree.id], req.user);
    res.json({ id: entree.id, ...done });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/caisse-agence/valider — body { ids: [...] } : validation en
 * masse (types 1/2). Les entrées déjà validées sont ignorées.
 */
async function validateEntrees(req, res, next) {
  try {
    const ids = Array.from(
      new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((v) => parseInt(v, 10)))
    ).filter((v) => Number.isInteger(v) && v > 0);
    if (!ids.length) return res.status(400).json({ message: 'Aucune entrée sélectionnée.' });
    if (ids.length > MAX_BULK) {
      return res
        .status(400)
        .json({ message: `${MAX_BULK} entrées maximum par validation en masse.` });
    }
    const done = await validerEntrees(ids, req.user);
    res.json({ ids, ...done });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/caisse-agence/:id — supprime l'entrée (super admin, type 1,
 * uniquement). Refusé si la ligne validée est incluse dans un arrêt de sa
 * caisse (le solde d'arrêt ne correspondrait plus).
 */
async function deleteEntree(req, res, next) {
  try {
    const entree = await loadEntree(req.params.id);
    if (!entree) return res.status(404).json({ message: 'Entrée introuvable.' });
    if (Number(entree.validated) === 1 && (await caisseArretDisponible())) {
      const [[arret]] = await pool.query(
        `SELECT DATE_FORMAT(arret_date, '%Y-%m-%d') AS date
           FROM delevery_caisse_arret
          WHERE arret_agence_id = ? AND arret_time_fin >= ?
          ORDER BY arret_time_fin ASC LIMIT 1`,
        [Number(entree.agence_id) || SANS_AGENCE, Number(entree.date_operation) || 0]
      );
      if (arret) {
        return res.status(400).json({
          message: `Entrée incluse dans l'arrêt de caisse du ${jourFr(arret.date)} : suppression impossible.`
        });
      }
    }
    await pool.query(`DELETE FROM delevery_spent WHERE spent_id = ?`, [entree.id]);
    res.json({ id: entree.id });
  } catch (err) {
    next(err);
  }
}

/* ======================= État des caisses & arrêts ======================= */

/**
 * GET /api/caisse-agence/caisses (types 1/2) — état de chaque caisse
 * (agences actives + Sans agence) : dernier arrêt, mouvements datés après
 * cet arrêt (toutes lignes, validées ou non), lignes encore à valider et
 * solde courant = solde d'arrêt + recettes − dépenses depuis l'arrêt.
 * `date_max` : dernière date d'arrêt acceptée (hier).
 */
async function listCaisses(req, res, next) {
  try {
    if (!(await arretsOuIndisponible(res))) return;
    const caisses = [];
    for (const c of await listeCaisses()) {
      const dernier = await dernierArret(pool, c.id);
      const m = await mouvements(pool, c.id, { apres: dernier ? dernier.time_fin : null });
      const soldeArret = dernier ? dernier.solde : 0;
      caisses.push({
        agence_id: c.id,
        nom: c.nom,
        dernier_arret: dernier,
        recettes: m.recettes,
        depenses: m.depenses,
        nb_lignes: m.nb_lignes,
        nb_non_validees: m.nb_non_validees,
        solde_courant: soldeArret + m.recettes - m.depenses
      });
    }
    res.json({ caisses, date_max: dayStr(-1) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/caisse-agence/arrets (types 1/2) — historique des arrêts, du plus
 * récent au plus ancien. Query : agence (none | <id>, facultatif).
 * `dernier` : 1 si c'est le dernier arrêt de sa caisse (seul supprimable).
 */
async function listArrets(req, res, next) {
  try {
    if (!(await arretsOuIndisponible(res))) return;
    const where = ['1 = 1'];
    const params = [];
    const agence = String(req.query.agence || '').trim();
    if (agence === 'none') where.push('a.arret_agence_id = 0');
    else if (/^\d+$/.test(agence)) {
      where.push('a.arret_agence_id = ?');
      params.push(Number(agence));
    }
    const [rows] = await pool.query(
      `SELECT a.arret_id                            AS id,
              a.arret_agence_id                     AS agence_id,
              COALESCE(ag.agence_name, ?)           AS agence,
              DATE_FORMAT(a.arret_date, '%Y-%m-%d') AS date,
              a.arret_solde_precedent               AS solde_precedent,
              a.arret_recettes                      AS recettes,
              a.arret_depenses                      AS depenses,
              a.arret_solde                         AS solde,
              a.arret_nb_lignes                     AS nb_lignes,
              u.users_name                          AS by_name,
              UNIX_TIMESTAMP(a.arret_created_at)    AS created_time,
              (a.arret_time_fin = (SELECT MAX(b.arret_time_fin) FROM delevery_caisse_arret b
                                    WHERE b.arret_agence_id = a.arret_agence_id)) AS dernier
         FROM delevery_caisse_arret a
         LEFT JOIN delevery_agences ag ON ag.agence_id = a.arret_agence_id
         LEFT JOIN delevery_users u ON u.users_id = a.arret_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.arret_time_fin DESC, a.arret_id DESC
        LIMIT ${MAX_ARRETS}`,
      [NOM_SANS_AGENCE, ...params]
    );
    res.json({
      rows: rows.map((r) => ({
        ...r,
        agence_id: Number(r.agence_id),
        solde_precedent: Number(r.solde_precedent) || 0,
        recettes: Number(r.recettes) || 0,
        depenses: Number(r.depenses) || 0,
        solde: Number(r.solde) || 0,
        nb_lignes: Number(r.nb_lignes) || 0,
        created_time: Number(r.created_time) || null,
        dernier: Number(r.dernier) ? 1 : 0
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/caisse-agence/arrets (types 1/2) — body { agence, date } :
 * agence = 'all' (toutes les caisses, Sans agence comprise), 'none' (Sans
 * agence) ou <agence_id> ; date "AAAA-MM-JJ" ≤ hier et > dernier arrêt de
 * chaque caisse visée. Tout ou rien : si une caisse a encore une ligne à
 * valider (ou un arrêt à une date ≥ celle demandée), aucun arrêt n'est
 * enregistré et le message détaille chaque caisse refusée.
 */
async function createArret(req, res, next) {
  let conn = null;
  try {
    if (!(await arretsOuIndisponible(res))) return;

    const dateStr = String(req.body?.date || '').trim();
    const date = dayToUnix(dateStr);
    if (date === null) return res.status(400).json({ message: "Veuillez choisir la date d'arrêt." });
    const timeFin = date + 86399;
    const hierFin = dayToUnix(dayStr(0)) - 1;
    if (timeFin > hierFin) {
      return res.status(400).json({
        message: "La date d'arrêt doit être au plus tard hier : la journée arrêtée doit être terminée."
      });
    }

    const toutes = await listeCaisses();
    const choix = String(req.body?.agence ?? '').trim();
    let cibles;
    if (choix === 'all') cibles = toutes;
    else if (choix === 'none') cibles = toutes.filter((c) => c.id === SANS_AGENCE);
    else if (/^\d+$/.test(choix)) cibles = toutes.filter((c) => c.id === Number(choix));
    else cibles = [];
    if (!cibles.length) return res.status(400).json({ message: 'Veuillez choisir la caisse à arrêter.' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const erreurs = [];
    const prepares = [];
    for (const caisse of cibles) {
      const dernier = await dernierArret(conn, caisse.id);
      if (dernier && dernier.time_fin >= timeFin) {
        erreurs.push(
          `${caisse.nom} : un arrêt existe déjà au ${jourFr(dernier.date)}, choisissez une date postérieure.`
        );
        continue;
      }
      const m = await mouvements(conn, caisse.id, {
        apres: dernier ? dernier.time_fin : null,
        jusqua: timeFin
      });
      if (m.nb_non_validees > 0) {
        erreurs.push(
          `${caisse.nom} : ${m.nb_non_validees} ligne(s) encore à valider jusqu'au ${jourFr(dateStr)}.`
        );
        continue;
      }
      const precedent = dernier ? dernier.solde : 0;
      prepares.push({
        agence_id: caisse.id,
        agence: caisse.nom,
        date: dateStr,
        solde_precedent: precedent,
        recettes: m.recettes_validees,
        depenses: m.depenses_validees,
        nb_lignes: m.nb_validees,
        solde: precedent + m.recettes_validees - m.depenses_validees
      });
    }

    if (erreurs.length) {
      await conn.rollback();
      return res.status(400).json({ message: `Arrêt refusé — ${erreurs.join(' ')}`, erreurs });
    }

    for (const a of prepares) {
      const [result] = await conn.query(
        `INSERT INTO delevery_caisse_arret
           (arret_agence_id, arret_date, arret_time_fin, arret_solde_precedent,
            arret_recettes, arret_depenses, arret_solde, arret_nb_lignes, arret_by, arret_created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          a.agence_id,
          a.date,
          timeFin,
          a.solde_precedent,
          a.recettes,
          a.depenses,
          a.solde,
          a.nb_lignes,
          Number(req.user.id) || 0
        ]
      );
      a.id = result.insertId;
    }
    await conn.commit();
    res.status(201).json({ arrets: prepares });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Un arrêt existe déjà à cette date pour cette caisse.' });
    }
    next(err);
  } finally {
    if (conn) conn.release();
  }
}

/**
 * DELETE /api/caisse-agence/arrets/:id (type 1) — supprime un arrêt, à
 * condition qu'il soit le dernier de sa caisse (l'arrêt précédent redevient
 * la référence du solde courant).
 */
async function deleteArret(req, res, next) {
  try {
    if (!(await arretsOuIndisponible(res))) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ message: 'Arrêt introuvable.' });
    const [[arret]] = await pool.query(
      `SELECT arret_id AS id, arret_agence_id AS agence_id, arret_time_fin AS time_fin
         FROM delevery_caisse_arret WHERE arret_id = ? LIMIT 1`,
      [id]
    );
    if (!arret) return res.status(404).json({ message: 'Arrêt introuvable.' });
    const dernier = await dernierArret(pool, arret.agence_id);
    if (!dernier || dernier.id !== arret.id) {
      return res.status(400).json({
        message: "Seul le dernier arrêt d'une caisse peut être supprimé (supprimez d'abord les arrêts plus récents)."
      });
    }
    await pool.query(`DELETE FROM delevery_caisse_arret WHERE arret_id = ?`, [arret.id]);
    res.json({ id: arret.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listFiltres,
  listEntrees,
  createEntree,
  validateEntree,
  validateEntrees,
  deleteEntree,
  listCaisses,
  listArrets,
  createArret,
  deleteArret
};
