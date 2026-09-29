const pool = require('../config/db');

/*
 * Bons de transport — journée et rattachement automatique des colis
 * scannés (module Transport, sql/2026-09-18_transport-bons.sql).
 *
 * Une JOURNÉE va de 06:00 à 06:00 le lendemain (heure locale du serveur,
 * comme toutes les dates du module) : un scan à 02:00 le 19/09 appartient à
 * la journée du 18/09. bon_journee = date du début de la journée.
 *
 * Un bon existe par trajet et par journée ; il est créé au premier colis
 * (INSERT protégé par l'UNIQUE (trajet_id, bon_journee) : deux scans
 * simultanés ne créent pas de doublon). Le trajet d'un colis est celui dont
 * une zone contient sa ville de destination (delevery_tarifs.zone) ; une zone
 * n'appartient qu'à un seul trajet (PRIMARY KEY zone_id de la liaison).
 */

/* Heure de début d'une journée (06:00). */
const HEURE_DEBUT = 6;

/* Codes MySQL rencontrés quand la migration n'a pas été exécutée. */
const CODES_MIGRATION = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

/** Vrai si l'erreur vient d'une table / colonne absente (migration non passée). */
function estMigrationManquante(err) {
  return Boolean(err && CODES_MIGRATION.has(err.code));
}

/** Timestamp unix → "AAAA-MM-JJ" de la journée (06:00 → 06:00) qui le contient. */
function journeeDe(unix) {
  const d = new Date((Number(unix) - HEURE_DEBUT * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Journée en cours ("AAAA-MM-JJ"). */
function journeeCourante() {
  return journeeDe(Math.floor(Date.now() / 1000));
}

/** "AAAA-MM-JJ" → { debut, fin } unix de la journée (06:00 → 06:00 lendemain), sinon null. */
function bornesJournee(journee) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(journee || '').trim());
  if (!m) return null;
  const debut = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), HEURE_DEBUT, 0, 0);
  if (Number.isNaN(debut.getTime())) return null;
  const d = Math.floor(debut.getTime() / 1000);
  return { debut: d, fin: d + 86400 };
}

/** Valeur DATE MySQL (Date ou chaîne) → "AAAA-MM-JJ". */
function journeeToString(value) {
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return String(value || '').slice(0, 10);
}

/**
 * Trajet couvrant une ville de destination : { id, nom, ville } ou
 * { id: null, ville } si aucune zone de trajet ne contient la ville
 * (ville sans zone comprise). ville = "REF - Nom" pour les messages.
 */
async function trajetPourVille(villeId) {
  const [[row]] = await pool.query(
    `SELECT t.trajet_id AS id, t.trajet_nom AS nom,
            v.reference_ville AS ville_ref, v.nom_ville AS ville_nom
       FROM delevery_tarifs v
       LEFT JOIN delevery_transport_trajet_zones tz ON tz.zone_id = v.zone
       LEFT JOIN delevery_transport_trajets t ON t.trajet_id = tz.trajet_id
      WHERE v.ville_id = ?
      LIMIT 1`,
    [Number(villeId) || 0]
  );
  const ville = row ? [row.ville_ref, row.ville_nom].filter(Boolean).join(' - ') : `#${villeId}`;
  if (!row || !row.id) return { id: null, nom: null, ville };
  return { id: Number(row.id), nom: row.nom, ville };
}

/** Référence d'un bon : BT-JJMMAA-0{id}0-XX (date de la journée, 2 chiffres aléatoires). */
function genererRef(bonId, journee) {
  const [aaaa, mm, jj] = journee.split('-');
  return `BT-${jj}${mm}${aaaa.slice(2)}-0${bonId}0-${String(Math.floor(Math.random() * 90) + 10)}`;
}

/**
 * Bon d'un trajet pour une journée : renvoyé s'il existe, créé sinon
 * (référence générée après l'INSERT, l'id la rendant unique). Deux appels
 * simultanés : l'UNIQUE (trajet_id, bon_journee) tranche et le perdant
 * relit le bon créé par l'autre. → { id, ref, cree }.
 */
async function bonDuJour(trajetId, journee, userId) {
  const lire = async () => {
    const [[bon]] = await pool.query(
      `SELECT bon_id AS id, bon_ref AS ref FROM delevery_transport_bons
        WHERE trajet_id = ? AND bon_journee = ? LIMIT 1`,
      [trajetId, journee]
    );
    return bon || null;
  };
  const existant = await lire();
  if (existant) return { ...existant, cree: false };
  try {
    const [result] = await pool.query(
      `INSERT INTO delevery_transport_bons (bon_ref, trajet_id, bon_journee, user_id, created_time)
       VALUES ('', ?, ?, ?, ?)`,
      [trajetId, journee, Number(userId) || 0, Math.floor(Date.now() / 1000)]
    );
    const ref = genererRef(result.insertId, journee);
    await pool.query(`UPDATE delevery_transport_bons SET bon_ref = ? WHERE bon_id = ?`, [ref, result.insertId]);
    return { id: result.insertId, ref, cree: true };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const bon = await lire();
      if (bon) return { ...bon, cree: false };
    }
    throw err;
  }
}

/**
 * Rattache un colis fraîchement enregistré (table envois ou retours) au bon
 * du jour du trajet couvrant sa ville de destination. Ne lève jamais : le
 * colis est déjà enregistré et tarifé, l'affectation est un complément.
 * → { bon: { id, ref } | null, trajet: { id, nom } | null, texte } où texte
 * est le complément à ajouter au message du scan.
 */
async function affecterAuBonDuJour(table, idCol, colisId, villeDestId, userId) {
  try {
    const trajet = await trajetPourVille(villeDestId);
    if (!trajet.id) {
      return { bon: null, trajet: null, texte: `Sans bon : aucun trajet pour la ville ${trajet.ville}.` };
    }
    const bon = await bonDuJour(trajet.id, journeeCourante(), userId);
    await pool.query(`UPDATE ${table} SET bon_id = ? WHERE ${idCol} = ? AND bon_id = 0`, [bon.id, colisId]);
    return {
      bon: { id: bon.id, ref: bon.ref },
      trajet: { id: trajet.id, nom: trajet.nom },
      texte: `Bon ${bon.ref} (${trajet.nom})${bon.cree ? ', nouveau bon de la journée' : ''}.`
    };
  } catch (err) {
    if (estMigrationManquante(err)) {
      console.warn('[transport] bons de transport : migration sql/2026-09-18_transport-bons.sql non exécutée.');
      return { bon: null, trajet: null, texte: 'Bon non affecté (migration bons de transport manquante).' };
    }
    console.error('[transport] affectation au bon de transport impossible :', err);
    return { bon: null, trajet: null, texte: 'Bon non affecté (erreur interne, à rattacher à la main).' };
  }
}

module.exports = {
  HEURE_DEBUT,
  estMigrationManquante,
  journeeDe,
  journeeCourante,
  bornesJournee,
  journeeToString,
  trajetPourVille,
  bonDuJour,
  affecterAuBonDuJour
};
