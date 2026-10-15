import { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Building2, FileSignature, FileText, Image, Palette, Save, Upload } from 'lucide-react';
import api from '../../api/client';
import { usePlatform } from '../../context/PlatformContext';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Champ d'upload d'image (logo ou icône) avec aperçu et envoi immédiat. */
function UploadField({ label, hint, kind, value, onUploaded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post(`/platform/upload/${kind}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onUploaded(res.data.url);
    } catch (err) {
      setError(err.response?.data?.message || "Échec de l'envoi du fichier.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="upload-field">
      <span className="field-label">{label}</span>
      <div className="upload-row">
        <div className={`upload-preview ${kind === 'icon' ? 'upload-preview-icon' : ''}`}>
          {value ? <img src={value} alt={label} /> : <Image size={26} className="upload-placeholder" />}
        </div>
        <div className="upload-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={15} /> {busy ? 'Envoi…' : value ? 'Remplacer' : 'Choisir un fichier'}
          </button>
          <span className="upload-hint">{hint}</span>
          {error && <span className="field-error">{error}</span>}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.svg,.webp,.ico"
          hidden
          onChange={handleChange}
        />
      </div>
    </div>
  );
}

/** Sélecteur de couleur : pastille native + saisie hexadécimale synchronisées. */
function ColorField({ label, value, onChange }) {
  const valid = HEX_RE.test(value);
  return (
    <label className="color-field">
      <span className="field-label">{label}</span>
      <span className="color-row">
        <input type="color" value={valid ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
        <input
          type="text"
          className={`color-hex ${valid ? '' : 'invalid'}`}
          value={value}
          maxLength={7}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={BRAND.colorPrimary}
        />
      </span>
    </label>
  );
}

/* Champs texte de la section Information société : [clé API, libellé, placeholder]. */
const SOCIETE_FIELDS = [
  ['nom', 'Nom de la société', `Ex. : ${BRAND.name}`],
  ['siege', 'Siège social', 'Adresse complète du siège'],
  ['telFixe', 'Téléphone fixe', 'Ex. : 05 22 00 00 00'],
  ['telMobile', 'Téléphone mobile', 'Ex. : 06 00 00 00 00'],
  ['email', 'Email', 'contact@societe.ma'],
  ['website', 'Site web', 'https://www.societe.ma'],
  ['ice', 'ICE', 'Identifiant commun de l’entreprise'],
  ['rc', 'RC', 'Registre de commerce'],
  ['ifFiscal', 'IF', 'Identifiant fiscal'],
  ['cnss', 'CNSS', 'N° d’affiliation CNSS']
];

const SOCIETE_EMPTY = Object.fromEntries([...SOCIETE_FIELDS.map(([k]) => [k, '']), ['formeJuridique', '']]);

/** Section « Information société » : coordonnées et identifiants légaux (delevery_configs). */
function SocieteSection() {
  const [societe, setSociete] = useState(SOCIETE_EMPTY);
  const [formes, setFormes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    api
      .get('/platform/societe')
      .then((res) => setSociete({ ...SOCIETE_EMPTY, ...res.data }))
      .catch(() => setFeedback({ type: 'error', text: 'Impossible de charger les informations société.' }));
    api
      .get('/config/listes/formes-juridiques')
      .then((res) => setFormes(res.data.filter((f) => f.active === 1)))
      .catch(() => setFormes([]));
  }, []);

  function setField(field, value) {
    setSociete((s) => ({ ...s, [field]: value }));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await api.put('/platform/societe', societe);
      setFeedback({ type: 'success', text: 'Information société enregistrée.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  // La forme juridique enregistrée reste proposée même si elle a été désactivée depuis.
  const formeOptions = formes.map((f) => f.val);
  if (societe.formeJuridique && !formeOptions.includes(societe.formeJuridique)) {
    formeOptions.unshift(societe.formeJuridique);
  }

  return (
    <section className="platform-card">
      <h2>
        <Building2 size={18} /> Information société
      </h2>
      <form onSubmit={save}>
        <div className="societe-grid">
          <label>
            <span className="field-label">Nom de la société</span>
            <input
              type="text"
              value={societe.nom}
              maxLength={255}
              placeholder={`Ex. : ${BRAND.name}`}
              onChange={(e) => setField('nom', e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Forme juridique</span>
            <select value={societe.formeJuridique} onChange={(e) => setField('formeJuridique', e.target.value)}>
              <option value="">— Choisir —</option>
              {formeOptions.map((val) => (
                <option key={val} value={val}>
                  {val}
                </option>
              ))}
            </select>
          </label>
          {SOCIETE_FIELDS.filter(([key]) => key !== 'nom').map(([key, label, placeholder]) => (
            <label key={key}>
              <span className="field-label">{label}</span>
              <input
                type={key === 'email' ? 'email' : 'text'}
                value={societe[key]}
                maxLength={255}
                placeholder={placeholder}
                onChange={(e) => setField(key, e.target.value)}
              />
            </label>
          ))}
        </div>
        <div className="platform-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer les informations'}
          </button>
          {feedback && <span className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</span>}
        </div>
      </form>
    </section>
  );
}

/* Les quatre versions du contrat de prestation de la page publique /contrat : [version, libellé]. */
const CONTRAT_VERSIONS = [
  ['particulier_fr', 'Particulier — Français'],
  ['particulier_ar', 'Particulier — Arabe'],
  ['societe_fr', 'Société — Français'],
  ['societe_ar', 'Société — Arabe']
];

function formatTaille(octets) {
  if (octets >= 1024 * 1024) return `${(octets / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
  return `${Math.max(1, Math.round(octets / 1024))} Ko`;
}

/** Champ d'upload d'un PDF de contrat : fichier en place (lien, taille, date) et envoi immédiat. */
function ContratUploadField({ version, label, value, onUploaded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post(`/platform/contrats/${version}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onUploaded(version, res.data.contrat);
    } catch (err) {
      setError(err.response?.data?.message || "Échec de l'envoi du fichier.");
    } finally {
      setBusy(false);
    }
  }

  // Sans PDF, la version « particulier / français » garde le texte intégré de la page ;
  // les trois autres sont signalées comme non disponibles.
  const hint =
    version === 'particulier_fr'
      ? 'Aucun fichier : la page publique affiche le texte intégré du contrat (particulier, français).'
      : 'Aucun fichier : cette version est signalée « non disponible » sur la page publique.';

  return (
    <div className="upload-field">
      <span className="field-label">{label}</span>
      <div className="upload-row">
        <div className={`upload-preview upload-preview-doc ${value ? 'has-file' : ''}`}>
          <FileText size={24} />
          <span>PDF</span>
        </div>
        <div className="upload-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={15} /> {busy ? 'Envoi…' : value ? 'Remplacer' : 'Choisir un fichier'}
          </button>
          {value ? (
            <span className="upload-doc-meta">
              <a href={value.url} target="_blank" rel="noreferrer">
                Voir le PDF
              </a>
              {' · '}
              {formatTaille(value.size)}
              {' · mis à jour le '}
              {new Date(value.updatedAt).toLocaleDateString('fr-FR')}
            </span>
          ) : (
            <span className="upload-hint">{hint}</span>
          )}
          {error && <span className="field-error">{error}</span>}
        </div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={handleChange} />
      </div>
    </div>
  );
}

/** Section « Contrats de prestation » : les quatre PDF (particulier / société × français / arabe) de /contrat. */
function ContratsSection() {
  const [contrats, setContrats] = useState({});
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api
      .get('/platform/contrats')
      .then((res) => setContrats(res.data))
      .catch(() => setLoadError('Impossible de charger les contrats en place.'));
  }, []);

  return (
    <section className="platform-card">
      <h2>
        <FileSignature size={18} /> Contrats de prestation
      </h2>
      <p className="section-sub">
        Documents PDF affichés sur la page publique{' '}
        <a href="/contrat" target="_blank" rel="noreferrer">
          /contrat
        </a>{' '}
        : le visiteur choisit Particulier ou Société, puis la langue. Le fichier remplace immédiatement
        la version en ligne (PDF, max 10 Mo).
      </p>
      <div className="contrats-grid">
        {CONTRAT_VERSIONS.map(([version, label]) => (
          <ContratUploadField
            key={version}
            version={version}
            label={label}
            value={contrats[version]}
            onUploaded={(v, info) => setContrats((c) => ({ ...c, [v]: info }))}
          />
        ))}
      </div>
      {loadError && <span className="field-error">{loadError}</span>}
    </section>
  );
}

export default function PlatformSettings() {
  const { config, refresh } = usePlatform();
  const [colorPrimary, setColorPrimary] = useState(config.colorPrimary);
  const [colorSecondary, setColorSecondary] = useState(config.colorSecondary);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Resynchronise le formulaire quand la config arrive du serveur.
  useEffect(() => {
    setColorPrimary(config.colorPrimary);
    setColorSecondary(config.colorSecondary);
  }, [config.colorPrimary, config.colorSecondary]);

  async function saveColors() {
    if (!HEX_RE.test(colorPrimary) || !HEX_RE.test(colorSecondary)) {
      setFeedback({ type: 'error', text: `Format de couleur invalide (ex. : ${BRAND.colorPrimary}).` });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      await api.put('/platform/config', { colorPrimary, colorSecondary });
      await refresh();
      setFeedback({ type: 'success', text: 'Couleurs enregistrées et appliquées.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="platform-page config-page">
      <section className="platform-card">
        <h2>
          <Image size={18} /> Logo &amp; icône
        </h2>
        <UploadField
          label="Logo de la société"
          hint="Affiché dans la barre du haut et sur la page de connexion (png, jpg, svg, webp — max 2 Mo)."
          kind="logo"
          value={config.logo}
          onUploaded={refresh}
        />
        <UploadField
          label="Icône (favicon)"
          hint="Icône de l'onglet du navigateur (png, svg, ico — idéalement carrée)."
          kind="icon"
          value={config.icon}
          onUploaded={refresh}
        />
      </section>

      <section className="platform-card">
        <h2>
          <Palette size={18} /> Couleurs de marque
        </h2>
        <div className="color-grid">
          <ColorField label="Couleur principale" value={colorPrimary} onChange={setColorPrimary} />
          <ColorField label="Couleur secondaire" value={colorSecondary} onChange={setColorSecondary} />
        </div>
        <div className="platform-actions">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={saveColors}>
            <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer les couleurs'}
          </button>
          {feedback && <span className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</span>}
        </div>
      </section>

      <SocieteSection />
      <ContratsSection />
    </div>
  );
}
