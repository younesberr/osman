import { AlertTriangle } from 'lucide-react';
import { fraisMontant, formatDh } from '../utils/fraisMontant';

/**
 * Notification « frais supplémentaires ajoutés » des formulaires colis
 * (Nouveau colis client / admin, modales de modification) : affichée
 * seulement si l'option « Frais selon le montant » du client est active et si
 * le montant saisi dépasse le seuil (2 500 DH). `regle` = bloc `frais_montant`
 * de l'API ({ actif, seuil, montant }) ; `livraison` (frais de livraison de
 * la ville, facultatif) → total livraison + frais supp affiché.
 */
export default function FraisMontantNotice({ price, regle, livraison = null, className = '' }) {
  const frais = fraisMontant(price, regle);
  if (!frais) return null;
  const seuil = formatDh(regle.seuil);
  return (
    <div className={`frais-montant-notice ${className}`.trim()} role="status">
      <AlertTriangle size={15} />
      <span>
        <strong>Frais supplémentaires ajoutés : +{formatDh(frais)} DH.</strong> Colis avec un montant
        supérieur à {seuil} DH ({formatDh(regle.montant)} DH par tranche de {seuil} DH).
        {livraison !== null && Number.isFinite(Number(livraison)) && (
          <> Frais de livraison + frais supplémentaires : {formatDh(Number(livraison) + frais)} DH.</>
        )}
      </span>
    </div>
  );
}
