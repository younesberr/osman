import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api from '../api/client';
import HomeFooter from '../components/HomeFooter';
import PublicLogo from '../components/PublicLogo';
import { BRAND, HOME_INFO } from '../config/brand';
import '../accueil.css';

/**
 * Page d'accueil publique (arabe RTL) : design propre à la marque, styles dans
 * src/accueil.css (police Alexandria, classes oe-). Le suivi de colis appelle
 * l'endpoint public /api/public/track.
 */

const NAV_LINKS = [
  { id: 'hero', label: 'الرئيسية' },
  { id: 'services', label: 'خدماتنا' },
  { id: 'how-it-works', label: 'كيف يعمل' },
  { id: 'rules', label: 'التزاماتنا' },
  // « الأسعار » ouvre la page tarifs directement (pas la section de la page d'accueil).
  { id: 'tarifs', label: 'الأسعار', to: '/tarifs' },
  { id: 'contact', label: 'اتصل بنا' }
];

/** Le premier service occupe la grande tuile de la grille. */
const SERVICES = [
  {
    title: 'توصيل سريع في كل المغرب',
    icon: 'fa-truck-fast',
    text: `بفضل شبكتنا الوطنية المحسّنة، تضمن ${BRAND.nameAr} آجال تسليم قصيرة وموثوقة. أينما كان عملاؤك، نضمن توزيعاً فعّالاً وفي الوقت المحدد.`
  },
  {
    title: 'استلام من طرد واحد',
    icon: 'fa-truck-ramp-box',
    text: 'خدمة استلام مرنة تناسب الأفراد والمحترفين. حتى لطرد واحد، نضمن استلاماً سريعاً وعملياً بدون قيود.'
  },
  {
    title: 'تتبع فوري ولحظي',
    icon: 'fa-location-crosshairs',
    text: 'تتبّع طرودك في أي وقت عبر نظام تتبع دقيق في كل مرحلة لتبقى على علم دائم بحالة شحنتك.'
  },
  {
    title: 'حماية وأمان البضائع',
    icon: 'fa-shield-halved',
    text: 'طرودك محمية من الاستلام حتى التسليم النهائي. معالجة بعناية وتعبئة مطابقة لتجنب أي ضرر.'
  },
  {
    title: 'إرجاع مجاني وسريع',
    icon: 'fa-rotate-left',
    text: 'خدمة إرجاع بسيطة ومجانية مع تتبع متكامل لشفافية كاملة حتى استلام الإرجاع.'
  },
  {
    title: 'خدمة عملاء احترافية',
    icon: 'fa-headset',
    text: 'دعم مخصص متاح للإجابة على جميع أسئلتك بكفاءة، قبل وأثناء وبعد التسليم.'
  },
  {
    title: 'حلول التجارة الإلكترونية',
    icon: 'fa-cart-shopping',
    // Pas de parenthèses autour des noms latins : elles s'inversent au retour à la ligne (bidi).
    text: 'واجهات برمجية جاهزة لربط متجرك على WooCommerce أو Shopify وغيرها، مع مزامنة تلقائية للطلبات والحالات.'
  },
  {
    title: 'خدمة تغليف احترافية',
    icon: 'fa-boxes-stacked',
    text: 'حلول تغليف قوية ومتكيفة مع كل نوع من البضائع لضمان حماية مثلى وتقليل مخاطر التلف.'
  },
  {
    title: 'تخزين البضائع في المستودع',
    icon: 'fa-warehouse',
    text: 'فضاء تخزين آمن لحماية منتجاتك بكل ثقة. حلول قصيرة أو متوسطة الأمد حسب احتياجاتك.'
  }
];

const STEPS = [
  {
    icon: 'fa-file-pen',
    title: 'سجّل شحنتك',
    text: 'أنشئ حسابك وسجّل طلبات التوصيل عبر لوحة التحكم بسهولة تامة في دقائق.'
  },
  {
    icon: 'fa-box',
    title: 'نستلم البضاعة',
    text: 'يتوجه سائقنا إليك ويستلم الطرود بعناية وينقلها إلى مستودعاتنا بأمان.'
  },
  {
    icon: 'fa-house-user',
    title: 'نوصّل للزبون',
    text: 'يصل الطرد إلى وجهته في أسرع وقت مع إشعار للزبون وتأكيد التسليم فوراً.'
  },
  {
    icon: 'fa-money-bill-wave',
    title: 'تستلم أموالك',
    text: 'تحصيل مبالغ الدفع عند الاستلام وتحويلها إليك في أقصر الآجال بشفافية كاملة.'
  }
];

const RULES = [
  {
    icon: 'fa-hand-holding-dollar',
    title: 'تعويض سريع وشفاف',
    text: 'تتم معالجة التعويضات بسرعة بعد التحقق من الضياع أو التلف أو الخطأ — دون تعقيدات أو إجراءات مطوّلة.'
  },
  {
    icon: 'fa-file-lines',
    title: 'الوثائق المحاسبية',
    text: 'توفير الوثائق والمستندات التبريرية عند الطلب لضمان التتبع الكامل والمطابقة الإدارية.'
  },
  {
    icon: 'fa-file-contract',
    title: 'عقد الخدمة',
    text: 'يُقترح عقد واضح على كل عميل يُحدّد المسؤوليات والضمانات وشروط الخدمة بالكامل.'
  },
  {
    icon: 'fa-ban',
    alert: true,
    title: 'المنتجات الممنوعة',
    text: `يُحظر إرسال المواد المحظورة قانوناً. تتبرأ ${BRAND.nameAr} من أي مسؤولية عن هذه الشحنات.`
  },
  {
    icon: 'fa-box-open',
    title: 'تعبئة جيدة وسليمة',
    text: 'يجب تعبئة كل طرد بشكل صحيح لضمان الحماية والسلامة التامة أثناء النقل.'
  },
  {
    icon: 'fa-comments',
    title: 'تواصل فوري وسريع',
    text: `أبلغوا ${BRAND.nameAr} فوراً عند أي تغيير أو مشكلة لتحسين عملية التسليم وتجنب التأخير.`
  }
];

const PRICING = [
  {
    icon: 'fa-calculator',
    title: 'أسعار مرنة',
    text: 'تتفاوت الأسعار حسب عدد الطرود والوزن والوجهة والخيارات المُختارة.'
  },
  {
    icon: 'fa-file-invoice-dollar',
    title: 'عرض أسعار مخصص',
    text: 'تواصل معنا للحصول على عرض أسعار يتناسب تماماً مع حجم أعمالك.'
  },
  {
    icon: 'fa-phone',
    title: 'دعم التسعير',
    text: 'فريقنا يساعدك في اختيار الحل الأكثر اقتصادية المناسب لطبيعة شحناتك.'
  }
];

/** Villes du bandeau défilant (illustration de la couverture nationale). */
const CITIES = [
  'الدار البيضاء',
  'الرباط',
  'مراكش',
  'فاس',
  'طنجة',
  'أكادير',
  'مكناس',
  'وجدة',
  'القنيطرة',
  'تطوان',
  'الجديدة',
  'آسفي',
  'بني ملال',
  'الناظور',
  'العيون',
  'الداخلة'
];

/** Exemple de numéro de suivi (même forme que les codes générés : 3 lettres, mois, année, id, 2 lettres). */
const TRACK_EXAMPLE = 'ABC1026512WX';

/** Résultat du suivi : historique du plus récent au plus ancien. */
function TrackResult({ code, history }) {
  const events = [...history].reverse();
  const latest = events[0];
  return (
    <div className="oe-result">
      <div className="oe-result-hd">
        <span className="oe-result-code">
          <i className="fa fa-box" /> {code}
        </span>
        {latest && (
          <span className="oe-status" style={{ background: latest.color }}>
            {latest.name}
          </span>
        )}
      </div>
      {events.length ? (
        <ol className="oe-timeline">
          {events.map((row, idx) => (
            <li key={idx} className={idx === 0 ? 'is-latest' : undefined}>
              <span className="oe-dot" style={{ background: row.color }} />
              <span className="oe-tl-name">{row.name}</span>
              <span className="oe-tl-date">{row.date}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="oe-result-empty">لا يوجد سجل متاح لهذا الطرد.</p>
      )}
    </div>
  );
}

/** Illustration du héro : étiquette d'expédition stylisée (purement décorative). */
function HeroArt() {
  return (
    <div className="oe-art" aria-hidden="true">
      <div className="oe-art-slab is-red" />
      <div className="oe-art-slab is-ink" />
      <div className="oe-art-speed">
        <span />
        <span />
        <span />
      </div>

      <div className="oe-label">
        <div className="oe-label-top">
          <span className="oe-label-brand">
            {BRAND.logoText.main}
            <b>{BRAND.logoText.sub}</b>
          </span>
          <span className="oe-label-chev">
            <span />
            <span />
          </span>
        </div>
        <div className="oe-label-body">
          <div className="oe-label-route">
            <div>
              <small>من</small>
              <strong>الدار البيضاء</strong>
            </div>
            <i className="fa fa-arrow-left" />
            <div>
              <small>إلى</small>
              <strong>طنجة</strong>
            </div>
          </div>
          <div className="oe-label-meta">
            <div>
              <small>الدفع</small>
              <strong>عند الاستلام</strong>
            </div>
            <div>
              <small>الطرود</small>
              <strong>1 / 1</strong>
            </div>
            {/* 3e colonne laissée libre : le tampon « مستعجل » s'y pose. */}
          </div>
          <div className="oe-label-bars" />
          <div className="oe-label-code">{TRACK_EXAMPLE}</div>
          <span className="oe-label-stamp">مستعجل</span>
        </div>
      </div>

      <div className="oe-art-chip">
        <span className="oe-art-chip-icon">
          <i className="fa fa-check" />
        </span>
        <span>
          <strong>تم تسليم الطرد</strong>
          <small>إشعار فوري للزبون</small>
        </span>
      </div>
    </div>
  );
}

export default function Home() {
  const { hash } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [activeId, setActiveId] = useState('hero');
  const [scrolled, setScrolled] = useState(false);
  const [trackNum, setTrackNum] = useState('');
  const [tracking, setTracking] = useState({ status: 'idle' });

  // Arrivée avec une ancre (ex. /#contact depuis la page tarifs) : défiler vers la section.
  useEffect(() => {
    if (!hash) return;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView(), 0);
    return () => clearTimeout(t);
  }, [hash]);

  // En-tête : filet et ombre dès que la page défile.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Scrollspy : le lien de navigation de la section visible devient actif.
  useEffect(() => {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        });
      },
      { rootMargin: '-40% 0px -50% 0px' }
    );
    document.querySelectorAll('.oe section[id]').forEach((s) => spy.observe(s));
    return () => spy.disconnect();
  }, []);

  const scrollTo = (id) => (e) => {
    e.preventDefault();
    setNavOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function doTrack(e) {
    e.preventDefault();
    const num = trackNum.trim();
    if (!num) {
      setTracking({ status: 'warning', message: 'يرجى إدخال رقم التتبع.' });
      return;
    }
    setTracking({ status: 'loading' });
    try {
      const { data } = await api.get('/public/track', { params: { num } });
      if (!data.success) {
        setTracking({ status: 'error', message: data.message });
      } else {
        setTracking({ status: 'done', code: data.code, history: data.history });
      }
    } catch (err) {
      setTracking({
        status: 'error',
        message: err.response?.data?.message || 'خطأ في الاتصال بالخادم.'
      });
    }
  }

  const whatsappUrl = `https://wa.me/${HOME_INFO.whatsapp}`;

  return (
    <div className="oe" dir="rtl" lang="ar">
      {/* ██ En-tête ██ */}
      <header className={`oe-header${scrolled ? ' is-scrolled' : ''}`}>
        <div className="oe-wrap oe-header-in">
          <Link to="/" className="oe-brand">
            <PublicLogo className="oe-logo" />
          </Link>
          <button
            type="button"
            className="oe-burger"
            aria-label="قائمة التنقل"
            aria-expanded={navOpen}
            aria-controls="oe-nav"
            onClick={() => setNavOpen((o) => !o)}
          >
            <span />
            <span />
            <span />
          </button>
          <nav id="oe-nav" className={`oe-nav${navOpen ? ' is-open' : ''}`} aria-label="التنقل الرئيسي">
            <ul className="oe-nav-links">
              {NAV_LINKS.map((link) => {
                const cls = `oe-nav-link${activeId === link.id ? ' is-active' : ''}`;
                return (
                  <li key={link.id}>
                    {link.to ? (
                      <Link to={link.to} className={cls} onClick={() => setNavOpen(false)}>
                        {link.label}
                      </Link>
                    ) : (
                      <a href={`#${link.id}`} className={cls} onClick={scrollTo(link.id)}>
                        {link.label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="oe-nav-actions">
              <Link to="/login" className="oe-login">
                <i className="fa fa-user" /> دخول
              </Link>
              <Link to="/register" className="oe-btn oe-btn-red oe-btn-sm">
                أنشئ حسابك
              </Link>
            </div>
          </nav>
        </div>
      </header>

      {/* ██ Héro + suivi de colis ██ */}
      <section id="hero" className="oe-hero">
        <div className="oe-wrap oe-hero-grid">
          <div>
            <p className="oe-eyebrow">خدمة التوصيل لتجارتك الإلكترونية في المغرب</p>
            <h1>
              من متجرك
              <br />
              إلى باب زبونك،
              <br />
              <em>في كل المغرب</em>
            </h1>
            <p className="oe-hero-lead">
              {BRAND.nameAr} تستلم طرودك، توصلها وتحصّل ثمنها عند التسليم، مع تتبّع لحظي لكل شحنة وفريق دعم
              يرافقك في كل خطوة.
            </p>

            <form className="oe-track" onSubmit={doTrack} noValidate>
              <label htmlFor="oe-track-num" className="oe-track-label">
                <span>
                  <i className="fa fa-location-crosshairs" />
                  تتبّع طردك
                </span>
                <small>رقم التتبع مكتوب على ملصق الطرد</small>
              </label>
              <div className="oe-track-bar">
                <i className="fa fa-barcode" aria-hidden="true" />
                <input
                  id="oe-track-num"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`مثال: ${TRACK_EXAMPLE}`}
                  value={trackNum}
                  onChange={(e) => setTrackNum(e.target.value)}
                />
                <button type="submit" className="oe-btn oe-btn-ink" disabled={tracking.status === 'loading'}>
                  تتبّع <i className="fa fa-arrow-left" />
                </button>
              </div>
              <div className="oe-track-out" aria-live="polite">
                {tracking.status === 'loading' && (
                  <div className="oe-loading">
                    <span className="oe-spinner" /> جاري البحث...
                  </div>
                )}
                {tracking.status === 'warning' && (
                  <div className="oe-alert is-warning">
                    <i className="fa fa-circle-exclamation" /> {tracking.message}
                  </div>
                )}
                {tracking.status === 'error' && (
                  <div className="oe-alert is-error">
                    <i className="fa fa-circle-xmark" /> {tracking.message}
                  </div>
                )}
                {tracking.status === 'done' && <TrackResult code={tracking.code} history={tracking.history} />}
              </div>
            </form>

            <div className="oe-hero-ctas">
              <Link to="/register" className="oe-btn oe-btn-red">
                انضم كعميل <i className="fa fa-arrow-left" />
              </Link>
              <a href={whatsappUrl} className="oe-btn oe-btn-line" target="_blank" rel="noopener noreferrer">
                <i className="fab fa-whatsapp" /> تواصل عبر واتساب
              </a>
            </div>
          </div>

          <HeroArt />
        </div>
      </section>

      {/* ██ Bandeau des villes ██ */}
      <div className="oe-ticker" aria-hidden="true">
        <div className="oe-ticker-tag">
          <i className="fa fa-route" /> نوصّل إلى
        </div>
        <div className="oe-ticker-viewport">
          <div className="oe-ticker-track">
            {[...CITIES, ...CITIES].map((city, idx) => (
              <span key={idx} className="oe-ticker-item">
                {city}
                <i className="fa fa-angles-left" />
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ██ Services ██ */}
      <section id="services" className="oe-services">
        <div className="oe-wrap">
          <div className="oe-head">
            <div>
              <p className="oe-eyebrow">
                <b>01</b> خدماتنا
              </p>
              <h2>كل ما تحتاجه تجارتك الإلكترونية، تحت سقف واحد</h2>
            </div>
            <p>من الاستلام والتخزين إلى التوصيل والتحصيل والإرجاع: حلول متكاملة مصمَّمة لتلبية احتياجات متجرك.</p>
          </div>

          <div className="oe-bento">
            {SERVICES.map((s, idx) =>
              idx === 0 ? (
                <article key={s.title} className="oe-tile is-feature">
                  <div className="oe-feature-deco" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="oe-tile-icon">
                    <i className={`fa ${s.icon}`} />
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <Link to="/register" className="oe-btn oe-btn-white oe-btn-sm">
                    ابدأ الشحن معنا <i className="fa fa-arrow-left" />
                  </Link>
                </article>
              ) : (
                <article key={s.title} className="oe-tile">
                  <div className="oe-tile-top">
                    <i className={`fa ${s.icon} oe-tile-icon`} />
                    <span className="oe-tile-num">{String(idx + 1).padStart(2, '0')}</span>
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </article>
              )
            )}
          </div>
        </div>
      </section>

      {/* ██ Comment ça marche ██ */}
      <section id="how-it-works" className="oe-how">
        <div className="oe-wrap">
          <div className="oe-head is-light">
            <div>
              <p className="oe-eyebrow">
                <b>02</b> كيف يعمل
              </p>
              <h2>أربع خطوات، من طلبك إلى أموالك</h2>
            </div>
            <p>سجّل شحنتك ونتكفّل بالباقي: الاستلام، التوصيل، تحصيل المبلغ وتحويله إليك.</p>
          </div>

          <ol className="oe-steps">
            {STEPS.map((step, idx) => (
              <li key={step.title} className="oe-step">
                <span className="oe-step-num">{String(idx + 1).padStart(2, '0')}</span>
                <h3>
                  <i className={`fa ${step.icon}`} />
                  {step.title}
                </h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>

          <div className="oe-how-cta">
            <p>
              جاهز للانطلاق مع {BRAND.nameAr}؟ <span>أنشئ حسابك وسجّل أول شحنة في دقائق.</span>
            </p>
            <Link to="/register" className="oe-btn oe-btn-red">
              ابدأ الآن <i className="fa fa-arrow-left" />
            </Link>
          </div>
        </div>
      </section>

      {/* ██ Engagements ██ */}
      <section id="rules" className="oe-commit">
        <div className="oe-wrap oe-commit-grid">
          <div className="oe-commit-intro">
            <p className="oe-eyebrow">
              <b>03</b> التزاماتنا
            </p>
            <h2 className="oe-h2">التزامات واضحة لعلاقة مبنية على الثقة</h2>
            <p>
              نلتزم بمعايير عالية لضمان تجربة شحن آمنة وشفافة لكل عميل، ونعتمد على بعض القواعد البسيطة لحماية
              طرودك وطرود الجميع.
            </p>
            <Link to="/contrat" className="oe-btn oe-btn-line">
              اطّلع على عقد الخدمة <i className="fa fa-arrow-left" />
            </Link>
          </div>
          <ul className="oe-commit-list">
            {RULES.map((rule) => (
              <li key={rule.title} className={`oe-commit-item${rule.alert ? ' is-alert' : ''}`}>
                <span className="oe-commit-icon">
                  <i className={`fa ${rule.icon}`} />
                </span>
                <div>
                  <h3>{rule.title}</h3>
                  <p>{rule.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ██ Tarifs ██ */}
      <section id="tarifs" className="oe-pricing">
        <div className="oe-wrap">
          <div className="oe-price">
            <div>
              <p className="oe-eyebrow">
                <b>04</b> الأسعار
              </p>
              <h2 className="oe-h2">أسعار تناسب حجم شحناتك</h2>
              <p className="oe-price-lead">
                تختلف التعريفة حسب مدينة الاستلام والوجهة. اطّلع على جدول الأسعار الكامل أو اطلب عرضاً مخصصاً لحجم
                أعمالك.
              </p>
              <div className="oe-price-ctas">
                <Link to="/tarifs" className="oe-btn oe-btn-white">
                  <i className="fa fa-table" /> جدول الأسعار الكامل
                </Link>
                <a href="#contact" className="oe-btn oe-btn-ghost" onClick={scrollTo('contact')}>
                  اطلب عرض سعر
                </a>
              </div>
            </div>
            <ul className="oe-price-list">
              {PRICING.map((p) => (
                <li key={p.title} className="oe-price-item">
                  <i className={`fa ${p.icon}`} />
                  <div>
                    <h3>{p.title}</h3>
                    <p>{p.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ██ Contact ██ */}
      <section id="contact" className="oe-contact">
        <div className="oe-wrap oe-contact-grid">
          <div className="oe-contact-intro">
            <p className="oe-eyebrow">
              <b>05</b> تواصل معنا
            </p>
            <h2 className="oe-h2">لنتحدّث عن شحناتك</h2>
            <p>فريقنا هنا للإجابة على جميع استفساراتك واقتراح الحل الأنسب لتجارتك — تواصل معنا بالطريقة التي تناسبك.</p>
            <div className="oe-hours">
              <i className="fa fa-clock" />
              <div>
                <small>أوقات العمل</small>
                <strong>{HOME_INFO.horaires}</strong>
              </div>
            </div>
            <div className="oe-social">
              <span className="oe-social-label">تابعونا</span>
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

          <div className="oe-contact-cards">
            <a href={`tel:${HOME_INFO.phone}`} className="oe-ccard">
              <span className="oe-ccard-icon">
                <i className="fa fa-phone" />
              </span>
              <i className="fa fa-arrow-left oe-ccard-go" />
              <small>الهاتف</small>
              <strong>
                <bdi dir="ltr">{HOME_INFO.phone}</bdi>
              </strong>
            </a>
            <a href={whatsappUrl} className="oe-ccard is-wa" target="_blank" rel="noopener noreferrer">
              <span className="oe-ccard-icon">
                <i className="fab fa-whatsapp" />
              </span>
              <i className="fa fa-arrow-left oe-ccard-go" />
              <small>واتساب</small>
              <strong>
                <bdi dir="ltr">{HOME_INFO.whatsapp}</bdi>
              </strong>
            </a>
            <a href={`mailto:${HOME_INFO.email}`} className="oe-ccard">
              <span className="oe-ccard-icon">
                <i className="fa fa-envelope" />
              </span>
              <i className="fa fa-arrow-left oe-ccard-go" />
              <small>البريد الإلكتروني</small>
              <strong>
                <bdi dir="ltr">{HOME_INFO.email}</bdi>
              </strong>
            </a>
            <div className="oe-ccard">
              <span className="oe-ccard-icon">
                <i className="fa fa-location-dot" />
              </span>
              <small>العنوان</small>
              <strong>{HOME_INFO.adresse}</strong>
            </div>
          </div>
        </div>
      </section>

      {/* ██ Pied de page ██ */}
      <HomeFooter scrollTo={scrollTo} />
    </div>
  );
}
