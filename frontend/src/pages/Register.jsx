import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import '../home.css';

/**
 * Page publique /register — « Devenir client » : reproduction de l'ancienne
 * page d'inscription (orta/clients/files/register.php) adaptée à la charte du
 * nouveau site public (arabe RTL, bleu #1C428A / jaune #f6db14, labels
 * bilingues comme l'original). Mêmes champs et mêmes règles : nom, magasin,
 * CIN, email, téléphones, ville, adresse, mot de passe ×2, site web, RIB,
 * consentements CGU + CNDP. La demande part sur POST /api/public/register
 * (INSERT dans delevery_new_customers, statut 0) puis est acceptée ou refusée
 * sur /admin/nouveaux-clients.
 */

const EMPTY_FORM = {
  fullname: '',
  storename: '',
  cin: '',
  email: '',
  phone: '',
  phonePersonal: '',
  city: '',
  address: '',
  password: '',
  passwordConfirm: '',
  website: '',
  rib: '',
  acceptTerms: false,
  acceptCndp: false,
  fax: '' // honeypot
};

/** Libellé bilingue : arabe (principal) + français (secondaire), comme l'ancien formulaire. */
function FieldLabel({ ar, fr, required }) {
  return (
    <label className="reg-label">
      {ar} {required && <span className="reg-req">*</span>}
      {fr && <span className="reg-fr">{fr}</span>}
    </label>
  );
}

export default function Register() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState('idle'); // idle | sending | success
  const [errors, setErrors] = useState([]);

  const setField = (field) => (e) =>
    setForm((f) => ({
      ...f,
      [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value
    }));

  /** Mêmes règles que l'ancien register.php (et que l'API) — messages en arabe. */
  function clientErrors() {
    const errs = [];
    const required = ['fullname', 'cin', 'phone', 'email', 'password', 'passwordConfirm', 'city', 'address'];
    if (required.some((f) => !String(form[f]).trim())) {
      errs.push('يرجى ملء جميع الخانات الإجبارية المميزة بعلامة *.');
      return errs;
    }
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      errs.push('البريد الإلكتروني غير صالح.');
    }
    if (!/^0[5-8][0-9]{8}$/.test(form.phone.trim())) {
      errs.push('يرجى إدخال رقم هاتف صحيح (10 أرقام يبدأ بـ 05، 06، 07 أو 08).');
    }
    if (form.password.length < 8) {
      errs.push('كلمة السر يجب أن تحتوي على 8 أحرف على الأقل.');
    } else if (form.password !== form.passwordConfirm) {
      errs.push('تأكيد كلمة السر غير مطابق.');
    }
    if (!form.acceptTerms) {
      errs.push('يجب الموافقة على شروط الاستخدام وسياسة الخصوصية.');
    }
    if (!form.acceptCndp) {
      errs.push('يجب الإقرار بإشعار CNDP وفقاً للقانون 09-08.');
    }
    return errs;
  }

  async function submit(e) {
    e.preventDefault();
    const errs = clientErrors();
    if (errs.length) {
      setErrors(errs);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setStatus('sending');
    setErrors([]);
    try {
      await api.post('/public/register', {
        ...form,
        fullname: form.fullname.trim(),
        storename: form.storename.trim(),
        cin: form.cin.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        phonePersonal: form.phonePersonal.trim(),
        city: form.city.trim(),
        address: form.address.trim(),
        website: form.website.trim(),
        rib: form.rib.trim()
      });
      setStatus('success');
      window.scrollTo({ top: 0 });
    } catch (err) {
      setStatus('idle');
      setErrors([err.response?.data?.message || 'خطأ في الخادم: تعذّر إرسال الطلب. حاول مرة أخرى.']);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

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

      <div className="reg-body">
        <div className="reg-card">
          <div className="reg-head">
            <h1>
              إنضم إلينا <span className="reg-head-fr">— Devenir client</span>
            </h1>
            <p>أنشئ حسابك في أورطالوج مجاناً — سنتواصل معك بعد مراجعة طلبك</p>
            <div className="reg-required-note">
              <i className="fa fa-asterisk" /> الخانات المميزة بعلامة * إجبارية
            </div>
          </div>

          <div className="reg-card-body">
            {status === 'success' ? (
              <div className="reg-success">
                <div className="reg-success-icon">
                  <i className="fa fa-circle-check" />
                </div>
                <h2>تم إرسال طلبك بنجاح!</h2>
                <p>
                  شكراً لثقتك بأورطالوج. سيقوم فريقنا بمراجعة طلبك والتواصل معك في أقرب وقت
                  لتفعيل حسابك.
                </p>
                <Link to="/" className="btn-hero-primary">
                  <i className="fa fa-arrow-right" /> العودة إلى الرئيسية
                </Link>
              </div>
            ) : (
              <form onSubmit={submit} noValidate autoComplete="off">
                {errors.length > 0 && (
                  <div className="alert alert-danger" role="alert">
                    <ul>
                      {errors.map((err) => (
                        <li key={err}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Honeypot : invisible aux humains, les robots le remplissent. */}
                <div className="hp-field" aria-hidden="true">
                  <label htmlFor="hp_fax">Fax</label>
                  <input
                    type="text"
                    id="hp_fax"
                    autoComplete="off"
                    tabIndex={-1}
                    value={form.fax}
                    onChange={setField('fax')}
                  />
                </div>

                <div className="reg-section">المعلومات الشخصية — Informations personnelles</div>
                <div className="reg-grid">
                  <div className="reg-field">
                    <FieldLabel ar="الاسم الكامل" fr="Nom complet" required />
                    <input
                      type="text"
                      maxLength={100}
                      placeholder="الاسم الكامل"
                      value={form.fullname}
                      onChange={setField('fullname')}
                    />
                  </div>
                  <div className="reg-field optional">
                    <FieldLabel ar="اسم المتجر" fr="Nom du magasin (optionnel)" />
                    <input
                      type="text"
                      maxLength={100}
                      placeholder="اسم المتجر (اختياري)"
                      value={form.storename}
                      onChange={setField('storename')}
                    />
                  </div>
                  <div className="reg-field">
                    <FieldLabel ar="رقم بطاقة التعريف" fr="CIN" required />
                    <input
                      type="text"
                      maxLength={100}
                      placeholder="CIN"
                      value={form.cin}
                      onChange={setField('cin')}
                    />
                  </div>
                  <div className="reg-field">
                    <FieldLabel ar="البريد الإلكتروني" fr="Email" required />
                    <input
                      type="email"
                      dir="ltr"
                      maxLength={100}
                      placeholder="votre@email.com"
                      value={form.email}
                      onChange={setField('email')}
                    />
                  </div>
                </div>

                <div className="reg-section">التواصل — Contact</div>
                <div className="reg-grid">
                  <div className="reg-field">
                    <FieldLabel ar="رقم الهاتف المهني" fr="Téléphone (pro)" required />
                    <input
                      type="tel"
                      dir="ltr"
                      maxLength={10}
                      placeholder="0600000000"
                      value={form.phone}
                      onChange={setField('phone')}
                    />
                  </div>
                  <div className="reg-field optional">
                    <FieldLabel ar="الهاتف الشخصي" fr="Téléphone (personnel)" />
                    <input
                      type="tel"
                      dir="ltr"
                      maxLength={50}
                      placeholder="(اختياري) 0600000000"
                      value={form.phonePersonal}
                      onChange={setField('phonePersonal')}
                    />
                  </div>
                  <div className="reg-field">
                    <FieldLabel ar="المدينة" fr="Ville" required />
                    <input
                      type="text"
                      maxLength={25}
                      placeholder="الدار البيضاء، الرباط…"
                      value={form.city}
                      onChange={setField('city')}
                    />
                  </div>
                  <div className="reg-field">
                    <FieldLabel ar="العنوان" fr="Adresse" required />
                    <input
                      type="text"
                      maxLength={250}
                      placeholder="العنوان الكامل"
                      value={form.address}
                      onChange={setField('address')}
                    />
                  </div>
                </div>

                <div className="reg-section">الأمان — Sécurité</div>
                <div className="reg-grid">
                  <div className="reg-field">
                    <FieldLabel ar="كلمة السر" fr="Mot de passe" required />
                    <input
                      type="password"
                      maxLength={100}
                      autoComplete="new-password"
                      placeholder="8 أحرف على الأقل"
                      value={form.password}
                      onChange={setField('password')}
                    />
                  </div>
                  <div className="reg-field">
                    <FieldLabel ar="تأكيد كلمة السر" fr="Confirmation" required />
                    <input
                      type="password"
                      maxLength={100}
                      autoComplete="new-password"
                      placeholder="أعد كتابة كلمة السر"
                      value={form.passwordConfirm}
                      onChange={setField('passwordConfirm')}
                    />
                  </div>
                </div>

                <div className="reg-section">معلومات إضافية (اختياري) — Informations complémentaires</div>
                <div className="reg-grid">
                  <div className="reg-field optional">
                    <FieldLabel ar="الموقع الإلكتروني" fr="Site web" />
                    <input
                      type="text"
                      dir="ltr"
                      maxLength={50}
                      placeholder="https://votresite.ma"
                      value={form.website}
                      onChange={setField('website')}
                    />
                  </div>
                  <div className="reg-field optional">
                    <FieldLabel ar="رقم الحساب البنكي" fr="RIB" />
                    <input
                      type="text"
                      dir="ltr"
                      maxLength={25}
                      placeholder="RIB"
                      value={form.rib}
                      onChange={setField('rib')}
                    />
                  </div>
                </div>

                <div className="reg-consent-box">
                  <label className="reg-consent-item">
                    <input type="checkbox" checked={form.acceptTerms} onChange={setField('acceptTerms')} />
                    <span>
                      قرأت وأوافق على{' '}
                      <Link to="/conditions-utilisation" target="_blank">
                        شروط الاستخدام وسياسة الخصوصية
                      </Link>{' '}
                      الخاصة بأورطالوج.<span className="reg-req">*</span>
                    </span>
                  </label>
                  <label className="reg-consent-item">
                    <input type="checkbox" checked={form.acceptCndp} onChange={setField('acceptCndp')} />
                    <span>
                      <Link to="/mentions-legales" target="_blank">
                        هذه المعالجة
                      </Link>{' '}
                      كانت موضوع طلب ترخيص لدى اللجنة الوطنية لحماية المعطيات الشخصية
                      (CNDP) — وفقاً للقانون <strong>09-08</strong>، لديك حق الوصول إلى بياناتك
                      وتصحيحها والاعتراض على معالجتها.<span className="reg-req">*</span>
                    </span>
                  </label>
                </div>

                <button type="submit" className="reg-btn" disabled={status === 'sending'}>
                  <i className="fa fa-paper-plane" />{' '}
                  {status === 'sending' ? 'جاري الإرسال...' : 'إرسال الطلب — Envoyer la demande'}
                </button>

                <div className="reg-login-link">
                  لديك حساب بالفعل؟ <Link to="/login">تسجيل الدخول</Link>
                </div>
              </form>
            )}
          </div>
        </div>

        <div className="reg-footer">
          © {new Date().getFullYear()} أورطالوج — جميع الحقوق محفوظة
        </div>
      </div>
    </div>
  );
}
