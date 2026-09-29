const pool = require('../config/db');
const { MATERIEL_TYPES, VENDABLE_TYPES } = require('./materiel.controller');

/*
 * Statistiques matériels (/admin/statistiques/materiels — service
 * STATISTIQUES, donc types 1 et 2). Un endpoint unique servant les onglets
 * par type d'article (auto, consommable, non consommable, emballage) :
 * consommation par article sur la période, agrégée depuis le journal
 * delevery_materiel_mvnt (mm_date). L'onglet Globale de la page sera
 * développé plus tard (pas d'endpoint pour l'instant).
 */

/* Mouvements comptés comme « consommation » de la période, selon le type :
 *  - auto : consommations véhicule + sorties (perte / casse / correction) ;
 *  - emballage / consommable : ventes clients + sorties ;
 *  - non_consommable : sorties seules — les affectations / récupérations sont
 *    des prêts (le matériel reste à la société), restituées à part. */
const CONSO_PAR_TYPE = {
  auto: ['sortie', 'consommation'],
  emballage: ['sortie', 'vente'],
  consommable: ['sortie', 'vente'],
  non_consommable: ['sortie']
};

/* Miroir des mm_type du journal (materiel.controller MVNT_TYPES). */
const MVNT_CODES = [
  'entree',
  'sortie',
  'transfert_agence',
  'retour_agence',
  'vente',
  'consommation',
  'affectation',
  'recuperation'
];

/** "AAAA-MM-JJ" valide → borne DATETIME ("… 00:00:00" / "… 23:59:59"), sinon null. */
function dayBound(value, endOfDay) {
  const v = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return `${v} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

const arrondi = (v) => Math.round(v * 100) / 100;

/**
 * GET /api/statistiques/materiels?type&dateFrom&dateTo — consommation par
 * article du type donné sur la période (plage vide → toutes les dates) :
 *  - rows : un article par ligne avec les quantités par type de mouvement,
 *    la consommation (CONSO_PAR_TYPE), sa valeur (× prix d'achat), le montant
 *    réellement facturé des ventes et le stock actuel (principal + agences).
 *    Les articles désactivés sans mouvement dans la période sont omis ;
 *  - totaux : cumuls des mêmes indicateurs pour les cartes de l'onglet.
 */
async function statsMateriels(req, res, next) {
  try {
    const type = String(req.query.type || '').trim();
    if (!MATERIEL_TYPES.some((t) => t.code === type)) {
      return res.status(400).json({ message: "Type d'article invalide." });
    }
    const periode = ['1 = 1'];
    const periodeParams = [];
    const from = dayBound(req.query.dateFrom, false);
    if (from) {
      periode.push('v.mm_date >= ?');
      periodeParams.push(from);
    }
    const to = dayBound(req.query.dateTo, true);
    if (to) {
      periode.push('v.mm_date <= ?');
      periodeParams.push(to);
    }
    const periodeSql = periode.join(' AND ');

    const articlesQ = pool.query(
      `SELECT m.mt_id AS id, m.mt_nom AS nom, m.mt_reference AS reference,
              m.mt_unite AS unite, m.mt_prix_achat AS prix_achat,
              m.mt_qte AS qte, m.mt_active AS active,
              (SELECT IFNULL(SUM(ma.ma_qte), 0)
                 FROM delevery_materiel_agence ma
                WHERE ma.ma_materiel = m.mt_id) AS stock_agences
         FROM delevery_materiel m
        WHERE m.mt_type = ?
        ORDER BY m.mt_nom`,
      [type]
    );
    const mvntsQ = pool.query(
      `SELECT v.mm_materiel AS id, v.mm_type AS mvnt,
              COALESCE(SUM(v.mm_qte), 0) AS qte, COUNT(*) AS nb
         FROM delevery_materiel_mvnt v
         JOIN delevery_materiel m ON m.mt_id = v.mm_materiel
        WHERE m.mt_type = ? AND ${periodeSql}
        GROUP BY v.mm_materiel, v.mm_type`,
      [type, ...periodeParams]
    );
    // Montant réellement facturé des ventes de la période : frais client lié
    // au mouvement « vente » (1 vente = 1 frais réel, invariant du journal).
    const ventesQ = VENDABLE_TYPES.includes(type)
      ? pool.query(
          `SELECT v.mm_materiel AS id, COALESCE(SUM(f.frais_montant), 0) AS montant
             FROM delevery_materiel_mvnt v
             JOIN delevery_materiel m ON m.mt_id = v.mm_materiel
             JOIN delevery_client_frais f ON f.frais_id = v.mm_frais
            WHERE m.mt_type = ? AND v.mm_type = 'vente' AND ${periodeSql}
            GROUP BY v.mm_materiel`,
          [type, ...periodeParams]
        )
      : Promise.resolve([[]]);

    const [[articles], [mvnts], [ventes]] = await Promise.all([articlesQ, mvntsQ, ventesQ]);

    const parId = new Map();
    for (const a of articles) {
      parId.set(a.id, {
        id: a.id,
        nom: a.nom,
        reference: a.reference,
        unite: a.unite,
        prix_achat: a.prix_achat == null ? null : Number(a.prix_achat),
        stock: Number(a.qte) + Number(a.stock_agences),
        active: Number(a.active),
        mouvements: 0,
        montant_ventes: null,
        ...Object.fromEntries(MVNT_CODES.map((c) => [c, 0]))
      });
    }
    for (const r of mvnts) {
      const row = parId.get(r.id);
      if (!row || !MVNT_CODES.includes(r.mvnt)) continue;
      row[r.mvnt] = Number(r.qte);
      row.mouvements += Number(r.nb);
    }
    for (const r of ventes) {
      const row = parId.get(r.id);
      if (row) row.montant_ventes = arrondi(Number(r.montant));
    }

    const rows = [];
    for (const row of parId.values()) {
      row.conso = CONSO_PAR_TYPE[type].reduce((somme, code) => somme + row[code], 0);
      row.valeur = row.prix_achat == null ? null : arrondi(row.conso * row.prix_achat);
      if (!row.active && !row.mouvements) continue;
      rows.push(row);
    }
    rows.sort((a, b) => b.conso - a.conso || a.nom.localeCompare(b.nom, 'fr'));

    const totaux = {
      articles: rows.length,
      articles_consommes: 0,
      conso: 0,
      valeur: 0,
      // true si des articles consommés n'ont pas de prix d'achat (valeur partielle).
      valeur_partielle: false,
      montant_ventes: 0,
      ...Object.fromEntries(MVNT_CODES.map((c) => [c, 0]))
    };
    for (const r of rows) {
      totaux.conso += r.conso;
      if (r.conso > 0) totaux.articles_consommes += 1;
      if (r.valeur == null) {
        if (r.conso > 0) totaux.valeur_partielle = true;
      } else {
        totaux.valeur += r.valeur;
      }
      totaux.montant_ventes += r.montant_ventes || 0;
      for (const code of MVNT_CODES) totaux[code] += r[code];
    }
    totaux.valeur = arrondi(totaux.valeur);
    totaux.montant_ventes = arrondi(totaux.montant_ventes);

    res.json({ rows, totaux });
  } catch (err) {
    next(err);
  }
}

module.exports = { statsMateriels };
