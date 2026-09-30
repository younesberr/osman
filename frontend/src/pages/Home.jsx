import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api from '../api/client';
import HomeFooter from '../components/HomeFooter';
import { BRAND, HOME_INFO } from '../config/brand';
import '../home.css';
import PublicLogo from '../components/PublicLogo';

/**
 * Page d'accueil publique — reproduction fidèle de la page d'accueil de
 * l'ancien site PHP (ancien site PHP) : arabe RTL, police Cairo,
 * rouge #d80613 / noir #111111. Le suivi de colis et le formulaire de
 * contact appellent les endpoints publics /api/public/*.
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

const SERVICES = [
  {
    title: 'توصيل سريع في كل المغرب',
    icon: 'fa-truck-fast',
    accent: false,
    text: `بفضل شبكتنا الوطنية المحسّنة، تضمن ${BRAND.nameAr} آجال تسليم قصيرة وموثوقة. أينما كان عملاؤك، نضمن توزيعاً فعّالاً وفي الوقت المحدد.`
  },
  {
    title: 'استلام من طرد واحد',
    icon: 'fa-truck-loading',
    accent: true,
    text: 'خدمة استلام مرنة تناسب الأفراد والمحترفين. حتى لطرد واحد، نضمن استلاماً سريعاً وعملياً بدون قيود.'
  },
  {
    title: 'تتبع فوري ولحظي',
    icon: 'fa-location-dot',
    accent: false,
    text: 'تتبّع طرودك في أي وقت عبر نظام تتبع دقيق في كل مرحلة لتبقى على علم دائم بحالة شحنتك.'
  },
  {
    title: 'حماية وأمان البضائع',
    icon: 'fa-shield-halved',
    accent: true,
    text: 'طرودك محمية من الاستلام حتى التسليم النهائي. معالجة بعناية وتعبئة مطابقة لتجنب أي ضرر.'
  },
  {
    title: 'إرجاع مجاني وسريع',
    icon: 'fa-rotate-left',
    accent: false,
    text: 'خدمة إرجاع بسيطة ومجانية مع تتبع متكامل لشفافية كاملة حتى استلام الإرجاع.'
  },
  {
    title: 'خدمة عملاء احترافية',
    icon: 'fa-headset',
    accent: true,
    text: 'دعم مخصص متاح للإجابة على جميع أسئلتك بكفاءة، قبل وأثناء وبعد التسليم.'
  },
  {
    title: 'حلول التجارة الإلكترونية',
    icon: 'fa-cart-shopping',
    accent: false,
    text: 'واجهات برمجية (WooCommerce, Shopify...) جاهزة لربط متجرك مع مزامنة تلقائية للطلبات والحالات.'
  },
  {
    title: 'خدمة تغليف احترافية',
    icon: 'fa-boxes-stacked',
    accent: true,
    text: 'حلول تغليف قوية ومتكيفة مع كل نوع من البضائع لضمان حماية مثلى وتقليل مخاطر التلف.'
  },
  {
    title: 'تخزين البضائع في المستودع',
    icon: 'fa-warehouse',
    accent: false,
    text: 'فضاء تخزين آمن لحماية منتجاتك بكل ثقة. حلول قصيرة أو متوسطة الأمد حسب احتياجاتك.'
  }
];

const STEPS = [
  {
    icon: 'fa-file-pen',
    title: 'سجّل شحنتك',
    text: 'أنشئ حسابك وسجّل طلبات التوصيل عبر لوحة التحكم بسهولة تامة في دقائق'
  },
  {
    icon: 'fa-box',
    title: 'نستلم البضاعة',
    text: 'يتوجه سائقنا إليك ويستلم الطرود بعناية وينقلها إلى مستودعاتنا بأمان'
  },
  {
    icon: 'fa-house-user',
    title: 'نوصّل للعميل',
    text: 'يصل الطرد إلى وجهته في أسرع وقت مع إشعار للعميل وتأكيد التسليم فوراً'
  },
  {
    icon: 'fa-money-bill-wave',
    title: 'تستلم أموالك',
    text: 'تحصيل مبالغ الدفع عند الاستلام وتحويلها إليك في أقصر الآجال بشفافية كاملة'
  }
];

const RULES = [
  {
    icon: 'fa-hand-holding-dollar',
    variant: 'primary',
    title: 'تعويض سريع وشفاف',
    text: 'تتم معالجة التعويضات بسرعة بعد التحقق من الضياع أو التلف أو الخطأ — دون تعقيدات أو إجراءات مطوّلة.'
  },
  {
    icon: 'fa-file-lines',
    variant: 'ghost',
    title: 'الوثائق المحاسبية',
    text: 'توفير الوثائق والمستندات التبريرية عند الطلب لضمان التتبع الكامل والمطابقة الإدارية.'
  },
  {
    icon: 'fa-file-contract',
    variant: 'primary',
    title: 'عقد الخدمة',
    text: 'يُقترح عقد واضح على كل عميل يُحدّد المسؤوليات والضمانات وشروط الخدمة بالكامل.'
  },
  {
    icon: 'fa-ban',
    variant: 'accent',
    title: 'المنتجات الممنوعة',
    text: `يُحظر إرسال المواد المحظورة قانوناً. تتبرأ ${BRAND.nameAr} من أي مسؤولية عن هذه الشحنات.`
  },
  {
    icon: 'fa-box-open',
    variant: 'ghost',
    title: 'تعبئة جيدة وسليمة',
    text: 'يجب تعبئة كل طرد بشكل صحيح لضمان الحماية والسلامة التامة أثناء النقل.'
  },
  {
    icon: 'fa-comments',
    variant: 'primary',
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

const EMPTY_CONTACT = { name: '', city: '', email: '', phone: '', message: '', website: '' };

/** Carte de résultat du suivi (même rendu que l'ancien site). */
function TrackResult({ code, history }) {
  const latest = history.length ? history[history.length - 1] : null;
  return (
    <div className="track-result-wrap">
      <div className="track-result-hd">
        <span className="track-result-num">
          <i className="fa fa-box-open" /> {code}
        </span>
        {latest && (
          <span className="trk-badge" style={{ background: latest.color }}>
            {latest.name}
          </span>
        )}
      </div>
      {history.length ? (
        <div className="track-history">
          {history.map((row, idx) => (
            <div key={idx} className={`trk-row${idx === history.length - 1 ? ' trk-row-last' : ''}`}>
              <div className="trk-row-start">
                <span className="trk-idx">{idx + 1}</span>
                <span className="trk-badge" style={{ background: row.color }}>
                  {row.name}
                </span>
              </div>
              <span className="trk-date">{row.date}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="trk-empty">لا يوجد سجل متاح لهذا الطرد.</p>
      )}
    </div>
  );
}

export default function Home() {
  const { hash } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [activeId, setActiveId] = useState('hero');

  // Arrivée avec une ancre (ex. /#contact depuis la page tarifs) : défiler vers la section.
  useEffect(() => {
    if (!hash) return;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView(), 0);
    return () => clearTimeout(t);
  }, [hash]);

  const [trackNum, setTrackNum] = useState('');
  const [tracking, setTracking] = useState({ status: 'idle' });

  const [form, setForm] = useState(EMPTY_CONTACT);
  const [contact, setContact] = useState({ status: 'idle', errors: [] });

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
    document.querySelectorAll('.home-ar section[id]').forEach((s) => spy.observe(s));
    return () => spy.disconnect();
  }, []);

  const scrollTo = (id) => (e) => {
    e.preventDefault();
    setNavOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function doTrack() {
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

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submitContact(e) {
    e.preventDefault();
    // Mêmes règles de validation que l'ancien site (messages identiques).
    const errors = [];
    if (!form.name.trim()) errors.push('الاسم الكامل مطلوب.');
    if (!form.email.trim() || !/^\S+@\S+\.\S+$/.test(form.email.trim()))
      errors.push('البريد الإلكتروني غير صالح.');
    if (!form.phone.trim()) errors.push('رقم الهاتف مطلوب.');
    if (!form.message.trim()) errors.push('الرسالة مطلوبة.');
    if (errors.length) {
      setContact({ status: 'error', errors });
      return;
    }
    setContact({ status: 'sending', errors: [] });
    try {
      await api.post('/public/contact', form);
      setContact({ status: 'success', errors: [] });
      setForm(EMPTY_CONTACT);
    } catch (err) {
      setContact({
        status: 'error',
        errors: [err.response?.data?.message || 'خطأ في الخادم: تعذّر حفظ الرسالة.']
      });
    }
  }

  return (
    <div className="home-ar" dir="rtl" lang="ar">
      {/* ██ Barre d'informations ██ */}
      <div className="topline">
        <div className="container topline-inner">
          <div className="topline-contacts">
            <a href={`tel:${HOME_INFO.phone}`}>
              <i className="fa fa-phone icon-accent" />
              <span>{HOME_INFO.phone}</span>
            </a>
            <a href={`https://wa.me/${HOME_INFO.whatsapp}`} target="_blank" rel="noopener noreferrer">
              <i className="fab fa-whatsapp ic-green" />
              <span>{HOME_INFO.whatsapp}</span>
            </a>
            <a href={`mailto:${HOME_INFO.email}`} className="topline-mail">
              <i className="fa fa-envelope icon-accent" />
              <span>{HOME_INFO.email}</span>
            </a>
          </div>
          <div className="topline-hours">
            <i className="fa fa-clock icon-accent" />
            أوقات العمل: {HOME_INFO.horaires}
          </div>
        </div>
      </div>

      {/* ██ Barre de navigation ██ */}
      <nav className="navbar-custom">
        <div className="container navbar-inner">
          <Link to="/" className="navbar-brand">
            <PublicLogo className="logo-header" />
          </Link>
          <button
            type="button"
            className="navbar-burger"
            aria-label="قائمة التنقل"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            <i className="fa fa-bars" />
          </button>
          <div className={`navbar-menu${navOpen ? ' open' : ''}`}>
            <ul className="navbar-links">
              {NAV_LINKS.map((link) => (
                <li key={link.id}>
                  {link.to ? (
                    <Link
                      to={link.to}
                      className={`nav-link${activeId === link.id ? ' active' : ''}`}
                      onClick={() => setNavOpen(false)}
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      href={`#${link.id}`}
                      className={`nav-link${activeId === link.id ? ' active' : ''}`}
                      onClick={scrollTo(link.id)}
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <div className="navbar-actions">
              <Link to="/register" className="btn-nav-outline">
                أنشئ حسابك
              </Link>
              <Link to="/login" className="btn-nav-solid">
                <i className="fa fa-user" /> دخول
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* ██ Héro + suivi de colis ██ */}
      <section id="hero" className="hero-section">
        <div className="hero-bg-circle c1" />
        <div className="hero-bg-circle c2" />
        <div className="hero-bg-circle c3" />

        <div className="container hero-inner">
          <div className="hero-grid">
            <div>
              <div className="hero-badge">
                <i className="fa fa-truck-fast" />
                شريك تجارتك الإلكترونية في المغرب
              </div>
              <h1 className="hero-title">
                توصيل سريع <span>وموثوق</span>
                <br />
                في كل مكان بالمغرب
              </h1>
              <p className="hero-subtitle">
                {BRAND.nameAr} — الحل الأمثل لإدارة شحناتك. من الاستلام حتى التسليم بتتبع لحظي وخدمة عملاء
                احترافية تُعلي من قيمة تجارتك.
              </p>
              <div className="hero-cta">
                <Link to="/register" className="btn-hero-primary">
                  <i className="fa fa-user-plus" />
                  انضم كعميل
                </Link>
                <a href="#contact" className="btn-hero-outline" onClick={scrollTo('contact')}>
                  <i className="fa fa-headset" />
                  تواصل معنا
                </a>
              </div>
            </div>

            <div>
              <div className="tracking-box">
                <h5>
                  <i className="fa fa-magnifying-glass icon-accent" />
                  تتبع طردك الآن
                </h5>
                <p className="track-label">أدخل رقم التتبع لمعرفة حالة شحنتك بشكل فوري</p>
                <div className="track-form">
                  <input
                    className="form-control"
                    type="text"
                    placeholder="مثال: ORT123456789"
                    dir="ltr"
                    autoComplete="off"
                    value={trackNum}
                    onChange={(e) => setTrackNum(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') doTrack();
                    }}
                  />
                  <button type="button" className="btn-track" onClick={doTrack}>
                    <i className="fa fa-search" /> بحث
                  </button>
                </div>
                <div className="track-result">
                  {tracking.status === 'loading' && (
                    <div className="track-spinner">
                      <div className="spinner-border" role="status" aria-label="جاري البحث..." />
                    </div>
                  )}
                  {tracking.status === 'warning' && (
                    <div className="alert alert-warning">{tracking.message}</div>
                  )}
                  {tracking.status === 'error' && (
                    <div className="alert alert-danger">{tracking.message}</div>
                  )}
                  {tracking.status === 'done' && (
                    <TrackResult code={tracking.code} history={tracking.history} />
                  )}
                </div>
              </div>

              <div className="quick-contact-bar">
                <a href={`tel:${HOME_INFO.phone}`} className="quick-contact-btn phone">
                  <i className="fa fa-phone icon-accent" />
                  <span>{HOME_INFO.phone}</span>
                </a>
                <a
                  href={`https://wa.me/${HOME_INFO.whatsapp}`}
                  className="quick-contact-btn whatsapp"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <i className="fab fa-whatsapp ic-green" />
                  <span>واتساب</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ██ Services ██ */}
      <section id="services" className="services-section">
        <div className="container">
          <div className="section-title">
            <h2>خدماتنا ومميزاتنا</h2>
            <p>نقدم مجموعة متكاملة من حلول الشحن والتوصيل المُصمَّمة لتلبية احتياجات تجارتك</p>
          </div>
          <div className="cards-grid-3">
            {SERVICES.map((s) => (
              <div key={s.title} className="service-card">
                <div className={`service-icon${s.accent ? ' accent' : ''}`}>
                  <i className={`fa ${s.icon}`} />
                </div>
                <h5>{s.title}</h5>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ██ Comment ça marche ██ */}
      <section id="how-it-works" className="how-section">
        <div className="container">
          <div className="section-title">
            <h2>كيف تعمل {BRAND.nameAr}؟</h2>
            <p>أربع خطوات بسيطة لإيصال طردك وتحصيل ثمنه في أسرع وقت</p>
          </div>
          <div className="steps-grid">
            {STEPS.map((step, idx) => (
              <div key={step.title} className="step-item">
                <div className="step-number">{idx + 1}</div>
                {idx < STEPS.length - 1 && <div className="step-connector" />}
                <div className="step-icon-wrap">
                  <i className={`fa ${step.icon}`} />
                </div>
                <h5>{step.title}</h5>
                <p>{step.text}</p>
              </div>
            ))}
          </div>
          <div className="how-cta">
            <Link to="/register" className="btn-cta-big">
              <i className="fa fa-rocket" /> ابدأ الآن
            </Link>
          </div>
        </div>
      </section>

      {/* ██ Engagements ██ */}
      <section id="rules" className="rules-section">
        <div className="container">
          <div className="section-title">
            <h2>التزاماتنا ومسؤولياتنا</h2>
            <p>نلتزم بمعايير عالية لضمان تجربة شحن آمنة وشفافة لكل عميل</p>
          </div>
          <div className="cards-grid-3">
            {RULES.map((rule) => (
              <article key={rule.title} className="rule-card">
                <div className={`rule-icon ${rule.variant}`}>
                  <i className={`fa ${rule.icon}`} />
                </div>
                <h5>{rule.title}</h5>
                <p>{rule.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ██ Tarifs ██ */}
      <section id="tarifs" className="pricing-section">
        <div className="container pricing-inner">
          <div className="section-title light">
            <h2>الأسعار والتعريفات</h2>
            <p>تعريفات مرنة تتكيف مع احتياجات كل عميل وحجم شحنته</p>
          </div>

          <div className="pricing-grid">
            {PRICING.map((p) => (
              <div key={p.title} className="pricing-card">
                <div className="p-icon">
                  <i className={`fa ${p.icon}`} />
                </div>
                <h4>{p.title}</h4>
                <p>{p.text}</p>
              </div>
            ))}
          </div>

          <div className="pricing-cta-box">
            <h4>تحتاج سعراً دقيقاً؟</h4>
            <p>اتصل بنا أو أرسل طلبك — سنعود إليك بأسرع وقت بعرض مخصص لاحتياجاتك</p>
            <div className="pricing-cta-btns">
              <a href={`tel:${HOME_INFO.phone}`} className="btn-hero-primary">
                <i className="fa fa-phone" /> {HOME_INFO.phone}
              </a>
              <a href="#contact" className="btn-hero-outline" onClick={scrollTo('contact')}>
                <i className="fa fa-envelope" /> راسلنا
              </a>
            </div>
          </div>

          <div className="pricing-full-link">
            <Link to="/tarifs" className="btn-pricing-full">
              <i className="fa fa-table" /> عرض جدول الاسعار الكامل
            </Link>
          </div>
        </div>
      </section>

      {/* ██ Contact ██ */}
      <section id="contact" className="contact-section">
        <div className="container">
          <div className="section-title">
            <h2>تواصل معنا</h2>
            <p>نحن هنا للإجابة على جميع استفساراتك — تواصل معنا بأي طريقة تناسبك</p>
          </div>

          <div className="contact-grid">
            <div>
              {contact.status === 'success' && (
                <div className="alert alert-success" role="alert">
                  <i className="fa fa-circle-check fa-lg" />
                  <div>شكراً! تم تسجيل رسالتك بنجاح. سنتواصل معك في أقرب وقت.</div>
                </div>
              )}
              {contact.status === 'error' && (
                <div className="alert alert-danger" role="alert">
                  <ul>
                    {contact.errors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="contact-form-wrap">
                <h5 className="form-title">
                  <i className="fa fa-paper-plane icon-accent" />
                  أرسل لنا رسالة
                </h5>
                <form onSubmit={submitContact} noValidate>
                  {/* Honeypot : invisible aux humains, les robots le remplissent. */}
                  <div className="hp-field" aria-hidden="true">
                    <label htmlFor="hp_website">Website</label>
                    <input
                      type="text"
                      id="hp_website"
                      autoComplete="off"
                      tabIndex={-1}
                      value={form.website}
                      onChange={setField('website')}
                    />
                  </div>
                  <div className="form-grid">
                    <div>
                      <label className="form-label">الاسم الكامل *</label>
                      <input
                        className="form-control"
                        placeholder="اكتب اسمك هنا"
                        value={form.name}
                        onChange={setField('name')}
                      />
                    </div>
                    <div>
                      <label className="form-label">المدينة</label>
                      <input
                        className="form-control"
                        placeholder="مدينتك"
                        value={form.city}
                        onChange={setField('city')}
                      />
                    </div>
                    <div>
                      <label className="form-label">البريد الإلكتروني *</label>
                      <input
                        className="form-control"
                        type="email"
                        placeholder="example@email.com"
                        dir="ltr"
                        value={form.email}
                        onChange={setField('email')}
                      />
                    </div>
                    <div>
                      <label className="form-label">رقم الهاتف *</label>
                      <input
                        className="form-control"
                        type="tel"
                        placeholder="+212 6XX XXX XXX"
                        dir="ltr"
                        value={form.phone}
                        onChange={setField('phone')}
                      />
                    </div>
                    <div className="form-full">
                      <label className="form-label">الرسالة *</label>
                      <textarea
                        className="form-control"
                        rows={5}
                        placeholder="اكتب رسالتك هنا..."
                        value={form.message}
                        onChange={setField('message')}
                      />
                    </div>
                    <div className="form-full">
                      <button type="submit" className="btn-submit" disabled={contact.status === 'sending'}>
                        <i className="fa fa-paper-plane" />
                        {contact.status === 'sending' ? 'جاري الإرسال...' : 'إرسال الرسالة'}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>

            <div>
              <h5 className="form-title">
                <i className="fa fa-address-card icon-accent" />
                معلومات التواصل
              </h5>

              <div className="contact-info-item">
                <div className="ci-icon">
                  <i className="fa fa-map-marker-alt" />
                </div>
                <div>
                  <span className="ci-label">العنوان</span>
                  <span className="ci-value">{HOME_INFO.adresse}</span>
                </div>
              </div>

              <div className="contact-info-item">
                <div className="ci-icon">
                  <i className="fa fa-phone" />
                </div>
                <div>
                  <span className="ci-label">الهاتف</span>
                  <a href={`tel:${HOME_INFO.phone}`} className="ci-value" dir="ltr">
                    {HOME_INFO.phone}
                  </a>
                </div>
              </div>

              <div className="contact-info-item">
                <div className="ci-icon green">
                  <i className="fab fa-whatsapp" />
                </div>
                <div>
                  <span className="ci-label">واتساب</span>
                  <a
                    href={`https://wa.me/${HOME_INFO.whatsapp}`}
                    className="ci-value"
                    dir="ltr"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {HOME_INFO.whatsapp}
                  </a>
                </div>
              </div>

              <div className="contact-info-item">
                <div className="ci-icon yellow">
                  <i className="fa fa-envelope" />
                </div>
                <div>
                  <span className="ci-label">البريد الإلكتروني</span>
                  <a href={`mailto:${HOME_INFO.email}`} className="ci-value" dir="ltr">
                    {HOME_INFO.email}
                  </a>
                </div>
              </div>

              <div className="contact-info-item">
                <div className="ci-icon">
                  <i className="fa fa-clock" />
                </div>
                <div>
                  <span className="ci-label">أوقات العمل</span>
                  <span className="ci-value">{HOME_INFO.horaires}</span>
                </div>
              </div>

              <p className="follow-label">تابعونا على:</p>
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
          </div>
        </div>
      </section>

      {/* ██ Footer ██ */}
      <HomeFooter scrollTo={scrollTo} />
    </div>
  );
}
