import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  BarChart3,
  Check,
  Clock,
  Contact,
  FileText,
  HandCoins,
  Hourglass,
  KeyRound,
  Landmark,
  MapPin,
  PackageOpen,
  ReceiptText,
  Save,
  Scale,
  Store,
  Trash2,
  UserRound,
  X
} from 'lucide-react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import SearchableSelect from '../../components/SearchableSelect';
import MultiSearchSelect from '../../components/MultiSearchSelect';
import MaFicheMembre from '../client/MaFicheMembre';

const TABS = [
  { key: 'compte', label: 'Compte et tarifs', icon: KeyRound },
  { key: 'infos', label: 'Informations', icon: Contact },
  { key: 'analyses', label: 'Analyses', icon: BarChart3 }
];

/* « Ma fiche » de l'espace client : deux onglets, tarifs jamais affichés. */
const SELF_TABS = [
  { key: 'compte', label: 'Compte', icon: KeyRound },
  { key: 'infos', label: 'Informations', icon: Contact }
];

/* Périodicités de facturation (valeurs stockées côté serveur). */
const PERIODES = [
  { val: 'annuelle', label: 'Annuelle', hint: 'facturée le 1er jour de chaque année' },
  {
    val: 'trimestrielle',
    label: 'Trimestrielle',
    hint: 'le 1er jour du trimestre suivant (début janvier pour le trimestre précédent)'
  },
  { val: 'mensuelle', label: 'Mensuelle', hint: 'le 1er jour du mois suivant' },
  { val: 'hebdomadaire', label: 'Hebdomadaire', hint: 'choisir le jour de la semaine' },
  { val: 'jours', label: 'Par jour', hint: 'choisir un ou plusieurs jours (lundi à vendredi)' }
];

const JOURS = [
  { val: 'lundi', label: 'Lundi' },
  { val: 'mardi', label: 'Mardi' },
  { val: 'mercredi', label: 'Mercredi' },
  { val: 'jeudi', label: 'Jeudi' },
  { val: 'vendredi', label: 'Vendredi' }
];

/* Jours de ramassage périodique : la facturation s'arrête au vendredi mais le
 * ramassage se fait aussi le samedi. Chaque jour coché déclenche une demande
 * de ramassage automatique à 12h00, sans action du client ni de l'admin. */
const JOURS_RAMASSAGE = [...JOURS, { val: 'samedi', label: 'Samedi' }];

/* Champs texte / date / select de l'onglet Informations (état du formulaire). */
const FORM_FIELDS = [
  'customers_name',
  'customers_cin',
  'customers_date_naissance',
  'customers_phone_personal',
  'customers_store',
  'customers_phone',
  'customers_address',
  'customers_pickup_location',
  'customers_website',
  'customers_company_type',
  'customers_ice',
  'customers_rc',
  'customers_societe_email',
  'customers_siege_social',
  'customers_ae_numero',
  'customers_ae_carte_expiration',
  'customers_bank',
  'customers_rib'
];

/**
 * Champs affichés selon la forme juridique choisie (même règle que la fiche
 * livreur) : SARL / SARLAU → société (ICE, RC…) ; auto-entrepreneur →
 * N° d'inscription, carte AE ; autres → aucun champ supplémentaire.
 * customers_company_type stocke le configs_id : on résout d'abord le libellé.
 */
function formeKind(formeId, formes) {
  const forme = (formes || []).find((f) => String(f.id) === String(formeId));
  const v = String(forme?.val || '').toLowerCase();
  if (v.includes('sarl')) return 'societe';
  if (v.includes('auto')) return 'ae';
  return '';
}

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

/** Champ d'upload : bouton "Choisir un fichier" + fichier courant ou sélectionné. */
function FileField({ label, hint, name, accept, current, file, onChange, span }) {
  return (
    <div className={`fiche-field ${span ? `span-${span}` : ''}`}>
      <span className="field-label">
        {label} <span className="fiche-hint">({hint})</span>
      </span>
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

function FicheHead({ icon: Icon, title, fiche }) {
  return (
    <header className="fiche-head">
      <span className="fiche-head-icon">
        <Icon size={22} />
      </span>
      <div className="fiche-head-text">
        <h2>
          {title} — {fiche.customers_store || fiche.customers_name || `Client n°${fiche.customers_id}`}
        </h2>
        <p className="fiche-head-sub">
          {`Compte client n°${fiche.customers_id}`}
          {/* Zone et agence dérivées de la ville de ramassage. */}
          {[fiche.ville_ramassage, fiche.zone, fiche.agence].some(Boolean) &&
            ` — ${[fiche.ville_ramassage, fiche.zone, fiche.agence].filter(Boolean).join(' · ')}`}
        </p>
      </div>
      <div className="fiche-head-role">
        <span className="fiche-hint">Rôle(s) / mission(s)</span>
        <span className="badge fiche-role-badge">
          <Store size={13} /> Client
        </span>
      </div>
    </header>
  );
}

/* Ligne éditable du tableau des tarifs : frais en texte + valeurs d'origine. */
function toRows(tarifs) {
  return tarifs.map((t) => ({
    ...t,
    fl: t.fraisLivraison != null ? String(t.fraisLivraison) : '',
    fr: t.fraisRefuse != null ? String(t.fraisRefuse) : '',
    rt: t.fraisRetour != null ? String(t.fraisRetour) : ''
  }));
}

function toAutreRow(autre) {
  return {
    fraisLivraison: autre?.fraisLivraison ?? 0,
    fraisRefuse: autre?.fraisRefuse ?? 0,
    fraisRetour: autre?.fraisRetour ?? 0,
    fl: String(autre?.fraisLivraison ?? 0),
    fr: String(autre?.fraisRefuse ?? 0),
    rt: String(autre?.fraisRetour ?? 0)
  };
}

function rowDirty(row) {
  return (
    Number(row.fl || 0) !== Number(row.fraisLivraison || 0) ||
    Number(row.fr || 0) !== Number(row.fraisRefuse || 0) ||
    Number(row.rt || 0) !== Number(row.fraisRetour || 0)
  );
}

/** Demande de modification en attente d'un type donné (FACTURATION | RAMASSAGE | INFOS). */
function demandeEnAttente(fiche, type) {
  return (fiche.demandes || []).find((d) => d.type === type) || null;
}

/**
 * Demande de modification en attente de validation (« Ma fiche » du client →
 * delevery_client_fiche_demande). Côté client : détail ancien → nouveau +
 * bouton "Annuler la demande". Côté admin : mêmes détails + Accepter (applique
 * les valeurs à la fiche) / Refuser (fiche intacte).
 */
function DemandePanel({ demande, self, clientId, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!demande) return null;

  async function run(request, confirmText) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      const res = await request();
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Échec de l'opération.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fiche-demande">
      <div className="fiche-demande-head">
        <Hourglass size={15} />
        <b>
          {self
            ? 'Modification en attente de validation par l’administration'
            : 'Le client demande les modifications suivantes'}
        </b>
      </div>
      <ul className="suivi-changes">
        {demande.changes.map((c) => (
          <li key={c.field}>
            {c.label} : <s>{c.old || '—'}</s> →{' '}
            {c.file ? (
              <a href={c.file} target="_blank" rel="noreferrer" className="fiche-file-link">
                <FileText size={13} /> {c.new || 'Nouveau fichier'}
              </a>
            ) : (
              <b>{c.new || '—'}</b>
            )}
          </li>
        ))}
      </ul>
      <div className="fiche-demande-actions">
        {error && <span className="field-error">{error}</span>}
        {self ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              run(
                () => api.delete(`/clients/me/demandes/${demande.type}`),
                'Annuler cette demande de modification ?'
              )
            }
          >
            <X size={15} /> Annuler la demande
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.post(`/clients/${clientId}/demandes/${demande.id}/refuser`),
                  'Refuser cette demande ? La fiche du client restera inchangée.'
                )
              }
            >
              <X size={15} /> Refuser
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(
                  () => api.post(`/clients/${clientId}/demandes/${demande.id}/accepter`),
                  'Appliquer ces modifications à la fiche du client ?'
                )
              }
            >
              <Check size={15} /> Accepter
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Onglet "Compte et tarifs" : trois sections — Compte (email / mot de passe),
 * Facturation (périodicité + jours) et Tarifs (ville de ramassage, tarifs
 * personnalisés). Le bouton Enregistrer sauvegarde les trois sections ;
 * le bouton Appliquer gère le tableau des tarifs personnalisés par ville.
 * En mode `self` (« Ma fiche » de l'espace client, onglet "Compte") : email et
 * mot de passe appliqués directement (PUT /clients/me/compte), périodicités de
 * ramassage et de facturation modifiables mais appliquées seulement après
 * validation admin (demandes RAMASSAGE / FACTURATION, pré-remplies si une
 * demande est en attente) — la section Tarifs n'est pas affichée.
 */
function OngletCompteTarifs({ fiche, options, self, apiBase, onSaved }) {
  // Périodicité affichée : demande en attente du client s'il y en a une (self).
  const facturationInitiale = (f) => {
    const demande = self ? demandeEnAttente(f, 'FACTURATION') : null;
    return {
      periode: demande?.payload?.periode ?? (f.facturation_periode || ''),
      jours: demande?.payload?.jours ?? (f.facturation_jours || [])
    };
  };
  const ramassageInitial = (f) => {
    const demande = self ? demandeEnAttente(f, 'RAMASSAGE') : null;
    return demande?.payload?.jours ?? (f.ramassage_jours || []);
  };
  const [form, setForm] = useState({
    customers_email: fiche.customers_email || '',
    password: '',
    password2: '',
    ...facturationInitiale(fiche),
    ramassageJours: ramassageInitial(fiche),
    ramassageHeure: fiche.ramassage_heure || '',
    pickupCity: fiche.customers_pickup_city != null ? String(fiche.customers_pickup_city) : '',
    customTarif: String(fiche.customers_custom_tarif ?? 0)
  });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [rows, setRows] = useState(null); // null = chargement
  const [autre, setAutre] = useState(null);
  const [apply, setApply] = useState({ villeIds: [], fraisLivraison: '', fraisRefuse: '', fraisRetour: '' });
  const [applying, setApplying] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [tarifFeedback, setTarifFeedback] = useState(null);

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      customers_email: fiche.customers_email || '',
      ...facturationInitiale(fiche),
      ramassageJours: ramassageInitial(fiche),
      ramassageHeure: fiche.ramassage_heure || '',
      pickupCity: fiche.customers_pickup_city != null ? String(fiche.customers_pickup_city) : '',
      customTarif: String(fiche.customers_custom_tarif ?? 0)
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiche]);

  useEffect(() => {
    if (self) return undefined; // tarifs jamais affichés sur « Ma fiche »
    let cancelled = false;
    api
      .get(`${apiBase}/tarifs`)
      .then((res) => {
        if (cancelled) return;
        setRows(toRows(res.data.tarifs));
        setAutre(toAutreRow(res.data.autre));
      })
      .catch((err) => {
        if (!cancelled) {
          setRows([]);
          setAutre(toAutreRow(null));
          setTarifFeedback({
            type: 'error',
            text: err.response?.data?.message || 'Erreur de chargement des tarifs.'
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, self]);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function toggleJour(jour) {
    setForm((prev) => ({
      ...prev,
      jours: prev.jours.includes(jour) ? prev.jours.filter((j) => j !== jour) : [...prev.jours, jour]
    }));
  }

  function toggleRamassageJour(jour) {
    setForm((prev) => ({
      ...prev,
      ramassageJours: prev.ramassageJours.includes(jour)
        ? prev.ramassageJours.filter((j) => j !== jour)
        : [...prev.ramassageJours, jour]
    }));
  }

  const villeOptions = useMemo(
    () => (options.villes || []).map((v) => ({ value: String(v.id), label: v.nom })),
    [options.villes]
  );

  /* Villes de ramassage : uniquement celles présentes dans la matrice tarifaire
     (delevery_tarifs_matrix), sans doublon. La ville actuelle du client, si elle
     n'y figure plus, reste proposée sous son nom (ou « Ville n°X » si inconnue). */
  const pickupOptions = useMemo(() => {
    const base = (options.villesRamassage || []).map((v) => ({ value: String(v.id), label: v.nom }));
    if (form.pickupCity && !base.some((o) => o.value === form.pickupCity)) {
      const connue = villeOptions.find((o) => o.value === form.pickupCity);
      return [...base, connue || { value: form.pickupCity, label: `Ville n°${form.pickupCity}` }];
    }
    return base;
  }, [options.villesRamassage, villeOptions, form.pickupCity]);

  const periodeChoisie = PERIODES.find((p) => p.val === form.periode);

  async function save() {
    if (form.password && form.password.length < 8) {
      setFeedback({ type: 'error', text: 'Le mot de passe doit contenir au moins 8 caractères.' });
      return;
    }
    if (form.password !== form.password2) {
      setFeedback({ type: 'error', text: 'Les deux mots de passe ne correspondent pas.' });
      return;
    }
    if (form.periode === 'hebdomadaire' && form.jours.length !== 1) {
      setFeedback({ type: 'error', text: 'Veuillez choisir le jour de facturation (lundi à vendredi).' });
      return;
    }
    if (form.periode === 'jours' && form.jours.length === 0) {
      setFeedback({ type: 'error', text: 'Veuillez choisir au moins un jour de facturation.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      let res;
      if (self) {
        // « Ma fiche » : email / mot de passe appliqués directement, la
        // périodicité devient une demande à valider par l'admin.
        const payload = {
          customers_email: form.customers_email,
          ramassage_jours: form.ramassageJours,
          facturation_periode: form.periode,
          facturation_jours: form.jours
        };
        if (form.password) payload.password = form.password;
        res = await api.put(`${apiBase}/compte`, payload);
      } else {
        const payload = {
          customers_email: form.customers_email,
          ramassage_jours: form.ramassageJours,
          ramassage_heure: form.ramassageHeure,
          facturation_periode: form.periode,
          facturation_jours: form.jours,
          pickup_city: form.pickupCity,
          custom_tarif: Number(form.customTarif)
        };
        if (form.password) payload.password = form.password;
        res = await api.put(`${apiBase}/compte-tarifs`, payload);
      }
      onSaved(res.data);
      setForm((prev) => ({ ...prev, password: '', password2: '' }));
      const demandeCreee =
        self &&
        (demandeEnAttente(res.data, 'FACTURATION') || demandeEnAttente(res.data, 'RAMASSAGE'));
      setFeedback({
        type: 'success',
        text: demandeCreee
          ? 'Compte enregistré — la nouvelle périodicité sera appliquée après validation par l’administration.'
          : self
            ? 'Compte enregistré.'
            : 'Compte et tarifs enregistrés.'
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function appliquer() {
    if (apply.villeIds.length === 0) {
      setTarifFeedback({ type: 'error', text: 'Veuillez sélectionner au moins une ville.' });
      return;
    }
    setApplying(true);
    setTarifFeedback(null);
    try {
      const res = await api.post(`/clients/${fiche.customers_id}/tarifs/appliquer`, {
        villeIds: apply.villeIds.map(Number),
        fraisLivraison: Number(apply.fraisLivraison || 0),
        fraisRefuse: Number(apply.fraisRefuse || 0),
        fraisRetour: Number(apply.fraisRetour || 0)
      });
      setRows(toRows(res.data.tarifs));
      setAutre(toAutreRow(res.data.autre));
      setApply((prev) => ({ ...prev, villeIds: [] }));
      setTarifFeedback({ type: 'success', text: 'Tarifs appliqués aux villes sélectionnées.' });
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'application des tarifs." });
    } finally {
      setApplying(false);
    }
  }

  function setRowField(id, name, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [name]: value } : r)));
  }

  async function saveRow(row) {
    setBusyRow(row.id);
    setTarifFeedback(null);
    try {
      const res = await api.put(`/clients/${fiche.customers_id}/tarifs/${row.id}`, {
        fraisLivraison: Number(row.fl || 0),
        fraisRefuse: Number(row.fr || 0),
        fraisRetour: Number(row.rt || 0)
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? toRows([res.data])[0] : r)));
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement du tarif." });
    } finally {
      setBusyRow(null);
    }
  }

  async function removeRow(row) {
    if (!window.confirm(`Supprimer le tarif de « ${row.ville} » ?`)) return;
    setBusyRow(row.id);
    setTarifFeedback(null);
    try {
      await api.delete(`/clients/${fiche.customers_id}/tarifs/${row.id}`);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || 'Échec de la suppression.' });
    } finally {
      setBusyRow(null);
    }
  }

  async function saveAutre() {
    setBusyRow('autre');
    setTarifFeedback(null);
    try {
      const res = await api.put(`/clients/${fiche.customers_id}/tarifs/autre`, {
        fraisLivraison: Number(autre.fl || 0),
        fraisRefuse: Number(autre.fr || 0),
        fraisRetour: Number(autre.rt || 0)
      });
      setAutre(toAutreRow(res.data.autre));
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement du tarif." });
    } finally {
      setBusyRow(null);
    }
  }

  const customActif = form.customTarif === '1';

  return (
    <section className="platform-card fiche-card">
      <FicheHead icon={KeyRound} title={self ? 'Compte' : 'Compte et tarifs'} fiche={fiche} />

      <DemandePanel
        demande={demandeEnAttente(fiche, 'RAMASSAGE')}
        self={self}
        clientId={fiche.customers_id}
        onSaved={onSaved}
      />
      <DemandePanel
        demande={demandeEnAttente(fiche, 'FACTURATION')}
        self={self}
        clientId={fiche.customers_id}
        onSaved={onSaved}
      />

      <SectionTitle icon={KeyRound}>Compte</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Adresse électronique</span>
          <input
            type="email"
            value={form.customers_email}
            onChange={(e) => setField('customers_email', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Mot de passe</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Laisser vide pour ne pas changer"
            value={form.password}
            onChange={(e) => setField('password', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Confirmation de mot de passe</span>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Retaper le mot de passe"
            value={form.password2}
            onChange={(e) => setField('password2', e.target.value)}
          />
        </label>
      </div>

      <SectionTitle icon={PackageOpen}>Ramassage</SectionTitle>
      {self && (
        <p className="fiche-hint">
          Le changement de périodicité de ramassage ne s'applique qu'après validation par
          l'administration.
        </p>
      )}
      <div className="fiche-grid">
        <div className="fiche-field span-4">
          <span className="field-label">Périodicité de ramassage</span>
          <div className="jours-checks">
            {JOURS_RAMASSAGE.map((j) => (
              <label
                key={j.val}
                className={`jour-check ${form.ramassageJours.includes(j.val) ? 'jour-check-on' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={form.ramassageJours.includes(j.val)}
                  onChange={() => toggleRamassageJour(j.val)}
                />
                {j.label}
              </label>
            ))}
          </div>
        </div>
        {/* Heure préférée de passage du ramasseur : réglée par l'admin
            uniquement (jamais sur « Ma fiche »), affichée sur les cartes du
            ramasseur ; vide = non fixée, rien n'est affiché. */}
        {!self && (
          <label className="fiche-field">
            <span className="field-label">Heure de ramassage</span>
            <input
              type="time"
              value={form.ramassageHeure}
              onChange={(e) => setField('ramassageHeure', e.target.value)}
            />
            <span className="fiche-hint">
              Heure préférée du client, affichée au ramasseur — laisser vide si non fixée.
            </span>
          </label>
        )}
      </div>

      <SectionTitle icon={ReceiptText}>Facturation</SectionTitle>
      {self && (
        <p className="fiche-hint">
          Le changement de périodicité de facturation ne s'applique qu'après validation par
          l'administration.
        </p>
      )}
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Périodicité de facturation</span>
          <select
            value={form.periode}
            onChange={(e) => {
              const periode = e.target.value;
              setForm((prev) => ({ ...prev, periode, jours: [] }));
            }}
          >
            <option value="">— Choisir la périodicité —</option>
            {PERIODES.map((p) => (
              <option key={p.val} value={p.val}>
                {p.label}
              </option>
            ))}
          </select>
          {periodeChoisie && <span className="fiche-hint facturation-hint">{periodeChoisie.hint}</span>}
        </label>

        {form.periode === 'hebdomadaire' && (
          <label className="fiche-field span-2">
            <span className="field-label">Jour de facturation</span>
            <select
              value={form.jours[0] || ''}
              onChange={(e) => setField('jours', e.target.value ? [e.target.value] : [])}
            >
              <option value="">— Choisir le jour —</option>
              {JOURS.map((j) => (
                <option key={j.val} value={j.val}>
                  {j.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {form.periode === 'jours' && (
          <div className="fiche-field span-2">
            <span className="field-label">Jours de facturation</span>
            <div className="jours-checks">
              {JOURS.map((j) => (
                <label key={j.val} className={`jour-check ${form.jours.includes(j.val) ? 'jour-check-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={form.jours.includes(j.val)}
                    onChange={() => toggleJour(j.val)}
                  />
                  {j.label}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Tarifs et ville de ramassage : jamais affichés sur « Ma fiche » client. */}
      {!self && (
        <>
          <SectionTitle icon={HandCoins}>Tarifs</SectionTitle>
          <div className="fiche-grid">
            <div className="fiche-field">
              <span className="field-label">Ville de ramassage</span>
              <SearchableSelect
                value={form.pickupCity}
                onChange={(v) => setField('pickupCity', String(v))}
                options={pickupOptions}
                placeholder="— Choisir la ville —"
              />
            </div>
            <label className="fiche-field">
              <span className="field-label">Tarifs personnalisés</span>
              <select value={form.customTarif} onChange={(e) => setField('customTarif', e.target.value)}>
                <option value="0">Non</option>
                <option value="1">Oui</option>
              </select>
            </label>
          </div>
        </>
      )}
      <div className="fiche-inline-actions">
        {feedback && (
          <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
            {feedback.text}
          </span>
        )}
        <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={save}>
          <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>

      {!self && customActif && (
        <>
          <div className="fiche-grid fiche-custom-tarifs">
            <div className="fiche-field span-2">
              <span className="field-label">Villes à personnaliser</span>
              <MultiSearchSelect
                value={apply.villeIds}
                onChange={(villeIds) => setApply((prev) => ({ ...prev, villeIds }))}
                options={villeOptions}
                placeholder="— Sélectionner une ou plusieurs villes —"
              />
            </div>
            <label className="fiche-field">
              <span className="field-label">Frais de livraison</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={apply.fraisLivraison}
                onChange={(e) => setApply((prev) => ({ ...prev, fraisLivraison: e.target.value }))}
              />
            </label>
            <label className="fiche-field">
              <span className="field-label">Frais de refusé</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={apply.fraisRefuse}
                onChange={(e) => setApply((prev) => ({ ...prev, fraisRefuse: e.target.value }))}
              />
            </label>
            <label className="fiche-field">
              <span className="field-label">Frais de retour</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={apply.fraisRetour}
                onChange={(e) => setApply((prev) => ({ ...prev, fraisRetour: e.target.value }))}
              />
            </label>
          </div>
          <div className="fiche-inline-actions">
            <span className="fiche-hint fiche-tarifs-note">
              La ligne « Autre » s’applique aux villes non personnalisées dès qu’un de ses montants
              est renseigné (&gt; 0). Sinon : matrice ville de ramassage → destination, puis tarif
              de la ville.
            </span>
            {tarifFeedback && (
              <span className={tarifFeedback.type === 'error' ? 'field-error' : 'field-success'}>
                {tarifFeedback.text}
              </span>
            )}
            <button type="button" className="btn btn-primary fiche-save" disabled={applying} onClick={appliquer}>
              <MapPin size={15} /> {applying ? 'Application…' : 'Appliquer'}
            </button>
          </div>

          {rows === null || autre === null ? (
            <p className="cell-sub">Chargement des tarifs…</p>
          ) : (
            <div className="table-wrap fiche-tarifs-table">
              <table>
                <thead>
                  <tr>
                    <th>Nom de ville</th>
                    <th>Frais de livraison</th>
                    <th>Frais de refusé</th>
                    <th>Frais de retour</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="datatable-empty">
                        Aucune ville personnalisée — sélectionnez des villes puis cliquez sur «
                        Appliquer ».
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="cell-main">{r.ville}</div>
                        {r.zone && <div className="cell-sub">{r.zone}</div>}
                      </td>
                      <td>
                        <input
                          type="number"
                          className="frais-input"
                          min="0"
                          step="1"
                          value={r.fl}
                          onChange={(e) => setRowField(r.id, 'fl', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="frais-input"
                          min="0"
                          step="1"
                          value={r.fr}
                          onChange={(e) => setRowField(r.id, 'fr', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="frais-input"
                          min="0"
                          step="1"
                          value={r.rt}
                          onChange={(e) => setRowField(r.id, 'rt', e.target.value)}
                        />
                      </td>
                      <td>
                        <div className="row-actions">
                          {rowDirty(r) && (
                            <button
                              type="button"
                              className="row-action row-action-success"
                              title="Enregistrer le tarif"
                              disabled={busyRow === r.id}
                              onClick={() => saveRow(r)}
                            >
                              <Save size={16} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer"
                            disabled={busyRow === r.id}
                            onClick={() => removeRow(r)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {/* Ligne "Autre" : frais des villes non personnalisées (toujours affichée).
                      Sous-libellé calculé sur les valeurs enregistrées, pas sur le brouillon :
                      active dès qu'un montant est > 0 (même règle que resolveClientFees). */}
                  <tr className="tarif-autre-row">
                    <td>
                      <div className="cell-main">Autre</div>
                      <div className="cell-sub">
                        {Number(autre.fraisLivraison) > 0 ||
                        Number(autre.fraisRefuse) > 0 ||
                        Number(autre.fraisRetour) > 0
                          ? 'Toutes les villes non personnalisées'
                          : 'Non renseignée : matrice puis tarif de la ville'}
                      </div>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="frais-input"
                        min="0"
                        step="1"
                        value={autre.fl}
                        onChange={(e) => setAutre((prev) => ({ ...prev, fl: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="frais-input"
                        min="0"
                        step="1"
                        value={autre.fr}
                        onChange={(e) => setAutre((prev) => ({ ...prev, fr: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="frais-input"
                        min="0"
                        step="1"
                        value={autre.rt}
                        onChange={(e) => setAutre((prev) => ({ ...prev, rt: e.target.value }))}
                      />
                    </td>
                    <td>
                      <div className="row-actions">
                        {rowDirty(autre) && (
                          <button
                            type="button"
                            className="row-action row-action-success"
                            title="Enregistrer le tarif"
                            disabled={busyRow === 'autre'}
                            onClick={saveAutre}
                          >
                            <Save size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Onglet "Informations" : identité, magasin, ramassage, forme juridique et
 * banque. En mode `self` (« Ma fiche » client) : mêmes champs, mais rien n'est
 * appliqué directement — l'enregistrement crée une demande à valider par
 * l'admin, et le formulaire est pré-rempli avec les valeurs demandées si une
 * demande est déjà en attente.
 */
function OngletInfos({ fiche, options, self, apiBase, onSaved }) {
  // Valeurs affichées : fiche actuelle + champs de la demande en attente (self).
  const formInitial = (f) => ({
    ...ficheToForm(f),
    ...(self ? demandeEnAttente(f, 'INFOS')?.payload?.fields : null)
  });
  const [form, setForm] = useState(() => formInitial(fiche));
  const [files, setFiles] = useState({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    setForm(formInitial(fiche));
    setFiles({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiche, self]);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function setFile(name, file) {
    setFiles((prev) => ({ ...prev, [name]: file }));
  }

  /* Forme / banque legacy absentes des listes : option supplémentaire pour ne pas perdre la valeur. */
  const formes = useMemo(() => {
    const list = options.formes || [];
    const current = String(form.customers_company_type || '');
    if (current && !list.some((f) => String(f.id) === current)) {
      return [...list, { id: current, val: `Forme n°${current}` }];
    }
    return list;
  }, [options.formes, form.customers_company_type]);

  const banques = useMemo(() => {
    const list = options.banques || [];
    const current = String(form.customers_bank || '');
    if (current && !list.some((b) => String(b.id) === current)) {
      return [...list, { id: current, val: `Banque n°${current}` }];
    }
    return list;
  }, [options.banques, form.customers_bank]);

  const kind = formeKind(form.customers_company_type, formes);

  /* Aperçu du logo : fichier sélectionné, sinon logo servi par la plateforme. */
  const logoPreview = files.logo
    ? URL.createObjectURL(files.logo)
    : String(fiche.customers_logo || '').startsWith('/uploads/')
      ? fiche.customers_logo
      : '';

  /** Ouvre Google Maps sur la localisation saisie, sinon sur l'adresse de ramassage. */
  function localiser() {
    const query = String(form.customers_pickup_location || form.customers_address || '').trim();
    if (!query) {
      setFeedback({ type: 'error', text: 'Saisissez une localisation ou une adresse de ramassage.' });
      return;
    }
    const url = /^https?:\/\//i.test(query)
      ? query
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    window.open(url, '_blank', 'noopener');
  }

  async function save() {
    if (!String(form.customers_name).trim() || !String(form.customers_cin).trim()) {
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
      setFeedback({
        type: 'success',
        text: !self
          ? 'Fiche enregistrée.'
          : demandeEnAttente(res.data, 'INFOS')
            ? 'Demande envoyée — les modifications seront appliquées après validation par l’administration.'
            : 'Aucune modification à valider : la fiche est déjà à jour.'
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="platform-card fiche-card">
      <FicheHead icon={Contact} title="Informations" fiche={fiche} />

      <DemandePanel
        demande={demandeEnAttente(fiche, 'INFOS')}
        self={self}
        clientId={fiche.customers_id}
        onSaved={onSaved}
      />
      {self && (
        <p className="fiche-hint">
          Les modifications de cette fiche ne s'appliquent qu'après validation par
          l'administration.
        </p>
      )}

      <SectionTitle icon={UserRound}>Identité &amp; coordonnées</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">
            Nom complet <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.customers_name}
            onChange={(e) => setField('customers_name', e.target.value)}
            required
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">
            CIN <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.customers_cin}
            onChange={(e) => setField('customers_cin', e.target.value)}
            required
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Date de naissance</span>
          <input
            type="date"
            value={form.customers_date_naissance}
            onChange={(e) => setField('customers_date_naissance', e.target.value)}
          />
        </label>
        <label className="fiche-field span-2">
          <span className="field-label">N° téléphone personnel</span>
          <input
            type="tel"
            value={form.customers_phone_personal}
            onChange={(e) => setField('customers_phone_personal', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier CIN — recto"
          hint="PDF"
          name="cin_recto"
          accept=".pdf"
          current={fiche.customers_cin_recto_image}
          file={files.cin_recto}
          onChange={setFile}
          span={2}
        />
        <FileField
          label="Fichier CIN — verso"
          hint="PDF"
          name="cin_verso"
          accept=".pdf"
          current={fiche.customers_cin_verso_image}
          file={files.cin_verso}
          onChange={setFile}
          span={2}
        />
      </div>

      <SectionTitle icon={Store}>Magasin &amp; ramassage</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Nom du magasin (brand)</span>
          <input
            type="text"
            value={form.customers_store}
            onChange={(e) => setField('customers_store', e.target.value)}
          />
        </label>
        <div className="fiche-field span-2">
          <span className="field-label">
            Logo du brand <span className="fiche-hint">(image PNG / JPG / WEBP)</span>
          </span>
          <div className="fiche-logo-row">
            {logoPreview ? (
              <img src={logoPreview} alt="Logo du brand" className="fiche-logo-preview" />
            ) : (
              <span className="fiche-logo-placeholder">
                <Store size={20} />
              </span>
            )}
            <label className="fiche-file">
              <span className="fiche-file-btn">Choisir un fichier</span>
              <span className="fiche-file-name">
                {files.logo ? files.logo.name : <FileValue value={fiche.customers_logo} />}
              </span>
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                hidden
                onChange={(e) => setFile('logo', e.target.files?.[0] || null)}
              />
            </label>
          </div>
        </div>
        <label className="fiche-field">
          <span className="field-label">N° téléphone magasin</span>
          <input
            type="tel"
            value={form.customers_phone}
            onChange={(e) => setField('customers_phone', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Site web</span>
          <input
            type="text"
            placeholder="https://…"
            value={form.customers_website}
            onChange={(e) => setField('customers_website', e.target.value)}
          />
        </label>
        <label className="fiche-field span-2">
          <span className="field-label">Adresse de ramassage</span>
          <input
            type="text"
            value={form.customers_address}
            onChange={(e) => setField('customers_address', e.target.value)}
          />
        </label>
        <div className="fiche-field span-2">
          <span className="field-label">
            Localisation <span className="fiche-hint">(lat, lng ou lien Google Maps)</span>
          </span>
          <div className="fiche-localisation-row">
            <input
              type="text"
              placeholder="33.5731, -7.5898"
              value={form.customers_pickup_location}
              onChange={(e) => setField('customers_pickup_location', e.target.value)}
            />
            <button type="button" className="btn btn-ghost fiche-localiser" onClick={localiser}>
              <MapPin size={15} /> Localiser
            </button>
          </div>
        </div>
      </div>

      <SectionTitle icon={Scale}>Forme juridique &amp; documents</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Forme juridique</span>
          <select
            value={form.customers_company_type}
            onChange={(e) => setField('customers_company_type', e.target.value)}
          >
            <option value="">— Choisir la forme juridique —</option>
            {formes.map((f) => (
              <option key={f.id} value={f.id}>
                {f.val}
              </option>
            ))}
          </select>
        </label>

        {kind === 'societe' && (
          <>
            <label className="fiche-field">
              <span className="field-label">ICE</span>
              <input
                type="text"
                value={form.customers_ice}
                onChange={(e) => setField('customers_ice', e.target.value)}
              />
            </label>
            <label className="fiche-field">
              <span className="field-label">RC</span>
              <input
                type="text"
                value={form.customers_rc}
                onChange={(e) => setField('customers_rc', e.target.value)}
              />
            </label>
            <FileField
              label="Fichier RC"
              hint="PDF"
              name="rc"
              accept=".pdf"
              current={fiche.customers_rc_fichier}
              file={files.rc}
              onChange={setFile}
              span={2}
            />
            <label className="fiche-field span-2">
              <span className="field-label">Email société</span>
              <input
                type="email"
                value={form.customers_societe_email}
                onChange={(e) => setField('customers_societe_email', e.target.value)}
              />
            </label>
            <label className="fiche-field span-2">
              <span className="field-label">Siège social</span>
              <input
                type="text"
                value={form.customers_siege_social}
                onChange={(e) => setField('customers_siege_social', e.target.value)}
              />
            </label>
          </>
        )}

        {kind === 'ae' && (
          <>
            <label className="fiche-field">
              <span className="field-label">N° d'inscription</span>
              <input
                type="text"
                value={form.customers_ae_numero}
                onChange={(e) => setField('customers_ae_numero', e.target.value)}
              />
            </label>
            <FileField
              label="Carte AE"
              hint="PDF"
              name="ae_carte"
              accept=".pdf"
              current={fiche.customers_ae_carte_fichier}
              file={files.ae_carte}
              onChange={setFile}
              span={2}
            />
            <label className="fiche-field">
              <span className="field-label">Date d'expiration carte AE</span>
              <input
                type="date"
                value={form.customers_ae_carte_expiration}
                onChange={(e) => setField('customers_ae_carte_expiration', e.target.value)}
              />
            </label>
          </>
        )}
      </div>

      <SectionTitle icon={Landmark}>Banque &amp; documents</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field">
          <span className="field-label">Nom de la banque</span>
          <select value={form.customers_bank} onChange={(e) => setField('customers_bank', e.target.value)}>
            <option value="">— Choisir la banque —</option>
            {banques.map((b) => (
              <option key={b.id} value={b.id}>
                {b.val}
              </option>
            ))}
          </select>
        </label>
        <label className="fiche-field">
          <span className="field-label">RIB</span>
          <input
            type="text"
            maxLength={50}
            value={form.customers_rib}
            onChange={(e) => setField('customers_rib', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier RIB"
          hint="PDF"
          name="rib"
          accept=".pdf"
          current={fiche.customers_rib_image}
          file={files.rib}
          onChange={setFile}
          span={2}
        />
        <FileField
          label="Contrat"
          hint="PDF"
          name="contrat"
          accept=".pdf"
          current={fiche.customers_contrat_photo}
          file={files.contrat}
          onChange={setFile}
          span={2}
        />
      </div>

      <footer className="fiche-footer">
        <span className="fiche-updated">
          <Clock size={14} />
          {fiche.customers_fiche_updated_at
            ? `Dernière mise à jour : ${fiche.customers_fiche_updated_at}`
            : 'Fiche jamais enregistrée depuis cette plateforme'}
        </span>
        {feedback && (
          <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
            {feedback.text}
          </span>
        )}
        <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={save}>
          <Check size={15} />{' '}
          {saving ? 'Enregistrement…' : self ? 'Envoyer pour validation' : 'Enregistrer'}
        </button>
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
 * Fiche détaillée d'un client (/admin/clients/:id), ouverte depuis l'action
 * "Modifier la fiche" de la page Clients. Trois onglets ; "Compte et tarifs"
 * (connexion, facturation, tarifs par ville) et "Informations" sont développés,
 * "Analyses" viendra plus tard.
 * Avec `self`, la même page devient « Ma fiche » de l'espace client
 * (/client/ma-fiche, menu avatar, propriétaire uniquement) : routes
 * /clients/me/*, deux onglets seulement (Compte, Informations). Email / mot de
 * passe appliqués directement ; périodicité de facturation et onglet
 * Informations modifiables mais appliqués après validation admin (demandes
 * delevery_client_fiche_demande, validées sur /admin/clients/:id) ; tarifs
 * jamais affichés.
 */
export default function FicheClient({ self = false }) {
  const { id } = useParams();
  const { user } = useAuth();
  const apiBase = self ? '/clients/me' : `/clients/${id}`;
  // Sous-compte (membre d'équipe) : fiche réduite à ses identifiants de connexion.
  const isMembre = self && Boolean(user?.memberId);
  const [fiche, setFiche] = useState(null);
  const [options, setOptions] = useState({ villes: [], villesRamassage: [], formes: [], banques: [] });
  const [tab, setTab] = useState('compte');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isMembre) return undefined; // fiche membre : aucun appel /clients/me/fiche
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      api.get(self ? '/clients/me/fiche' : `/clients/${id}`),
      api.get(self ? '/clients/me/fiche/options' : '/clients/fiche/options')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, self]);

  if (isMembre) return <MaFicheMembre />;
  if (loading) return <p className="cell-sub">Chargement de la fiche…</p>;
  if (error) return <div className="form-error">{error}</div>;
  if (!fiche) return null;

  const tabs = self ? SELF_TABS : TABS;

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

      {tab === 'compte' ? (
        <OngletCompteTarifs fiche={fiche} options={options} self={self} apiBase={apiBase} onSaved={setFiche} />
      ) : tab === 'infos' ? (
        <OngletInfos fiche={fiche} options={options} self={self} apiBase={apiBase} onSaved={setFiche} />
      ) : (
        <OngletAVenir label={tabs.find((t) => t.key === tab)?.label} />
      )}
    </div>
  );
}
