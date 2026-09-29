const pool = require('../config/db');

/*
 * Statistiques du CRM WhatsApp (page /admin/api-liaison/whatsapp/statistiques)
 * sur une période [from, to] (AAAA-MM-JJ, bornes incluses) : volumes par
 * statut, par jour, par modèle, par règle, erreurs Meta, discussions, taux et
 * délai médian de réponse (premier message d'un employé après un message
 * entrant qui n'avait pas encore de réponse).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function jourIso(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Bornes valides : par défaut les 30 derniers jours ; période plafonnée à 366 jours. */
function bornes(from, to) {
  const aujourdhui = new Date();
  let fin = DATE_RE.test(to || '') ? to : jourIso(aujourdhui);
  let debut = DATE_RE.test(from || '') ? from : null;
  if (!debut) {
    const d = new Date(fin);
    d.setDate(d.getDate() - 29);
    debut = jourIso(d);
  }
  if (debut > fin) [debut, fin] = [fin, debut];
  const dDebut = new Date(debut);
  const dFin = new Date(fin);
  if ((dFin - dDebut) / 86400000 > 366) {
    const d = new Date(dFin);
    d.setDate(d.getDate() - 366);
    debut = jourIso(d);
  }
  return { from: debut, to: fin };
}

function mediane(valeurs) {
  if (!valeurs.length) return null;
  const s = [...valeurs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function statistiques({ from, to } = {}) {
  const p = bornes(from, to);
  const periode = 'wam_created_at >= ? AND wam_created_at < DATE_ADD(?, INTERVAL 1 DAY)';
  const args = [p.from, p.to];

  const [[parStatut], [parJourRows], [parModele], [parRegle], [erreurs], [[conv]], [fil]] = await Promise.all([
    pool.query(
      `SELECT wam_direction AS direction, wam_statut AS statut, COUNT(*) AS n
         FROM delevery_whatsapp_message WHERE ${periode} GROUP BY wam_direction, wam_statut`,
      args
    ),
    pool.query(
      `SELECT DATE(wam_created_at) AS jour,
              SUM(wam_direction = 'sortant' AND wam_statut IN ('envoye', 'remis', 'lu')) AS envoyes,
              SUM(wam_direction = 'entrant') AS recus,
              SUM(wam_direction = 'sortant' AND wam_statut = 'echec') AS echecs
         FROM delevery_whatsapp_message WHERE ${periode} GROUP BY DATE(wam_created_at) ORDER BY jour`,
      args
    ),
    pool.query(
      `SELECT wam_template AS modele, COUNT(*) AS total,
              SUM(wam_statut IN ('envoye', 'remis', 'lu')) AS envoyes,
              SUM(wam_statut IN ('remis', 'lu')) AS remis, SUM(wam_statut = 'lu') AS lus,
              SUM(wam_statut = 'echec') AS echecs
         FROM delevery_whatsapp_message
        WHERE ${periode} AND wam_direction = 'sortant' AND wam_template IS NOT NULL
        GROUP BY wam_template ORDER BY total DESC LIMIT 20`,
      args
    ),
    pool.query(
      `SELECT m.wam_regle AS regleId, COALESCE(r.wamr_nom, CONCAT('Règle n°', m.wam_regle)) AS regle,
              COUNT(*) AS total,
              SUM(m.wam_statut IN ('envoye', 'remis', 'lu')) AS envoyes,
              SUM(m.wam_statut IN ('remis', 'lu')) AS remis, SUM(m.wam_statut = 'lu') AS lus,
              SUM(m.wam_statut = 'echec') AS echecs, SUM(m.wam_statut = 'planifie') AS planifies
         FROM delevery_whatsapp_message m
         LEFT JOIN delevery_whatsapp_regle r ON r.wamr_id = m.wam_regle
        WHERE ${periode} AND m.wam_regle IS NOT NULL
        GROUP BY m.wam_regle, r.wamr_nom ORDER BY total DESC LIMIT 20`,
      args
    ),
    pool.query(
      `SELECT COALESCE(wam_erreur_code, '?') AS code, MIN(wam_erreur_message) AS message, COUNT(*) AS n
         FROM delevery_whatsapp_message
        WHERE ${periode} AND wam_direction = 'sortant' AND wam_statut = 'echec'
        GROUP BY wam_erreur_code ORDER BY n DESC LIMIT 20`,
      args
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM delevery_whatsapp_conversation
           WHERE wac_created_at >= ? AND wac_created_at < DATE_ADD(?, INTERVAL 1 DAY)) AS creees,
         (SELECT COUNT(*) FROM delevery_whatsapp_conversation
           WHERE wac_statut <> 'termine' AND wac_dernier_entrant_le IS NOT NULL) AS ouvertes,
         (SELECT COUNT(*) FROM delevery_whatsapp_conversation WHERE wac_non_lus > 0) AS nonLues,
         (SELECT COUNT(*) FROM delevery_whatsapp_conversation WHERE wac_opt_out = 1) AS optOut,
         (SELECT COUNT(*) FROM delevery_whatsapp_conversation
           WHERE wac_affecte_a IS NULL AND wac_statut <> 'termine' AND wac_dernier_entrant_le IS NOT NULL) AS nonAffectees`,
      args
    ),
    pool.query(
      `SELECT wam_conversation AS conv, wam_direction AS direction, wam_created_by AS par, wam_created_at AS date
         FROM delevery_whatsapp_message
        WHERE ${periode} AND wam_conversation IS NOT NULL AND wam_direction IN ('sortant', 'entrant')
        ORDER BY wam_conversation, wam_id`,
      args
    )
  ]);

  const totaux = { envoyes: 0, remis: 0, lus: 0, echecs: 0, planifies: 0, enAttente: 0, recus: 0, notes: 0 };
  for (const r of parStatut) {
    const n = Number(r.n) || 0;
    if (r.direction === 'entrant') totaux.recus += n;
    else if (r.direction === 'note') totaux.notes += n;
    else {
      if (['envoye', 'remis', 'lu'].includes(r.statut)) totaux.envoyes += n;
      if (['remis', 'lu'].includes(r.statut)) totaux.remis += n;
      if (r.statut === 'lu') totaux.lus += n;
      if (r.statut === 'echec') totaux.echecs += n;
      if (r.statut === 'planifie') totaux.planifies += n;
      if (r.statut === 'en_attente') totaux.enAttente += n;
    }
  }

  // Jours de la période complétés à zéro.
  const parJourMap = new Map(parJourRows.map((r) => [jourIso(new Date(r.jour)), r]));
  const parJour = [];
  for (let d = new Date(p.from); jourIso(d) <= p.to; d.setDate(d.getDate() + 1)) {
    const k = jourIso(d);
    const r = parJourMap.get(k);
    parJour.push({ jour: k, envoyes: Number(r?.envoyes) || 0, recus: Number(r?.recus) || 0, echecs: Number(r?.echecs) || 0 });
  }

  // Réponses : un entrant ouvre une « question » si aucune n'est en attente ;
  // le premier sortant d'un employé (createdBy > 0) la clôt.
  let questions = 0;
  const delais = [];
  let convCourante = null;
  let attente = null;
  for (const m of fil) {
    if (m.conv !== convCourante) {
      convCourante = m.conv;
      attente = null;
    }
    if (m.direction === 'entrant') {
      if (!attente) {
        attente = new Date(m.date);
        questions += 1;
      }
    } else if (attente && Number(m.par) > 0) {
      delais.push((new Date(m.date) - attente) / 60000);
      attente = null;
    }
  }
  const repondues = delais.length;

  const num = (v) => Number(v) || 0;
  return {
    periode: p,
    totaux,
    taux: {
      remis: totaux.envoyes ? Math.round((totaux.remis / totaux.envoyes) * 100) : 0,
      lus: totaux.envoyes ? Math.round((totaux.lus / totaux.envoyes) * 100) : 0,
      echecs: totaux.envoyes + totaux.echecs ? Math.round((totaux.echecs / (totaux.envoyes + totaux.echecs)) * 100) : 0
    },
    reponses: {
      questions,
      repondues,
      taux: questions ? Math.round((repondues / questions) * 100) : 0,
      delaiMedianMinutes: mediane(delais) == null ? null : Math.round(mediane(delais))
    },
    conversations: {
      creees: num(conv?.creees),
      ouvertes: num(conv?.ouvertes),
      nonLues: num(conv?.nonLues),
      optOut: num(conv?.optOut),
      nonAffectees: num(conv?.nonAffectees)
    },
    parJour,
    parModele: parModele.map((r) => ({ modele: r.modele, total: num(r.total), envoyes: num(r.envoyes), remis: num(r.remis), lus: num(r.lus), echecs: num(r.echecs) })),
    parRegle: parRegle.map((r) => ({ regleId: r.regleId, regle: r.regle, total: num(r.total), envoyes: num(r.envoyes), remis: num(r.remis), lus: num(r.lus), echecs: num(r.echecs), planifies: num(r.planifies) })),
    erreurs: erreurs.map((r) => ({ code: r.code, message: r.message, n: num(r.n) }))
  };
}

module.exports = { statistiques, bornes };
