const pool = require('../config/db');

/*
 * Module Transport — facturation (pages /admin/transport/facturation et
 * /admin/transport/facturation/:id, service TRANSPORT, types 1/2 dans les
 * routes). Table legacy delevery_transport_factures + colonnes de l'application
 * facture_total / facture_nb_colis / facture_paid_time
 * (sql/2026-08-24_transport-tickets.sql).
 *
 * Une facture regroupe les colis (envois + retours) d'une société : les
 * colis passent de facture_id = 0 à facture_id = F (réversible tant que la
 * facture n'est pas payée). Statut : 0 = non payée, 1 = payée. Au passage
 * « payée », total / nb de colis / date sont FIGÉS sur la facture (le legacy
 * recalculait tout à la volée) ; les anciennes factures payées côté legacy
 * n'ont pas ces valeurs (facture_paid_time = 0) → totaux calculés en direct.
 *
 * Références : nouvelles factures FCT-JJMMAA-0{id}0-{2 chiffres} (pattern
 * application, séquentiel) ; les références legacy FCT + 7 caractères aléatoires
 * restent affichées telles quelles.
 */

const MAX_ROWS = 1000;

/* Taille de page maximale de la liste paginée des factures. */
const MAX_PAGE_SIZE = 100;

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Bornes { debut, fin } (unix, fin exclusive) depuis la query, ou null. */
function periodeFromBody(source) {
  const debut = dayToUnix(source?.debut);
  const fin = dayToUnix(source?.fin);
  return {
    debut: debut !== null ? debut : null,
    fin: fin !== null ? fin + 86400 : null
  };
}

/** Charge une facture ; null si introuvable. */
async function loadFacture(id) {
  const factureId = parseInt(id, 10);
  if (!Number.isInteger(factureId) || factureId <= 0) return null;
  const [[facture]] = await pool.query(
    `SELECT f.facture_id AS id, f.reference, f.societe_id, f.statut,
            f.facture_total, f.facture_nb_colis, f.facture_paid_time,
            f.user_id, f.created_time
       FROM delevery_transport_factures f
      WHERE f.facture_id = ? LIMIT 1`,
    [factureId]
  );
  return facture || null;
}

/** Totaux en direct d'une facture : { nb, total } (envois + retours). */
async function totauxLive(conn, factureId) {
  const [[t]] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM delevery_transport_envois WHERE facture_id = ?)
     + (SELECT COUNT(*) FROM delevery_transport_retours WHERE facture_id = ?) AS nb,
       (SELECT IFNULL(SUM(tarif), 0) FROM delevery_transport_envois WHERE facture_id = ?)
     + (SELECT IFNULL(SUM(tarif), 0) FROM delevery_transport_retours WHERE facture_id = ?) AS total`,
    [factureId, factureId, factureId, factureId]
  );
  return { nb: Number(t.nb), total: Number(t.total) };
}

/**
 * UNION envois + retours d'une société pour une facture donnée (mode
 * facture : facture_id = F ; mode dispo : facture_id = 0, avec période
 * facultative). Mêmes colonnes que le legacy : la « ville d'expédition »
 * d'un retour est sa ville de ramassage.
 */
async function listColisUnion(societeId, factureId, periode) {
  const where = [];
  const params = [];
  if (periode?.debut !== null && periode?.debut !== undefined) {
    where.push('c.created_time >= ?');
    params.push(periode.debut);
  }
  if (periode?.fin !== null && periode?.fin !== undefined) {
    where.push('c.created_time < ?');
    params.push(periode.fin);
  }
  const extra = where.length ? ` AND ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT c.colis_id, c.type_colis, c.code, c.tarif, c.tarif_type, c.created_time,
            v1.reference_ville AS ville_exp_ref, v1.nom_ville AS ville_exp,
            v2.reference_ville AS ville_dest_ref, v2.nom_ville AS ville_dest
       FROM (
         SELECT e.envoi_id AS colis_id, 'envoi' AS type_colis, e.code, e.tarif,
                e.tarif_type, e.created_time,
                e.ville_envoi_id AS ville_exp_id, e.ville_dest_id
           FROM delevery_transport_envois e
          WHERE e.societe_exp_id = ? AND e.facture_id = ?
         UNION ALL
         SELECT r.retour_id, 'retour', r.code, r.tarif, r.tarif_type, r.created_time,
                r.ville_ram_id, r.ville_dest_id
           FROM delevery_transport_retours r
          WHERE r.societe_id = ? AND r.facture_id = ?
       ) c
       LEFT JOIN delevery_tarifs v1 ON v1.ville_id = c.ville_exp_id
       LEFT JOIN delevery_tarifs v2 ON v2.ville_id = c.ville_dest_id
      WHERE 1 = 1${extra}
      ORDER BY c.created_time DESC
      LIMIT ${MAX_ROWS}`,
    [societeId, factureId, societeId, factureId, ...params]
  );
  return rows.map((r) => ({ ...r, tarif: Number(r.tarif) }));
}

/**
 * GET /api/transport/factures/societes — sociétés actives avec leur encours
 * non facturé (nb de colis + montant) pour la modale de création.
 */
async function listSocietesFacturables(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
              (SELECT COUNT(*) FROM delevery_transport_envois e
                WHERE e.societe_exp_id = s.societe_id AND e.facture_id = 0)
            + (SELECT COUNT(*) FROM delevery_transport_retours r
                WHERE r.societe_id = s.societe_id AND r.facture_id = 0) AS nb_colis,
              (SELECT IFNULL(SUM(e.tarif), 0) FROM delevery_transport_envois e
                WHERE e.societe_exp_id = s.societe_id AND e.facture_id = 0)
            + (SELECT IFNULL(SUM(r.tarif), 0) FROM delevery_transport_retours r
                WHERE r.societe_id = s.societe_id AND r.facture_id = 0) AS montant
         FROM delevery_transport_societes s
        WHERE s.statut = 1
        ORDER BY s.nom_societe`
    );
    res.json(rows.map((r) => ({ ...r, nb_colis: Number(r.nb_colis), montant: Number(r.montant) })));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transport/factures — liste paginée pour la datatable, de la plus
 * récente à la plus ancienne. Query : page, pageSize (5-100), societe,
 * statut (impayee | payee, '' = toutes), debut / fin (date de création).
 * Totaux : figés si payée via l'application (facture_paid_time > 0), sinon en
 * direct. Renvoie { rows, total, page, pageSize, totalPages }.
 */
async function listFactures(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);

    const where = ['1 = 1'];
    const params = [];
    const societe = parseInt(req.query.societe, 10) || 0;
    if (societe) {
      where.push('f.societe_id = ?');
      params.push(societe);
    }
    const statut = String(req.query.statut || '').trim();
    if (statut === 'impayee') where.push('f.statut = 0');
    else if (statut === 'payee') where.push('f.statut = 1');
    const debut = dayToUnix(req.query.debut);
    if (debut !== null) {
      where.push('f.created_time >= ?');
      params.push(debut);
    }
    const fin = dayToUnix(req.query.fin);
    if (fin !== null) {
      where.push('f.created_time < ?');
      params.push(fin + 86400);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM delevery_transport_factures f ${whereSql}`,
      params
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    // Totaux en direct calculés pour les seules factures de la page.
    const [rows] = await pool.query(
      `SELECT f.facture_id AS id, f.reference, f.societe_id, f.statut,
              f.facture_total, f.facture_nb_colis, f.facture_paid_time,
              f.created_time, s.nom_societe AS societe, u.users_name AS created_by,
              (SELECT COUNT(*) FROM delevery_transport_envois e WHERE e.facture_id = f.facture_id)
            + (SELECT COUNT(*) FROM delevery_transport_retours r WHERE r.facture_id = f.facture_id)
                AS nb_live,
              (SELECT IFNULL(SUM(e.tarif), 0) FROM delevery_transport_envois e WHERE e.facture_id = f.facture_id)
            + (SELECT IFNULL(SUM(r.tarif), 0) FROM delevery_transport_retours r WHERE r.facture_id = f.facture_id)
                AS total_live
         FROM delevery_transport_factures f
         LEFT JOIN delevery_transport_societes s ON s.societe_id = f.societe_id
         LEFT JOIN delevery_users u ON u.users_id = f.user_id
         ${whereSql}
        ORDER BY f.created_time DESC, f.facture_id DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({
      rows: rows.map((r) => {
        const fige = Number(r.statut) === 1 && Number(r.facture_paid_time) > 0;
        return {
          id: r.id,
          reference: r.reference,
          societe_id: r.societe_id,
          societe: r.societe,
          statut: Number(r.statut),
          nb_colis: fige ? Number(r.facture_nb_colis) : Number(r.nb_live),
          total: fige ? Number(r.facture_total) : Number(r.total_live),
          paid_time: Number(r.facture_paid_time),
          created_time: r.created_time,
          created_by: r.created_by
        };
      }),
      total: Number(total),
      page,
      pageSize,
      totalPages
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transport/factures — body { societe, auto, debut, fin }. Crée
 * une facture non payée pour la société (référence FCT-JJMMAA-0{id}0-XX) ;
 * si auto est vrai, y rattache d'un coup tous ses colis non facturés
 * (période facultative). Correction du legacy : POST (plus de factures
 * vides créées par un simple GET). Renvoie { id, ref, nb_colis }.
 */
async function createFacture(req, res, next) {
  try {
    const societeId = parseInt(req.body?.societe, 10);
    if (!Number.isInteger(societeId) || societeId <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner une société.' });
    }
    const [[societe]] = await pool.query(
      `SELECT societe_id FROM delevery_transport_societes
        WHERE societe_id = ? AND statut = 1 LIMIT 1`,
      [societeId]
    );
    if (!societe) return res.status(400).json({ message: 'Société introuvable ou désactivée.' });

    const auto = Boolean(req.body?.auto);
    const periode = periodeFromBody(req.body);
    const now = Math.floor(Date.now() / 1000);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO delevery_transport_factures
           (reference, societe_id, statut, user_id, created_time)
         VALUES ('', ?, 0, ?, ?)`,
        [societeId, Number(req.user.id), now]
      );
      const factureId = result.insertId;

      const d = new Date(now * 1000);
      const jj = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const aa = String(d.getFullYear() % 100).padStart(2, '0');
      const ref = `FCT-${jj}${mm}${aa}-0${factureId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
      await conn.query(
        `UPDATE delevery_transport_factures SET reference = ? WHERE facture_id = ?`,
        [ref, factureId]
      );

      let nbColis = 0;
      if (auto) {
        const extra = [];
        const extraParams = [];
        if (periode.debut !== null) {
          extra.push('AND created_time >= ?');
          extraParams.push(periode.debut);
        }
        if (periode.fin !== null) {
          extra.push('AND created_time < ?');
          extraParams.push(periode.fin);
        }
        const [envois] = await conn.query(
          `UPDATE delevery_transport_envois SET facture_id = ?
            WHERE societe_exp_id = ? AND facture_id = 0 ${extra.join(' ')}`,
          [factureId, societeId, ...extraParams]
        );
        const [retours] = await conn.query(
          `UPDATE delevery_transport_retours SET facture_id = ?
            WHERE societe_id = ? AND facture_id = 0 ${extra.join(' ')}`,
          [factureId, societeId, ...extraParams]
        );
        nbColis = Number(envois.affectedRows) + Number(retours.affectedRows);
      }
      await conn.commit();
      res.status(201).json({ id: factureId, ref, nb_colis: nbColis });
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
 * GET /api/transport/factures/:id — détail : facture + société (ICE,
 * adresse… pour le PDF), colis de la facture et colis disponibles (non
 * facturés de la société, période facultative en query debut / fin).
 */
async function getFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });

    const [[societe]] = await pool.query(
      `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
              s.telephone, s.ice, s.adresse,
              v.reference_ville AS ville_ref, v.nom_ville AS ville
         FROM delevery_transport_societes s
         LEFT JOIN delevery_tarifs v ON v.ville_id = s.ville_id
        WHERE s.societe_id = ? LIMIT 1`,
      [facture.societe_id]
    );
    const periode = periodeFromBody(req.query);
    const colis = await listColisUnion(facture.societe_id, facture.id, null);
    const disponibles =
      Number(facture.statut) === 1 ? [] : await listColisUnion(facture.societe_id, 0, periode);

    const fige = Number(facture.statut) === 1 && Number(facture.facture_paid_time) > 0;
    const live = colis.reduce(
      (acc, c) => ({ nb: acc.nb + 1, total: acc.total + c.tarif }),
      { nb: 0, total: 0 }
    );
    res.json({
      facture: {
        id: facture.id,
        reference: facture.reference,
        statut: Number(facture.statut),
        nb_colis: fige ? Number(facture.facture_nb_colis) : live.nb,
        total: fige ? Number(facture.facture_total) : live.total,
        paid_time: Number(facture.facture_paid_time),
        created_time: facture.created_time
      },
      societe: societe || null,
      colis,
      disponibles
    });
  } catch (err) {
    next(err);
  }
}

/** Facture modifiable (existe + non payée), sinon répond et renvoie null. */
async function factureOuverte(req, res) {
  const facture = await loadFacture(req.params.id);
  if (!facture) {
    res.status(404).json({ message: 'Facture introuvable.' });
    return null;
  }
  if (Number(facture.statut) === 1) {
    res.status(400).json({ message: 'Facture payée : modification impossible.' });
    return null;
  }
  return facture;
}

/** Items [{ type: 'envoi'|'retour', id }] → { envois: [], retours: [] } ou null. */
function parseItems(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const envois = [];
  const retours = [];
  for (const item of items) {
    const id = parseInt(item?.id, 10);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (item?.type === 'envoi') envois.push(id);
    else if (item?.type === 'retour') retours.push(id);
    else return null;
  }
  if (!envois.length && !retours.length) return null;
  if (envois.length + retours.length > MAX_ROWS) return null;
  return { envois, retours };
}

/**
 * POST /api/transport/factures/:id/colis — body { items: [{ type, id }] }.
 * Rattache en masse des colis non facturés de la société à la facture (non
 * payée). Renvoie { nb_colis } réellement rattachés.
 */
async function addColis(req, res, next) {
  try {
    const facture = await factureOuverte(req, res);
    if (!facture) return;
    const items = parseItems(req.body);
    if (!items) return res.status(400).json({ message: 'Aucun colis sélectionné.' });

    let nb = 0;
    if (items.envois.length) {
      const [r] = await pool.query(
        `UPDATE delevery_transport_envois SET facture_id = ?
          WHERE envoi_id IN (?) AND societe_exp_id = ? AND facture_id = 0`,
        [facture.id, items.envois, facture.societe_id]
      );
      nb += Number(r.affectedRows);
    }
    if (items.retours.length) {
      const [r] = await pool.query(
        `UPDATE delevery_transport_retours SET facture_id = ?
          WHERE retour_id IN (?) AND societe_id = ? AND facture_id = 0`,
        [facture.id, items.retours, facture.societe_id]
      );
      nb += Number(r.affectedRows);
    }
    res.json({ nb_colis: nb });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transport/factures/:id/colis/tout — body { debut, fin }
 * facultatifs. Rattache d'un coup tous les colis non facturés de la société
 * (période facultative). Renvoie { nb_colis }.
 */
async function addTousColis(req, res, next) {
  try {
    const facture = await factureOuverte(req, res);
    if (!facture) return;
    const periode = periodeFromBody(req.body);
    const extra = [];
    const params = [];
    if (periode.debut !== null) {
      extra.push('AND created_time >= ?');
      params.push(periode.debut);
    }
    if (periode.fin !== null) {
      extra.push('AND created_time < ?');
      params.push(periode.fin);
    }
    const [envois] = await pool.query(
      `UPDATE delevery_transport_envois SET facture_id = ?
        WHERE societe_exp_id = ? AND facture_id = 0 ${extra.join(' ')}`,
      [facture.id, facture.societe_id, ...params]
    );
    const [retours] = await pool.query(
      `UPDATE delevery_transport_retours SET facture_id = ?
        WHERE societe_id = ? AND facture_id = 0 ${extra.join(' ')}`,
      [facture.id, facture.societe_id, ...params]
    );
    res.json({ nb_colis: Number(envois.affectedRows) + Number(retours.affectedRows) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/transport/factures/:id/colis — body { items: [{ type, id }] }.
 * Retire en masse des colis de la facture (non payée). Renvoie { nb_colis }.
 */
async function removeColis(req, res, next) {
  try {
    const facture = await factureOuverte(req, res);
    if (!facture) return;
    const items = parseItems(req.body);
    if (!items) return res.status(400).json({ message: 'Aucun colis sélectionné.' });

    let nb = 0;
    if (items.envois.length) {
      const [r] = await pool.query(
        `UPDATE delevery_transport_envois SET facture_id = 0
          WHERE envoi_id IN (?) AND facture_id = ?`,
        [items.envois, facture.id]
      );
      nb += Number(r.affectedRows);
    }
    if (items.retours.length) {
      const [r] = await pool.query(
        `UPDATE delevery_transport_retours SET facture_id = 0
          WHERE retour_id IN (?) AND facture_id = ?`,
        [items.retours, facture.id]
      );
      nb += Number(r.affectedRows);
    }
    res.json({ nb_colis: nb });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/transport/factures/:id/statut — body { statut: 0 | 1 }.
 * Passage « payée » : total, nb de colis et date de paiement figés sur la
 * facture. Retour « non payée » : valeurs remises à zéro (totaux de nouveau
 * en direct).
 */
async function setStatut(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    const statut = Number(req.body?.statut);
    if (statut !== 0 && statut !== 1) {
      return res.status(400).json({ message: 'Statut invalide.' });
    }
    if (statut === Number(facture.statut)) return res.json({ id: facture.id, statut });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (statut === 1) {
        const { nb, total } = await totauxLive(conn, facture.id);
        await conn.query(
          `UPDATE delevery_transport_factures
              SET statut = 1, facture_total = ?, facture_nb_colis = ?, facture_paid_time = ?
            WHERE facture_id = ?`,
          [total, nb, Math.floor(Date.now() / 1000), facture.id]
        );
      } else {
        await conn.query(
          `UPDATE delevery_transport_factures
              SET statut = 0, facture_total = 0, facture_nb_colis = 0, facture_paid_time = 0
            WHERE facture_id = ?`,
          [facture.id]
        );
      }
      await conn.commit();
      res.json({ id: facture.id, statut });
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
 * DELETE /api/transport/factures/:id — supprime une facture SANS colis
 * uniquement (comme le legacy : sinon retirer d'abord les colis).
 */
async function deleteFacture(req, res, next) {
  try {
    const facture = await loadFacture(req.params.id);
    if (!facture) return res.status(404).json({ message: 'Facture introuvable.' });
    if (Number(facture.statut) === 1) {
      return res.status(400).json({ message: 'Facture payée : suppression impossible.' });
    }
    const { nb } = await totauxLive(pool, facture.id);
    if (nb > 0) {
      return res.status(400).json({
        message: 'Cette facture contient des colis : retirez-les avant de la supprimer.'
      });
    }
    await pool.query(`DELETE FROM delevery_transport_factures WHERE facture_id = ?`, [facture.id]);
    res.json({ id: facture.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listSocietesFacturables,
  listFactures,
  createFacture,
  getFacture,
  addColis,
  addTousColis,
  removeColis,
  setStatut,
  deleteFacture
};
