import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  BarChart3,
  Bike,
  Check,
  Clock,
  Contact,
  FileText,
  HandCoins,
  KeyRound,
  MapPin,
  Save,
  Scale,
  Trash2,
  UserRound,
  Wrench
} from 'lucide-react';
import api from '../../api/client';
import LivreurAnalyse from '../../components/LivreurAnalyse';
import MaterielAffectations from '../../components/MaterielAffectations';
import SearchableSelect from '../../components/SearchableSelect';

const TABS = [
  { key: 'compte', label: 'Compte', icon: KeyRound },
  { key: 'infos', label: 'Infos personnelles', icon: Contact },
  { key: 'analyse', label: 'Analyse', icon: BarChart3 },
  { key: 'materiel', label: 'Matériel', icon: Wrench }
];

/* Champs texte / date / select de l'onglet Infos personnelles (état du formulaire). */
const FORM_FIELDS = [
  'users_name',
  'users_cin',
  'users_date_naissance',
  'users_city',
  'users_address',
  'users_forme_juridique',
  'users_ice',
  'users_rc',
  'users_societe_email',
  'users_siege_social',
  'users_ae_numero',
  'users_ae_carte_expiration',
  'users_bank',
  'users_rib'
];

/**
 * Champs affichés selon la forme juridique choisie :
 * SARL / SARLAU → société (ICE, RC…) ; auto-entrepreneur → N° inscription,
 * carte AE ; personne physique / particulier (et autres) → aucun champ.
 */
function formeKind(forme) {
  const v = String(forme || '').toLowerCase();
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
        <h2>{title} — {fiche.users_name || `Livreur n°${fiche.users_id}`}</h2>
        <p className="fiche-head-sub">
          {`Compte livreur n°${fiche.users_id}`}
          {/* Zone et agence dérivées de la ville de fonction. */}
          {[fiche.ville_fonction, fiche.zone, fiche.agence].some(Boolean) &&
            ` — ${[fiche.ville_fonction, fiche.zone, fiche.agence].filter(Boolean).join(' · ')}`}
        </p>
      </div>
      <div className="fiche-head-role">
        <span className="fiche-hint">Rôle(s) / mission(s)</span>
        <span className="badge fiche-role-badge">
          <Bike size={13} /> Livreur
        </span>
      </div>
    </header>
  );
}

/**
 * Onglet "Compte" : informations de connexion (email / mot de passe /
 * téléphone pro) + tarifs par ville (bouton Appliquer = ville de fonction
 * enregistrée + frais appliqués aux villes actives de sa zone — par défaut
 * seulement celles sans tarif, case « Conserver les tarifs existants »).
 * Le tableau liste aussi les villes actives de la zone sans tarif (badge
 * « Sans tarif ») : saisir les frais puis enregistrer tarife cette seule ville.
 * `self` (« Ma fiche » du dashboard livreur) : seule la section connexion,
 * modifiable via PUT /livreurs/me/compte — les tarifs restent gérés par
 * le service LIVREURS.
 */
function OngletCompte({ fiche, options, onSaved, self = false, apiBase = `/livreurs/${fiche.users_id}` }) {
  const [form, setForm] = useState({
    users_email: fiche.users_email || '',
    users_phone: fiche.users_phone || '',
    password: '',
    password2: ''
  });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  /* Lignes = villes déjà tarifées + villes actives de la zone de fonction sans
     tarif (id null → enregistrable une par une via POST /tarifs). */
  const [rows, setRows] = useState(null); // null = chargement
  const [apply, setApply] = useState({
    villeId: fiche.users_ville_id != null ? String(fiche.users_ville_id) : '',
    fraisLivraison: '',
    fraisRefuse: '',
    conserver: true // ne renseigner que les villes sans tarif
  });
  const [applying, setApplying] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [tarifFeedback, setTarifFeedback] = useState(null);

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      users_email: fiche.users_email || '',
      users_phone: fiche.users_phone || ''
    }));
  }, [fiche]);

  /* Ligne éditable : frais en texte + valeurs d'origine pour détecter les modifications. */
  function toRows(tarifs) {
    return tarifs.map((t) => ({
      ...t,
      fl: t.fraisLivraison != null ? String(t.fraisLivraison) : '',
      fr: t.fraisRefuse != null ? String(t.fraisRefuse) : ''
    }));
  }

  useEffect(() => {
    if (self) return undefined; // « Ma fiche » : pas de section tarifs.
    let cancelled = false;
    api
      .get(`${apiBase}/tarifs`)
      .then((res) => {
        if (!cancelled) setRows(toRows(res.data.tarifs));
      })
      .catch((err) => {
        if (!cancelled) {
          setRows([]);
          setTarifFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur de chargement des tarifs.' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, self]);

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  const villes = useMemo(() => {
    const list = options.villes || [];
    const current = Number(apply.villeId);
    if (current && !list.some((v) => v.id === current)) {
      return [...list, { id: current, nom: `Ville n°${current}` }];
    }
    return list;
  }, [options.villes, apply.villeId]);

  async function saveConnexion() {
    if (form.password && form.password.length < 8) {
      setFeedback({ type: 'error', text: 'Le mot de passe doit contenir au moins 8 caractères.' });
      return;
    }
    if (form.password !== form.password2) {
      setFeedback({ type: 'error', text: 'Les deux mots de passe ne correspondent pas.' });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const payload = { users_email: form.users_email, users_phone: form.users_phone };
      if (form.password) payload.password = form.password;
      const res = await api.put(`${apiBase}/compte`, payload);
      onSaved(res.data);
      setForm((prev) => ({ ...prev, password: '', password2: '' }));
      setFeedback({ type: 'success', text: 'Informations de connexion enregistrées.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  async function appliquer() {
    if (!apply.villeId) {
      setTarifFeedback({ type: 'error', text: 'Veuillez sélectionner une ville de fonction.' });
      return;
    }
    setApplying(true);
    setTarifFeedback(null);
    try {
      const res = await api.post(`/livreurs/${fiche.users_id}/tarifs/appliquer`, {
        villeId: Number(apply.villeId),
        fraisLivraison: Number(apply.fraisLivraison || 0),
        fraisRefuse: Number(apply.fraisRefuse || 0),
        conserver: apply.conserver
      });
      setRows(toRows(res.data.tarifs));
      onSaved({
        ...fiche,
        users_ville_id: res.data.users_ville_id,
        ville_fonction: res.data.ville_fonction,
        zone: res.data.zone,
        agence: res.data.agence
      });
      setTarifFeedback({
        type: 'success',
        text: apply.conserver
          ? 'Ville de fonction enregistrée ; frais appliqués aux villes de la zone qui n’avaient pas de tarif.'
          : 'Tarifs appliqués à toutes les villes de la zone.'
      });
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'application des tarifs." });
    } finally {
      setApplying(false);
    }
  }

  /* Ligne sans tarif : enregistrable dès qu'un montant est saisi (0 compris). */
  function isDirty(row) {
    if (row.id == null) return row.fl !== '' || row.fr !== '';
    return Number(row.fl || 0) !== Number(row.fraisLivraison || 0) ||
      Number(row.fr || 0) !== Number(row.fraisRefuse || 0);
  }

  function setRowField(villeId, name, value) {
    setRows((prev) => prev.map((r) => (r.villeId === villeId ? { ...r, [name]: value } : r)));
  }

  /* Ligne existante → PUT /tarifs/:id ; ville sans tarif → POST /tarifs (une
     seule ville, les autres tarifs restent intacts). */
  async function saveRow(row) {
    setBusyRow(row.villeId);
    setTarifFeedback(null);
    try {
      const payload = { fraisLivraison: Number(row.fl || 0), fraisRefuse: Number(row.fr || 0) };
      const res = row.id == null
        ? await api.post(`/livreurs/${fiche.users_id}/tarifs`, { ...payload, villeId: row.villeId })
        : await api.put(`/livreurs/${fiche.users_id}/tarifs/${row.id}`, payload);
      setRows((prev) => prev.map((r) => (r.villeId === row.villeId ? toRows([res.data])[0] : r)));
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement du tarif." });
    } finally {
      setBusyRow(null);
    }
  }

  /* Suppression : la ville reste listée « sans tarif » si elle est active dans
     la zone de fonction (même règle que le chargement), sinon elle disparaît. */
  async function removeRow(row) {
    if (!window.confirm(`Supprimer le tarif de « ${row.ville} » ?`)) return;
    setBusyRow(row.villeId);
    setTarifFeedback(null);
    try {
      await api.delete(`/livreurs/${fiche.users_id}/tarifs/${row.id}`);
      const res = await api.get(`${apiBase}/tarifs`);
      setRows(toRows(res.data.tarifs));
    } catch (err) {
      setTarifFeedback({ type: 'error', text: err.response?.data?.message || 'Échec de la suppression.' });
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <section className="platform-card fiche-card">
      <FicheHead icon={KeyRound} title="Compte" fiche={fiche} />

      <SectionTitle icon={KeyRound}>Informations de connexion</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Adresse électronique</span>
          <input
            type="email"
            value={form.users_email}
            onChange={(e) => setField('users_email', e.target.value)}
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
        <label className="fiche-field span-2">
          <span className="field-label">N° téléphone professionnel</span>
          <input
            type="tel"
            value={form.users_phone}
            onChange={(e) => setField('users_phone', e.target.value)}
          />
        </label>
      </div>
      <div className="fiche-inline-actions">
        {feedback && (
          <span className={feedback.type === 'error' ? 'field-error' : 'field-success'}>
            {feedback.text}
          </span>
        )}
        <button type="button" className="btn btn-primary fiche-save" disabled={saving} onClick={saveConnexion}>
          <Check size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>

      {!self && (
      <>
      <SectionTitle icon={HandCoins}>Tarifs</SectionTitle>
      <div className="fiche-grid">
        <div className="fiche-field span-2">
          <span className="field-label">Ville de fonction</span>
          <SearchableSelect
            value={apply.villeId}
            onChange={(v) => setApply((p) => ({ ...p, villeId: String(v) }))}
            placeholder="— Choisir la ville —"
            options={villes.map((v) => ({ value: v.id, label: v.nom }))}
          />
        </div>
        <label className="fiche-field">
          <span className="field-label">Frais de livraison</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={apply.fraisLivraison}
            onChange={(e) => setApply((p) => ({ ...p, fraisLivraison: e.target.value }))}
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Frais de refusé</span>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={apply.fraisRefuse}
            onChange={(e) => setApply((p) => ({ ...p, fraisRefuse: e.target.value }))}
          />
        </label>
      </div>
      <div className="fiche-inline-actions">
        <span className="fiche-hint fiche-tarifs-note">
          Les frais s’appliquent aux villes actives de la zone de la ville choisie
          (les tarifs des autres zones sont conservés). Les villes de la zone sans tarif
          sont listées ci-dessous et se tarifent une par une.
          <label className="fiche-tarifs-option">
            <input
              type="checkbox"
              checked={apply.conserver}
              onChange={(e) => setApply((p) => ({ ...p, conserver: e.target.checked }))}
            />
            Conserver les tarifs existants (ne renseigner que les villes sans tarif)
          </label>
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

      {rows === null ? (
        <p className="cell-sub">Chargement des tarifs…</p>
      ) : (
        <div className="table-wrap fiche-tarifs-table">
          <table>
            <thead>
              <tr>
                <th>Nom de ville</th>
                <th>Frais de livraison</th>
                <th>Frais de refusé</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucun tarif — choisissez une ville de fonction puis cliquez sur « Appliquer ».
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.villeId} className={r.id == null ? 'fiche-tarif-absent' : undefined}>
                    <td>
                      <div className="cell-main">
                        {r.ville}
                        {r.id == null && (
                          <span className="badge badge-sans-tarif" title="Ville de la zone sans tarif pour ce livreur">
                            Sans tarif
                          </span>
                        )}
                      </div>
                      {r.zone && <div className="cell-sub">{r.zone}</div>}
                    </td>
                    <td>
                      <input
                        type="number"
                        className="frais-input"
                        min="0"
                        step="0.01"
                        placeholder={r.id == null ? '0.00' : undefined}
                        value={r.fl}
                        onChange={(e) => setRowField(r.villeId, 'fl', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="frais-input"
                        min="0"
                        step="0.01"
                        placeholder={r.id == null ? '0.00' : undefined}
                        value={r.fr}
                        onChange={(e) => setRowField(r.villeId, 'fr', e.target.value)}
                      />
                    </td>
                    <td>
                      <div className="row-actions">
                        {isDirty(r) && (
                          <button
                            type="button"
                            className="row-action row-action-success"
                            title={r.id == null ? 'Enregistrer le tarif de cette ville' : 'Enregistrer le tarif'}
                            disabled={busyRow === r.villeId}
                            onClick={() => saveRow(r)}
                          >
                            <Save size={16} />
                          </button>
                        )}
                        {r.id != null && (
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer"
                            disabled={busyRow === r.villeId}
                            onClick={() => removeRow(r)}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </section>
  );
}

/** Onglet "Infos personnelles" : identité + forme juridique et documents. */
function OngletInfos({ fiche, options, onSaved }) {
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

  /* Ville / forme legacy absentes des listes : option supplémentaire pour ne pas perdre la valeur. */
  const villes = useMemo(() => {
    const list = options.villes || [];
    const current = Number(form.users_city);
    if (current && !list.some((v) => v.id === current)) {
      return [...list, { id: current, nom: `Ville n°${current}` }];
    }
    return list;
  }, [options.villes, form.users_city]);

  const formes = useMemo(() => {
    const list = options.formes || [];
    const current = String(form.users_forme_juridique || '');
    if (current && !list.some((f) => f.val === current)) {
      return [...list, { id: `current-${current}`, val: current }];
    }
    return list;
  }, [options.formes, form.users_forme_juridique]);

  const banques = useMemo(() => {
    const list = options.banques || [];
    const current = Number(form.users_bank);
    if (current && !list.some((b) => b.id === current)) {
      return [...list, { id: current, nom: `Banque n°${current}` }];
    }
    return list;
  }, [options.banques, form.users_bank]);

  const kind = formeKind(form.users_forme_juridique);

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
      const res = await api.put(`/livreurs/${fiche.users_id}/fiche`, data, {
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
      <FicheHead icon={Contact} title="Infos personnelles" fiche={fiche} />

      <SectionTitle icon={UserRound}>Identité &amp; coordonnées</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">
            Nom complet <span className="fiche-req">*</span>
          </span>
          <input
            type="text"
            value={form.users_name}
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
            onChange={(e) => setField('users_cin', e.target.value)}
            required
          />
        </label>
        <label className="fiche-field">
          <span className="field-label">Date de naissance</span>
          <input
            type="date"
            value={form.users_date_naissance}
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
        />
        <div className="fiche-field">
          <span className="field-label">Ville</span>
          <SearchableSelect
            value={form.users_city}
            onChange={(v) => setField('users_city', String(v))}
            placeholder="— Choisir la ville —"
            options={villes.map((v) => ({ value: v.id, label: v.nom }))}
          />
        </div>
        <label className="fiche-field span-2">
          <span className="field-label">Adresse</span>
          <input
            type="text"
            value={form.users_address}
            onChange={(e) => setField('users_address', e.target.value)}
          />
        </label>
      </div>

      <SectionTitle icon={Scale}>Forme juridique &amp; documents</SectionTitle>
      <div className="fiche-grid">
        <label className="fiche-field span-2">
          <span className="field-label">Forme juridique</span>
          <select
            value={form.users_forme_juridique}
            onChange={(e) => setField('users_forme_juridique', e.target.value)}
          >
            <option value="">— Choisir la forme juridique —</option>
            {formes.map((f) => (
              <option key={f.id} value={f.val}>
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
                value={form.users_ice}
                onChange={(e) => setField('users_ice', e.target.value)}
              />
            </label>
            <label className="fiche-field">
              <span className="field-label">RC</span>
              <input
                type="text"
                value={form.users_rc}
                onChange={(e) => setField('users_rc', e.target.value)}
              />
            </label>
            <FileField
              label="Fichier RC"
              hint="PDF"
              name="rc"
              accept=".pdf"
              current={fiche.users_rc_fichier}
              file={files.rc}
              onChange={setFile}
              span={2}
            />
            <label className="fiche-field span-2">
              <span className="field-label">Email société</span>
              <input
                type="email"
                value={form.users_societe_email}
                onChange={(e) => setField('users_societe_email', e.target.value)}
              />
            </label>
            <label className="fiche-field span-2">
              <span className="field-label">Siège social</span>
              <input
                type="text"
                value={form.users_siege_social}
                onChange={(e) => setField('users_siege_social', e.target.value)}
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
                value={form.users_ae_numero}
                onChange={(e) => setField('users_ae_numero', e.target.value)}
              />
            </label>
            <FileField
              label="Carte AE"
              hint="PDF"
              name="ae_carte"
              accept=".pdf"
              current={fiche.users_ae_carte_fichier}
              file={files.ae_carte}
              onChange={setFile}
              span={2}
            />
            <label className="fiche-field">
              <span className="field-label">Date d'expiration carte AE</span>
              <input
                type="date"
                value={form.users_ae_carte_expiration}
                onChange={(e) => setField('users_ae_carte_expiration', e.target.value)}
              />
            </label>
          </>
        )}

        <label className="fiche-field span-2">
          <span className="field-label">Nom de la banque</span>
          <select value={form.users_bank} onChange={(e) => setField('users_bank', e.target.value)}>
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
            onChange={(e) => setField('users_rib', e.target.value)}
          />
        </label>
        <FileField
          label="Fichier RIB"
          hint="PDF"
          name="rib"
          accept=".pdf"
          current={fiche.users_pro_rib_fichier}
          file={files.rib}
          onChange={setFile}
          span={2}
        />
        <FileField
          label="Contrat"
          hint="PDF"
          name="contrat"
          accept=".pdf"
          current={fiche.users_contrat_fichier}
          file={files.contrat}
          onChange={setFile}
          span={2}
        />
        <FileField
          label="Garanties"
          hint="PDF"
          name="garanties"
          accept=".pdf"
          current={fiche.users_garanties_fichier}
          file={files.garanties}
          onChange={setFile}
          span={2}
        />
      </div>

      <footer className="fiche-footer">
        <span className="fiche-updated">
          <Clock size={14} />
          {fiche.users_fiche_updated_at
            ? `Dernière mise à jour : ${fiche.users_fiche_updated_at}`
            : 'Fiche jamais enregistrée depuis cette plateforme'}
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
 * Fiche détaillée d'un livreur (/admin/livreurs/:id), ouverte depuis l'action
 * "Voir détail" de la page Livreurs. Quatre onglets : "Compte" (connexion +
 * tarifs par ville), "Infos personnelles", "Analyse" (statistiques du livreur
 * filtrées par période) et "Matériel" (affectations de matériel non
 * consommable).
 * Avec `self`, la même page devient « Ma fiche » du dashboard livreur
 * (/livreur/ma-fiche, menu avatar) : routes /livreurs/me/* (sans le service
 * LIVREURS), deux onglets seulement — "Compte" (identifiants de connexion
 * modifiables, sans les tarifs) et "Matériel" (affectations, consultation).
 */
export default function FicheLivreur({ self = false }) {
  const { id } = useParams();
  const apiBase = self ? '/livreurs/me' : `/livreurs/${id}`;
  const [fiche, setFiche] = useState(null);
  const [options, setOptions] = useState({ villes: [], formes: [], banques: [] });
  const [tab, setTab] = useState('compte');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    /* « Ma fiche » : pas d'options (réservées au service LIVREURS) — elles ne
     * servent qu'aux tarifs et à l'onglet Infos, absents en mode self. */
    Promise.all([
      api.get(apiBase),
      self ? Promise.resolve(null) : api.get('/livreurs/fiche/options')
    ])
      .then(([ficheRes, optionsRes]) => {
        if (cancelled) return;
        setFiche(ficheRes.data);
        if (optionsRes) setOptions(optionsRes.data);
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

  /* « Ma fiche » : deux onglets — Compte (connexion) et Matériel. */
  const tabs = self ? TABS.filter((t) => t.key === 'compte' || t.key === 'materiel') : TABS;

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
        <OngletCompte fiche={fiche} options={options} onSaved={setFiche} self={self} apiBase={apiBase} />
      ) : tab === 'infos' ? (
        <OngletInfos fiche={fiche} options={options} onSaved={setFiche} />
      ) : tab === 'analyse' ? (
        <LivreurAnalyse fiche={fiche} />
      ) : tab === 'materiel' ? (
        <MaterielAffectations endpoint={`${apiBase}/materiel`} title="Matériel affecté" />
      ) : (
        <OngletAVenir label={tabs.find((t) => t.key === tab)?.label} />
      )}
    </div>
  );
}
