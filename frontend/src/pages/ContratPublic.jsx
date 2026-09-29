import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import HomeFooter from '../components/HomeFooter';
import { HOME_INFO } from '../config/homeInfo';
import '../home.css';

/**
 * Page publique « Contrat de prestation de services ».
 *
 * Quatre versions PDF chargées par l'admin (Configuration › Plateforme,
 * `GET /api/platform/contrats`) : particulier / société × arabe / français.
 * Le visiteur choisit le type de client puis la langue ; le PDF s'affiche
 * dans une visionneuse (boutons Ouvrir / Télécharger — sur mobile, seuls
 * les boutons : les navigateurs mobiles n'affichent pas les PDF en iframe).
 *
 * Sans PDF, la version particulier / français garde le texte intégré porté
 * de l'ancienne page PHP (orta/files/contrat.php : document imprimable,
 * filigrane, format A4) ; les autres versions sont signalées non disponibles.
 */

/* Types de client puis langues : l'ordre sert aussi de priorité d'affichage par défaut. */
const TYPES = [
  { id: 'particulier', ar: 'الأفراد', fr: 'Particuliers', icon: 'fa-user' },
  { id: 'societe', ar: 'الشركات', fr: 'Sociétés', icon: 'fa-building' }
];
const LANGS = [
  { id: 'ar', label: 'العربية' },
  { id: 'fr', label: 'Français' }
];
const DEFAULT_ORDER = ['particulier_ar', 'particulier_fr', 'societe_ar', 'societe_fr'];

const TITRES = {
  particulier_ar: 'عقد تقديم الخدمات — الأفراد',
  particulier_fr: 'Contrat de prestation de services — Particuliers',
  societe_ar: 'عقد تقديم الخدمات — الشركات',
  societe_fr: 'Contrat de prestation de services — Sociétés'
};

function formatTaille(octets, lang) {
  const unite = lang === 'ar' ? ['كيلوبايت', 'ميغابايت'] : ['Ko', 'Mo'];
  if (octets >= 1024 * 1024) return `${(octets / (1024 * 1024)).toFixed(1)} ${unite[1]}`;
  return `${Math.max(1, Math.round(octets / 1024))} ${unite[0]}`;
}

/** Visionneuse d'une version PDF : en-tête (titre, taille, actions) + iframe. */
function ContratPdf({ doc, version, lang }) {
  const ar = lang === 'ar';
  const titre = TITRES[version];
  return (
    <div className="contrat-doc" dir={ar ? 'rtl' : 'ltr'} lang={lang}>
      <div className="contrat-doc-head no-print">
        <div className="contrat-doc-title">
          <i className="fa fa-file-pdf" aria-hidden="true" />
          <div>
            <strong>{titre}</strong>
            <small>PDF · {formatTaille(doc.size, lang)}</small>
          </div>
        </div>
        <div className="contrat-doc-actions">
          <a className="btn-print" href={doc.url} target="_blank" rel="noreferrer">
            <i className="fa fa-external-link-alt" aria-hidden="true" /> {ar ? 'فتح' : 'Ouvrir'}
          </a>
          <a className="btn-print btn-print-outline" href={doc.url} download>
            <i className="fa fa-download" aria-hidden="true" /> {ar ? 'تحميل' : 'Télécharger'}
          </a>
        </div>
      </div>
      <iframe className="contrat-viewer" src={doc.url} title={titre} />
      <p className="contrat-mobile-note">
        {ar
          ? 'لعرض العقد على الهاتف، اضغط على « فتح » أو « تحميل ».'
          : 'Sur mobile, utilisez « Ouvrir » ou « Télécharger » pour consulter le contrat.'}
      </p>
    </div>
  );
}

/** Version sans PDF : message bilingue selon la langue choisie. */
function ContratIndisponible({ lang }) {
  const ar = lang === 'ar';
  return (
    <div className="contrat-empty" dir={ar ? 'rtl' : 'ltr'} lang={lang}>
      <i className="fa fa-file-signature" aria-hidden="true" />
      <strong>
        {ar ? 'هذه النسخة من العقد غير متاحة حالياً.' : 'Cette version du contrat n’est pas encore disponible.'}
      </strong>
      <span>{ar ? 'يرجى اختيار نسخة أخرى أو التواصل معنا.' : 'Choisissez une autre version ou contactez-nous.'}</span>
    </div>
  );
}

/**
 * Texte intégré du contrat particulier / français (portage fidèle de
 * orta/files/contrat.php) : affiché tant qu'aucun PDF n'est chargé pour
 * cette version.
 */
function ContratParticulierFrTexte() {
  return (
    <>
      <div className="contract-toolbar no-print">
        <button type="button" className="btn-print" onClick={() => window.print()}>
          <i className="fa fa-print" /> Imprimer le contrat
        </button>
      </div>

      <div className="contract-container" dir="ltr" lang="fr">
        <div className="watermark" aria-hidden="true">ORTALOG</div>

        <h2>CONTRAT DE PRESTATION DE SERVICES</h2>

        <p>
          <strong>Entre les parties :</strong>
        </p>

        <p>
          <strong>D'une part,</strong>
          <br />
          La société <strong>ORTALOG</strong>, une société à responsabilité limitée, au
          capital de {HOME_INFO.capital} dirhams, dont le siège social est situé au{' '}
          <strong>{HOME_INFO.siegeFr}</strong>, immatriculée au registre de commerce de{' '}
          {HOME_INFO.rcVille} sous le numéro <strong>{HOME_INFO.rc}</strong>, et disposant
          de l'ICE <strong>N° {HOME_INFO.ice}</strong>, ci-après dénommée{' '}
          <strong>le « Prestataire »</strong>.
        </p>

        <p>
          <strong>D'autre part,</strong>
          <br />
          Mr (Mme) ..........................................................................................,
          <br />
          résidant à .......................................................................................... ,
          <br />
          joignable au numéro : .................................., identifié(e) par
          l'email : .............................................. ,
          <br />
          ci-après dénommé(e) <strong>le « Client »</strong>.
        </p>

        <p>Les deux parties conviennent des termes et conditions suivants :</p>

        <hr />

        <h4>ARTICLE 1 : OBJET DU CONTRAT &amp; NATURE DE LA PRESTATION</h4>
        <p>
          Le présent contrat établit les modalités de la prestation de services consistant
          en :{' '}
          <strong>
            Ramassage et livraison à domicile d'envois préparés et emballés par le Client,
            avec possibilité de service contre remboursement.
          </strong>
          <br />
          Les colis doivent être correctement fermés, conditionnés et sécurisés par le
          Client.
        </p>

        <h4>ARTICLE 2 : EXÉCUTION DE LA PRESTATION</h4>
        <p>
          Les principales missions du Prestataire comprennent le ramassage des colis, le
          transport des envois, la livraison à domicile dans les délais prévus, le retour
          des colis en cas de non-réception, ainsi que le retour de fonds, sauf en cas de
          force majeure.
        </p>

        <h4>ARTICLE 3 : FACTURATION &amp; PRIX DE LA PRESTATION</h4>
        <p>
          La prestation de livraison s'effectue <strong>contre remboursement</strong>. Les
          frais de transport sont facturés selon les tarifs de chaque destination
          disponibles sur le site web du Prestataire.
        </p>
        <p>
          En cas de retour des envois, le retour est <strong>gratuit</strong>.
        </p>
        <p>Le Client peut bénéficier de remises selon son volume mensuel d'envois.</p>

        <h4>ARTICLE 4 : DURÉE &amp; VALIDITÉ DU CONTRAT</h4>
        <p>
          Le contrat prend effet à compter de la{' '}
          <strong>première utilisation du service</strong>.
        </p>

        <h4>ARTICLE 5 : NATURE DES OBLIGATIONS</h4>
        <p>
          Le Client s'engage à garantir l'absence de contenus dangereux ou prohibés dans
          ses envois.
        </p>
        <p>
          Le Prestataire s'engage à prendre toutes les mesures nécessaires à la bonne
          exécution du service.
        </p>

        <h4>ARTICLE 6 : ACCÈS AUX INFORMATIONS</h4>
        <ul>
          <li>Un interlocuteur dédié,</li>
          <li>Une procédure sécurisée de traitement,</li>
          <li>Un accès pour enregistrer les colis,</li>
          <li>
            Un système de suivi sur <strong>{HOME_INFO.siteWeb}</strong>.
          </li>
        </ul>

        <h4>ARTICLE 7 : RESPONSABILITÉ</h4>
        <p>
          Sauf force majeure, en cas de perte ou avarie due à une faute du Prestataire, sa
          responsabilité est limitée à une indemnité déterminée.
        </p>
        <p>
          Réclamation possible dans un délai de <strong>1 mois</strong> après dépôt.
        </p>

        <h4>ARTICLE 8 : CONFIDENTIALITÉ</h4>
        <p>
          Les parties s'engagent à préserver la confidentialité des informations liées au
          contrat.
        </p>

        <h4>ARTICLE 9 : RÉSILIATION &amp; LITIGES</h4>
        <p>Résiliation possible avec préavis d'un mois.</p>
        <p>
          Compétence du <strong>Tribunal de Commerce de Rabat</strong>.
        </p>

        <table className="signature-table">
          <tbody>
            <tr>
              <td>
                <strong>Prestataire</strong>
                <br />
                <br />
                __________________________
              </td>
              <td>
                <strong>Client</strong>
                <br />
                <br />
                __________________________
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function ContratPublic() {
  const [contrats, setContrats] = useState(null); // null = chargement en cours
  const [type, setType] = useState('particulier');
  const [lang, setLang] = useState('ar');

  // Les règles @media print du contrat (home.css) sont scopées sur cette
  // classe body : elles ne s'appliquent que tant que la page est montée,
  // sans perturber l'impression du reste de l'application.
  useEffect(() => {
    document.body.classList.add('print-contrat');
    return () => document.body.classList.remove('print-contrat');
  }, []);

  // Versions en ligne ; la première disponible est affichée par défaut.
  // Aucune version chargée (ou API injoignable) : texte intégré particulier / français.
  useEffect(() => {
    api
      .get('/platform/contrats')
      .then(({ data }) => {
        setContrats(data);
        const [t, l] = (DEFAULT_ORDER.find((v) => data[v]) || 'particulier_fr').split('_');
        setType(t);
        setLang(l);
      })
      .catch(() => {
        setContrats({});
        setType('particulier');
        setLang('fr');
      });
  }, []);

  const version = `${type}_${lang}`;
  const doc = contrats?.[version] || null;
  const loading = contrats === null;
  const texteIntegre = !loading && !doc && version === 'particulier_fr';

  return (
    <div className="home-ar" dir="rtl" lang="ar">
      <nav className="navbar-custom no-print">
        <div className="container page-nav-inner">
          <Link to="/" className="btn-nav-solid">
            <i className="fa fa-home" /> الرئيسية
          </Link>
          <Link to="/" className="navbar-brand">
            <img className="logo-header" src="/home/header-logo.png" width="780" height="220" alt="أورطالوج" />
          </Link>
        </div>
      </nav>

      <div className="tarifs-hero no-print">
        <div className="container">
          <div className="tarifs-hero-badge">
            <i className="fa fa-file-signature" /> عقد الخدمة
          </div>
          <h1>عقد تقديم الخدمات</h1>
          <p>Contrat de prestation de services — ORTALOG</p>
        </div>
      </div>

      <section className="legal-section">
        <div className="container">
          <div className="contrat-switches no-print">
            <div className="contrat-switch" role="tablist" aria-label="نوع العميل">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={type === t.id}
                  className={type === t.id ? 'active' : ''}
                  onClick={() => setType(t.id)}
                >
                  <i className={`fa ${t.icon}`} aria-hidden="true" /> {t.ar} <small>{t.fr}</small>
                </button>
              ))}
            </div>
            <div className="contrat-switch" role="tablist" aria-label="اللغة">
              {LANGS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="tab"
                  lang={l.id}
                  aria-selected={lang === l.id}
                  className={lang === l.id ? 'active' : ''}
                  onClick={() => setLang(l.id)}
                >
                  <i className="fa fa-globe" aria-hidden="true" /> {l.label}
                </button>
              ))}
            </div>
          </div>

          {loading && (
            <div className="contrat-empty">
              <i className="fa fa-spinner fa-spin" aria-hidden="true" />
              <span>جارٍ التحميل…</span>
            </div>
          )}
          {doc && <ContratPdf doc={doc} version={version} lang={lang} />}
          {!loading && !doc && !texteIntegre && <ContratIndisponible lang={lang} />}
          {texteIntegre && <ContratParticulierFrTexte />}
        </div>
      </section>

      <HomeFooter />
    </div>
  );
}
