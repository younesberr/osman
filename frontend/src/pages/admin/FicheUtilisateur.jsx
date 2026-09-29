import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Briefcase,
  CalendarDays,
  Check,
  Clock,
  Contact,
  FileText,
  IdCard,
  KeyRound,
  Landmark,
  MapPin,
  Star,
  UserRound,
  Wrench
} from 'lucide-react';
import api from '../../api/client';
import ComptesUtilisateur from '../../components/ComptesUtilisateur';
import CongesAbsences from '../../components/CongesAbsences';
import MaterielAffectations from '../../components/MaterielAffectations';
import ParcoursProfessionnel from '../../components/ParcoursProfessionnel';
import SearchableSelect from '../../components/SearchableSelect';

const TYPE_LABELS = {
  SUPER_ADMIN: 'Super admin',
  RESPONSABLE_SERVICE: 'Responsable service',
  RESPONSABLE_AGENCE: "Responsable d'agence",
  AGENT_AGENCE: "Agent d'agence",
  RAMASSEUR: 'Ramasseur',
  LIVREUR: 'Livreur'
};

const TABS = [
  { key: 'comptes', label: 'Comptes', icon: KeyRound },
  { key: 'infos', label: 'Infos personnelles', icon: Contact },
  { key: 'parcours', label: 'Parcours professionnel', icon: Briefcase },
  { key: 'evaluation', label: 'Évaluation', icon: Star },
  { key: 'conges', label: 'Congés & absences', icon: CalendarDays },
  { key: 'materiels', label: 'Matériels', icon: Wrench }
];

/* Champs texte / date / select de l'onglet Infos personnelles (état du formulaire). */
const FORM_FIELDS = [
  'users_name',
  'users_cin',
  'users_cin_expiration',
  'users_date_naissance',
  'users_city',
  'users_address',
  'users_phone',
  'users_bank',
  'users_rib',
  'users_permis_numero',
  'users_permis_expiration',
  'users_visite_medicale_expiration'
];

/* Champs fichier : nom multipart → colonne renvoyée par l'API. */
const FILE_FIELDS = {
  cin_recto: 'users_cin_recto_image',
  cin_verso: 'users_cin_verso_image',
  rib: 'users_rib_image',
  permis: 'users_permis_fichier',
  visite_medicale: 'users_visite_medicale'
};

/** 'AAAA-MM-JJ HH:MM:SS' → 'AAAA-MM-JJ HH:MM:SS' (déjà lisible) — garde tel quel. */
function ficheToForm(fiche) {
  const form = {};
  for (const f of FORM_FIELDS) form[f] = fiche[f] ?? '';
  return form;
}

/** Libellé d'un champ fichier : lien si le fichier est servi, sinon nom brut (legacy). */
function FileValue({ value }) {
  if (!value) return <span className="fiche-file-empty">Aucun fichier n’a été sélectionné</span>;
  if (value.startsWith('/uploads/')) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="fiche-file-link">
        <FileText size={14} /> Voir le fichier
      </a>
    );
  }
  return <span className="fiche-file-empty" title={value}>Fichier existant (ancien système)</span>;
}

/** Champ d'upload : bouton "Choisir un fichier" + fichier courant ou sélectionné.
 * `readOnly` (« Ma fiche ») : uniquement le fichier courant, sans bouton d'upload. */
function FileField({ label, hint, name, accept, current, file, onChange, span, readOnly }) {
  return (
    <div className={`fiche-field ${span ? `span-${span}` : ''}`}>
      <span className="field-label">
        {label} <span className="fiche-hint">({hint})</span>
      </span>
      {readOnly ? (
        <span className="fiche-file">
          <span className="fiche-file-name">
            <FileValue value={current} />
          </span>
        </span>
      ) : (
        <label className="fiche-file">
          <span className="fiche-file-btn">Choisir un fichier</span>
          <span className="fiche-file-name">
            {file ? file.name : <FileValue value={current} />}
          </span>
          <input
            type="file"
            accept={accept}
            hidden
            onChange={(e) => onChange(name, e.target.files?.[0] || null)}
          />
        </label>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }) {
  return (
    <h3 className="fiche-section-title">
      <Icon size={15} /> {children}
    </h3>
  );
}

/** Onglet "Infos personnelles" — structure calquée sur la fiche SUIVI.
 * `readOnly` (« Ma fiche ») : consultation seule, sans upload ni enregistrement. */
function InfosPersonnelles({ fiche, options, apiBase, onSaved, readOnly = false }) {
  const [form, setForm] = useState(() => ficheToForm(fiche));
  const [files, setFiles] = useState({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    setForm(ficheToForm(fiche));
    setFiles({});
  }, [fiche]);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function setFile(name, file) {
    setFiles((prev) => ({ ...prev, [name]: file }));
  }

  /* Ville / banque legacy absentes des listes : option supplémentaire pour ne pas perdre la valeur. */
  const villes = useMemo(() => {
    const list = options.villes || [];
    const current = Number(form.users_city);
    if (current && !list.some((v) => v.id === current)) {
      return [...list, { id: current, nom: `Ville n°${current}` }];
    }
    return list;
  }, [options.villes, form.users_city]);

  const banques = useMemo(() => {
    const list = options.banques || [];
    const current = Number(form.users_bank);
    if (current && !list.some((b) => b.id === current)) {
      return [...list, { id: current, nom: `Banque n°${current}` }];
    }
    return list;
  }, [options.banques, form.users_bank]);

  async function save() {
    if (!String(form.users_name).trim() || !String(form.users_cin).trim()) {
      setFeedback({ type: 'error', text: 'Le nom complet et le CIN sont obligatoires.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const data = new FormData();
      for (const f of FORM_FIELDS) data.append(f, form[f] ?? '');
      for (const [name, file] of Object.entries(files)) {
        if (file) data.append(name, file);
      }
      const res = await api.put(`${apiBase}/fiche`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onSaved(res.data);
      setFeedback({ type: 'success', text: 'Fiche enregistrée.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="platform-card fiche-card">
      <header className="fiche-head">
        <span className="fiche-head-icon">
          <Contact size={22} />
        </span>
        <div className="fiche-head-text">
          <h2>Infos personnelles — {fiche.users_name || `Utilisateur n°${fiche.users_id}`}</h2>
          <p className="fiche-head-sub">
            {`Compte utilisateur n°${fiche.users_id}`}
            {/* Zone et agence dérivées de la ville de fonction. */}
            {[fiche.ville_fonction, fiche.zone, fiche.agence].some(Boolean) &&
              ` — ${[fiche.ville_fonction, fiche.zone, fiche.agence].filter(Boolean).join(' · ')}`}
          </p>
        </div>
        <div className="fiche-head-role">
          <span className="fiche-hint">Rôle(s) / mission(s)</span>
          <span className="badge fiche-role-badge">
            <UserRound size={13} /> {TYPE_LABELS[fiche.type_code] || fiche.type_code || '—'}
          </span>
        </div>
      </header>

      <SectionTitle icon={UserRound}>Identité</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">
            Nom complet <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.users_name}
            disabled={readOnly}
            onChange={(e) => setField('users_name', e.target.value)}
            required
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">
            CIN <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.users_cin}
            disabled={readOnly}
            onChange={(e) => setField('users_cin', e.target.value)}
            required
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Date d'expiration CIN</span>
          <input
            type="date"
            value={form.users_cin_expiration}
            disabled={readOnly}
            onChange={(e) => setField('users_cin_expiration', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Date de naissance</span>
          <input
            type="date"
            value={form.users_date_naissance}
            disabled={readOnly}
            onChange={(e) => setField('users_date_naissance', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier CIN — recto"
          hint="PDF"
          name="cin_recto"
          accept=".pdf"
          current={fiche.users_cin_recto_image}
          file={files.cin_recto}
          onChange={setFile}
          span={2}
          readOnly={readOnly}
        />
        <FileField
          label="Fichier CIN — verso"
          hint="PDF"
          name="cin_verso"
          accept=".pdf"
          current={fiche.users_cin_verso_image}
          file={files.cin_verso}
          onChange={setFile}
          span={2}
          readOnly={readOnly}
        />
      </div>

      <SectionTitle icon={MapPin}>Coordonnées</SectionTitle>
      <div className="fiche-grid">
        <div className="fiche-field">
          <span className="field-label">Ville</span>
          {readOnly ? (
            /* SearchableSelect n'a pas d'état désactivé : champ figé à la place. */
            <input
              type="text"
              value={villes.find((v) => String(v.id) === String(form.users_city))?.nom || '—'}
              disabled
            />
          ) : (
            <SearchableSelect
              value={form.users_city}
              onChange={(v) => setField('users_city', String(v))}
              placeholder="— Choisir la ville —"
              options={villes.map((v) => ({ value: v.id, label: v.nom }))}
            />
          )}
        </div>
        <label className="fiche-field span-2">
          <span className="field-label">Adresse</span>
          <input
            type="text"
            value={form.users_address}
            disabled={readOnly}
            onChange={(e) => setField('users_address', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">N° téléphone personnel</span>
          <input
            type="tel"
            value={form.users_phone}
            disabled={readOnly}
            onChange={(e) => setField('users_phone', e.target.value)}
          />
        </label>
      </div>

      <SectionTitle icon={Landmark}>Informations bancaires</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field">
          <span className="field-label">Banque</span>
          <select
            value={form.users_bank}
            disabled={readOnly}
            onChange={(e) => setField('users_bank', e.target.value)}
          >
            <option value="">— Choisir la banque —</option>
            {banques.map((b) => (
              <option key={b.id} value={b.id}>
                {b.nom}
              </option>
            ))}
          </select>
        </label>
        <label className="fiche-field span-2">
          <span className="field-label">RIB</span>
          <input
            type="text"
            maxLength={25}
            value={form.users_rib}
            disabled={readOnly}
            onChange={(e) => setField('users_rib', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier RIB"
          hint="PDF"
          name="rib"
          accept=".pdf"
          current={fiche.users_rib_image}
          file={files.rib}
          onChange={setFile}
          readOnly={readOnly}
        />
      </div>

      <SectionTitle icon={IdCard}>Permis &amp; visite médicale</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field">
          <span className="field-label">Permis n°</span>
          <input
            type="text"
            value={form.users_permis_numero}
            disabled={readOnly}
            onChange={(e) => setField('users_permis_numero', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Date d'expiration permis</span>
          <input
            type="date"
            value={form.users_permis_expiration}
            disabled={readOnly}
            onChange={(e) => setField('users_permis_expiration', e.target.value)}
          />
        </label>
        <FileField
          label="Visite médicale"
          hint="PDF ou image"
          name="visite_medicale"
          accept=".pdf,.png,.jpg,.jpeg,.webp"
          current={fiche.users_visite_medicale}
          file={files.visite_medicale}
          onChange={setFile}
          readOnly={readOnly}
        />
        <label className="fiche-field">
          <span className="field-label">Date d'expiration visite</span>
          <input
            type="date"
            value={form.users_visite_medicale_expiration}
            disabled={readOnly}
            onChange={(e) => setField('users_visite_medicale_expiration', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier permis"
          hint="PDF"
          name="permis"
          accept=".pdf"
          current={fiche.users_permis_fichier}
          file={files.permis}
          onChange={setFile}
          span={2}
          readOnly={readOnly}
        />
      </div>

      <footer className="fiche-footer">
        <span className="fiche-updated">
          <Clock size={14} />
          {fiche.users_fiche_updated_at
            ? `Dernière mise à jour : ${fiche.users_fiche_updated_at}`
            : 'Fiche jamais enregistrée depuis cette plateforme'}
        </span>
        {!readOnly && feedback && (
          <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
            {feedback.text}
          </span>
        )}
        {!readOnly && (
          <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={save}>
            <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        )}
      </footer>
    </section>
  );
}

/** Onglet non encore développé. */
function OngletAVenir({ label }) {
  return (
    <section className="platform-card fiche-card fiche-empty-tab">
      <h2>{label}</h2>
      <p className="cell-sub">Cet onglet est en cours de développement.</p>
    </section>
  );
}

/**
 * Fiche détaillée d'un utilisateur (/admin/utilisateurs/:id), ouverte depuis
 * l'action "Voir détail" de la page Utilisateurs. Six onglets ; "Comptes"
 * (coordonnées d'accès, une par fonction) et "Infos personnelles" sont
 * développés (les données sont sur delevery_users).
 * Avec `self`, la même page devient « Ma fiche » (/admin/ma-fiche, menu
 * avatar) : routes /users/me/* (sans le service UTILISATEURS), cinq onglets
 * (pas d'Évaluation), tout en consultation SAUF les identifiants de connexion
 * de ses comptes (email / téléphone / mot de passe) ; parcours limité à la
 * première section et statistiques des congés filtrées sur l'année en cours.
 */
export default function FicheUtilisateur({ self = false }) {
  const { id } = useParams();
  const apiBase = self ? '/users/me' : `/users/${id}`;
  const [fiche, setFiche] = useState(null);
  const [options, setOptions] = useState({ banques: [], villes: [] });
  const [tab, setTab] = useState('infos');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      api.get(apiBase),
      api.get(self ? '/users/me/fiche/options' : '/users/fiche/options')
    ])
      .then(([ficheRes, optionsRes]) => {
        if (cancelled) return;
        setFiche(ficheRes.data);
        setOptions(optionsRes.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, self]);

  if (loading) return <p className="cell-sub">Chargement de la fiche…</p>;
  if (error) return <div className="form-error">{error}</div>;
  if (!fiche) return null;

  /* « Ma fiche » : cinq onglets — l'évaluation reste réservée aux RH. */
  const tabs = self ? TABS.filter((t) => t.key !== 'evaluation') : TABS;

  return (
    <div className="fiche-page">
      <nav className="fiche-tabs" aria-label="Onglets de la fiche">
        {tabs.map((t) => (
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

      {tab === 'comptes' ? (
        /* « Ma fiche » : seuls SES identifiants de connexion sont modifiables. */
        <ComptesUtilisateur userId={fiche.users_id} apiBase={apiBase} readOnly={self} selfEdit={self} />
      ) : tab === 'infos' ? (
        <InfosPersonnelles
          fiche={fiche}
          options={options}
          apiBase={apiBase}
          onSaved={setFiche}
          readOnly={self}
        />
      ) : tab === 'parcours' ? (
        /* « Ma fiche » : première section seulement, en consultation. */
        <ParcoursProfessionnel
          apiBase={apiBase}
          userName={fiche.users_name || `Utilisateur n°${fiche.users_id}`}
          readOnly={self}
          summaryOnly={self}
        />
      ) : tab === 'conges' ? (
        <CongesAbsences
          apiBase={apiBase}
          userName={fiche.users_name || `Utilisateur n°${fiche.users_id}`}
          readOnly={self}
          filtreAnneeEnCours={self}
        />
      ) : tab === 'materiels' ? (
        <MaterielAffectations endpoint={`${apiBase}/materiel`} />
      ) : (
        <OngletAVenir label={tabs.find((t) => t.key === tab)?.label} />
      )}
    </div>
  );
}
