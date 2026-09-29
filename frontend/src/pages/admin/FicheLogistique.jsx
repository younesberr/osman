import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bell,
  Boxes,
  Check,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Cog,
  CreditCard,
  Droplets,
  ExternalLink,
  FileText,
  FolderOpen,
  Fuel,
  HandCoins,
  Info,
  Paperclip,
  Plus,
  ShieldCheck,
  ShoppingCart,
  Ticket,
  Trash2,
  TriangleAlert,
  Truck,
  Wrench,
  X
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import { NouveauMoyenModal } from './Logistiques';

/*
 * Fiche d'un moyen logistique (/admin/logistiques/:id), ouverte depuis
 * « Plus d'info » de la liste du parc. Cinq onglets :
 *  - Informations : identification + caractéristiques (+ suppression) ;
 *  - Maintenance  : prochaine vidange estimée + alertes, vidanges,
 *    entretiens et consommation carburant ;
 *  - Documents    : réglementaires (carte grise recto/verso, visite
 *    technique, assurance, vignette) + autres documents (fichiers) ;
 *  - Financement  : prix / méthode d'achat, détail du crédit (totaux
 *    calculés automatiquement) + documents du financement ;
 *  - Matériels    : structure prête, en attente du module Matériels.
 * L'en-tête permet de basculer vers un autre moyen (sélecteur « Moyen : »)
 * et d'ajouter un nouveau moyen (même modale que la liste).
 */

const TABS = [
  { key: 'infos', label: 'Informations', icon: ClipboardList },
  { key: 'maintenance', label: 'Maintenance', icon: Wrench },
  { key: 'documents', label: 'Documents', icon: FolderOpen },
  { key: 'financement', label: 'Financement', icon: HandCoins },
  { key: 'materiels', label: 'Matériels', icon: Boxes }
];

const FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';

/** Libellé court du moyen : "VL · trafic — 1234567890" (comme le sélecteur). */
function moyenTitre(fiche) {
  return `${fiche.type.toUpperCase()} · ${fiche.marque} — ${fiche.chassis}`;
}

/** Libellé d'un code dans une liste [{ code, label }] du backend. */
function labelOf(list, code) {
  return list.find((item) => item.code === code)?.label || code;
}

function formatKm(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} km`;
}

function formatDh(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} DH`;
}

/** Date du jour "AAAA-MM-JJ" (comparaison d'expiration des documents). */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function SectionTitle({ icon: Icon, children }) {
  return (
    <h3 className="fiche-section-title">
      <Icon size={15} /> {children}
    </h3>
  );
}

/** Lien vers un fichier uploadé, ou mention « aucun fichier ». */
function FileValue({ value }) {
  if (!value) return <span className="fiche-file-empty">Aucun fichier choisi</span>;
  return (
    <a href={value} target="_blank" rel="noreferrer" className="fiche-file-link">
      <FileText size={14} /> Voir le fichier
    </a>
  );
}

/** Champ d'upload (un fichier) : bouton + fichier courant ou sélectionné. */
function FileField({ label, name, current, file, onChange }) {
  return (
    <div className="fiche-field">
      <span className="field-label">{label}</span>
      <label className="fiche-file">
        <span className="fiche-file-btn">Choisir un fichier</span>
        <span className="fiche-file-name">{file ? file.name : <FileValue value={current} />}</span>
        <input
          type="file"
          accept={FILE_ACCEPT}
          hidden
          onChange={(e) => onChange(name, e.target.files?.[0] || null)}
        />
      </label>
    </div>
  );
}

/** Badge « Expiré » à côté d'un libellé si la date de validité est dépassée. */
function ExpireBadge({ date }) {
  if (!date || date >= todayStr()) return null;
  return <span className="badge badge-refuse lg-expire-badge">Expiré</span>;
}

/**
 * Documents libres (une ligne par fichier) : liste + formulaire d'ajout
 * (description + plusieurs fichiers). Utilisé par « Autres documents »
 * (onglet Documents) et « Documents du financement » (onglet Financement).
 */
function DocumentsLibres({ icon, titre, vide, placeholder, docs, onAdd, onDelete }) {
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState([]);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function ajouter(e) {
    e.preventDefault();
    setError('');
    if (!files.length) {
      setError('Veuillez sélectionner au moins un fichier.');
      return;
    }
    setBusy(true);
    try {
      await onAdd(description, files);
      setDescription('');
      setFiles([]);
      setInputKey((k) => k + 1);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'ajout des documents.");
    } finally {
      setBusy(false);
    }
  }

  async function supprimer(doc) {
    if (!window.confirm(`Supprimer le document${doc.numero ? ` « ${doc.numero} »` : ''} ?`)) return;
    setBusy(true);
    setError('');
    try {
      await onDelete(doc);
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la suppression.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="platform-card fiche-card">
      <SectionTitle icon={icon}>{titre}</SectionTitle>

      {docs.length === 0 ? (
        <p className="cell-sub">{vide}</p>
      ) : (
        <div className="lg-libres-list">
          {docs.map((doc) => (
            <div key={doc.id} className="lg-libre-doc">
              <Paperclip size={15} />
              <span className="lg-libre-desc">{doc.numero || 'Sans description'}</span>
              <FileValue value={doc.fichier} />
              <span className="cell-sub">Ajouté le {doc.created_at}</span>
              <button
                type="button"
                className="row-action row-action-danger lg-libre-del"
                title="Supprimer le document"
                disabled={busy}
                onClick={() => supprimer(doc)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="lg-libres-form" onSubmit={ajouter}>
        <label className="fiche-field">
          <span className="field-label">Description</span>
          <input
            type="text"
            value={description}
            maxLength={100}
            placeholder={placeholder}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="fiche-field">
          <span className="field-label">
            Fichier(s) <span className="fiche-req">*</span>
          </span>
          <label className="fiche-file">
            <span className="fiche-file-btn">Sélect. fichiers</span>
            <span className="fiche-file-name">
              {files.length
                ? `${files.length} fichier${files.length > 1 ? 's' : ''} sélectionné${files.length > 1 ? 's' : ''}`
                : 'Aucun fichier choisi'}
            </span>
            <input
              key={inputKey}
              type="file"
              accept={FILE_ACCEPT}
              multiple
              hidden
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
          </label>
          <p className="cell-sub lg-modal-hint">
            Vous pouvez sélectionner plusieurs fichiers (PDF ou image).
          </p>
        </div>
        <button type="submit" className="btn btn-primary lg-libres-btn" disabled={busy}>
          <Plus size={15} /> {busy ? 'Ajout…' : 'Ajouter'}
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Informations                                                */
/* ------------------------------------------------------------------ */

/**
 * Onglet Informations : identification (type, marque du type sélectionné,
 * n° de châssis) et caractéristiques (immatriculations, mise en circulation,
 * énergie, statut, observation) + suppression du moyen.
 */
function OngletInformations({ fiche, filtres, onSaved }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    type: fiche.type,
    marqueId: String(fiche.marque_id),
    chassis: fiche.chassis,
    immatWw: fiche.immat_ww,
    immat: fiche.immat,
    miseCirculation: fiche.mise_circulation,
    energie: fiche.energie,
    statut: fiche.statut,
    observation: fiche.observation
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    setForm({
      type: fiche.type,
      marqueId: String(fiche.marque_id),
      chassis: fiche.chassis,
      immatWw: fiche.immat_ww,
      immat: fiche.immat,
      miseCirculation: fiche.mise_circulation,
      energie: fiche.energie,
      statut: fiche.statut,
      observation: fiche.observation
    });
  }, [fiche]);

  // Le message d'enregistrement ne se réinitialise qu'au changement de moyen
  // (le re-sync du formulaire après un enregistrement le laisserait invisible).
  useEffect(() => {
    setFeedback(null);
  }, [fiche.id]);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  // Marques du type sélectionné ; la marque actuelle reste proposée même si
  // elle a été désactivée dans Configuration > Options.
  const marqueOptions = useMemo(() => {
    const list = filtres.marques
      .filter((m) => m.type === form.type)
      .map((m) => ({ value: String(m.id), label: m.nom }));
    if (
      form.type === fiche.type &&
      !list.some((o) => o.value === String(fiche.marque_id))
    ) {
      list.push({ value: String(fiche.marque_id), label: fiche.marque });
    }
    return list;
  }, [filtres.marques, form.type, fiche]);

  async function save() {
    if (!form.marqueId) {
      setFeedback({ type: 'error', text: 'Veuillez choisir la marque.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.put(`/logistiques/${fiche.id}`, {
        type: form.type,
        marqueId: Number(form.marqueId),
        chassis: form.chassis,
        immatWw: form.immatWw,
        immat: form.immat,
        miseCirculation: form.miseCirculation,
        energie: form.energie,
        statut: form.statut,
        observation: form.observation
      });
      onSaved(res.data);
      setFeedback({ type: 'success', text: 'Fiche enregistrée.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function supprimer() {
    if (!window.confirm(`Supprimer le moyen « ${moyenTitre(fiche)} » et ses documents ?`)) return;
    setDeleting(true);
    try {
      await api.delete(`/logistiques/${fiche.id}`);
      navigate('/admin/logistiques');
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setDeleting(false);
    }
  }

  return (
    <section className="platform-card fiche-card">
      <header className="fiche-head">
        <span className="fiche-head-icon">
          <ClipboardList size={22} />
        </span>
        <div className="fiche-head-text">
          <h2>Informations — {moyenTitre(fiche)}</h2>
          <p className="fiche-head-sub">
            Fiche du moyen n°{fiche.id} — le type, la marque et le n° de châssis sont
            modifiables (l'identification se fait par ce numéro).
          </p>
        </div>
        <div className="fiche-head-role">
          <button
            type="button"
            className="btn btn-danger"
            onClick={supprimer}
            disabled={deleting}
          >
            <Trash2 size={15} /> {deleting ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </header>

      <SectionTitle icon={Truck}>Identification</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field">
          <span className="field-label">
            Type <span className="fiche-req">*</span>
          </span>
          <select
            value={form.type}
            onChange={(e) => {
              const type = e.target.value;
              // Marque remise à zéro si elle n'est pas du nouveau type.
              const garde = filtres.marques.some(
                (m) => m.type === type && String(m.id) === form.marqueId
              );
              setForm((prev) => ({ ...prev, type, marqueId: garde ? prev.marqueId : '' }));
            }}
          >
            {filtres.types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="fiche-field">
          <span className="field-label">
            Marque <span className="fiche-req">*</span>
          </span>
          <SearchableSelect
            value={form.marqueId}
            onChange={(v) => setField('marqueId', v)}
            options={marqueOptions}
            placeholder="— Choisir la marque —"
            emptyText="Aucune marque de ce type (Configuration > Options)."
          />
        </div>
        <label className="fiche-field span-2">
          <span className="field-label">
            N° de châssis <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.chassis}
            maxLength={100}
            onChange={(e) => setField('chassis', e.target.value)}
          />
        </label>
      </div>

      <SectionTitle icon={Info}>Caractéristiques</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field">
          <span className="field-label">Immatriculation WW</span>
          <input
            type="text"
            value={form.immatWw}
            maxLength={50}
            onChange={(e) => setField('immatWw', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Immatriculation</span>
          <input
            type="text"
            value={form.immat}
            maxLength={50}
            onChange={(e) => setField('immat', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Mise en circulation</span>
          <input
            type="date"
            value={form.miseCirculation}
            onChange={(e) => setField('miseCirculation', e.target.value)}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Énergie</span>
          <select value={form.energie} onChange={(e) => setField('energie', e.target.value)}>
            <option value="">— Choisir —</option>
            {filtres.energies.map((en) => (
              <option key={en.code} value={en.code}>
                {en.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fiche-field">
          <span className="field-label">Statut</span>
          <select value={form.statut} onChange={(e) => setField('statut', e.target.value)}>
            {filtres.statuts.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fiche-field span-2 lg-observation">
          <span className="field-label">Observation</span>
          <textarea
            rows={3}
            value={form.observation}
            maxLength={2000}
            onChange={(e) => setField('observation', e.target.value)}
          />
        </label>
      </div>

      <footer className="fiche-footer">
        <span className="fiche-updated">
          <Clock size={14} />
          {fiche.updated_at
            ? `Dernière mise à jour : ${fiche.updated_at}`
            : `Créé le ${fiche.created_at}`}
        </span>
        {feedback && (
          <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
            {feedback.text}
          </span>
        )}
        <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={save}>
          <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </footer>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Maintenance                                                 */
/* ------------------------------------------------------------------ */

/** Modale « Nouvelle vidange » : kilométrage + éléments remplacés. */
function VidangeModal({ fiche, onClose, onSaved }) {
  const [km, setKm] = useState('');
  const [checks, setChecks] = useState({
    filtreHuile: false,
    filtreCarburant: false,
    filtreAir: false,
    adblue: false,
    antiCristallisant: false
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const ITEMS = [
    ['filtreHuile', 'Filtre à huile'],
    ['filtreCarburant', 'Filtre à carburant'],
    ['filtreAir', 'Filtre à air'],
    ['adblue', 'AdBlue'],
    ['antiCristallisant', 'Anti-cristallisant']
  ];

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/logistiques/${fiche.id}/vidanges`, {
        km: Number(km),
        ...checks
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de la vidange.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Droplets size={18} />
            <div className="cell-main">Nouvelle vidange</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Kilométrage *</span>
              <input
                type="number"
                min="0"
                step="1"
                value={km}
                onChange={(e) => setKm(e.target.value)}
                placeholder="Ex. : 45 000"
                required
              />
            </label>
            <div className="modal-form-full">
              <span className="field-label">Remplacés en même temps</span>
              <div className="lg-checks">
                {ITEMS.map(([key, label]) => (
                  <label key={key} className="lg-check-item">
                    <input
                      type="checkbox"
                      checked={checks[key]}
                      onChange={(e) => setChecks((c) => ({ ...c, [key]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Ajouter un entretien » : type, kilométrage, observation. */
function EntretienModal({ fiche, filtres, onClose, onSaved }) {
  const [form, setForm] = useState({ type: '', km: '', observation: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/logistiques/${fiche.id}/entretiens`, {
        type: form.type,
        km: Number(form.km),
        observation: form.observation
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de l'entretien.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Cog size={18} />
            <div className="cell-main">Ajouter un entretien</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Type *</span>
              <select
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                required
              >
                <option value="">— Choisir —</option>
                {filtres.entretienTypes.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Kilométrage *</span>
              <input
                type="number"
                min="0"
                step="1"
                value={form.km}
                onChange={(e) => setForm((f) => ({ ...f, km: e.target.value }))}
                required
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Observation (facultatif)</span>
              <textarea
                rows={3}
                value={form.observation}
                maxLength={500}
                onChange={(e) => setForm((f) => ({ ...f, observation: e.target.value }))}
                placeholder="Détail de l'entretien…"
              />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Ajouter une recharge » : montant, kilométrage, date & heure. */
function ConsoModal({ fiche, onClose, onSaved }) {
  const [form, setForm] = useState({ montant: '', km: '', rechargeAt: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await api.post(`/logistiques/${fiche.id}/consommations`, {
        montant: form.montant,
        km: Number(form.km),
        rechargeAt: form.rechargeAt
      });
      onSaved(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de la recharge.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Fuel size={18} />
            <div className="cell-main">Ajouter une recharge</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Montant (DH) *</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.montant}
                onChange={(e) => setForm((f) => ({ ...f, montant: e.target.value }))}
                required
              />
            </label>
            <label>
              <span className="field-label">Kilométrage *</span>
              <input
                type="number"
                min="0"
                step="1"
                value={form.km}
                onChange={(e) => setForm((f) => ({ ...f, km: e.target.value }))}
                required
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Date &amp; heure de recharge *</span>
              <input
                type="datetime-local"
                value={form.rechargeAt}
                onChange={(e) => setForm((f) => ({ ...f, rechargeAt: e.target.value }))}
                required
              />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ALERT_ICONS = { info: Info, success: Check, warn: TriangleAlert, urgent: TriangleAlert };

/** Onglet Maintenance : prochaine vidange + alertes, puis les 3 historiques. */
function OngletMaintenance({ fiche, filtres }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(''); // '' | 'vidange' | 'entretien' | 'conso'
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api
      .get(`/logistiques/${fiche.id}/maintenance`)
      .then((res) => {
        if (!cancelled) setData(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement de la maintenance.');
      });
    return () => {
      cancelled = true;
    };
  }, [fiche.id]);

  function handleSaved(payload) {
    setData(payload);
    setModal('');
  }

  async function supprimer(kind, item, libelle) {
    if (!window.confirm(`Supprimer ${libelle} (${formatKm(item.km)}) ?`)) return;
    setBusyId(`${kind}-${item.id}`);
    try {
      const res = await api.delete(`/logistiques/${fiche.id}/${kind}/${item.id}`);
      setData(res.data);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    } finally {
      setBusyId('');
    }
  }

  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <p className="cell-sub">Chargement de la maintenance…</p>;

  const bool = (v) => (Number(v) === 1 ? <Check size={16} className="lg-oui" /> : '—');

  return (
    <>
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <Wrench size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Maintenance — {moyenTitre(fiche)}</h2>
            <p className="fiche-head-sub">
              Prochaine vidange estimée (dernière vidange + {formatKm(data.intervalleVidange)}) et
              alertes du moyen
            </p>
          </div>
        </header>

        <div className="lg-mnt-grid">
          <div>
            <SectionTitle icon={Droplets}>Prochaine vidange</SectionTitle>
            {data.derniereVidange ? (
              <>
                <div className="lg-prochaine-value">≈ {formatKm(data.prochaineVidange)}</div>
                <p className="cell-sub">
                  Dernière vidange : {formatKm(data.derniereVidange.km)} ·{' '}
                  {data.derniereVidange.date}
                </p>
                {data.dernierKm !== null && (
                  <p className="cell-sub">Dernier kilométrage relevé : {formatKm(data.dernierKm)}</p>
                )}
              </>
            ) : (
              <p className="cell-sub">
                <Info size={14} /> Aucune vidange enregistrée : la prochaine vidange sera estimée à
                partir de la première saisie.
              </p>
            )}
          </div>
          <div>
            <SectionTitle icon={Bell}>Alertes</SectionTitle>
            {data.alertes.map((a, i) => {
              const AlertIcon = ALERT_ICONS[a.niveau] || Info;
              return (
                <div key={i} className={`lg-alert lg-alert-${a.niveau}`}>
                  <AlertIcon size={16} /> {a.texte}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="platform-card fiche-card">
        <div className="bons-head">
          <h2>
            <Droplets size={18} /> Vidanges
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('vidange')}>
            <Plus size={15} /> Nouvelle vidange
          </button>
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Filtre à huile</th>
                <th>Filtre à carburant</th>
                <th>Filtre à air</th>
                <th>AdBlue</th>
                <th>Anti-cristallisant</th>
                <th>Kilométrage</th>
                <th>Date d'ajout</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.vidanges.length === 0 ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucune vidange enregistrée.
                  </td>
                </tr>
              ) : (
                data.vidanges.map((v) => (
                  <tr key={v.id}>
                    <td>{bool(v.filtre_huile)}</td>
                    <td>{bool(v.filtre_carburant)}</td>
                    <td>{bool(v.filtre_air)}</td>
                    <td>{bool(v.adblue)}</td>
                    <td>{bool(v.anti_cristallisant)}</td>
                    <td>
                      <div className="cell-main">{formatKm(v.km)}</div>
                    </td>
                    <td>{v.created_at}</td>
                    <td>
                      <button
                        type="button"
                        className="row-action row-action-danger"
                        title="Supprimer la vidange"
                        disabled={busyId === `vidanges-${v.id}`}
                        onClick={() => supprimer('vidanges', v, 'la vidange')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="platform-card fiche-card">
        <div className="bons-head">
          <h2>
            <Cog size={18} /> Entretiens
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('entretien')}>
            <Plus size={15} /> Ajouter
          </button>
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Kilométrage</th>
                <th>Observation</th>
                <th>Date d'ajout</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.entretiens.length === 0 ? (
                <tr>
                  <td colSpan={5} className="datatable-empty">
                    Aucun entretien enregistré.
                  </td>
                </tr>
              ) : (
                data.entretiens.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="cell-main">{labelOf(filtres.entretienTypes, e.type)}</div>
                    </td>
                    <td>{formatKm(e.km)}</td>
                    <td>{e.observation || '—'}</td>
                    <td>{e.created_at}</td>
                    <td>
                      <button
                        type="button"
                        className="row-action row-action-danger"
                        title="Supprimer l'entretien"
                        disabled={busyId === `entretiens-${e.id}`}
                        onClick={() => supprimer('entretiens', e, "l'entretien")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="platform-card fiche-card">
        <div className="bons-head">
          <h2>
            <Fuel size={18} /> Consommation
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('conso')}>
            <Plus size={15} /> Ajouter
          </button>
        </div>
        <div className="table-wrap datatable">
          <table>
            <thead>
              <tr>
                <th>Montant</th>
                <th>Kilométrage</th>
                <th>Date &amp; heure de recharge</th>
                <th>Date d'ajout</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.consommations.length === 0 ? (
                <tr>
                  <td colSpan={5} className="datatable-empty">
                    Aucune recharge enregistrée.
                  </td>
                </tr>
              ) : (
                data.consommations.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cell-main">{formatDh(c.montant)}</div>
                    </td>
                    <td>{formatKm(c.km)}</td>
                    <td>{c.recharge_at}</td>
                    <td>{c.created_at}</td>
                    <td>
                      <button
                        type="button"
                        className="row-action row-action-danger"
                        title="Supprimer la recharge"
                        disabled={busyId === `consommations-${c.id}`}
                        onClick={() => supprimer('consommations', c, 'la recharge')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {modal === 'vidange' && (
        <VidangeModal fiche={fiche} onClose={() => setModal('')} onSaved={handleSaved} />
      )}
      {modal === 'entretien' && (
        <EntretienModal fiche={fiche} filtres={filtres} onClose={() => setModal('')} onSaved={handleSaved} />
      )}
      {modal === 'conso' && (
        <ConsoModal fiche={fiche} onClose={() => setModal('')} onSaved={handleSaved} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Documents                                                   */
/* ------------------------------------------------------------------ */

/** Onglet Documents : réglementaires (upsert) + autres documents. */
function OngletDocuments({ fiche }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    carte_grise: '',
    visite_technique: '',
    assurance: '',
    vignette: ''
  });
  const [files, setFiles] = useState({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    setFeedback(null);
    setFiles({});
    api
      .get(`/logistiques/${fiche.id}/documents`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        const r = res.data.reglementaires;
        setForm({
          carte_grise: r.carte_grise.expiration || '',
          visite_technique: r.visite_technique.expiration || '',
          assurance: r.assurance.expiration || '',
          vignette: r.vignette.expiration || ''
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des documents.');
      });
    return () => {
      cancelled = true;
    };
  }, [fiche.id]);

  function setFile(name, file) {
    setFiles((prev) => ({ ...prev, [name]: file }));
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const fd = new FormData();
      fd.append('carte_grise_expiration', form.carte_grise);
      fd.append('visite_technique_expiration', form.visite_technique);
      fd.append('assurance_expiration', form.assurance);
      fd.append('vignette_expiration', form.vignette);
      for (const name of ['carte_grise_recto', 'carte_grise_verso', 'visite_technique', 'assurance', 'vignette']) {
        if (files[name]) fd.append(name, files[name]);
      }
      const res = await api.put(`/logistiques/${fiche.id}/documents`, fd);
      setData(res.data);
      setFiles({});
      setFeedback({ type: 'success', text: 'Documents enregistrés.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function addAutre(description, fileList) {
    const fd = new FormData();
    fd.append('description', description);
    for (const f of fileList) fd.append('fichiers', f);
    const res = await api.post(`/logistiques/${fiche.id}/documents/autres`, fd);
    setData(res.data);
  }

  async function deleteAutre(doc) {
    const res = await api.delete(`/logistiques/${fiche.id}/documents/autres/${doc.id}`);
    setData(res.data);
  }

  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <p className="cell-sub">Chargement des documents…</p>;

  const regl = data.reglementaires;

  return (
    <>
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <FolderOpen size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Documents — {moyenTitre(fiche)}</h2>
            <p className="fiche-head-sub">
              Documents réglementaires du moyen (carte grise, visite technique, assurance,
              vignette) — PDF ou image, 10 Mo max.
            </p>
          </div>
        </header>

        <SectionTitle icon={CreditCard}>
          Carte grise <ExpireBadge date={form.carte_grise} />
        </SectionTitle>
        <div className="fiche-grid">
          <label className="fiche-field">
            <span className="field-label">Valable jusqu'à</span>
            <input
              type="date"
              value={form.carte_grise}
              onChange={(e) => setForm((f) => ({ ...f, carte_grise: e.target.value }))}
            />
          </label>
          <FileField
            label="Recto"
            name="carte_grise_recto"
            current={regl.carte_grise.fichier}
            file={files.carte_grise_recto}
            onChange={setFile}
          />
          <FileField
            label="Verso"
            name="carte_grise_verso"
            current={regl.carte_grise.fichier2}
            file={files.carte_grise_verso}
            onChange={setFile}
          />
        </div>

        <SectionTitle icon={ClipboardCheck}>
          Visite technique <ExpireBadge date={form.visite_technique} />
        </SectionTitle>
        <div className="fiche-grid">
          <label className="fiche-field">
            <span className="field-label">Valable jusqu'à</span>
            <input
              type="date"
              value={form.visite_technique}
              onChange={(e) => setForm((f) => ({ ...f, visite_technique: e.target.value }))}
            />
          </label>
          <FileField
            label="Fichier"
            name="visite_technique"
            current={regl.visite_technique.fichier}
            file={files.visite_technique}
            onChange={setFile}
          />
        </div>

        <SectionTitle icon={ShieldCheck}>
          Assurance <ExpireBadge date={form.assurance} />
        </SectionTitle>
        <div className="fiche-grid">
          <label className="fiche-field">
            <span className="field-label">Valable jusqu'à</span>
            <input
              type="date"
              value={form.assurance}
              onChange={(e) => setForm((f) => ({ ...f, assurance: e.target.value }))}
            />
          </label>
          <FileField
            label="Fichier"
            name="assurance"
            current={regl.assurance.fichier}
            file={files.assurance}
            onChange={setFile}
          />
        </div>

        <SectionTitle icon={Ticket}>
          Vignette <ExpireBadge date={form.vignette} />
        </SectionTitle>
        <div className="fiche-grid">
          <label className="fiche-field">
            <span className="field-label">Valable jusqu'à</span>
            <input
              type="date"
              value={form.vignette}
              onChange={(e) => setForm((f) => ({ ...f, vignette: e.target.value }))}
            />
          </label>
          <FileField
            label="Fichier"
            name="vignette"
            current={regl.vignette.fichier}
            file={files.vignette}
            onChange={setFile}
          />
        </div>

        <div className="lg-docs-actions">
          {feedback && (
            <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
              {feedback.text}
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer les documents'}
          </button>
        </div>
      </section>

      <DocumentsLibres
        icon={Paperclip}
        titre="Autres documents"
        vide="Aucun autre document enregistré pour ce moyen."
        placeholder="Ex. Attestation, procès-verbal…"
        docs={data.autres}
        onAdd={addAutre}
        onDelete={deleteAutre}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Financement                                                 */
/* ------------------------------------------------------------------ */

/** "AAAA-MM-JJ" + n mois → "JJ/MM/AAAA" (fin de crédit affichée). */
function addMonths(dayStr, months) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(y, m - 1 + months, d).toLocaleDateString('fr-FR');
}

/** Onglet Financement : achat / crédit (totaux automatiques) + documents. */
function OngletFinancement({ fiche, filtres }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    prixAchat: '',
    methode: '',
    apport: '',
    mensualite: '',
    nbMensualites: '',
    premiereMensualite: ''
  });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    setFeedback(null);
    api
      .get(`/logistiques/${fiche.id}/financement`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        const f = res.data.financement;
        setForm({
          prixAchat: f?.prix_achat != null ? String(f.prix_achat) : '',
          methode: f?.methode || '',
          apport: f?.apport != null ? String(f.apport) : '',
          mensualite: f?.mensualite != null ? String(f.mensualite) : '',
          nbMensualites: f?.nb_mensualites != null ? String(f.nb_mensualites) : '',
          premiereMensualite: f?.premiere_mensualite || ''
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du financement.');
      });
    return () => {
      cancelled = true;
    };
  }, [fiche.id]);

  const aCredit = form.methode === 'credit' || form.methode === 'leasing';

  // Totaux affichés en direct : total payé, coût du financement, fin de crédit.
  const totaux = useMemo(() => {
    if (!aCredit) return null;
    const apport = Number(form.apport) || 0;
    const mensualite = Number(form.mensualite) || 0;
    const nb = Number(form.nbMensualites) || 0;
    const prix = Number(form.prixAchat) || 0;
    const total = apport + mensualite * nb;
    return {
      total,
      cout: prix ? total - prix : null,
      fin: form.premiereMensualite && nb > 0 ? addMonths(form.premiereMensualite, nb - 1) : null
    };
  }, [aCredit, form]);

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await api.put(`/logistiques/${fiche.id}/financement`, {
        prixAchat: form.prixAchat,
        methode: form.methode,
        apport: form.apport,
        mensualite: form.mensualite,
        nbMensualites: form.nbMensualites,
        premiereMensualite: form.premiereMensualite
      });
      setData((prev) => ({ ...res.data, documents: res.data.documents ?? prev?.documents ?? [] }));
      setFeedback({ type: 'success', text: 'Financement enregistré.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function addDoc(description, fileList) {
    const fd = new FormData();
    fd.append('description', description);
    for (const f of fileList) fd.append('fichiers', f);
    const res = await api.post(`/logistiques/${fiche.id}/financement/documents`, fd);
    setData(res.data);
  }

  async function deleteDoc(doc) {
    const res = await api.delete(`/logistiques/${fiche.id}/financement/documents/${doc.id}`);
    setData(res.data);
  }

  if (error) return <div className="form-error">{error}</div>;
  if (!data) return <p className="cell-sub">Chargement du financement…</p>;

  return (
    <>
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <HandCoins size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Financement — {moyenTitre(fiche)}</h2>
            <p className="fiche-head-sub">
              Prix et méthode d'achat du moyen ; détail du crédit le cas échéant (les totaux
              sont calculés automatiquement).
            </p>
          </div>
        </header>

        <SectionTitle icon={ShoppingCart}>Achat</SectionTitle>
        <div className="fiche-grid">
          <label className="fiche-field">
            <span className="field-label">
              Prix d'achat <span className="fiche-hint">(DH)</span>
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.prixAchat}
              onChange={(e) => setForm((f) => ({ ...f, prixAchat: e.target.value }))}
            />
          </label>
          <label className="fiche-field">
            <span className="field-label">Méthode d'achat</span>
            <select
              value={form.methode}
              onChange={(e) => setForm((f) => ({ ...f, methode: e.target.value }))}
            >
              <option value="">— Choisir —</option>
              {filtres.methodes.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {aCredit && (
          <>
            <SectionTitle icon={CreditCard}>Détail du crédit</SectionTitle>
            <div className="fiche-grid">
              <label className="fiche-field">
                <span className="field-label">
                  Apport / avance <span className="fiche-hint">(DH)</span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.apport}
                  onChange={(e) => setForm((f) => ({ ...f, apport: e.target.value }))}
                />
              </label>
              <label className="fiche-field">
                <span className="field-label">
                  Mensualité <span className="fiche-hint">(DH)</span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.mensualite}
                  onChange={(e) => setForm((f) => ({ ...f, mensualite: e.target.value }))}
                />
              </label>
              <label className="fiche-field">
                <span className="field-label">Nombre de mensualités</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  max="600"
                  value={form.nbMensualites}
                  onChange={(e) => setForm((f) => ({ ...f, nbMensualites: e.target.value }))}
                />
              </label>
              <label className="fiche-field">
                <span className="field-label">1ère mensualité</span>
                <input
                  type="date"
                  value={form.premiereMensualite}
                  onChange={(e) => setForm((f) => ({ ...f, premiereMensualite: e.target.value }))}
                />
              </label>
            </div>

            {totaux && (
              <div className="stats-grid lg-fin-totaux">
                <div className="stat-card">
                  <div className="stat-value">{formatDh(totaux.total)}</div>
                  <div className="stat-label">Total payé (apport + mensualités)</div>
                </div>
                <div className={`stat-card ${totaux.cout != null && totaux.cout > 0 ? 'tone-danger' : ''}`}>
                  <div className="stat-value">{totaux.cout != null ? formatDh(totaux.cout) : '—'}</div>
                  <div className="stat-label">Coût du financement</div>
                </div>
                <div className="stat-card tone-primary">
                  <div className="stat-value">{totaux.fin || '—'}</div>
                  <div className="stat-label">Fin de crédit</div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="lg-docs-actions">
          {feedback && (
            <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
              {feedback.text}
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
            <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer le financement'}
          </button>
        </div>
      </section>

      <DocumentsLibres
        icon={Paperclip}
        titre="Documents du financement"
        vide="Aucun document de financement enregistré pour ce moyen."
        placeholder="Ex. Contrat de crédit, tableau d'amortissement…"
        docs={data.documents}
        onAdd={addDoc}
        onDelete={deleteDoc}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Matériels                                                   */
/* ------------------------------------------------------------------ */

/** Onglet Matériels : consommations de matériel auto sur ce moyen (mouvements
 * « Consommation véhicule » saisis depuis la page /admin/materiel, lecture
 * seule ici). */
function OngletMateriels({ fiche }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/logistiques/${fiche.id}/materiels`)
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des matériels.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fiche.id]);

  return (
    <>
      <section className="platform-card fiche-card">
        <header className="fiche-head">
          <span className="fiche-head-icon">
            <Boxes size={22} />
          </span>
          <div className="fiche-head-text">
            <h2>Matériels — {moyenTitre(fiche)}</h2>
            <p className="fiche-head-sub">
              Matériel auto consommé sur ce moyen (saisi depuis la page Matériel)
            </p>
          </div>
        </header>
        <div className="lg-alert lg-alert-info">
          <Info size={16} /> Les consommations se saisissent depuis l'onglet Auto de la page
          Matériel (action « Consommation véhicule ») : elles s'affichent ici en lecture seule.
        </div>
      </section>

      <section className="platform-card fiche-card">
        <div className="bons-head">
          <h2>
            <Clock size={18} /> Matériel consommé sur ce moyen
          </h2>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Matériel</th>
                <th>Quantité</th>
                <th>Commentaire</th>
                <th>Par</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="datatable-empty">
                    Aucun matériel consommé sur ce moyen.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>{r.materiel}</td>
                    <td>
                      {r.qte}
                      {r.unite ? ` ${r.unite}` : ''}
                    </td>
                    <td>{r.commentaire || '—'}</td>
                    <td>{r.par || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Fiche d'un moyen logistique : en-tête (retour, sélecteur, ajout) + onglets. */
export default function FicheLogistique() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { fiche, moyens }
  const [filtres, setFiltres] = useState(null);
  const [tab, setTab] = useState('infos');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([api.get(`/logistiques/${id}`), api.get('/logistiques/filtres')])
      .then(([ficheRes, filtresRes]) => {
        if (cancelled) return;
        setData(ficheRes.data);
        setFiltres(filtresRes.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement de la fiche.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <p className="cell-sub">Chargement de la fiche…</p>;
  if (error) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{error}</div>
          <Link className="btn btn-ghost" to="/admin/logistiques">
            <ArrowLeft size={15} /> Retour à la liste du parc
          </Link>
        </section>
      </div>
    );
  }
  if (!data || !filtres) return null;

  return (
    <div className="fiche-page">
      <div className="bons-head lg-fiche-top">
        <div>
          <h2>
            <Truck size={18} /> Logistiques
          </h2>
          <Link to="/admin/logistiques" className="lg-retour">
            <ArrowLeft size={14} /> Retour à la liste du parc
          </Link>
        </div>
        <div className="lg-fiche-actions">
          <span className="lg-moyen-label">
            <Truck size={15} /> Moyen :
          </span>
          <SearchableSelect
            className="lg-moyen-select"
            value={String(data.fiche.id)}
            onChange={(v) => {
              if (String(v) !== String(id)) navigate(`/admin/logistiques/${v}`);
            }}
            options={data.moyens.map((m) => ({ value: String(m.id), label: m.label }))}
          />
          <button type="button" className="btn btn-primary" onClick={() => setModal(true)}>
            <Plus size={15} /> Ajouter
          </button>
        </div>
      </div>

      <nav className="fiche-tabs" aria-label="Onglets de la fiche">
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

      {tab === 'infos' ? (
        <OngletInformations fiche={data.fiche} filtres={filtres} onSaved={setData} />
      ) : tab === 'maintenance' ? (
        <OngletMaintenance fiche={data.fiche} filtres={filtres} />
      ) : tab === 'documents' ? (
        <OngletDocuments fiche={data.fiche} />
      ) : tab === 'financement' ? (
        <OngletFinancement fiche={data.fiche} filtres={filtres} />
      ) : (
        <OngletMateriels fiche={data.fiche} />
      )}

      {modal && (
        <NouveauMoyenModal
          filtres={filtres}
          onClose={() => setModal(false)}
          onSaved={(newId) => {
            setModal(false);
            navigate(`/admin/logistiques/${newId}`);
          }}
        />
      )}
    </div>
  );
}
