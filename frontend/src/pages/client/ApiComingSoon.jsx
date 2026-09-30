import { Link } from 'react-router-dom';
import { BRAND } from '../../config/brand';
import { ShoppingCart, Store, BookOpen } from 'lucide-react';

/*
 * Menu client « API liaison » : pages WooCommerce (/client/api/woocommerce) et
 * Shopify (/client/api/shopify), en attendant les connecteurs. Simple mention
 * « Coming soon » + renvoi vers la documentation API (/client/api/documentation)
 * pour connecter la boutique dès maintenant.
 */

const PLATFORMS = {
  woocommerce: {
    name: 'WooCommerce',
    Icon: ShoppingCart,
    color: '#7f54b3',
    desc: `Vos commandes WooCommerce seront synchronisées automatiquement en colis ${BRAND.name}, avec le suivi des statuts dans votre boutique.`
  },
  shopify: {
    name: 'Shopify',
    Icon: Store,
    color: '#5e8e3e',
    desc: `Vos commandes Shopify seront synchronisées automatiquement en colis ${BRAND.name}, avec le suivi des statuts dans votre boutique.`
  }
};

export default function ApiComingSoon({ platform }) {
  const p = PLATFORMS[platform];
  if (!p) return null;
  const Icon = p.Icon;

  return (
    <div className="coming-soon">
      <div className="coming-soon-card">
        <div className="coming-soon-icon" style={{ background: p.color }}>
          <Icon size={34} />
        </div>
        <span className="coming-soon-eyebrow">Liaison {p.name}</span>
        <h1>Coming soon</h1>
        <p className="coming-soon-sub">Bientôt disponible</p>
        <p>{p.desc}</p>
        <p className="coming-soon-hint">
          En attendant, vous pouvez déjà connecter votre plateforme grâce à l’API {BRAND.name}.
        </p>
        <Link to="/client/api/documentation" className="btn btn-primary coming-soon-btn">
          <BookOpen size={17} />
          Voir la documentation API
        </Link>
      </div>
    </div>
  );
}
