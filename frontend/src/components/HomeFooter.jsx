import { Link } from 'react-router-dom';
import { BRAND, HOME_INFO } from '../config/brand';
import PublicLogo from './PublicLogo';

/**
 * Footer des pages publiques (accueil, tarifs) — identique au ws_footer()
 * de l'ancien site PHP. Sur la page d'accueil, passer `scrollTo` pour que
 * les liens d'ancres défilent en douceur ; ailleurs ils naviguent vers
 * la page d'accueil (`/#section`, gérée au montage de Home).
 */
export default function HomeFooter({ scrollTo }) {
  const anchor = (id, label) =>
    scrollTo ? (
      <a href={`#${id}`} onClick={scrollTo(id)}>{label}</a>
    ) : (
      <Link to={`/#${id}`}>{label}</Link>
    );

  return (
    <footer className="home-footer-ar">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-about">
            <Link to="/">
              <PublicLogo className="footer-logo" />
            </Link>
            <p>
              {BRAND.nameAr} شركة متخصصة في خدمات التوصيل واللوجستيك، تقدم حلول النقل والاستلام والتخزين
              في جميع أرجاء المغرب.
            </p>
            <div className="social-links">
              <a href={HOME_INFO.fb} className="social-btn fb" target="_blank" rel="noopener noreferrer" title="Facebook">
                <i className="fab fa-facebook-f" />
              </a>
              <a href={HOME_INFO.insta} className="social-btn ig" target="_blank" rel="noopener noreferrer" title="Instagram">
                <i className="fab fa-instagram" />
              </a>
              <a href={HOME_INFO.yt} className="social-btn yt" target="_blank" rel="noopener noreferrer" title="YouTube">
                <i className="fab fa-youtube" />
              </a>
            </div>
          </div>

          <div>
            <h6>روابط سريعة</h6>
            <ul className="footer-links">
              <li>{anchor('hero', 'من نحن')}</li>
              <li>{anchor('contact', 'اتصل بنا')}</li>
              <li>{anchor('services', 'خدماتنا')}</li>
              <li>{anchor('how-it-works', 'كيف يعمل')}</li>
              <li>
                <Link to="/mentions-legales">الإشارات القانونية</Link>
              </li>
              <li>
                <Link to="/contrat">عقد الخدمة</Link>
              </li>
              <li>
                <Link to="/register">إنشاء حساب</Link>
              </li>
              <li>
                <Link to="/login">دخول العملاء</Link>
              </li>
            </ul>
          </div>

          <div>
            <h6>تواصل معنا</h6>
            <ul className="footer-contact">
              <li>
                <i className="fa fa-map-marker-alt" />
                {HOME_INFO.adresse}
              </li>
              <li>
                <a href={`tel:${HOME_INFO.phone}`}>
                  <i className="fa fa-phone" /> {HOME_INFO.phone}
                </a>
              </li>
              <li>
                <a href={`https://wa.me/${HOME_INFO.whatsapp}`} target="_blank" rel="noopener noreferrer">
                  <i className="fab fa-whatsapp" /> واتساب {HOME_INFO.whatsapp}
                </a>
              </li>
              <li>
                <a href={`mailto:${HOME_INFO.email}`}>
                  <i className="fa fa-envelope" /> {HOME_INFO.email}
                </a>
              </li>
              <li className="footer-hours">
                <i className="fa fa-clock" />
                {HOME_INFO.horaires}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="footer-bottom">© {new Date().getFullYear()} {BRAND.nameAr} — جميع الحقوق محفوظة</div>
    </footer>
  );
}
