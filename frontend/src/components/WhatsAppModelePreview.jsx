import { ExternalLink, Phone, Reply } from 'lucide-react';
import { rendreSegments, segmentsMiseEnForme } from '../utils/whatsappModele';

/*
 * Aperçu façon WhatsApp d'un modèle de message (en-tête, corps rendu avec les
 * paramètres, pied de page, boutons). Les variables non remplies restent
 * surlignées ({{n}}). Utilisé par la page Modèles, la modale de règle, le
 * compositeur des discussions et la modale d'envoi depuis un colis.
 */

function MiseEnForme({ texte }) {
  return segmentsMiseEnForme(texte).map((s, i) => {
    if (s.style === 'b') return <strong key={i}>{s.texte}</strong>;
    if (s.style === 'i') return <em key={i}>{s.texte}</em>;
    if (s.style === 's') return <s key={i}>{s.texte}</s>;
    return <span key={i}>{s.texte}</span>;
  });
}

export default function WhatsAppModelePreview({ modele, params = [], texte, heure = '14:32', compact = false }) {
  if (!modele && !texte) return null;
  const segments = modele ? rendreSegments(modele.corps, params) : [{ type: 'texte', valeur: texte }];
  const boutons = modele?.boutons || [];
  return (
    <div className={`wa-preview ${compact ? 'wa-preview-compact' : ''}`}>
      <div className="wa-preview-bubble">
        {modele?.entete && <div className="wa-preview-entete">{modele.entete}</div>}
        <div className="wa-preview-corps">
          {segments.map((seg, i) =>
            seg.type === 'var' ? (
              seg.valeur == null ? (
                <mark key={i} className="wa-var">{`{{${seg.n}}}`}</mark>
              ) : (
                <span key={i} className="wa-var-valeur">
                  <MiseEnForme texte={seg.valeur} />
                </span>
              )
            ) : (
              <MiseEnForme key={i} texte={seg.valeur} />
            )
          )}
        </div>
        {modele?.pied && <div className="wa-preview-pied">{modele.pied}</div>}
        <div className="wa-preview-heure">{heure} ✓✓</div>
        {boutons.length > 0 && (
          <div className="wa-preview-btns">
            {boutons.map((b, i) => (
              <div key={i}>
                {b.type === 'URL' ? <ExternalLink size={14} /> : b.type === 'PHONE_NUMBER' ? <Phone size={14} /> : <Reply size={14} />}
                {b.texte}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
