const pool = require('../config/db');
const {
  estMigrationManquante,
  bornesJournee,
  journeeToString
} = require('../utils/transportBons');

/*
 * Module Transport — bons de transport (pages /admin/transport/bons et
 * /admin/transport/bons/:id, service TRANSPORT, tous types ; suppression
 * d'un bon vide réservée aux types 1/2 dans les routes). Tables
 * delevery_transport_bons / _trajets / _trajet_zones + colonne bon_id des
 * envois et retours (sql/2026-09-18_transport-bons.sql).
 *
 * Un bon = un trajet × une journée (06:00 → 06:00, voir utils/transportBons),
 * créé automatiquement au premier scan (aucune création manuelle). Il
 * regroupe des envois ET des retours : un colis est identifié par le couple
 * (type envoi | retour, id). Page d'édition : ajout de colis non affectés
 * (bon_id = 0) dont la ville de destination est couverte par le trajet du
 * bon ou par aucun trajet, scannés pendant la journée du bon ou les 7 jours
 * précédents ; retrait d'un colis du bon (il redevient non affecté). Les bons
 * des journées passées restent modifiables.
 */

/* Les deux tables de colis, avec la société « expéditeur » de chacune :
 * envoi = société expéditrice (préfixe du ticket), retour = société de
 * ramassage (préfixe aussi : celle chez qui le colis est ramassé). */
const TYPES = {
  envoi: { table: 'delevery_transport_envois', idCol: 'envoi_id', expCol: 'societe_exp_id', label: 'Envoi' },
  retour: { table: 'delevery_transport_retours', idCol: 'retour_id', expCol: 'societe_ram_id', label: 'Retour' }
};

/* Fenêtre des colis non affectés proposés à l'ajout : journée du bon + N jours avant. */
const FENETRE_JOURS = 7;

/* Nombre maximal de colis par ajout groupé. */
const MAX_AJOUT = 200;

/** Migration absente → 503 explicite, sinon erreur standard. */
function gererErreur(err, res, next) {
  if (estMigrationManquante(err)) {
    return res.status(503).json({
      message: 'Bons de transport indisponibles : exécuter sql/2026-09-18_transport-bons.sql.'
    });
  }
  return next(err);
}

/** "AAAA-MM-JJ" valide → la chaîne, sinon null. */
function parseJournee(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && bornesJournee(s) ? s : null;
}

/** "AAAA-MM-JJ" → "JJ/MM/AAAA" (messages). */
function formatJournee(journee) {
  const [aaaa, mm, jj] = String(journee).split('-');
  return `${jj}/${mm}/${aaaa}`;
}

/**
 * SELECT commun des colis d'un type (envoi | retour) : identité, société
 * expéditeur, ville de destination, trajet couvrant cette ville (tz).
 */
function colisSelect(type) {
  const t = TYPES[type];
  return `SELECT '${type}'       AS type,
                 c.${t.idCol}    AS id,
                 c.code          AS code,
                 c.tarif         AS tarif,
                 c.facture_id    AS facture_id,
                 c.bon_id        AS bon_id,
                 c.created_time  AS created_time,
                 s.nom_societe   AS societe_exp,
                 v.reference_ville AS ville_ref,
                 v.nom_ville     AS ville,
                 tz.trajet_id    AS trajet_ville,
                 u.users_name    AS scanne_par
            FROM ${t.table} c
            LEFT JOIN delevery_transport_societes s ON s.societe_id = c.${t.expCol}
            LEFT JOIN delevery_tarifs v ON v.ville_id = c.ville_dest_id
            LEFT JOIN delevery_transport_trajet_zones tz ON tz.zone_id = v.zone
            LEFT JOIN delevery_users u ON u.users_id = c.user_id`;
}

/** Ligne SQL → objet colis renvoyé au front (clé unique type-id). */
function mapColis(r) {
  return {
    key: `${r.type}-${r.id}`,
    type: r.type,
    type_label: TYPES[r.type].label,
    id: Number(r.id),
    code: r.code,
    tarif: Number(r.tarif),
    facture_id: Number(r.facture_id),
    bon_id: Number(r.bon_id),
    created_time: Number(r.created_time),
    societe_exp: r.societe_exp || '',
    ville_ref: r.ville_ref || '',
    ville: r.ville || '',
    trajet_ville: r.trajet_ville ? Number(r.trajet_ville) : null,
    scanne_par: r.scanne_par || ''
  };
}

/** Charge un bon (avec son trajet) ; null si introuvable. */
async function loadBon(id) {
  const bonId = parseInt(id, 10);
  if (!Number.isInteger(bonId) || bonId <= 0) return null;
  const [[bon]] = await pool.query(
    `SELECT b.bon_id AS id, b.bon_ref AS ref, b.trajet_id, t.trajet_nom AS trajet,
            b.bon_journee AS journee, b.created_time, u.users_name AS cree_par
       FROM delevery_transport_bons b
       LEFT JOIN delevery_transport_trajets t ON t.trajet_id = b.trajet_id
       LEFT JOIN delevery_users u ON u.users_id = b.user_id
      WHERE b.bon_id = ? LIMIT 1`,
    [bonId]
  );
  if (!bon) return null;
  const journee = journeeToString(bon.journee);
  const bornes = bornesJournee(journee) || { debut: 0, fin: 0 };
  return {
    id: Number(bon.id),
    ref: bon.ref,
    trajet_id: Number(bon.trajet_id),
    trajet: bon.trajet || '',
    journee,
    journee_debut: bornes.debut,
    journee_fin: bornes.fin,
    created_time: Number(bon.created_time),
    cree_par: bon.cree_par || ''
  };
}

/** Un colis par (type, id) ; null si type inconnu ou colis introuvable. */
async function loadColis(type, id) {
  if (!TYPES[type]) return null;
  const colisId = parseInt(id, 10);
  if (!Number.isInteger(colisId) || colisId <= 0) return null;
  const [[row]] = await pool.query(`${colisSelect(type)} WHERE c.${TYPES[type].idCol} = ? LIMIT 1`, [colisId]);
  return row ? mapColis(row) : null;
}

/** Un colis par code, cherché dans les deux tables ; null si inconnu. */
async function loadColisParCode(code) {
  for (const type of Object.keys(TYPES)) {
    const [[row]] = await pool.query(`${colisSelect(type)} WHERE c.code = ? LIMIT 1`, [code]);
    if (row) return mapColis(row);
  }
  return null;
}

/** Référence + journée d'un autre bon (messages « déjà dans le bon … »). */
async function decrireBon(bonId) {
  const [[b]] = await pool.query(
    `SELECT bon_ref AS ref, bon_journee AS journee FROM delevery_transport_bons WHERE bon_id = ? LIMIT 1`,
    [bonId]
  );
  return b ? `${b.ref} (journée du ${formatJournee(journeeToString(b.journee))})` : `#${bonId}`;
}

/**
 * Motif d'inéligibilité d'un colis à l'ajout dans un bon, ou null s'il est
 * ajoutable : déjà affecté, ou ville couverte par un autre trajet (une ville
 * sans trajet est ajoutable à n'importe quel bon).
 */
async function motifRefus(colis, bon) {
  if (colis.bon_id === bon.id) return 'déjà dans ce bon';
  if (colis.bon_id > 0) return `déjà dans le bon ${await decrireBon(colis.bon_id)}`;
  if (colis.trajet_ville && colis.trajet_ville !== bon.trajet_id) {
    const [[t]] = await pool.query(`SELECT trajet_nom FROM delevery_transport_trajets WHERE trajet_id = ?`, [
      colis.trajet_ville
    ]);
    return `ville ${colis.ville || colis.ville_ref} couverte par le trajet ${t ? t.trajet_nom : colis.trajet_ville}`;
  }
  return null;
}

/** Affecte un colis au bon (atomique : seulement s'il est encore non affecté). */
async function affecter(colis, bonId) {
  const t = TYPES[colis.type];
  const [result] = await pool.query(`UPDATE ${t.table} SET bon_id = ? WHERE ${t.idCol} = ? AND bon_id = 0`, [
    bonId,
    colis.id
  ]);
  return result.affectedRows > 0;
}

/** Retire un colis du bon (seulement s'il y est encore). */
async function desaffecter(colis, bonId) {
  const t = TYPES[colis.type];
  const [result] = await pool.query(`UPDATE ${t.table} SET bon_id = 0 WHERE ${t.idCol} = ? AND bon_id = ?`, [
    colis.id,
    bonId
  ]);
  return result.affectedRows > 0;
}

/** GET /api/transport/bons/trajets — trajets (id, nom) pour le filtre de la liste. */
async function listTrajetsBons(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT trajet_id AS id, trajet_nom AS nom FROM delevery_transport_trajets ORDER BY trajet_nom`
    );
    res.json(rows);
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * GET /api/transport/bons — liste des bons (journée la plus récente en tête).
 * Query : trajet (id), debut / fin (AAAA-MM-JJ sur la journée du bon, vides =
 * toutes). Une ligne par bon avec son nombre de colis (envois + retours).
 */
async function listBons(req, res, next) {
  try {
    const where = ['1 = 1'];
    const params = [];
    const trajet = parseInt(req.query.trajet, 10) || 0;
    if (trajet) {
      where.push('b.trajet_id = ?');
      params.push(trajet);
    }
    const debut = parseJournee(req.query.debut);
    if (debut) {
      where.push('b.bon_journee >= ?');
      params.push(debut);
    }
    const fin = parseJournee(req.query.fin);
    if (fin) {
      where.push('b.bon_journee <= ?');
      params.push(fin);
    }
    const [rows] = await pool.query(
      `SELECT b.bon_id AS id, b.bon_ref AS ref, b.trajet_id, t.trajet_nom AS trajet,
              b.bon_journee AS journee, b.created_time, u.users_name AS cree_par,
              (SELECT COUNT(*) FROM delevery_transport_envois e WHERE e.bon_id = b.bon_id)
            + (SELECT COUNT(*) FROM delevery_transport_retours r WHERE r.bon_id = b.bon_id) AS nb_colis
         FROM delevery_transport_bons b
         LEFT JOIN delevery_transport_trajets t ON t.trajet_id = b.trajet_id
         LEFT JOIN delevery_users u ON u.users_id = b.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.bon_journee DESC, t.trajet_nom, b.bon_id DESC`,
      params
    );
    res.json(
      rows.map((r) => {
        const journee = journeeToString(r.journee);
        const bornes = bornesJournee(journee) || { debut: 0, fin: 0 };
        return {
          id: Number(r.id),
          ref: r.ref,
          trajet_id: Number(r.trajet_id),
          trajet: r.trajet || '',
          journee,
          journee_debut: bornes.debut,
          journee_fin: bornes.fin,
          created_time: Number(r.created_time),
          cree_par: r.cree_par || '',
          nb_colis: Number(r.nb_colis)
        };
      })
    );
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * GET /api/transport/bons/:id — informations du bon + ses colis (envois et
 * retours, du plus récent au plus ancien). Le regroupement du détail
 * (société expéditeur → ville de destination) est fait côté front.
 */
async function getBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [rows] = await pool.query(
      `${colisSelect('envoi')} WHERE c.bon_id = ?
       UNION ALL
       ${colisSelect('retour')} WHERE c.bon_id = ?
       ORDER BY created_time DESC, id DESC`,
      [bon.id, bon.id]
    );
    const colis = rows.map(mapColis);
    res.json({ ...bon, nb_colis: colis.length, colis });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * GET /api/transport/bons/:id/disponibles — colis non affectés ajoutables au
 * bon : ville de destination couverte par le trajet du bon ou par aucun
 * trajet, scannés entre (début de la journée − 7 jours) et la fin de la
 * journée du bon.
 */
async function listDisponibles(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const debut = bon.journee_debut - FENETRE_JOURS * 86400;
    const fin = bon.journee_fin;
    const cond = `WHERE c.bon_id = 0 AND (tz.trajet_id = ? OR tz.trajet_id IS NULL)
                    AND c.created_time >= ? AND c.created_time < ?`;
    const params = [bon.trajet_id, debut, fin];
    const [rows] = await pool.query(
      `${colisSelect('envoi')} ${cond}
       UNION ALL
       ${colisSelect('retour')} ${cond}
       ORDER BY created_time DESC, id DESC`,
      [...params, ...params]
    );
    res.json(rows.map(mapColis));
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * POST /api/transport/bons/:id/colis — body { items: [{ type, id }] }.
 * Ajoute des colis non affectés au bon (bouton « Ajouter » ou sélection).
 * → { added: [colis], skipped: [{ code, reason }] }.
 */
async function addColis(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_AJOUT) : [];
    if (!items.length) return res.status(400).json({ message: 'Aucun colis sélectionné.' });

    const added = [];
    const skipped = [];
    for (const item of items) {
      const colis = await loadColis(String(item?.type || ''), item?.id);
      if (!colis) {
        skipped.push({ code: `${item?.type || '?'}#${item?.id || '?'}`, reason: 'introuvable' });
        continue;
      }
      const motif = await motifRefus(colis, bon);
      if (motif) {
        skipped.push({ code: colis.code, reason: motif });
        continue;
      }
      if (await affecter(colis, bon.id)) added.push({ ...colis, bon_id: bon.id });
      else skipped.push({ code: colis.code, reason: 'affecté entre-temps à un autre bon' });
    }
    res.json({ added, skipped });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * POST /api/transport/bons/:id/scan — body { code }. Ajoute au bon un colis
 * déjà enregistré (Envoi / Retour) et non affecté. → { colis, message }.
 */
async function scanAjout(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Code vide.' });
    const colis = await loadColisParCode(code);
    if (!colis) {
      return res.status(400).json({
        message: `Code ${code} inconnu : enregistrez-le d'abord sur Transport › Envoi ou Retour.`
      });
    }
    const motif = await motifRefus(colis, bon);
    if (motif) return res.status(400).json({ message: `Colis ${code} : ${motif}.` });
    if (!(await affecter(colis, bon.id))) {
      return res.status(400).json({ message: `Colis ${code} affecté entre-temps à un autre bon.` });
    }
    res.json({
      colis: { ...colis, bon_id: bon.id },
      message: `${TYPES[colis.type].label} ${code} ajouté au bon — ${colis.societe_exp || '?'} → ${colis.ville || colis.ville_ref || '?'}.`
    });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * POST /api/transport/bons/:id/scan-retrait — body { code }. Retire du bon le
 * colis scanné (il redevient non affecté). → { colis, message }.
 */
async function scanRetrait(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Code vide.' });
    const colis = await loadColisParCode(code);
    if (!colis) return res.status(400).json({ message: `Code ${code} inconnu.` });
    if (colis.bon_id !== bon.id) {
      return res.status(400).json({
        message:
          colis.bon_id > 0
            ? `Colis ${code} : dans le bon ${await decrireBon(colis.bon_id)}, pas dans celui-ci.`
            : `Colis ${code} : n'est dans aucun bon.`
      });
    }
    if (!(await desaffecter(colis, bon.id))) {
      return res.status(400).json({ message: `Colis ${code} déjà retiré du bon.` });
    }
    res.json({ colis: { ...colis, bon_id: 0 }, message: `${TYPES[colis.type].label} ${code} retiré du bon.` });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * DELETE /api/transport/bons/:id/colis/:type/:colisId — retire un colis du
 * bon (bouton « Retirer » ou sélection). → { type, id }.
 */
async function removeColis(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const colis = await loadColis(String(req.params.type || ''), req.params.colisId);
    if (!colis) return res.status(404).json({ message: 'Colis introuvable.' });
    if (colis.bon_id !== bon.id) return res.status(400).json({ message: "Ce colis n'est pas dans ce bon." });
    await desaffecter(colis, bon.id);
    res.json({ type: colis.type, id: colis.id });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

/**
 * DELETE /api/transport/bons/:id — supprime un bon VIDE (types 1/2 dans les
 * routes). Un nouveau scan recréera le bon du jour si nécessaire.
 */
async function deleteBon(req, res, next) {
  try {
    const bon = await loadBon(req.params.id);
    if (!bon) return res.status(404).json({ message: 'Bon introuvable.' });
    const [[{ nb }]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM delevery_transport_envois WHERE bon_id = ?)
            + (SELECT COUNT(*) FROM delevery_transport_retours WHERE bon_id = ?) AS nb`,
      [bon.id, bon.id]
    );
    if (Number(nb) > 0) {
      return res.status(400).json({ message: 'Suppression possible uniquement si le bon est vide.' });
    }
    await pool.query(`DELETE FROM delevery_transport_bons WHERE bon_id = ?`, [bon.id]);
    res.json({ id: bon.id });
  } catch (err) {
    gererErreur(err, res, next);
  }
}

module.exports = {
  listTrajetsBons,
  listBons,
  getBon,
  listDisponibles,
  addColis,
  scanAjout,
  scanRetrait,
  removeColis,
  deleteBon
};
