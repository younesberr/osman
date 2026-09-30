import { useEffect, useRef, useState } from 'react';
import { BRAND } from '../../config/brand';
import { Landmark, MapPin, MessageCircle, Plus, Power, RefreshCw, Save, Scale, Tags, Trash2, Truck, Upload, Volume2, Wrench } from 'lucide-react';
import api from '../../api/client';
import { statutLabel, rafraichirStatutLabels } from '../../utils/statuts';
import { usePagination, Pager } from '../../components/Pagination';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Familles de statuts dans delevery_parcel_statut (parcel_statut_type). */
const TYPE_LABELS = { 1: 'Paiement', 2: 'Colis', 3: 'Statut second' };

/** Sélecteur de couleur : pastille native + saisie hexadécimale synchronisées. */
function ColorPicker({ value, onChange }) {
  const valid = HEX_RE.test(value);
  return (
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
  );
}

/* ---------- Section 1 : Status Colis ---------- */

/** Ligne éditable du tableau des statuts : nom + couleur modifiables, activation. */
function StatutRow({ statut, onSaved, onToggled }) {
  const [nom, setNom] = useState(statut.nom || '');
  const [color, setColor] = useState(statut.color || '#000000');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const dirty = nom !== (statut.nom || '') || color !== (statut.color || '');
  const actif = statut.active === 1;

  async function save() {
    if (!HEX_RE.test(color)) {
      alert('Couleur invalide (format attendu : #RRGGBB).');
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/statuts/${statut.id}`, { nom, color });
      rafraichirStatutLabels();
      onSaved(statut.id, res.data);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le statut « ${statut.code} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/statuts/${statut.id}/active`, { active: actif ? 0 : 1 });
      onToggled(statut.id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="cell-main">
          {statut.code}
          {!actif && <span className="badge badge-inactive">Désactivé</span>}
        </div>
        <div className="cell-sub">{TYPE_LABELS[statut.type] || `Type ${statut.type}`}</div>
      </td>
      <td>
        <input
          type="text"
          className="statut-nom-input"
          value={nom}
          placeholder={statutLabel(statut.code)}
          onChange={(e) => setNom(e.target.value)}
        />
      </td>
      <td>
        <ColorPicker value={color} onChange={setColor} />
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Enregistrer" onClick={save} disabled={saving || !dirty}>
            <Save size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={toggle}
            disabled={toggling}
          >
            <Power size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function StatutsSection() {
  const [statuts, setStatuts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [color, setColor] = useState('#25a0d7');
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const pager = usePagination(statuts, 'statut');

  useEffect(() => {
    api
      .get('/config/statuts')
      .then((res) => setStatuts(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des statuts.'))
      .finally(() => setLoading(false));
  }, []);

  async function addStatut(e) {
    e.preventDefault();
    setFeedback(null);
    if (!code.trim() || !nom.trim()) {
      setFeedback({ type: 'error', text: 'Le code et le nom du statut sont obligatoires.' });
      return;
    }
    if (!HEX_RE.test(color)) {
      setFeedback({ type: 'error', text: 'Couleur invalide (format attendu : #RRGGBB).' });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post('/config/statuts', { code: code.trim(), nom: nom.trim(), color });
      rafraichirStatutLabels();
      setStatuts((prev) => [...prev, res.data]);
      setCode('');
      setNom('');
      setFeedback({ type: 'success', text: `Statut « ${res.data.code} » ajouté.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout du statut." });
    } finally {
      setAdding(false);
    }
  }

  function handleSaved(id, data) {
    setStatuts((prev) => prev.map((s) => (s.id === id ? { ...s, nom: data.nom, color: data.color } : s)));
  }

  function handleToggled(id, active) {
    setStatuts((prev) => prev.map((s) => (s.id === id ? { ...s, active } : s)));
  }

  return (
    <section className="platform-card">
      <h2>
        <Tags size={18} /> Status Colis
      </h2>

      <form className="statut-form" onSubmit={addStatut}>
        <label>
          <span className="field-label">Code status</span>
          <input
            type="text"
            value={code}
            maxLength={50}
            placeholder="EX_MON_STATUT"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
        <label>
          <span className="field-label">Nom status</span>
          <input
            type="text"
            value={nom}
            maxLength={255}
            placeholder="Mon statut"
            onChange={(e) => setNom(e.target.value)}
          />
        </label>
        <div>
          <span className="field-label">Couleur</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          <Plus size={15} /> {adding ? 'Ajout…' : 'Ajouter'}
        </button>
      </form>
      {feedback && (
        <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Nom status</th>
              <th>Couleur</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {statuts.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="datatable-empty">
                  Aucun statut trouvé.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((s) => (
                <StatutRow key={s.id} statut={s} onSaved={handleSaved} onToggled={handleToggled} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/* ---------- Sections 2 & 3 : listes stockées dans delevery_configs ---------- */

/* Position de stock (rayonnage) : une lettre majuscule + un nombre de 1 à 99. */
const POSITION_RE = /^[A-Z][1-9][0-9]?$/;

function validatePosition(v) {
  if (!v) return 'La position est obligatoire.';
  if (!POSITION_RE.test(v)) {
    return "Position invalide : une lettre majuscule suivie d'un nombre de 1 à 99 (ex : A1, N7, X66).";
  }
  return '';
}

/** Ligne éditable d'une liste de valeurs : valeur modifiable, activation. */
function ListeRow({ item, unit, normalize, validate, maxLength, onSaved, onToggled }) {
  const [val, setVal] = useState(item.val);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const dirty = val.trim() !== item.val;
  const actif = item.active === 1;

  async function save() {
    if (!val.trim()) {
      alert('La valeur est obligatoire.');
      return;
    }
    const invalide = validate ? validate(val.trim()) : '';
    if (invalide) {
      alert(invalide);
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/listes/items/${item.id}`, { val: val.trim() });
      setVal(res.data.val);
      onSaved(item.id, res.data.val);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} « ${item.val} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/listes/items/${item.id}/active`, { active: actif ? 0 : 1 });
      onToggled(item.id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="liste-val-cell">
          <input
            type="text"
            className="statut-nom-input"
            value={val}
            maxLength={maxLength || 255}
            onChange={(e) => setVal(normalize ? normalize(e.target.value) : e.target.value)}
          />
          {!actif && <span className="badge badge-inactive">Désactivé</span>}
        </div>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Modifier" onClick={save} disabled={saving || !dirty}>
            <Save size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={toggle}
            disabled={toggling}
          >
            <Power size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Section générique pour une liste de valeurs de delevery_configs.
 * kind = 'formes-juridiques' | 'banques' | 'positions' (mappé côté serveur vers configs_var).
 * normalize/validate/maxLength : contraintes de saisie propres à la liste
 * (ex. positions : majuscule + nombre de 1 à 99).
 */
function ConfigListSection({ kind, title, icon: Icon, fieldLabel, placeholder, unit, unitPlural, normalize, validate, maxLength }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [val, setVal] = useState('');
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const pager = usePagination(items, unit, unitPlural);

  useEffect(() => {
    api
      .get(`/config/listes/${kind}`)
      .then((res) => setItems(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, [kind]);

  async function addItem(e) {
    e.preventDefault();
    setFeedback(null);
    if (!val.trim()) {
      setFeedback({ type: 'error', text: `Le champ « ${fieldLabel} » est obligatoire.` });
      return;
    }
    const invalide = validate ? validate(val.trim()) : '';
    if (invalide) {
      setFeedback({ type: 'error', text: invalide });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post(`/config/listes/${kind}`, { val: val.trim() });
      setItems((prev) =>
        [...prev, res.data].sort((a, b) =>
          a.val.localeCompare(b.val, 'fr', { sensitivity: 'base', numeric: true })
        )
      );
      setVal('');
      setFeedback({ type: 'success', text: `« ${res.data.val} » ajouté.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout." });
    } finally {
      setAdding(false);
    }
  }

  function handleSaved(id, newVal) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, val: newVal } : it)));
  }

  function handleToggled(id, active) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, active } : it)));
  }

  return (
    <section className="platform-card">
      <h2>
        <Icon size={18} /> {title}
      </h2>

      <form className="statut-form" onSubmit={addItem}>
        <label>
          <span className="field-label">{fieldLabel}</span>
          <input
            type="text"
            value={val}
            maxLength={maxLength || 255}
            placeholder={placeholder}
            onChange={(e) => setVal(normalize ? normalize(e.target.value) : e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          <Plus size={15} /> {adding ? 'Ajout…' : 'Ajouter'}
        </button>
      </form>
      {feedback && (
        <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>{fieldLabel}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={2} className="datatable-empty">
                  Aucune valeur trouvée.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((it) => (
                <ListeRow
                  key={it.id}
                  item={it}
                  unit={unit}
                  normalize={normalize}
                  validate={validate}
                  maxLength={maxLength}
                  onSaved={handleSaved}
                  onToggled={handleToggled}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/* ---------- Section 4 : Sons du scanner ---------- */

/** Étapes du scanner : un son par étape, en succès ou en échec. */
const SON_TYPE_LABELS = {
  ramassage_success: 'Ramassage succès',
  ramassage_error: 'Ramassage échec',
  envoi_success: 'Envoi succès',
  envoi_error: 'Envoi échec',
  distribution_success: 'Distribution succès',
  distribution_error: 'Distribution échec',
  retour_success: 'Retour succès',
  retour_error: 'Retour échec'
};
const AUDIO_ACCEPT = '.mp3,.wav,.ogg,.webm,.m4a,.aac,audio/*';

/** Ligne d'un son : étape, aperçu audio, changer le fichier, supprimer. */
function SonRow({ son, onUpdated, onDeleted }) {
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const label = SON_TYPE_LABELS[son.type] || son.type;

  function changeFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('type', son.type);
    fd.append('file', file);
    setSaving(true);
    api
      .put(`/config/sons/${son.id}`, fd)
      .then((res) => onUpdated(res.data))
      .catch((err) => alert(err.response?.data?.message || "Erreur lors de l'enregistrement."))
      .finally(() => setSaving(false));
  }

  async function remove() {
    if (!window.confirm(`Voulez-vous vraiment supprimer le son « ${label} » ?`)) return;
    setSaving(true);
    try {
      await api.delete(`/config/sons/${son.id}`);
      onDeleted(son.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      setSaving(false);
    }
  }

  return (
    <tr>
      <td>{label}</td>
      <td>
        <audio className="son-audio" controls preload="none" src={son.url} />
      </td>
      <td>
        <div className="row-actions">
          <button
            type="button"
            className="row-action"
            title="Changer le fichier audio"
            onClick={() => fileRef.current?.click()}
            disabled={saving}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="row-action row-action-danger"
            title="Supprimer"
            onClick={remove}
            disabled={saving}
          >
            <Trash2 size={16} />
          </button>
          <input ref={fileRef} type="file" accept={AUDIO_ACCEPT} hidden onChange={changeFile} />
        </div>
      </td>
    </tr>
  );
}

/**
 * Sons joués par les pages de scan : un son par étape (ramassage, envoi,
 * distribution, retour — succès / échec). Uploader un son pour une étape
 * remplace celui déjà en place.
 */
function SonsSection() {
  const [sons, setSons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [type, setType] = useState('ramassage_success');
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const pager = usePagination(sons, 'son');

  useEffect(() => {
    api
      .get('/config/sons')
      .then((res) => setSons(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des sons.'))
      .finally(() => setLoading(false));
  }, []);

  async function addSon(e) {
    e.preventDefault();
    setFeedback(null);
    if (!file) {
      setFeedback({ type: 'error', text: 'Veuillez choisir un fichier audio.' });
      return;
    }
    setAdding(true);
    try {
      const fd = new FormData();
      fd.append('type', type);
      fd.append('file', file);
      const res = await api.post('/config/sons', fd);
      // Un seul son par étape : la nouvelle ligne remplace celle du même type.
      setSons((prev) => [res.data, ...prev.filter((s) => s.type !== res.data.type)]);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setFeedback({
        type: 'success',
        text: `Son « ${SON_TYPE_LABELS[res.data.type] || res.data.type} » enregistré.`
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'upload du son." });
    } finally {
      setAdding(false);
    }
  }

  function handleUpdated(updated) {
    setSons((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }

  function handleDeleted(id) {
    setSons((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <section className="platform-card">
      <h2>
        <Volume2 size={18} /> Sons du scanner
      </h2>
      <p className="son-section-sub">
        Un son par étape de scan (ramassage, envoi, distribution, retour — succès ou échec).
        Uploader un son pour une étape remplace celui déjà en place.
      </p>

      <form className="statut-form son-form" onSubmit={addSon}>
        <label>
          <span className="field-label">Étape</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(SON_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Fichier audio</span>
          <input
            ref={fileRef}
            type="file"
            accept={AUDIO_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          <Upload size={15} /> {adding ? 'Upload…' : 'Uploader'}
        </button>
      </form>
      {feedback && (
        <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Étape</th>
              <th>Aperçu</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sons.length === 0 && !loading ? (
              <tr>
                <td colSpan={3} className="datatable-empty">
                  Aucun son chargé — un bip par défaut est joué.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((son) => (
                <SonRow key={son.id} son={son} onUpdated={handleUpdated} onDeleted={handleDeleted} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/* ---------- Section : Message WhatsApp livreur ---------- */

/** Balises remplacées par les données du colis + valeurs d'exemple pour l'aperçu. */
const MSG_LIVREUR_BALISES = [
  { balise: '{destinataire}', label: 'Destinataire', exemple: 'Mohamed Alami' },
  { balise: '{code}', label: 'Code du colis', exemple: 'OSM0926100002LR' },
  { balise: '{magasin}', label: 'Magasin', exemple: 'Amine shop' },
  { balise: '{crbt}', label: 'Montant à encaisser', exemple: '700 DH' },
  { balise: '{adresse}', label: 'Adresse', exemple: '17 Rue Oued Zem' },
  { balise: '{ville}', label: 'Ville', exemple: 'Al Hoceima' }
];

/**
 * Modèle du message WhatsApp prérempli quand le livreur contacte le
 * destinataire depuis /livreur/colis (bouton « Message WhatsApp »).
 * Les balises sont remplacées par les données du colis au moment de l'envoi.
 */
function MessageLivreurSection() {
  const [template, setTemplate] = useState('');
  const [initial, setInitial] = useState('');
  const [defaut, setDefaut] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    api
      .get('/config/message-livreur')
      .then((res) => {
        setTemplate(res.data.template);
        setInitial(res.data.template);
        setDefaut(res.data.defaut);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement du message.'));
  }, []);

  const apercu = MSG_LIVREUR_BALISES.reduce(
    (texte, { balise, exemple }) => texte.split(balise).join(exemple),
    template
  );

  async function save(e) {
    e.preventDefault();
    setFeedback(null);
    if (!template.trim()) {
      setFeedback({ type: 'error', text: 'Le message est obligatoire.' });
      return;
    }
    setSaving(true);
    try {
      const res = await api.put('/config/message-livreur', { template: template.trim() });
      setTemplate(res.data.template);
      setInitial(res.data.template);
      setFeedback({ type: 'success', text: 'Modèle du message enregistré.' });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="platform-card">
      <h2>
        <MessageCircle size={18} /> Message WhatsApp livreur
      </h2>
      <p className="son-section-sub">
        Message prérempli quand le livreur contacte le destinataire d'un colis par WhatsApp
        (bouton « Message WhatsApp » de sa liste des colis). Cliquer sur une balise l'ajoute
        au message ; elle sera remplacée par la donnée du colis.
      </p>

      {loadError && <div className="form-error">{loadError}</div>}

      <form onSubmit={save}>
        <textarea
          rows={5}
          maxLength={1000}
          value={template}
          placeholder={defaut}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <div className="msg-livreur-balises">
          {MSG_LIVREUR_BALISES.map(({ balise, label }) => (
            <button
              key={balise}
              type="button"
              className="msg-livreur-balise"
              title={`Insérer ${balise}`}
              onClick={() => setTemplate((t) => (t && !/\s$/.test(t) ? `${t} ${balise}` : `${t}${balise}`))}
            >
              <code>{balise}</code> {label}
            </button>
          ))}
        </div>
        {template.trim() && (
          <div className="msg-livreur-apercu">
            <span className="field-label">Aperçu (colis d'exemple)</span>
            <p>{apercu}</p>
          </div>
        )}
        {feedback && (
          <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
        )}
        <div className="msg-livreur-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setTemplate(defaut)}
            disabled={saving || !defaut || template === defaut}
          >
            <RefreshCw size={15} /> Message par défaut
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || template.trim() === initial}>
            <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ---------- Sections 5 & 6 : moyens logistiques (marques + maintenance) ---------- */

/** Types de moyen logistique (permis requis). */
const MOYEN_TYPE_LABELS = { moto: 'Moto', vl: 'VL (permis B)', pl: 'PL (permis C)' };

/** Pièces / entretiens suivis, dans l'ordre d'affichage. */
const MAINTENANCE_FIELDS = [
  { key: 'vidange', label: 'Vidange (huile moteur)' },
  { key: 'filtre_huile', label: 'Filtre à huile' },
  { key: 'filtre_carburant', label: 'Filtre à carburant' },
  { key: 'filtre_air', label: 'Filtre à air' },
  { key: 'adblue', label: 'AdBlue' },
  { key: 'anti_cristallisant', label: 'Anti-cristallisant' },
  { key: 'vidange_boite', label: 'Vidange boîte' },
  { key: 'chaine_tendeur', label: 'Chaîne et tendeur' },
  { key: 'pneus_avant', label: 'Pneus avant' },
  { key: 'pneus_arriere', label: 'Pneus arrière' }
];

/** Ligne éditable d'une marque : nom + type modifiables, activation. */
function MarqueRow({ marque, onSaved, onToggled }) {
  const [nom, setNom] = useState(marque.marque);
  const [type, setType] = useState(marque.type);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const dirty = nom.trim() !== marque.marque || type !== marque.type;
  const actif = marque.active === 1;

  async function save() {
    if (!nom.trim()) {
      alert('La marque est obligatoire.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/moyens/marques/${marque.id}`, { marque: nom.trim(), type });
      onSaved(marque.id, res.data);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} la marque « ${marque.marque} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/moyens/marques/${marque.id}/active`, { active: actif ? 0 : 1 });
      onToggled(marque.id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <div className="liste-val-cell">
          <input
            type="text"
            className="statut-nom-input"
            value={nom}
            maxLength={100}
            onChange={(e) => setNom(e.target.value)}
          />
          {!actif && <span className="badge badge-inactive">Désactivé</span>}
        </div>
      </td>
      <td>
        <select className="marque-type-select" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(MOYEN_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Enregistrer" onClick={save} disabled={saving || !dirty}>
            <Save size={16} />
          </button>
          <button
            type="button"
            className={`row-action ${actif ? 'row-action-danger' : 'row-action-success'}`}
            title={actif ? 'Désactiver' : 'Activer'}
            onClick={toggle}
            disabled={toggling}
          >
            <Power size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Catalogue des marques de véhicules utilisées comme moyens logistiques. */
function MarquesSection() {
  const [marques, setMarques] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [nom, setNom] = useState('');
  const [type, setType] = useState('');
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const pager = usePagination(marques, 'marque');

  useEffect(() => {
    api
      .get('/config/moyens/marques')
      .then((res) => setMarques(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des marques.'))
      .finally(() => setLoading(false));
  }, []);

  async function addMarque(e) {
    e.preventDefault();
    setFeedback(null);
    if (!nom.trim()) {
      setFeedback({ type: 'error', text: 'La marque est obligatoire.' });
      return;
    }
    if (!type) {
      setFeedback({ type: 'error', text: 'Veuillez choisir le type de moyen.' });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post('/config/moyens/marques', { marque: nom.trim(), type });
      const ordre = Object.keys(MOYEN_TYPE_LABELS);
      setMarques((prev) =>
        [...prev, res.data].sort(
          (a, b) =>
            ordre.indexOf(a.type) - ordre.indexOf(b.type) ||
            a.marque.localeCompare(b.marque, 'fr', { sensitivity: 'base' })
        )
      );
      setNom('');
      setFeedback({ type: 'success', text: `Marque « ${res.data.marque} » ajoutée.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout de la marque." });
    } finally {
      setAdding(false);
    }
  }

  function handleSaved(id, data) {
    setMarques((prev) => prev.map((m) => (m.id === id ? { ...m, marque: data.marque, type: data.type } : m)));
  }

  function handleToggled(id, active) {
    setMarques((prev) => prev.map((m) => (m.id === id ? { ...m, active } : m)));
  }

  return (
    <section className="platform-card">
      <h2>
        <Truck size={18} /> Marques moyen logistique
      </h2>
      <p className="son-section-sub">
        Catalogue des marques de véhicules utilisées comme moyens logistiques.
      </p>

      <form className="statut-form" onSubmit={addMarque}>
        <label>
          <span className="field-label">Marque *</span>
          <input
            type="text"
            value={nom}
            maxLength={100}
            placeholder="Ex : Renault"
            onChange={(e) => setNom(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">Type *</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">— Choisir —</option>
            {Object.entries(MOYEN_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={adding}>
          <Plus size={15} /> {adding ? 'Ajout…' : 'Ajouter'}
        </button>
      </form>
      {feedback && (
        <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
      )}

      {loadError && <div className="form-error">{loadError}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Marque</th>
              <th>Type</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {marques.length === 0 && !loading ? (
              <tr>
                <td colSpan={3} className="datatable-empty">
                  Aucune marque enregistrée.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((m) => (
                <MarqueRow key={m.id} marque={m} onSaved={handleSaved} onToggled={handleToggled} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/**
 * Intervalles de maintenance des moyens logistiques : kilométrage entre deux
 * remplacements de chaque pièce / entretien, une configuration par type
 * (Moto, VL, PL).
 */
function MaintenanceSection() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [type, setType] = useState('moto');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    api
      .get('/config/moyens/maintenance')
      .then((res) => setData(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des intervalles.'));
  }, []);

  function setKm(key, value) {
    setData((prev) => ({ ...prev, [type]: { ...prev[type], [key]: value } }));
  }

  async function save(e) {
    e.preventDefault();
    setFeedback(null);
    const intervalles = {};
    for (const { key, label } of MAINTENANCE_FIELDS) {
      const v = Number(data[type][key]);
      if (!Number.isInteger(v) || v <= 0) {
        setFeedback({ type: 'error', text: `« ${label} » : kilométrage entier positif obligatoire.` });
        return;
      }
      intervalles[key] = v;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/moyens/maintenance/${type}`, { intervalles });
      setData((prev) => ({ ...prev, [type]: res.data.intervalles }));
      setFeedback({ type: 'success', text: `Intervalles « ${MOYEN_TYPE_LABELS[type]} » enregistrés.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'enregistrement." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="platform-card options-card-wide">
      <h2>
        <Wrench size={18} /> Intervalles maintenance (moyen logistique)
      </h2>
      <p className="son-section-sub">
        Kilométrage entre deux remplacements de chaque pièce / entretien. Chaque type de moyen
        (Moto, VL, PL) a sa propre configuration ; la clé « Vidange (huile moteur) » définit
        l'estimation de la prochaine vidange.
      </p>

      <div className="fiche-tabs mnt-tabs">
        {Object.entries(MOYEN_TYPE_LABELS).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`fiche-tab ${type === value ? 'active' : ''}`}
            onClick={() => {
              setType(value);
              setFeedback(null);
            }}
          >
            <Truck size={15} /> {label}
          </button>
        ))}
      </div>

      {loadError && <div className="form-error">{loadError}</div>}

      {data && (
        <form onSubmit={save}>
          <div className="mnt-grid">
            {MAINTENANCE_FIELDS.map(({ key, label }) => (
              <label key={key} className="mnt-field">
                <span className="field-label">{label}</span>
                <span className="mnt-input">
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    value={data[type][key]}
                    onChange={(e) => setKm(key, e.target.value)}
                  />
                  <span className="mnt-unit">km</span>
                </span>
              </label>
            ))}
          </div>
          {feedback && (
            <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
          )}
          <div className="mnt-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} />{' '}
              {saving ? 'Enregistrement…' : `Enregistrer (${MOYEN_TYPE_LABELS[type]})`}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Configuration > Options — page en sections. */
export default function Options() {
  return (
    <div className="platform-page options-grid">
      <StatutsSection />
      <ConfigListSection
        kind="positions"
        title="Position"
        icon={MapPin}
        fieldLabel="Position"
        placeholder="A1, N7, X66…"
        unit="position"
        maxLength={3}
        normalize={(v) => v.toUpperCase()}
        validate={validatePosition}
      />
      <ConfigListSection
        kind="formes-juridiques"
        title="Formes juridiques"
        icon={Scale}
        fieldLabel="Forme juridique"
        placeholder="SARL, Auto entrepreneur…"
        unit="forme juridique"
        unitPlural="formes juridiques"
      />
      <ConfigListSection
        kind="banques"
        title="Banques"
        icon={Landmark}
        fieldLabel="Nom de la banque"
        placeholder="CIH BANK…"
        unit="banque"
      />
      <SonsSection />
      <MessageLivreurSection />
      <MarquesSection />
      <MaintenanceSection />
    </div>
  );
}
