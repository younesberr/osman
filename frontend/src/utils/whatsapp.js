/*
 * Helpers des pages API liaison (WhatsApp Business Cloud API de Meta) :
 * configuration, guide, journal et CRM (discussions, modèles, actions
 * automatiques, statistiques). URL du webhook, jeton de vérification,
 * libellés des statuts (journal, modèles Meta, discussions), formats.
 */

/** Chemin du webhook côté backend (routes/whatsapp.routes.js). */
export const WEBHOOK_PATH = '/api/whatsapp/webhook';

/** URL de rappel complète pour une origine (« https://ortalog.ma » → « …/api/whatsapp/webhook »). */
export function urlWebhook(origine) {
  return `${String(origine || '').trim().replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}

/** Jeton de vérification du webhook : 48 caractères hexadécimaux aléatoires (généré dans le navigateur). */
export function genererVerifyToken() {
  const octets = new Uint8Array(24);
  crypto.getRandomValues(octets);
  return Array.from(octets, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** ISO → « 05/09/2026 14:32 » (chaîne d'origine si invalide). */
export function formatDateHeure(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

/** ISO → « 14:32 » si aujourd'hui, sinon « 05/09 14:32 » (année ajoutée si différente). */
export function formatHeureCourte(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return heure;
  const jour = d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  });
  return `${jour} ${heure}`;
}

/** Libellé du jour d'un message (séparateurs du fil) : « Aujourd'hui », « Hier », sinon date longue. */
export function formatJour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hier = new Date();
  hier.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === hier.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Secondes → « 3 h 12 » / « 45 min » / « < 1 min ». */
export function formatDuree(secondes) {
  const s = Math.max(0, Number(secondes) || 0);
  if (s < 60) return '< 1 min';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

/** « 212612345678 » → « +212 6 12 34 56 78 » (autres formats : préfixe « + » seulement). */
export function formatPhoneInternational(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (/^212\d{9}$/.test(d)) {
    return `+212 ${d[3]} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)} ${d.slice(10, 12)}`;
  }
  return d ? `+${d}` : '';
}

/** Lien « ouvrir dans WhatsApp » d'un numéro (E.164 ou 06…). */
export function waMeLink(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) d = `212${d.slice(1)}`;
  return d ? `https://wa.me/${d}` : '';
}

/** Qualité du numéro / d'un modèle renvoyée par Meta → libellé + classe de badge. */
export const QUALITE = {
  GREEN: ['Bonne', 'badge-active'],
  YELLOW: ['Moyenne', 'badge-attente'],
  RED: ['Faible', 'badge-inactive'],
  UNKNOWN: ['Inconnue', 'badge-neutral'],
  NA: ['Non évaluée', 'badge-neutral']
};

/** Statuts du journal (wam_statut) → libellé + classe de badge. */
export const STATUTS = {
  planifie: { label: 'Planifié', cls: 'badge-attente' },
  en_attente: { label: 'En attente', cls: 'badge-attente' },
  envoye: { label: 'Envoyé', cls: 'badge-wa-envoye' },
  remis: { label: 'Remis', cls: 'badge-active' },
  lu: { label: 'Lu', cls: 'badge-wa-lu' },
  echec: { label: 'Échec', cls: 'badge-wa-echec' },
  recu: { label: 'Reçu', cls: 'badge-wa-entrant' },
  note: { label: 'Note interne', cls: 'badge-neutral' }
};

export const DIRECTIONS = { sortant: 'Sortant', entrant: 'Entrant', note: 'Note interne' };

/** Statut d'un modèle chez Meta → libellé + classe de badge. */
export const STATUTS_META = {
  APPROVED: { label: 'Approuvé', cls: 'badge-active' },
  PENDING: { label: 'En attente', cls: 'badge-attente' },
  REJECTED: { label: 'Refusé', cls: 'badge-inactive' },
  PAUSED: { label: 'En pause', cls: 'badge-wa-envoye' },
  DISABLED: { label: 'Désactivé', cls: 'badge-neutral' },
  IN_APPEAL: { label: 'En appel', cls: 'badge-attente' },
  PENDING_DELETION: { label: 'Suppression en cours', cls: 'badge-neutral' },
  DELETED: { label: 'Supprimé', cls: 'badge-neutral' },
  SUPPRIME_META: { label: 'Absent chez Meta', cls: 'badge-neutral' }
};

export const CATEGORIES = { UTILITY: 'Utilitaire', MARKETING: 'Marketing', AUTHENTICATION: 'Authentification' };

/** Type de contact d'une discussion (wac_type_contact). */
export const TYPES_CONTACT = {
  destinataire: 'Destinataire',
  client: 'Client',
  livreur: 'Livreur',
  employe: 'Employé',
  inconnu: 'Inconnu'
};

/** Statut d'une discussion (wac_statut). */
export const STATUTS_CONVERSATION = {
  nouveau: { label: 'Nouvelle', cls: 'badge-chat-nonlu' },
  en_cours: { label: 'En cours', cls: 'badge-chat-encours' },
  termine: { label: 'Terminée', cls: 'badge-chat-termine' }
};

/** Libellé lisible d'un modèle (nom · langue). */
export function libelleModele(m) {
  return m ? `${m.nom} · ${m.langue}` : '';
}

/** Demande un rafraîchissement des badges de la sidebar (AdminLayout écoute cet événement). */
export function rafraichirCompteurs() {
  window.dispatchEvent(new Event('ortalog:compteurs'));
}
