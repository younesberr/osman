const pool = require('../config/db');
const { crmDisponible } = require('../utils/whatsappSchema');
const wa = require('../services/whatsapp');
const { lireParametresCrm } = require('../services/whatsappParametres');

/*
 * File d'envoi WhatsApp (actions automatiques, réponse automatique, renvois) :
 * lignes de delevery_whatsapp_message au statut 'planifie' dont
 * wam_planifie_le est échu. Toutes les 5 s (même forme que
 * ramassagePeriodique.js), le tick :
 *  1. balaie les lignes orphelines : 'en_attente' sans wamid depuis > 2 min
 *     (processus arrêté entre l'appel Meta et la mise à jour) → 'echec'
 *     « interrompu », JAMAIS renvoyées automatiquement (le message est peut-être
 *     parti) ; 'planifie' plus vieilles que l'expiration (Paramètres CRM) → 'echec' « expire » ;
 *  2. s'arrête si l'intégration n'est pas prête (les lignes attendent) ;
 *  3. réclame ≤ 20 lignes échues (→ 'en_attente'), les envoie une par une avec
 *     une pause de 250 ms ; erreur temporaire (limite de débit, indisponibilité
 *     Meta, réseau) → nouvel essai dans 30 s × 2^n (3 essais max), et arrêt du
 *     tick sur une limite globale.
 * Suppose un seul processus Node (Hostinger) : pas de verrou SQL.
 */

const TICK_MS = 5000;
const LOT = 20;
const PAUSE_MS = 250;
const TENTATIVES_MAX = 3;
const LIMITE_GLOBALE = new Set([130429, 4, 80007]);

let enCours = false;
let timer = null;
const etat = { dernierTick: null, dernierEnvoi: null, derniereErreur: null, envoyes: 0, echecs: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function balayer() {
  const params = await lireParametresCrm();
  await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_statut = 'echec', wam_erreur_code = 'interrompu',
            wam_erreur_message = 'Envoi interrompu (redémarrage du serveur) : statut inconnu, renvoyer si besoin.',
            wam_updated_at = NOW()
      WHERE wam_direction = 'sortant' AND wam_statut = 'en_attente' AND wam_wamid IS NULL
        AND wam_created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        AND (wam_updated_at IS NULL OR wam_updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE))`
  );
  await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_statut = 'echec', wam_erreur_code = 'expire', wam_erreur_message = ?, wam_updated_at = NOW()
      WHERE wam_direction = 'sortant' AND wam_statut = 'planifie'
        AND wam_planifie_le < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [
      `Envoi expiré : non envoyé dans les ${params.expirationHeures} h (intégration désactivée ou serveur arrêté).`,
      params.expirationHeures
    ]
  );
}

async function tick() {
  if (enCours) return;
  enCours = true;
  try {
    etat.dernierTick = new Date();
    if (!(await crmDisponible())) return;
    await balayer();
    const cfg = await wa.lireConfiguration({ avecSecrets: true });
    if (cfg.etat !== 'pret') return;

    const [aEnvoyer] = await pool.query(
      `SELECT wam_id FROM delevery_whatsapp_message
        WHERE wam_direction = 'sortant' AND wam_statut = 'planifie' AND wam_planifie_le <= NOW()
        ORDER BY wam_planifie_le, wam_id LIMIT ${LOT}`
    );
    if (!aEnvoyer.length) return;
    const ids = aEnvoyer.map((r) => r.wam_id);
    await pool.query(
      `UPDATE delevery_whatsapp_message SET wam_statut = 'en_attente', wam_updated_at = NOW()
        WHERE wam_id IN (?) AND wam_statut = 'planifie'`,
      [ids]
    );
    const [rows] = await pool.query(
      `SELECT wam_id, wam_payload, wam_conversation, wam_contenu, wam_tentatives
         FROM delevery_whatsapp_message WHERE wam_id IN (?) AND wam_statut = 'en_attente' ORDER BY wam_id`,
      [ids]
    );
    for (const row of rows) {
      try {
        await wa.executerEnvoi(cfg, row);
        etat.dernierEnvoi = new Date();
        etat.envoyes += 1;
      } catch (err) {
        etat.echecs += 1;
        etat.derniereErreur = { date: new Date(), code: err.metaCode ?? null, message: err.message };
        if (wa.estErreurTemporaire(err) && Number(row.wam_tentatives) < TENTATIVES_MAX) {
          const attente = 30 * 2 ** Number(row.wam_tentatives);
          await pool.query(
            `UPDATE delevery_whatsapp_message
                SET wam_statut = 'planifie', wam_tentatives = wam_tentatives + 1,
                    wam_planifie_le = DATE_ADD(NOW(), INTERVAL ? SECOND), wam_updated_at = NOW()
              WHERE wam_id = ?`,
            [attente, row.wam_id]
          );
          if (LIMITE_GLOBALE.has(Number(err.metaCode))) {
            console.warn(`[whatsapp-file] limite de débit Meta : reprise dans ${attente} s.`);
            break;
          }
        } else {
          console.warn(`[whatsapp-file] message ${row.wam_id} en échec (${err.metaCode ?? 'erreur'}) : ${err.message}`);
        }
      }
      await sleep(PAUSE_MS);
    }
  } catch (err) {
    etat.derniereErreur = { date: new Date(), code: err.code ?? null, message: err.message };
    console.error(`[whatsapp-file] ${err.message}`);
  } finally {
    enCours = false;
  }
}

function startWhatsappFile() {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
}

/** État de la file pour GET /api/whatsapp/crm/etat. */
async function etatFile() {
  let compteurs = { planifies: 0, enAttente: 0, echecs24h: 0, prochain: null };
  if (await crmDisponible()) {
    const [[c]] = await pool.query(
      `SELECT SUM(wam_statut = 'planifie') AS planifies, SUM(wam_statut = 'en_attente') AS enAttente,
              SUM(wam_statut = 'echec' AND wam_updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS echecs24h,
              MIN(CASE WHEN wam_statut = 'planifie' THEN wam_planifie_le END) AS prochain
         FROM delevery_whatsapp_message WHERE wam_direction = 'sortant'`
    );
    compteurs = {
      planifies: Number(c?.planifies) || 0,
      enAttente: Number(c?.enAttente) || 0,
      echecs24h: Number(c?.echecs24h) || 0,
      prochain: c?.prochain || null
    };
  }
  return { ...etat, ...compteurs, actif: Boolean(timer) };
}

/** Annule un envoi planifié (→ 'echec' « annule »). */
async function annulerEnvoi(id) {
  const [r] = await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_statut = 'echec', wam_erreur_code = 'annule', wam_erreur_message = 'Annulé par un employé.', wam_updated_at = NOW()
      WHERE wam_id = ? AND wam_direction = 'sortant' AND wam_statut = 'planifie'`,
    [Number(id)]
  );
  return r.affectedRows > 0;
}

/** Remet un envoi en échec dans la file (tentatives à zéro, envoi au prochain tick). */
async function renvoyerEnvoi(id) {
  const [r] = await pool.query(
    `UPDATE delevery_whatsapp_message
        SET wam_statut = 'planifie', wam_tentatives = 0, wam_planifie_le = NOW(),
            wam_erreur_code = NULL, wam_erreur_message = NULL, wam_updated_at = NOW()
      WHERE wam_id = ? AND wam_direction = 'sortant' AND wam_statut = 'echec'`,
    [Number(id)]
  );
  return r.affectedRows > 0;
}

module.exports = { startWhatsappFile, etatFile, annulerEnvoi, renvoyerEnvoi };
