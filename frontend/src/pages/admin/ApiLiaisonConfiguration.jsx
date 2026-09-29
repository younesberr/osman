import { useCallback, useEffect, useState } from 'react';
import { BookOpen, History, KeyRound, Link2, Lock, MessageCircle, Plug, Save, Send, SlidersHorizontal, Wand2 } from 'lucide-react';
import api from '../../api/client';
import SecretInput from '../../components/SecretInput';
import Toggle from '../../components/Toggle';
import { CopyBtn } from '../../components/ApiDocBlocks';
import { QUALITE, formatDateHeure, genererVerifyToken, urlWebhook } from '../../utils/whatsapp';
import ApiLiaisonGuide from './ApiLiaisonGuide';
import ApiLiaisonJournal from './ApiLiaisonJournal';
import ApiLiaisonParametresCrm from './ApiLiaisonParametresCrm';

/*
 * Page /admin/api-liaison/configuration — liaison avec l'API WhatsApp Business
 * Cloud de Meta (service API_LIAISON, fonctions 1 et 2).
 * Quatre onglets : Configuration (identifiants, secrets, tests), Guide pas à pas
 * (checklist + étapes côté Meta, écrit pour un débutant), Journal des messages
 * et Paramètres CRM (heures calmes, réponse automatique, opt-out, réponses rapides).
 * API : /api/whatsapp/* (backend/src/controllers/whatsapp.controller.js).
 * Les secrets ne transitent jamais en clair du serveur vers la page : le
 * serveur renvoie { defini, masque, dechiffrable } ; un champ laissé vide
 * conserve la valeur enregistrée.
 */

const TABS = [
  { key: 'config', label: 'Configuration', icon: Plug },
  { key: 'guide', label: 'Guide pas à pas', icon: BookOpen },
  { key: 'journal', label: 'Journal des messages', icon: History },
  { key: 'crm', label: 'Paramètres CRM', icon: SlidersHorizontal }
];

/** Libellé + champ + aide « où le trouver ». */
function Field({ label, hint, children }) {
  return (
    <div className="wa-field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="wa-field-hint">{hint}</span>}
    </div>
  );
}

/** Badge d'état global de la liaison. */
function etatBadge(config) {
  if (config.etat === 'non_configure') return { label: 'Non configuré', cls: 'badge-neutral' };
  const test = config.dernierTest;
  if (test && test.ok === false) return { label: 'Erreur au dernier test', cls: 'badge-inactive' };
  if (config.etat === 'inactif') return { label: test ? 'Testé, désactivé' : 'Désactivé', cls: 'badge-attente' };
  return { label: test ? 'Connecté' : 'Prêt (non testé)', cls: 'badge-active' };
}

/** Bandeau du haut : état, informations du dernier test, alertes serveur. */
function EtatBanner({ config }) {
  const badge = etatBadge(config);
  const test = config.dernierTest;
  const qualite = test?.qualityRating ? QUALITE[test.qualityRating] || [test.qualityRating, 'badge-neutral'] : null;
  const illisible = !config.accessToken.dechiffrable || !config.appSecret.dechiffrable;

  return (
    <section className="platform-card wa-etat-card">
      <div className="wa-etat">
        <div className="wa-etat-titre">
          <MessageCircle size={20} /> Liaison WhatsApp Business (Meta)
        </div>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
      </div>
      {test && test.ok !== false && (
        <div className="wa-etat-infos">
          <span>
            Nom vérifié : <strong>{test.verifiedName || '—'}</strong>
          </span>
          <span>
            Numéro : <strong>{test.displayPhoneNumber || '—'}</strong>
          </span>
          {qualite && (
            <span>
              Qualité : <span className={`badge ${qualite[1]}`}>{qualite[0]}</span>
            </span>
          )}
          <span>
            Dernier test : <strong>{formatDateHeure(test.date)}</strong>
          </span>
        </div>
      )}
      {test && test.ok === false && (
        <div className="form-error">
          Dernier test ({formatDateHeure(test.date)}) : {test.erreur}
        </div>
      )}
      {!config.secretKeyConfigured && (
        <div className="form-error">
          <strong>Clé de chiffrement absente sur le serveur.</strong> Le jeton d'accès et la clé secrète ne peuvent pas
          être enregistrés tant que la variable <code>WHATSAPP_SECRET_KEY</code> (au moins 32 caractères) n'est pas
          définie : en local dans <code>backend/.env</code> puis redémarrage du serveur ; en production dans les
          variables d'environnement de l'application Node (Hostinger hPanel). Les autres champs restent modifiables.
        </div>
      )}
      {config.secretKeyConfigured && illisible && (
        <div className="form-notice">
          La clé de chiffrement du serveur a changé : une valeur enregistrée est devenue illisible. Saisissez de nouveau
          le jeton d'accès et/ou la clé secrète de l'app, puis enregistrez.
        </div>
      )}
    </section>
  );
}

/** Copie éditable de la configuration (secrets vides = conserver). */
function formDepuisConfig(cfg) {
  return {
    actif: Boolean(cfg.actif),
    phoneNumberId: cfg.phoneNumberId || '',
    wabaId: cfg.wabaId || '',
    apiVersion: cfg.apiVersion || cfg.apiVersionDefaut,
    testPhone: cfg.testPhone || '',
    verifyToken: cfg.verifyToken || '',
    accessToken: '',
    appSecret: ''
  };
}

function OngletConfiguration({ config, onSaved, onRefresh }) {
  const [form, setForm] = useState(() => formDepuisConfig(config));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [testConn, setTestConn] = useState({ busy: false, result: null, error: '' });
  const [testMsg, setTestMsg] = useState({ busy: false, result: null, error: '' });
  const [abonnement, setAbonnement] = useState({ busy: false, result: '', error: '' });

  // Resynchronise le formulaire quand la config est rechargée (après enregistrement ou test).
  useEffect(() => {
    setForm(formDepuisConfig(config));
  }, [config]);

  const dirty = JSON.stringify(form) !== JSON.stringify(formDepuisConfig(config));
  const secretsBloques = !config.secretKeyConfigured;
  const webhookUrlLocale = urlWebhook(window.location.origin);

  function setField(field, value) {
    setFeedback(null);
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    const payload = {
      actif: form.actif,
      phoneNumberId: form.phoneNumberId.trim(),
      wabaId: form.wabaId.trim(),
      apiVersion: form.apiVersion.trim(),
      testPhone: form.testPhone.trim(),
      verifyToken: form.verifyToken.trim()
    };
    // Secret : null = effacer, chaîne non vide = remplacer, absent = conserver.
    for (const field of ['accessToken', 'appSecret']) {
      if (form[field] === null) payload[field] = null;
      else if (form[field] && form[field].trim()) payload[field] = form[field].trim();
    }
    try {
      const res = await api.put('/whatsapp/configuration', payload);
      onSaved(res.data);
      setFeedback({ type: 'success', text: res.data.message || 'Configuration enregistrée.' });
    } catch (err) {
      if (err.response?.data?.configuration) onSaved(err.response.data.configuration);
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function testerConnexion() {
    setTestConn({ busy: true, result: null, error: '' });
    try {
      const res = await api.post('/whatsapp/test-connexion');
      setTestConn({ busy: false, result: res.data, error: '' });
    } catch (err) {
      setTestConn({ busy: false, result: null, error: err.response?.data?.message || 'Test impossible.' });
    }
    onRefresh();
  }

  async function envoyerTest() {
    setTestMsg({ busy: true, result: null, error: '' });
    try {
      const res = await api.post('/whatsapp/test-message');
      setTestMsg({ busy: false, result: res.data, error: '' });
    } catch (err) {
      setTestMsg({ busy: false, result: null, error: err.response?.data?.message || 'Envoi impossible.' });
    }
  }

  async function abonner() {
    setAbonnement({ busy: true, result: '', error: '' });
    try {
      const res = await api.post('/whatsapp/abonner-webhook');
      setAbonnement({ busy: false, result: res.data.message, error: '' });
    } catch (err) {
      setAbonnement({ busy: false, result: '', error: err.response?.data?.message || 'Abonnement impossible.' });
    }
  }

  const testsDesactives = config.etat === 'non_configure' || dirty;
  const raisonTests = dirty
    ? "Enregistrez d'abord vos modifications : les tests utilisent la configuration enregistrée."
    : config.etat === 'non_configure'
      ? "Renseignez le Phone Number ID et le jeton d'accès, puis enregistrez pour débloquer les tests."
      : '';
  const qualiteTest = testConn.result?.qualityRating
    ? QUALITE[testConn.result.qualityRating]?.[0] || testConn.result.qualityRating
    : '—';

  return (
    <>
      <form onSubmit={save}>
        <section className="platform-card">
          <h2>
            <KeyRound size={18} /> Identifiants Meta
          </h2>
          <div className="societe-grid">
            <Field
              label="Phone Number ID"
              hint="Où le trouver : developers.facebook.com › votre app › WhatsApp › Démarrage rapide (API Setup), sous le numéro de test. Ce n'est pas le numéro de téléphone lui-même."
            >
              <input
                type="text"
                inputMode="numeric"
                value={form.phoneNumberId}
                maxLength={32}
                placeholder="Ex. : 106540352242922"
                onChange={(e) => setField('phoneNumberId', e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field
              label="WhatsApp Business Account ID (WABA ID)"
              hint="Même écran, juste en dessous du Phone Number ID (« Identifiant du compte WhatsApp Business »)."
            >
              <input
                type="text"
                inputMode="numeric"
                value={form.wabaId}
                maxLength={32}
                placeholder="Ex. : 102290129340398"
                onChange={(e) => setField('wabaId', e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field
              label="Version de l'API Graph"
              hint={`Laissez la valeur par défaut (${config.apiVersionDefaut}) sauf indication contraire de Meta.`}
            >
              <input
                type="text"
                value={form.apiVersion}
                maxLength={8}
                placeholder={config.apiVersionDefaut}
                onChange={(e) => setField('apiVersion', e.target.value.trim())}
              />
            </Field>
            <Field
              label="Numéro de test (destinataire)"
              hint="Votre propre numéro WhatsApp, ajouté dans la liste des destinataires de test chez Meta (5 maximum). Format 06XXXXXXXX."
            >
              <input
                type="tel"
                value={form.testPhone}
                maxLength={14}
                placeholder="Ex. : 0612345678"
                onChange={(e) => setField('testPhone', e.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="platform-card">
          <h2>
            <Lock size={18} /> Secrets et webhook
          </h2>
          {secretsBloques && (
            <div className="form-notice">
              Clé de chiffrement absente sur le serveur : les secrets ne peuvent pas être enregistrés pour l'instant
              (voir le bandeau en haut de page). Les autres champs restent modifiables.
            </div>
          )}
          <div className="wa-secrets-grid">
            <SecretInput
              label="Jeton d'accès (Access Token)"
              hint="Jeton temporaire (24 h) pour essayer, puis jeton permanent d'utilisateur système (Guide, étape 6). Ne le partagez jamais."
              value={form.accessToken}
              onChange={(v) => setField('accessToken', v)}
              defini={config.accessToken.defini}
              masque={config.accessToken.masque}
              dechiffrable={config.accessToken.dechiffrable}
              disabled={secretsBloques}
              placeholder="Collez le jeton (commence souvent par EAA…)"
            />
            <SecretInput
              label="Clé secrète de l'app (App Secret)"
              hint="developers.facebook.com › votre app › Paramètres de l'app › Général › Clé secrète › Afficher. Sert à vérifier que les webhooks viennent bien de Meta."
              value={form.appSecret}
              onChange={(v) => setField('appSecret', v)}
              defini={config.appSecret.defini}
              masque={config.appSecret.masque}
              dechiffrable={config.appSecret.dechiffrable}
              disabled={secretsBloques}
              placeholder="32 caractères hexadécimaux"
            />
            <Field
              label="Jeton de vérification du webhook (Verify Token)"
              hint="Mot de passe que vous inventez : Meta vous le demande lors de la configuration du webhook. Cliquez sur « Générer », enregistrez, puis copiez-le chez Meta."
            >
              <div className="wa-readonly">
                <input type="text" readOnly value={form.verifyToken} placeholder="Cliquez sur « Générer »" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setField('verifyToken', genererVerifyToken())}
                >
                  <Wand2 size={14} /> Générer
                </button>
                {form.verifyToken && <CopyBtn text={form.verifyToken} title="Copier le jeton de vérification" />}
              </div>
            </Field>
            <Field
              label="URL de rappel du webhook (Callback URL)"
              hint="À coller chez Meta (WhatsApp › Configuration › Webhook). En local, remplacez l'origine par l'URL publique de votre tunnel : voir le Guide, étape 7."
            >
              <div className="wa-readonly">
                <input type="text" readOnly value={webhookUrlLocale} />
                <CopyBtn text={webhookUrlLocale} title="Copier l’URL de rappel" />
              </div>
            </Field>
          </div>
          <div className="platform-actions wa-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <div className="wa-switch-row">
              <Toggle checked={form.actif} onChange={(v) => setField('actif', v)} label="Intégration activée" />
              <span>Intégration activée</span>
            </div>
            {feedback && (
              <span className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</span>
            )}
          </div>
          <p className="wa-field-hint">
            L'interrupteur autorise les envois automatiques (Actions automatiques) et les envois depuis les
            Discussions. Les tests ci-dessous fonctionnent même s'il est éteint.
          </p>
        </section>
      </form>

      <section className="platform-card">
        <h2>
          <Send size={18} /> Tests
        </h2>
        {raisonTests && <div className="form-notice">{raisonTests}</div>}
        <div className="wa-tests">
          <div className="wa-test-bloc">
            <h3>1. Tester la connexion</h3>
            <p>
              Interroge Meta avec votre jeton et votre Phone Number ID : si tout est bon, le nom vérifié et le numéro
              s'affichent. Aucun message n'est envoyé.
            </p>
            <div className="platform-actions wa-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={testsDesactives || testConn.busy}
                onClick={testerConnexion}
              >
                <Plug size={15} /> {testConn.busy ? 'Test en cours…' : 'Tester la connexion'}
              </button>
              {testConn.error && <span className="field-error">{testConn.error}</span>}
            </div>
            {testConn.result && (
              <div className="wa-test-result">
                <div>
                  <span>Nom vérifié</span>
                  <strong>{testConn.result.verifiedName || '—'}</strong>
                </div>
                <div>
                  <span>Numéro</span>
                  <strong>{testConn.result.displayPhoneNumber || '—'}</strong>
                </div>
                <div>
                  <span>Qualité du numéro</span>
                  <strong>{qualiteTest}</strong>
                </div>
                <div>
                  <span>Version API</span>
                  <strong>{testConn.result.apiVersion}</strong>
                </div>
              </div>
            )}
          </div>

          <div className="wa-test-bloc">
            <h3>2. Envoyer un message de test</h3>
            <p>
              Envoie le modèle <code>hello_world</code> (fourni par Meta) au numéro de test{' '}
              {config.testPhone ? <strong>{config.testPhone}</strong> : '(à renseigner ci-dessus)'}. Le résultat et les
              accusés de réception apparaissent dans l'onglet Journal.
            </p>
            <div className="platform-actions wa-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={testsDesactives || testMsg.busy || !config.testPhone}
                onClick={envoyerTest}
              >
                <Send size={15} /> {testMsg.busy ? 'Envoi…' : 'Envoyer le message de test'}
              </button>
              {testMsg.error && <span className="field-error">{testMsg.error}</span>}
              {testMsg.result && <span className="field-success">{testMsg.result.message}</span>}
            </div>
          </div>

          <div className="wa-test-bloc">
            <h3>3. Abonner l'app aux webhooks du compte (facultatif)</h3>
            <p>
              À utiliser au passage en production si les accusés de réception n'arrivent plus : lie explicitement votre
              app au compte WhatsApp Business (WABA ID requis).
            </p>
            <div className="platform-actions wa-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={testsDesactives || abonnement.busy || !config.wabaId}
                onClick={abonner}
              >
                <Link2 size={14} /> {abonnement.busy ? 'Abonnement…' : "Abonner l'app"}
              </button>
              {abonnement.error && <span className="field-error">{abonnement.error}</span>}
              {abonnement.result && <span className="field-success">{abonnement.result}</span>}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export default function ApiLiaisonConfiguration() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('config');

  const refresh = useCallback(
    () =>
      api
        .get('/whatsapp/configuration')
        .then((res) => setConfig(res.data))
        .catch(() => {}),
    []
  );

  useEffect(() => {
    api
      .get('/whatsapp/configuration')
      .then((res) => setConfig(res.data))
      .catch((err) =>
        setLoadError(err.response?.data?.message || 'Impossible de charger la configuration WhatsApp.')
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="modal-loading">Chargement…</div>;
  if (!config) return <div className="form-error">{loadError}</div>;

  return (
    <div className="platform-page config-page wa-page">
      <EtatBanner config={config} />

      <nav className="fiche-tabs" aria-label="Onglets API liaison">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`fiche-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === 'config' && <OngletConfiguration config={config} onSaved={setConfig} onRefresh={refresh} />}
      {tab === 'guide' && <ApiLiaisonGuide config={config} />}
      {tab === 'journal' && <ApiLiaisonJournal />}
      {tab === 'crm' && <ApiLiaisonParametresCrm />}
    </div>
  );
}
