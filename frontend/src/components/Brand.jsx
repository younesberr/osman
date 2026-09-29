import { usePlatform } from '../context/PlatformContext';

/**
 * Marque de la plateforme : affiche le logo uploadé (page Plateforme)
 * ou, à défaut, le monogramme « O » + ORTALOG.
 */
export default function Brand({ className = '' }) {
  const { config } = usePlatform();

  return (
    <span className={`brand ${className}`}>
      {config.logo ? (
        <img src={config.logo} alt="ORTALOG" className="brand-logo" />
      ) : (
        <>
          <span className="brand-mark">O</span>
          <span className="brand-name">ORTALOG</span>
        </>
      )}
    </span>
  );
}
