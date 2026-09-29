import { Link } from 'react-router-dom';
import '../home.css';

/**
 * Page publique vierge (register, tarifs, mentions légales, contrat,
 * conditions d'utilisation) : navbar simplifiée de l'ancien site
 * (ws_header_page) + message « à développer plus tard ».
 */
export default function PublicPlaceholder({ title }) {
  return (
    <div className="home-ar" dir="rtl" lang="ar">
      <nav className="navbar-custom">
        <div className="container page-nav-inner">
          <Link to="/" className="btn-nav-solid">
            <i className="fa fa-home" /> الرئيسية
          </Link>
          <Link to="/" className="navbar-brand">
            <img className="logo-header" src="/home/header-logo.png" width="780" height="220" alt="أورطالوج" />
          </Link>
        </div>
      </nav>

      <div className="placeholder-body">
        <div className="placeholder-card">
          <div className="placeholder-icon">
            <i className="fa fa-screwdriver-wrench" />
          </div>
          <h1>{title}</h1>
          <p>
            هذه الصفحة قيد الإنجاز — سيتم تطويرها لاحقاً.
            <br />
            (Page à développer plus tard)
          </p>
          <Link to="/" className="btn-hero-primary">
            <i className="fa fa-arrow-right" /> العودة إلى الرئيسية
          </Link>
        </div>
      </div>
    </div>
  );
}
