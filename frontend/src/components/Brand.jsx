import { usePlatform } from '../context/PlatformContext';
import { BRAND } from '../config/brand';

/**
 * Marque de la plateforme : affiche le logo uploadé (page Plateforme)
 * ou, à défaut, le monogramme + le nom de la marque (config/brand.js).
 */
export default function Brand({ className = '' }) {
  const { config } = usePlatform();

  return (
    <span className={`brand ${className}`}>
      {config.logo ? (
        <img src={config.logo} alt={BRAND.name} className="brand-logo" />
      ) : (
        <>
          <span className="brand-mark">{BRAND.monogram}</span>
          <span className="brand-name">{BRAND.name}</span>
        </>
      )}
    </span>
  );
}
