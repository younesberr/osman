import { Banknote, Lock, MapPin, MessageSquare, Phone, PhoneCall, RefreshCw, Route, User } from 'lucide-react';
import {
  statutLabel,
  STATUT_ATTENTE_REEXPEDITION,
  STATUT_ATTENTE_CONFIRMATION
} from '../utils/statuts';

/*
 * Carte d'un colis du dashboard livreur : vue mobile de la liste des colis
 * (/livreur/colis) et résultat du scan de la page « Changer statut par scan »
 * (/livreur/changer-statut). Les aides d'affichage (montant, badge statut,
 * consignes) et les liens WhatsApp / appel sont exportées pour la ligne du
 * tableau (ColisRow) de la liste. Styles : classes .lvc-card* (styles.css),
 * indépendantes de la bascule tableau ↔ cartes (.lvc-cards).
 */

/** Numéro marocain "06…" → format international WhatsApp "2126…" (wa.me). */
function waPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `212${digits.slice(1)}` : digits;
}

/* Modèle de repli si le serveur ne répond pas — même défaut que le backend
 * (Configuration > Options > Message WhatsApp livreur). */
const WA_TEMPLATE_DEFAUT =
  'Bonjour {destinataire}, je suis le livreur ORTALOG. J’ai un colis pour vous : {code} ({magasin}), montant à régler : {crbt}. Adresse : {adresse}, {ville}. Merci de me confirmer votre disponibilité.';

/** Balises du modèle admin → valeurs du colis. */
function waMessage(parcel, template) {
  const valeurs = {
    destinataire: parcel.parcel_receiver || '',
    code: parcel.parcel_code || '',
    magasin: parcel.magasin || '',
    crbt: formatDh(parcel.crbt),
    adresse: parcel.adresse || '',
    ville: parcel.ville || ''
  };
  return (template || WA_TEMPLATE_DEFAUT).replace(/\{(\w+)\}/g, (balise, cle) =>
    cle in valeurs ? valeurs[cle] : balise
  );
}

/** Message WhatsApp prérempli : le livreur contacte le destinataire du colis. */
export function waUrl(parcel, template) {
  return `https://wa.me/${waPhone(parcel.parcel_phone)}?text=${encodeURIComponent(
    waMessage(parcel, template)
  )}`;
}

/** Appel WhatsApp : ouvre la conversation (sans texte) — l'appel se lance
 * depuis WhatsApp, qui n'offre pas de lien direct de mise en relation. */
export function waCallUrl(parcel) {
  return `https://wa.me/${waPhone(parcel.parcel_phone)}`;
}

/** Statuts pour lesquels on affiche la date programmée sous le badge. */
const STATUTS_AVEC_DATE = ['POSTPONED', 'PROGRAMMER'];

/** Vrai si le statut du colis est verrouillé pour le livreur : « Attente
 * réexpédition » (colis à réexpédier par un bon d'envoi) ou « Attente
 * confirmation » (colis scanné sans adresse en agence), posés par
 * l'administration — le colis reste dans sa tournée (visible), mais le bouton
 * « Changer statut » est désactivé (le serveur refuse aussi, 403). */
export function statutVerrouille(parcel) {
  return (
    parcel?.statut === STATUT_ATTENTE_REEXPEDITION ||
    parcel?.statut === STATUT_ATTENTE_CONFIRMATION
  );
}

export const VERROU_TITRE =
  "Statut verrouillé par l'administration (attente réexpédition / attente confirmation)";

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → affichage "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value.trim();
}

/** Montant en dirhams, format français. */
export function formatDh(value) {
  return `${(Number(value) || 0).toLocaleString('fr-FR')} DH`;
}

/** Badge du statut effectif (+ date programmée dessous le cas échéant). */
export function StatutColis({ parcel }) {
  return (
    <>
      <span
        className="badge"
        style={parcel.statut_color ? { background: parcel.statut_color } : undefined}
      >
        {statutLabel(parcel.statut)}
      </span>
      {STATUTS_AVEC_DATE.includes(parcel.statut) && formatReportDate(parcel.report_time) && (
        <div className="cell-sub">{formatReportDate(parcel.report_time)}</div>
      )}
    </>
  );
}

/** Consignes du colis : interdictions (ouvrir / essayer) + colis à remplacer. */
export function FlagsColis({ parcel }) {
  const interdits = [];
  if (Number(parcel.parcel_open) !== 1) interdits.push("Interdit d'ouvrir");
  if (Number(parcel.parcel_essayage) !== 1) interdits.push('Interdit essayage');
  const remplacer = Number(parcel.parcel_replace) === 1;
  if (interdits.length === 0 && !remplacer) return null;
  return (
    <span className="lvc-flags">
      {interdits.map((label) => (
        <span key={label} className="badge badge-type badge-interdit">
          {label}
        </span>
      ))}
      {remplacer && <span className="badge badge-type badge-remplacer">Colis à remplacer</span>}
    </span>
  );
}

/**
 * Carte d'un colis : code, magasin, badge statut, destinataire + téléphone,
 * adresse, CRBT + consignes, note, puis actions tactiles (appeler, message
 * WhatsApp, appel WhatsApp, détail suivi, changer statut).
 */
export default function ColisCard({ parcel, onSuivi, onStatut, waTemplate }) {
  const phone = parcel.parcel_phone || '';
  const verrouille = statutVerrouille(parcel);
  return (
    <article className="lvc-card">
      <div className="lvc-card-head">
        <div>
          <div className="cell-main mono">{parcel.parcel_code || '—'}</div>
          <div className="cell-sub">{parcel.magasin || '—'}</div>
        </div>
        <div className="lvc-card-badges">
          <StatutColis parcel={parcel} />
        </div>
      </div>

      <div className="lvc-card-row">
        <User size={15} />
        <span>
          {parcel.parcel_receiver || '—'}
          {phone && (
            <a className="lvc-card-phone mono" href={`tel:${phone}`}>
              {phone}
            </a>
          )}
        </span>
      </div>
      <div className="lvc-card-row">
        <MapPin size={15} />
        <span>
          {parcel.adresse || '—'}
          {parcel.ville ? ` — ${parcel.ville}` : ''}
          {parcel.zone ? ` (${parcel.zone})` : ''}
        </span>
      </div>
      <div className="lvc-card-row">
        <Banknote size={15} />
        <span>
          <span className="lvc-crbt">{formatDh(parcel.crbt)}</span>
          <FlagsColis parcel={parcel} />
        </span>
      </div>
      {parcel.parcel_note && (
        <div className="lvc-card-row">
          <MessageSquare size={15} />
          <span>{parcel.parcel_note}</span>
        </div>
      )}
      {verrouille && (
        <div className="lvc-card-row lvc-verrou">
          <Lock size={15} />
          <span>{VERROU_TITRE} : remettez ce colis à l'agence.</span>
        </div>
      )}

      <div className="lvc-card-actions">
        {phone && (
          <>
            <a
              className="btn lvc-action-ico lvc-action-tel"
              href={`tel:${phone}`}
              title="Appeler"
              aria-label="Appeler"
            >
              <Phone size={18} />
            </a>
            <a
              className="btn lvc-action-ico lvc-action-wa btn-whatsapp"
              href={waUrl(parcel, waTemplate)}
              target="_blank"
              rel="noopener noreferrer"
              title="Message WhatsApp"
              aria-label="Message WhatsApp"
            >
              <i className="fab fa-whatsapp" />
            </a>
            <a
              className="btn lvc-action-ico lvc-action-wa"
              href={waCallUrl(parcel)}
              target="_blank"
              rel="noopener noreferrer"
              title="Appel WhatsApp"
              aria-label="Appel WhatsApp"
            >
              <PhoneCall size={18} />
            </a>
          </>
        )}
        <button
          type="button"
          className="btn lvc-action-ico lvc-action-suivi"
          onClick={() => onSuivi(parcel)}
          title="Détail suivi"
          aria-label="Détail suivi"
        >
          <Route size={18} />
        </button>
        <button
          type="button"
          className="btn btn-primary lvc-action-ico"
          onClick={() => onStatut(parcel)}
          disabled={verrouille}
          title={verrouille ? VERROU_TITRE : 'Changer statut'}
          aria-label={verrouille ? VERROU_TITRE : 'Changer statut'}
        >
          {verrouille ? <Lock size={18} /> : <RefreshCw size={18} />}
        </button>
      </div>
    </article>
  );
}
