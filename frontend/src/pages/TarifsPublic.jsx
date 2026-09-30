import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import HomeFooter from '../components/HomeFooter';
import SearchableSelect from '../components/SearchableSelect';
import '../home.css';
import PublicLogo from '../components/PublicLogo';

/**
 * Page tarifs publique — même design que la page « tarifs » de l'ancien site
 * PHP (ancien site PHP), avec la logique de la saisie des colis :
 * la liste déroulante propose les villes de ramassage de la matrice tarifaire,
 * et le tableau affiche pour la ville choisie les tarifs de la matrice puis,
 * en second, les tarifs par défaut (delevery_tarifs) des villes absentes de
 * la matrice pour ce ramassage.
 */

/** Normalisation arabe pour la recherche (mêmes règles que l'ancien site). */
function normalizeAr(str) {
  return String(str)
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ٟ]/g, '');
}

/** Badge de prix : « مجاني » si 0, sinon le montant en dirhams. */
function PriceBadge({ value, kind }) {
  if (!value) {
    return <span className="badge-price free">مجاني</span>;
  }
  return (
    <span className={`badge-price ${kind}`}>
      {value} <small>درهم</small>
    </span>
  );
}

export default function TarifsPublic() {
  const [villes, setVilles] = useState([]);
  const [pickup, setPickup] = useState('');
  const [rows, setRows] = useState(null); // null = aucune ville choisie
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Villes de ramassage de la matrice tarifaire.
  useEffect(() => {
    api
      .get('/public/tarifs/villes')
      .then(({ data }) => setVilles(data))
      .catch(() => setError('تعذّر تحميل قائمة المدن. يرجى إعادة تحميل الصفحة.'));
  }, []);

  // Tarifs de la ville de ramassage choisie (matrice + tarifs par défaut).
  useEffect(() => {
    if (!pickup) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setQuery('');
    setPage(1);
    api
      .get('/public/tarifs', { params: { pickup } })
      .then(({ data }) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setError('خطأ في الاتصال بالخادم.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickup]);

  // Tri du moins cher au plus cher (prix de livraison, puis prix de retour, puis nom).
  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort(
      (a, b) =>
        a.livraison - b.livraison ||
        a.retour - b.retour ||
        a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' })
    );
  }, [rows]);

  const filtered = useMemo(() => {
    const q = normalizeAr(query.trim());
    if (!q) return sorted;
    return sorted.filter((r) => normalizeAr(r.nom).includes(q));
  }, [sorted, query]);

  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // Fenêtre de 5 boutons de page (comme l'ancien site).
  let startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
  const pageButtons = [];
  for (let p = startPage; p <= endPage; p += 1) pageButtons.push(p);

  return (
    <div className="home-ar" dir="rtl" lang="ar">
      <nav className="navbar-custom">
        <div className="container page-nav-inner">
          <Link to="/" className="btn-nav-solid">
            <i className="fa fa-home" /> الرئيسية
          </Link>
          <Link to="/" className="navbar-brand">
            <PublicLogo className="logo-header" />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <div className="tarifs-hero">
        <div className="container">
          <div className="tarifs-hero-badge">
            <i className="fa fa-table" /> جدول الأسعار
          </div>
          <h1>أسعار التوصيل والإرجاع</h1>
          <p>اختر مدينة الاستلام (الرامساج) لعرض أسعار التوصيل إلى جميع المدن</p>
        </div>
      </div>

      <section className="tarifs-section">
        <div className="container">
          {/* Sélection ville de ramassage */}
          <div className="pickup-card">
            <label>
              <i className="fa fa-map-marker-alt icon-accent" /> مدينة الاستلام (الرامساج)
            </label>
            <div className="pickup-row">
              <SearchableSelect
                className="pickup-select-wrap"
                value={pickup}
                onChange={setPickup}
                options={villes.map((v) => ({ value: v.id, label: v.nom }))}
                placeholder="— اختر مدينة الاستلام —"
                searchPlaceholder="ابحث عن مدينة..."
                emptyText="لا توجد نتائج مطابقة"
              />
              {rows && <span className="pickup-info">({rows.length} مدينة)</span>}
            </div>
          </div>

          {error && <div className="alert alert-danger">{error}</div>}

          {/* Tableau des tarifs */}
          <div className="tarifs-table-wrap">
            {rows && !loading && (
              <div className="table-search-bar">
                <div className="table-search-input">
                  <i className="fa fa-search search-icon" />
                  <input
                    type="text"
                    placeholder="ابحث عن مدينة توصيل..."
                    autoComplete="off"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="table-perpage">
                  <label htmlFor="perPageSelect">صفوف في الصفحة:</label>
                  <select
                    id="perPageSelect"
                    className="perpage-select"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>
            )}

            {!rows && !loading && (
              <div className="empty-state">
                <i className="fa fa-map-location-dot" />
                <p>اختر مدينة الاستلام من القائمة أعلاه لعرض الأسعار</p>
              </div>
            )}

            {loading && (
              <div className="track-spinner" style={{ padding: '48px 0' }}>
                <div className="spinner-border" role="status" aria-label="جاري التحميل..." />
              </div>
            )}

            {rows && !loading && (
              <div className="tarifs-scroll">
                <table className="tarifs-table">
                  <thead>
                    <tr>
                      <th>
                        <i className="fa fa-city" /> مدينة التوصيل
                      </th>
                      <th>
                        <i className="fa fa-truck" /> سعر التوصيل
                      </th>
                      <th>
                        <i className="fa fa-rotate-left" /> سعر الإرجاع
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 ? (
                      <tr>
                        <td colSpan={3}>
                          <div className="empty-state">
                            <i className="fa fa-inbox" />
                            <p>لا توجد نتائج مطابقة</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      pageRows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.nom}</td>
                          <td>
                            <PriceBadge value={r.livraison} kind="livraison" />
                          </td>
                          <td>
                            <PriceBadge value={r.retour} kind="retour" />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {rows && !loading && totalPages > 1 && (
              <div className="tarifs-pagination">
                <span className="pagination-info">
                  {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} من{' '}
                  {total} مدينة
                </span>
                <div className="pagination-controls">
                  <button
                    type="button"
                    className="page-btn"
                    disabled={currentPage === 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    <i className="fa fa-chevron-right" />
                  </button>
                  {pageButtons.map((p) => (
                    <button
                      type="button"
                      key={p}
                      className={`page-btn${p === currentPage ? ' active' : ''}`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="page-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    <i className="fa fa-chevron-left" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="tarifs-note">
            <i className="fa fa-circle-info" /> الأسعار المعروضة بالدرهم المغربي (MAD) وقابلة
            للتفاوض حسب الحجم والتعاقد. للحصول على عرض سعر مخصص،{' '}
            <Link to="/#contact">تواصل معنا</Link>.
          </div>
        </div>
      </section>

      <HomeFooter />
    </div>
  );
}
