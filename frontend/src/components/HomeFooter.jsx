import { Link } from 'react-router-dom';
import { BRAND, HOME_INFO } from '../config/brand';
import '../accueil.css';

/**
 * Pied de page des pages publiques (accueil, tarifs, pages légales), styles
 * dans src/accueil.css. Sur la page d'accueil, passer `scrollTo` pour que les
 * liens d'ancres défilent en douceur ; ailleurs ils naviguent vers la page
 * d'accueil (`/#section`, gérée au montage de Home).
 */
export default function HomeFooter({ scrollTo }) {
  const anchor = (id, label) =>
    scrollTo ? (
      <a href={`#${id}`} onClick={scrollTo(id)}>
        {label}
      </a>
    ) : (
      <Link to={`/#${id}`}>{label}</Link>
    );

  return (
    <footer className="oe-footer">
      <div className="oe-wrap">
        <div className="oe-footer-cta">
          <div>
            <h2>جاهز لتوصيل أول طرد؟</h2>
            <p>أنشئ حسابك في دقائق وابدأ الشحن مع {BRAND.nameAr}.</p>
          </div>
          <div className="oe-footer-cta-btns">
            <Link to="/register" className="oe-btn oe-btn-red">
              أنشئ حسابك <i className="fa fa-arrow-left" />
            </Link>
            <Link to="/login" className="oe-btn oe-btn-ghost">
              <i className="fa fa-user" /> دخول العملاء
            </Link>
          </div>
        </div>

        <div className="oe-footer-grid">
          <div className="oe-footer-about">
            <h3>{BRAND.nameAr}</h3>
            <p>
              {BRAND.nameAr} شركة متخصصة في خدمات التوصيل واللوجستيك، تقدم حلول النقل والاستلام والتخزين في جميع
              أرجاء المغرب.
            </p>
            <div className="oe-footer-social">
              <a href={HOME_INFO.fb} target="_blank" rel="noopener noreferrer" aria-label="Facebook" title="Facebook">
                <i className="fab fa-facebook-f" />
              </a>
              <a href={HOME_INFO.insta} target="_blank" rel="noopener noreferrer" aria-label="Instagram" title="Instagram">
                <i className="fab fa-instagram" />
              </a>
              <a href={HOME_INFO.yt} target="_blank" rel="noopener noreferrer" aria-label="YouTube" title="YouTube">
                <i className="fab fa-youtube" />
              </a>
            </div>
          </div>

          <div>
            <h3>روابط سريعة</h3>
            <ul className="oe-footer-links">
              <li>{anchor('hero', 'الرئيسية')}</li>
              <li>{anchor('services', 'خدماتنا')}</li>
              <li>{anchor('how-it-works', 'كيف يعمل')}</li>
              <li>
                <Link to="/tarifs">الأسعار</Link>
              </li>
              <li>{anchor('contact', 'اتصل بنا')}</li>
            </ul>
          </div>

          <div>
            <h3>حسابك</h3>
            <ul className="oe-footer-links">
              <li>
                <Link to="/register">إنشاء حساب</Link>
              </li>
              <li>
                <Link to="/login">دخول العملاء</Link>
              </li>
              <li>
                <Link to="/contrat">عقد الخدمة</Link>
              </li>
              <li>
                <Link to="/conditions-utilisation">شروط الاستخدام</Link>
              </li>
            </ul>
          </div>

          <div>
            <h3>تواصل معنا</h3>
            <ul className="oe-footer-contact">
              <li>
                <i className="fa fa-location-dot" />
                <span>{HOME_INFO.adresse}</span>
              </li>
              <li>
                <i className="fa fa-phone" />
                <a href={`tel:${HOME_INFO.phone}`}>
                  <bdi dir="ltr">{HOME_INFO.phone}</bdi>
                </a>
              </li>
              <li>
                <i className="fab fa-whatsapp" />
                <a href={`https://wa.me/${HOME_INFO.whatsapp}`} target="_blank" rel="noopener noreferrer">
                  واتساب <bdi dir="ltr">{HOME_INFO.whatsapp}</bdi>
                </a>
              </li>
              <li>
                <i className="fa fa-envelope" />
                <a href={`mailto:${HOME_INFO.email}`}>
                  <bdi dir="ltr">{HOME_INFO.email}</bdi>
                </a>
              </li>
              <li>
                <i className="fa fa-clock" />
                <span>{HOME_INFO.horaires}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="oe-footer-mark" aria-hidden="true">
        {BRAND.logoText.main} <em>{BRAND.logoText.sub}</em>
      </div>

      <div className="oe-wrap oe-footer-bottom">
        <span>
          © {new Date().getFullYear()} {BRAND.nameAr} — جميع الحقوق محفوظة
        </span>
        <span className="oe-footer-legal">
          <Link to="/mentions-legales">الإشارات القانونية</Link>
          <Link to="/conditions-utilisation">شروط الاستخدام</Link>
        </span>
      </div>
    </footer>
  );
}
