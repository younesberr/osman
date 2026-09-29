const { createDemandesPeriodiques } = require('../controllers/demandesRamassage.controller');

/*
 * Déclencheur des demandes de ramassage périodiques (fiche client, section
 * "Ramassage", colonne customers_ramassage_jours) : chaque jour à 12h00
 * (heure du serveur), une demande automatique est créée pour les clients dont
 * les jours de ramassage incluent le jour courant, sans action du client ni
 * de l'admin. Vérification chaque minute ; un serveur (re)démarré après 12h00
 * rattrape le déclenchement du jour — sans doublon : createDemandesPeriodiques
 * est idempotente (au plus une demande périodique par client et par jour).
 */

const HEURE_DECLENCHEMENT = 12;

let dernierJour = ''; // 'AAAA-MM-JJ' du dernier déclenchement (mémoire process)

async function tick() {
  const now = new Date();
  if (now.getHours() < HEURE_DECLENCHEMENT) return;
  const pad = (n) => String(n).padStart(2, '0');
  const jour = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (jour === dernierJour) return;
  dernierJour = jour;
  await createDemandesPeriodiques(now);
}

function startRamassagePeriodique() {
  tick();
  setInterval(tick, 60 * 1000);
}

module.exports = { startRamassagePeriodique };
