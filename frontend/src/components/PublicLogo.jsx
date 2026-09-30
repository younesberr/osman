import { BRAND } from '../config/brand';

/** Logo des pages publiques (navbar, footer, pages légales, inscription). */
export default function PublicLogo({ className = 'logo-header' }) {
  return (
    <img
      className={className}
      src={BRAND.logo.src}
      width={BRAND.logo.width}
      height={BRAND.logo.height}
      alt={BRAND.logo.alt}
    />
  );
}
