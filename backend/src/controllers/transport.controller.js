const pool = require('../config/db');
const { affecterAuBonDuJour } = require('../utils/transportBons');

/*
 * Module Transport — envois et retours (pages /admin/transport/envoi et
 * /admin/transport/retour, service TRANSPORT). Tables legacy partagées avec
 * le système de production PHP : delevery_transport_envois,
 * delevery_transport_retours, delevery_transport_societes,
 * delevery_transport_tarifs, delevery_transport_config
 * (sql/2026-08-24_transport-tickets.sql).
 *
 * Un ticket transport porte un code CODE_EXP + chiffres + CODE_DEST (codes
 * société de 2-3 lettres). Le même ticket physique est lu à l'envoi (préfixe
 * = société expéditrice, facturée) ou au retour (préfixe = société de
 * ramassage, suffixe = société cliente facturée) ; un code ne peut exister
 * que dans UNE des deux tables (anti-doublon croisé + UNIQUE code).
 *
 * Tarif figé au scan : grille personnalisée de la société facturée vers la
 * ville de l'autre partie (delevery_transport_tarifs) si la société est en
 * tarif_personnalise, sinon tarif standard global (delevery_transport_config).
 * tarif_type : standard | personnalise | manuel (prix édité à la main).
 *
 * Un colis rattaché à une facture (facture_id > 0) n'est plus ni modifiable
 * ni supprimable (correction du legacy, qui permettait de toucher aux colis
 * d'une facture même payée). Pas de périmètre agence : le module legacy n'a
 * aucune colonne agence (accès types 1/2/3/4/6, actions réservées aux 1/2
 * dans les routes).
 *
 * Bons de transport (utils/transportBons) : chaque colis enregistré (scan ou
 * saisie manuelle) rejoint automatiquement le bon du jour du trajet couvrant
 * sa ville de destination (colonne bon_id) ; ville sans trajet → colis non
 * affecté. Un colis supprimé quitte son bon avec lui.
 */

/* Taille de page maximale des listes paginées (envois / retours). */
const MAX_PAGE_SIZE = 100;

/* Format des codes tickets : CODE_EXP + 8-20 chiffres + CODE_DEST. */
const CODE_RE = /^([A-Z]{2,3})([0-9]{8,20})([A-Z]{2,3})$/;

/*
 * Les deux sens partagent toute la logique ; seule change la sémantique des
 * colonnes : à l'envoi la société facturée est le préfixe du code (elle
 * expédie), au retour c'est le suffixe (on ramasse chez le préfixe pour son
 * compte). villeFacturee / villeAutre = colonnes où sont recopiées les villes
 * des deux sociétés au moment du scan.
 */
const DIRECTIONS = {
  envoi: {
    table: 'delevery_transport_envois',
    idCol: 'envoi_id',
    facturee: 'societe_exp_id',
    autre: 'societe_dest_id',
    villeFacturee: 'ville_envoi_id',
    villeAutre: 'ville_dest_id',
    villeListe: 'ville_envoi_id',
    factureeEstPrefixe: true,
    prefixeInconnu: 'Société expéditrice inconnue',
    suffixeInconnu: 'Société destinataire inconnue',
    dejaIci: 'Colis déjà ramassé le',
    dejaAutreSens: 'Code déjà scanné au retour le'
  },
  retour: {
    table: 'delevery_transport_retours',
    idCol: 'retour_id',
    facturee: 'societe_id',
    autre: 'societe_ram_id',
    villeFacturee: 'ville_dest_id',
    villeAutre: 'ville_ram_id',
    villeListe: 'ville_ram_id',
    factureeEstPrefixe: false,
    prefixeInconnu: 'Société de ramassage inconnue',
    suffixeInconnu: 'Société cliente inconnue',
    dejaIci: 'Colis déjà scanné au retour le',
    dejaAutreSens: "Code déjà scanné à l'envoi le"
  }
};

/** Direction depuis l'URL (:direction = envois | retours), sinon null. */
function getDirection(req) {
  const dir = req.params.direction === 'envois' ? 'envoi' : req.params.direction === 'retours' ? 'retour' : null;
  return dir ? DIRECTIONS[dir] : null;
}

/** "AAAA-MM-JJ" → timestamp unix (secondes, heure locale serveur), sinon null. */
function dayToUnix(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/** Timestamp unix → "JJ/MM/AAAA HH:MM" (messages de doublon au scan). */
function formatDateHeure(unix) {
  const d = new Date(Number(unix) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Société active par code (préfixe/suffixe d'un ticket), avec sa ville.
 * { societe } ; { error } si inconnue ou si plusieurs sociétés partagent le
 * code (config à corriger — le legacy prenait la première en silence).
 */
async function societeParCode(code) {
  const [rows] = await pool.query(
    `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
            s.ville_id, s.tarif_personnalise
       FROM delevery_transport_societes s
      WHERE s.code_societe = ? AND s.statut = 1`,
    [code]
  );
  if (!rows.length) return { error: null };
  if (rows.length > 1) {
    return { error: `Plusieurs sociétés portent le code ${code} : corrigez la configuration.` };
  }
  return { societe: rows[0] };
}

/**
 * Tarif applicable : grille personnalisée de la société facturée vers la
 * ville de l'autre partie, sinon tarif standard global.
 * → { tarif, tarifType }.
 */
async function calculerTarif(facturee, villeAutreId) {
  if (Number(facturee.tarif_personnalise) === 1) {
    const [[ligne]] = await pool.query(
      `SELECT tarif FROM delevery_transport_tarifs
        WHERE societe_id = ? AND ville_id = ? LIMIT 1`,
      [facturee.id, villeAutreId]
    );
    if (ligne) return { tarif: Number(ligne.tarif), tarifType: 'personnalise' };
  }
  const [[config]] = await pool.query(
    `SELECT tarif_standard FROM delevery_transport_config WHERE config_id = 1 LIMIT 1`
  );
  return { tarif: config ? Number(config.tarif_standard) : 0, tarifType: 'standard' };
}

/**
 * Cherche un code dans les deux tables (anti-doublon croisé).
 * → { table: 'envoi' | 'retour', created_time } ou null.
 */
async function codeDejaScanne(code) {
  const [[envoi]] = await pool.query(
    `SELECT created_time FROM delevery_transport_envois WHERE code = ? LIMIT 1`,
    [code]
  );
  if (envoi) return { table: 'envoi', created_time: envoi.created_time };
  const [[retour]] = await pool.query(
    `SELECT created_time FROM delevery_transport_retours WHERE code = ? LIMIT 1`,
    [code]
  );
  if (retour) return { table: 'retour', created_time: retour.created_time };
  return null;
}

/**
 * Enregistre un colis scanné/saisi (facturee et autre = sociétés résolues,
 * avec leur ville). → { status, message } au format du scan legacy :
 * success | duplicate | error.
 */
async function enregistrerColis(dir, code, facturee, autre, userId) {
  const deja = await codeDejaScanne(code);
  if (deja) {
    const memeSens = (deja.table === 'envoi') === (dir === DIRECTIONS.envoi);
    return {
      status: 'duplicate',
      message: `${memeSens ? dir.dejaIci : dir.dejaAutreSens} ${formatDateHeure(deja.created_time)}.`
    };
  }
  const { tarif, tarifType } = await calculerTarif(facturee, autre.ville_id);
  const now = Math.floor(Date.now() / 1000);
  let colisId;
  try {
    const [result] = await pool.query(
      `INSERT INTO ${dir.table}
         (code, ${dir.facturee}, ${dir.autre}, ${dir.villeFacturee}, ${dir.villeAutre},
          tarif, tarif_type, facture_id, user_id, created_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [code, facturee.id, autre.id, facturee.ville_id, autre.ville_id, tarif, tarifType, userId, now]
    );
    colisId = result.insertId;
  } catch (err) {
    // Deux scans simultanés du même code : l'UNIQUE sur code tranche.
    if (err && err.code === 'ER_DUP_ENTRY') {
      return { status: 'duplicate', message: 'Code déjà scanné.' };
    }
    throw err;
  }
  // Sens physique du colis : préfixe → suffixe (envoi : expéditrice →
  // destinataire ; retour : ramassage → cliente).
  const de = dir.factureeEstPrefixe ? facturee : autre;
  const vers = dir.factureeEstPrefixe ? autre : facturee;
  // Bon de transport du jour : trajet couvrant la ville de destination
  // (ville_dest_id = ville de la société suffixe, où le colis est livré).
  const affectation = await affecterAuBonDuJour(dir.table, dir.idCol, colisId, vers.ville_id, userId);
  return {
    status: 'success',
    message: `Colis ${code} enregistré — ${de.nom} → ${vers.nom} (${tarif.toFixed(2)} DH, facturé à ${facturee.nom}). ${affectation.texte}`,
    bon: affectation.bon,
    trajet: affectation.trajet
  };
}

/**
 * GET /api/transport/filtres — sociétés actives (id, nom, code) pour les
 * selects de filtre et la saisie manuelle.
 */
async function listFiltres(req, res, next) {
  try {
    const [societes] = await pool.query(
      `SELECT s.societe_id AS id, s.nom_societe AS nom, s.code_societe AS code,
              v.reference_ville AS ville_ref, v.nom_ville AS ville
         FROM delevery_transport_societes s
         LEFT JOIN delevery_tarifs v ON v.ville_id = s.ville_id
        WHERE s.statut = 1
        ORDER BY s.nom_societe`
    );
    res.json({ societes });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transport/stats — tuiles de synthèse des trois pages : scans du
 * jour et encours non facturé par sens, factures impayées (nb + montant).
 */
async function getStats(req, res, next) {
  try {
    const d = new Date();
    const debutJour = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
    const [[stats]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM delevery_transport_envois WHERE created_time >= ?)  AS envois_jour,
         (SELECT COUNT(*) FROM delevery_transport_retours WHERE created_time >= ?) AS retours_jour,
         (SELECT COUNT(*) FROM delevery_transport_envois WHERE facture_id = 0)     AS envois_non_factures,
         (SELECT COUNT(*) FROM delevery_transport_retours WHERE facture_id = 0)    AS retours_non_factures,
         (SELECT IFNULL(SUM(tarif), 0) FROM delevery_transport_envois WHERE facture_id = 0)
       + (SELECT IFNULL(SUM(tarif), 0) FROM delevery_transport_retours WHERE facture_id = 0)
                                                                                   AS encours_montant,
         (SELECT COUNT(*) FROM delevery_transport_factures WHERE statut = 0)       AS factures_impayees`,
      [debutJour, debutJour]
    );
    res.json({
      envoisJour: Number(stats.envois_jour),
      retoursJour: Number(stats.retours_jour),
      envoisNonFactures: Number(stats.envois_non_factures),
      retoursNonFactures: Number(stats.retours_non_factures),
      encoursMontant: Number(stats.encours_montant),
      facturesImpayees: Number(stats.factures_impayees)
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transport/:direction — liste paginée des colis scannés pour la
 * datatable, du plus récent au plus ancien. Query : page, pageSize (5-100),
 * debut / fin (AAAA-MM-JJ, vides = toutes les dates), societe (id de la
 * société facturée), statut (non-facture | facture | paye, '' = tous), q
 * (code / société / ville). Renvoie { rows, total, page, pageSize,
 * totalPages } : tous les colis sont accessibles, pas seulement les 1000
 * plus récents.
 */
async function listColis(req, res, next) {
  try {
    const dir = getDirection(req);
    if (!dir) return res.status(404).json({ message: 'Route introuvable.' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 5), MAX_PAGE_SIZE);

    const where = ['1 = 1'];
    const params = [];
    const debut = dayToUnix(req.query.debut);
    if (debut !== null) {
      where.push('c.created_time >= ?');
      params.push(debut);
    }
    const fin = dayToUnix(req.query.fin);
    if (fin !== null) {
      where.push('c.created_time < ?');
      params.push(fin + 86400);
    }
    const societe = parseInt(req.query.societe, 10) || 0;
    if (societe) {
      where.push(`c.${dir.facturee} = ?`);
      params.push(societe);
    }
    const statut = String(req.query.statut || '').trim();
    if (statut === 'non-facture') where.push('c.facture_id = 0');
    else if (statut === 'facture') where.push('c.facture_id > 0 AND IFNULL(f.statut, 0) = 0');
    else if (statut === 'paye') where.push('c.facture_id > 0 AND f.statut = 1');
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) {
      where.push(`(c.code LIKE ? OR s1.nom_societe LIKE ? OR s2.nom_societe LIKE ?
                   OR v1.nom_ville LIKE ? OR v2.nom_ville LIKE ?
                   OR v1.reference_ville LIKE ? OR v2.reference_ville LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like);
    }

    // Jointures nécessaires aux filtres (statut, recherche) : partagées entre
    // le comptage et la page ; l'utilisateur ayant scanné n'est joint que
    // pour l'affichage.
    const fromSql = `FROM ${dir.table} c
         LEFT JOIN delevery_transport_societes s1 ON s1.societe_id = c.${dir.facturee}
         LEFT JOIN delevery_transport_societes s2 ON s2.societe_id = c.${dir.autre}
         LEFT JOIN delevery_tarifs v1 ON v1.ville_id = c.${dir.villeListe}
         LEFT JOIN delevery_tarifs v2 ON v2.ville_id = c.ville_dest_id
         LEFT JOIN delevery_transport_factures f ON f.facture_id = c.facture_id`;
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${fromSql} ${whereSql}`, params);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT c.${dir.idCol}     AS id,
              c.code             AS code,
              c.tarif            AS tarif,
              c.tarif_type       AS tarif_type,
              c.facture_id       AS facture_id,
              c.created_time     AS created_time,
              s1.nom_societe     AS societe,
              s2.nom_societe     AS autre_societe,
              v1.reference_ville AS ville_ref,
              v1.nom_ville       AS ville,
              v2.reference_ville AS ville_dest_ref,
              v2.nom_ville       AS ville_dest,
              IFNULL(f.statut, 0) AS facture_statut,
              f.reference        AS facture_ref,
              u.users_name       AS scanne_par
         ${fromSql}
         LEFT JOIN delevery_users u ON u.users_id = c.user_id
         ${whereSql}
        ORDER BY c.created_time DESC, c.${dir.idCol} DESC
        LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({
      rows: rows.map((r) => ({
        ...r,
        tarif: Number(r.tarif),
        facture_id: Number(r.facture_id),
        facture_statut: Number(r.facture_statut)
      })),
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
 * POST /api/transport/:direction/scan — body { code }. Enregistre un colis
 * scanné (douchette ou caméra). Réponse 200 { status: success | duplicate |
 * error, message } — le bandeau et le bip du front suivent le statut.
 */
async function scanColis(req, res, next) {
  try {
    const dir = getDirection(req);
    if (!dir) return res.status(404).json({ message: 'Route introuvable.' });

    const code = String(req.body?.code || '').trim().toUpperCase();
    const m = CODE_RE.exec(code);
    if (!m) {
      return res.json({ status: 'error', message: `Format du code invalide : ${code || '(vide)'}` });
    }
    const prefixe = await societeParCode(m[1]);
    if (prefixe.error) return res.json({ status: 'error', message: prefixe.error });
    if (!prefixe.societe) {
      return res.json({ status: 'error', message: `${dir.prefixeInconnu} (code ${m[1]}).` });
    }
    const suffixe = await societeParCode(m[3]);
    if (suffixe.error) return res.json({ status: 'error', message: suffixe.error });
    if (!suffixe.societe) {
      return res.json({ status: 'error', message: `${dir.suffixeInconnu} (code ${m[3]}).` });
    }
    const facturee = dir.factureeEstPrefixe ? prefixe.societe : suffixe.societe;
    const autre = dir.factureeEstPrefixe ? suffixe.societe : prefixe.societe;
    res.json(await enregistrerColis(dir, code, facturee, autre, Number(req.user.id)));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transport/:direction — saisie manuelle de secours (ticket
 * illisible) : body { exp, dest } à l'envoi (expéditrice facturée →
 * destinataire), { ram, client } au retour (ramassage → cliente facturée).
 * Le code est généré au format ticket (CODE + ms + 3 chiffres + CODE) pour
 * rester compatible avec l'anti-doublon et la facturation.
 */
async function createColis(req, res, next) {
  try {
    const dir = getDirection(req);
    if (!dir) return res.status(404).json({ message: 'Route introuvable.' });

    const idPrefixe = parseInt(dir.factureeEstPrefixe ? req.body?.exp : req.body?.ram, 10);
    const idSuffixe = parseInt(dir.factureeEstPrefixe ? req.body?.dest : req.body?.client, 10);
    if (!Number.isInteger(idPrefixe) || idPrefixe <= 0 || !Number.isInteger(idSuffixe) || idSuffixe <= 0) {
      return res.status(400).json({ message: 'Veuillez sélectionner les deux sociétés.' });
    }
    if (idPrefixe === idSuffixe) {
      return res.status(400).json({ message: 'Les deux sociétés doivent être différentes.' });
    }
    const charger = async (id) => {
      const [[s]] = await pool.query(
        `SELECT societe_id AS id, nom_societe AS nom, code_societe AS code,
                ville_id, tarif_personnalise
           FROM delevery_transport_societes WHERE societe_id = ? AND statut = 1 LIMIT 1`,
        [id]
      );
      return s || null;
    };
    const prefixe = await charger(idPrefixe);
    const suffixe = await charger(idSuffixe);
    if (!prefixe || !suffixe) {
      return res.status(400).json({ message: 'Société introuvable ou désactivée.' });
    }
    if (!/^[A-Z]{2,3}$/.test(prefixe.code) || !/^[A-Z]{2,3}$/.test(suffixe.code)) {
      return res.status(400).json({
        message: 'Les deux sociétés doivent avoir un code (Transport - Configuration).'
      });
    }
    const code = `${prefixe.code}${Date.now()}${String(Math.floor(Math.random() * 900) + 100)}${suffixe.code}`;
    const facturee = dir.factureeEstPrefixe ? prefixe : suffixe;
    const autre = dir.factureeEstPrefixe ? suffixe : prefixe;
    const result = await enregistrerColis(dir, code, facturee, autre, Number(req.user.id));
    if (result.status !== 'success') return res.status(400).json({ message: result.message });
    res.status(201).json({ code, message: result.message });
  } catch (err) {
    next(err);
  }
}

/** Charge un colis ; null si introuvable. */
async function loadColis(dir, id) {
  const colisId = parseInt(id, 10);
  if (!Number.isInteger(colisId) || colisId <= 0) return null;
  const [[colis]] = await pool.query(
    `SELECT ${dir.idCol} AS id, code, tarif, facture_id FROM ${dir.table}
      WHERE ${dir.idCol} = ? LIMIT 1`,
    [colisId]
  );
  return colis || null;
}

/**
 * PATCH /api/transport/:direction/:id — body { tarif }. Modifie le prix d'un
 * colis NON facturé (le tarif passe en « manuel »). Types 1/2 (routes).
 */
async function updateColis(req, res, next) {
  try {
    const dir = getDirection(req);
    if (!dir) return res.status(404).json({ message: 'Route introuvable.' });
    const colis = await loadColis(dir, req.params.id);
    if (!colis) return res.status(404).json({ message: 'Colis introuvable.' });
    if (Number(colis.facture_id) !== 0) {
      return res.status(400).json({ message: 'Colis rattaché à une facture : modification impossible.' });
    }
    const tarif = Number(req.body?.tarif);
    if (!Number.isFinite(tarif) || tarif < 0 || tarif > 99999999) {
      return res.status(400).json({ message: 'Tarif invalide.' });
    }
    await pool.query(
      `UPDATE ${dir.table} SET tarif = ?, tarif_type = 'manuel'
        WHERE ${dir.idCol} = ? AND facture_id = 0`,
      [Math.round(tarif * 100) / 100, colis.id]
    );
    res.json({ id: colis.id });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/transport/:direction/:id — supprime un colis NON facturé
 * (correction du legacy : suppression possible même facturé/payé). Types 1/2.
 */
async function deleteColis(req, res, next) {
  try {
    const dir = getDirection(req);
    if (!dir) return res.status(404).json({ message: 'Route introuvable.' });
    const colis = await loadColis(dir, req.params.id);
    if (!colis) return res.status(404).json({ message: 'Colis introuvable.' });
    if (Number(colis.facture_id) !== 0) {
      return res.status(400).json({ message: 'Colis rattaché à une facture : suppression impossible.' });
    }
    await pool.query(`DELETE FROM ${dir.table} WHERE ${dir.idCol} = ? AND facture_id = 0`, [colis.id]);
    res.json({ id: colis.id });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listFiltres,
  getStats,
  listColis,
  scanColis,
  createColis,
  updateColis,
  deleteColis
};
