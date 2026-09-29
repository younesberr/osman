import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BadgeCheck,
  Coins,
  Eye,
  Hourglass,
  MessageCircle,
  PackageOpen,
  Plus,
  Power,
  Save,
  Search,
  Settings2,
  SquarePen,
  X,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';

const PAGE_SIZES = [10, 25, 50, 100];

/** Nombre entier au format fr-FR ('1 234'). */
function formatCount(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}

/** Taux part/total en pourcentage ('91,2 %'), null si le client n'a aucun colis. */
function formatTaux(part, total) {
  if (!total) return null;
  return `${((part / total) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
}

/** Filtre oui/non de la barre d'outils (valeurs '' / '1' / '0'). */
function FlagSelect({ value, onChange, label }) {
  return (
    <select className="datatable-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{label} : tous</option>
      <option value="1">{label} : oui</option>
      <option value="0">{label} : non</option>
    </select>
  );
}

/** Modale "Ajouter nouveau client" : création d'un compte marchand. */
function CreateModal({ villes, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    cin: '',
    email: '',
    phone: '',
    password: '',
    passwordConfirm: '',
    address: '',
    pickupCity: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function save(e) {
    e.preventDefault();
    if (form.password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (form.password !== form.passwordConfirm) {
      setError('La confirmation ne correspond pas au mot de passe.');
      return;
    }
    if (!form.pickupCity) {
      setError('Veuillez choisir la ville de ramassage.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/clients', {
        name: form.name.trim(),
        cin: form.cin.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
        passwordConfirm: form.passwordConfirm,
        address: form.address.trim(),
        pickupCity: form.pickupCity
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la création du client.');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Plus size={18} />
            <div>
              <div className="cell-main">Ajouter nouveau client</div>
              <div className="cell-sub">Le client se connecte avec son téléphone personnel ou son email.</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom complet</span>
              <input
                type="text"
                value={form.name}
                maxLength={100}
                required
                onChange={(e) => setField('name', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">CIN</span>
              <input
                type="text"
                value={form.cin}
                maxLength={100}
                required
                onChange={(e) => setField('cin', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Adresse électronique</span>
              <input
                type="email"
                value={form.email}
                maxLength={100}
                required
                onChange={(e) => setField('email', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Téléphone personnel</span>
              <input
                type="tel"
                value={form.phone}
                maxLength={50}
                required
                onChange={(e) => setField('phone', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Mot de passe</span>
              <input
                type="password"
                value={form.password}
                minLength={8}
                maxLength={100}
                required
                autoComplete="new-password"
                onChange={(e) => setField('password', e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Confirmation du mot de passe</span>
              <input
                type="password"
                value={form.passwordConfirm}
                minLength={8}
                maxLength={100}
                required
                autoComplete="new-password"
                onChange={(e) => setField('passwordConfirm', e.target.value)}
              />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse</span>
              <input
                type="text"
                value={form.address}
                maxLength={250}
                required
                onChange={(e) => setField('address', e.target.value)}
              />
            </label>
            <div className="modal-form-full">
              <span className="field-label">Ville de ramassage</span>
              <SearchableSelect
                value={form.pickupCity}
                onChange={(v) => setField('pickupCity', v)}
                placeholder="— Sélectionner —"
                options={villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))}
              />
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* Types de demande de modification de fiche → libellé affiché. */
const DEMANDE_TYPE_LABELS = { FACTURATION: 'Facturation', RAMASSAGE: 'Ramassage', INFOS: 'Informations' };

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDateDemande(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Modale "Modifications en attente" : clients ayant une demande de
 * modification de fiche à valider (« Ma fiche » client →
 * delevery_client_fiche_demande). Ouvrir la fiche mène aux panneaux
 * Accepter / Refuser des onglets concernés.
 */
function DemandesModal({ rows, onClose, onOuvrir }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Hourglass size={18} />
            <div>
              <div className="cell-main">Modifications en attente de validation</div>
              <div className="cell-sub">
                Demandes envoyées par les clients depuis leur fiche — validez-les depuis la fiche
                du client.
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Modifications</th>
                <th>Depuis</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucune demande en attente.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.customers_id}>
                    <td>
                      <div className="cell-main">{r.store || '—'}</div>
                      <div className="cell-sub">{r.name || '—'}</div>
                    </td>
                    <td>
                      <div className="row-actions">
                        {r.types.map((t) => (
                          <span key={t} className="badge badge-attente">
                            {DEMANDE_TYPE_LABELS[t] || t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{formatDateDemande(r.since)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => onOuvrir(r.customers_id)}
                      >
                        <SquarePen size={15} /> Voir la fiche
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Modale "Voir fiche client" : coordonnées et informations bancaires. */
function DetailModal({ client, onClose }) {
  const rows = [
    ['Nom complet', client.name],
    ['CIN', client.cin],
    ['N° téléphone personnel', client.phone_personal],
    ['N° téléphone magasin', client.phone],
    ['Ville', client.city],
    ['Adresse', client.address],
    ['Banque', client.banque],
    ['RIB', client.rib]
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">{client.store || '—'}</div>
              <div className="cell-sub">
                {client.active === 1 ? 'Client actif' : 'Client désactivé'}
                {client.verified === 1 ? ' — vérifié' : ' — non vérifié'}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <dl className="detail-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="detail-row">
              <dt>{label}</dt>
              <dd>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Ligne « libellé + boutons radio Activer / Désactiver » des modales Options. */
function RadioRow({ label, value, onChange, name, disabled = false }) {
  return (
    <div className="option-row">
      <span className="field-label">{label}</span>
      <div className="radio-group">
        {[
          [1, 'Activer'],
          [0, 'Désactiver']
        ].map(([v, text]) => (
          <label
            key={v}
            className={`radio-pill ${value === v ? 'radio-pill-checked' : ''} ${disabled ? 'radio-pill-disabled' : ''}`}
          >
            <input type="radio" name={name} checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
            {text}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Modale "Options" : voir n° livreur (customers_livreur), afficher le n° du
 * vendeur sur les tickets (customers_phone_show, même réglage que la page
 * /client/configuration) et vérification colis zéro (customers_colis_zero),
 * en boutons radio Activer / Désactiver ; section « Options par défaut » :
 * « Interdire l'ouverture du colis par défaut » (customers_default_open) et
 * « Interdire l'essayage par défaut » (customers_default_essayage, colonne
 * inversée : 1 = essayage autorisé), mêmes réglages que /client/configuration,
 * ouverture interdite → essayage interdit et verrouillé ; section « Frais
 * selon le montant du colis » (customers_frais_montant, réglage admin
 * uniquement : 20 DH de frais supp ajoutés automatiquement par tranche de
 * 2 500 DH au-delà de 2 500 DH de montant, activé par défaut ; désactivé =
 * aucun frais automatique pour ce client) ; puis section
 * « Notifications WhatsApp » : mêmes choix que /client/configuration (bon
 * retour expédié, réclamation traitée, remboursement, modification de colis,
 * factures). Le tout est chargé par GET /clients/:id/options
 * (default_open, default_essayage, frais_montant.{disponible, actif, seuil,
 * montant}, whatsapp.{disponible, options, prefs}, table
 * delevery_whatsapp_pref_client) et enregistré avec les autres options.
 */
function OptionsModal({ client, onClose, onSaved }) {
  const [livreurShow, setLivreurShow] = useState(client.livreur_show === 1 ? 1 : 0);
  const [phoneShow, setPhoneShow] = useState(client.phone_show === 1 ? 1 : 0);
  const [colisZero, setColisZero] = useState(client.colis_zero === 1 ? 1 : 0);
  // null = chargement ; { interdireOuverture: 0|1, interdireEssayage: 0|1 } (valeurs affichées :
  // interdireEssayage = 1 équivaut à customers_default_essayage = 0).
  const [defauts, setDefauts] = useState(null);
  // null = chargement ; { disponible, actif: 0|1, seuil, montant } (frais supp selon le montant).
  const [fraisMontant, setFraisMontant] = useState(null);
  // null = chargement ; { disponible, options: [{ code, label }], prefs: { code: 0|1 } }
  const [whatsapp, setWhatsapp] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/clients/${client.customers_id}/options`)
      .then((res) => {
        if (cancelled) return;
        const interdireOuverture = Number(res.data.default_open) === 1 ? 1 : 0;
        setDefauts({
          interdireOuverture,
          // Ouverture interdite → essayage interdit d'office.
          interdireEssayage: interdireOuverture === 1 || Number(res.data.default_essayage) !== 1 ? 1 : 0
        });
        setFraisMontant({
          disponible: Boolean(res.data.frais_montant?.disponible),
          actif: Number(res.data.frais_montant?.actif) === 0 ? 0 : 1,
          seuil: Number(res.data.frais_montant?.seuil) || 2500,
          montant: Number(res.data.frais_montant?.montant) || 20
        });
        setWhatsapp({
          disponible: Boolean(res.data.whatsapp?.disponible),
          options: Array.isArray(res.data.whatsapp?.options) ? res.data.whatsapp.options : [],
          prefs: { ...(res.data.whatsapp?.prefs || {}) }
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Options non chargées.');
      });
    return () => {
      cancelled = true;
    };
  }, [client.customers_id]);

  /* Interdire l'ouverture → interdire aussi l'essayage (verrouillé, même règle que /client/configuration). */
  function setInterdireOuverture(v) {
    setDefauts((d) => (d ? { interdireOuverture: v, interdireEssayage: v === 1 ? 1 : d.interdireEssayage } : d));
  }

  function setInterdireEssayage(v) {
    setDefauts((d) => (d ? { ...d, interdireEssayage: v } : d));
  }

  function setWhatsappPref(code, value) {
    setWhatsapp((w) => (w ? { ...w, prefs: { ...w.prefs, [code]: value } } : w));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await api.patch(`/clients/${client.customers_id}/options`, {
        livreurShow,
        phoneShow,
        colisZero,
        // Options par défaut envoyées seulement une fois chargées (ouverture
        // interdite → essayage interdit d'office ; 1 en base = essayage autorisé).
        ...(defauts
          ? {
              defaultOpen: defauts.interdireOuverture,
              defaultEssayage: defauts.interdireOuverture === 1 || defauts.interdireEssayage === 1 ? 0 : 1
            }
          : {}),
        // Frais selon le montant : envoyé seulement si la colonne est migrée.
        ...(fraisMontant?.disponible ? { fraisMontant: fraisMontant.actif } : {}),
        // Préférences WhatsApp envoyées seulement si la migration est en place.
        ...(whatsapp?.disponible ? { whatsappNotifs: whatsapp.prefs } : {})
      });
      onSaved(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">Options — {client.store || client.name || '—'}</div>
              <div className="cell-sub">Paramètres du compte client</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="option-rows">
            <RadioRow label="Voir n° livreur" name="livreurShow" value={livreurShow} onChange={setLivreurShow} />
            <RadioRow
              label="Afficher n° vendeur sur ticket"
              name="phoneShow"
              value={phoneShow}
              onChange={setPhoneShow}
            />
            <RadioRow
              label="Vérification colis zéro"
              name="colisZero"
              value={colisZero}
              onChange={setColisZero}
            />
          </div>

          <div className="option-section-title">
            <PackageOpen size={14} /> Options par défaut
          </div>
          <p className="option-section-hint">
            Valeurs par défaut des cases « interdire l'ouverture » et « interdire l'essayage » lors de l'ajout d'un
            nouveau colis. Le client a les mêmes choix dans son dashboard › Configuration.
          </p>
          {loadError ? (
            <div className="option-section-note">{loadError}</div>
          ) : !defauts ? (
            <div className="cell-sub">Chargement…</div>
          ) : (
            <div className="option-rows">
              <RadioRow
                label="Interdire l'ouverture du colis par défaut"
                name="defaultOpen"
                value={defauts.interdireOuverture}
                onChange={setInterdireOuverture}
              />
              <RadioRow
                label="Interdire l'essayage par défaut"
                name="defaultEssayage"
                value={defauts.interdireOuverture === 1 ? 1 : defauts.interdireEssayage}
                onChange={setInterdireEssayage}
                disabled={defauts.interdireOuverture === 1}
              />
              {defauts.interdireOuverture === 1 && (
                <div className="cell-sub">Ouverture interdite : l'essayage est interdit d'office.</div>
              )}
            </div>
          )}

          <div className="option-section-title">
            <Coins size={14} /> Frais selon le montant du colis
          </div>
          <p className="option-section-hint">
            {fraisMontant ? formatCount(fraisMontant.montant) : '20'} DH de frais supplémentaires ajoutés
            automatiquement à chaque colis pour chaque tranche de{' '}
            {fraisMontant ? formatCount(fraisMontant.seuil) : '2 500'} DH au-delà de{' '}
            {fraisMontant ? formatCount(fraisMontant.seuil) : '2 500'} DH de montant (ex. de 2 501 à 5 000 DH :
            +20 DH ; de 5 001 à 7 500 DH : +40 DH ; de 7 501 à 10 000 DH : +60 DH). Activé par défaut ;
            désactivé : aucun frais supplémentaire automatique sur les colis de ce client.
          </p>
          {loadError ? (
            <div className="option-section-note">{loadError}</div>
          ) : !fraisMontant ? (
            <div className="cell-sub">Chargement…</div>
          ) : (
            <>
              {!fraisMontant.disponible && (
                <div className="option-section-note">
                  Option indisponible : exécutez sql/2026-09-28_frais-montant-colis.sql dans phpMyAdmin (en
                  attendant, les frais s'appliquent à tous les clients).
                </div>
              )}
              <div className="option-rows">
                <RadioRow
                  label="Frais supp. colis au montant > 2 500 DH"
                  name="fraisMontant"
                  value={fraisMontant.actif}
                  onChange={(v) => setFraisMontant((f) => (f ? { ...f, actif: v } : f))}
                  disabled={!fraisMontant.disponible}
                />
              </div>
            </>
          )}

          <div className="option-section-title">
            <MessageCircle size={14} /> Notifications WhatsApp
          </div>
          <p className="option-section-hint">
            Messages automatiques du CRM WhatsApp envoyés au client (numéro personnel, sinon celui du magasin). Le
            client a les mêmes choix dans son dashboard › Configuration.
          </p>
          {loadError ? (
            <div className="option-section-note">{loadError}</div>
          ) : !whatsapp ? (
            <div className="cell-sub">Chargement…</div>
          ) : (
            <>
              {!whatsapp.disponible && (
                <div className="option-section-note">
                  Préférences indisponibles : exécutez sql/2026-09-18_whatsapp-preferences-client.sql dans phpMyAdmin.
                </div>
              )}
              <div className="option-rows">
                {whatsapp.options.map((o) => (
                  <RadioRow
                    key={o.code}
                    label={o.label}
                    name={`wa_${o.code}`}
                    value={whatsapp.prefs[o.code] === 0 ? 0 : 1}
                    onChange={(v) => setWhatsappPref(o.code, v)}
                    disabled={!whatsapp.disponible}
                  />
                ))}
              </div>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Page Clients : datatable des comptes marchands (delevery_customers). */
export default function Clients() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [ville, setVille] = useState('');
  const [agence, setAgence] = useState('');
  const [forme, setForme] = useState('');
  const [flags, setFlags] = useState({
    customTarif: '',
    verified: '',
    livreurShow: '',
    phoneShow: '',
    colisZero: '',
    active: '1'
  });
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [filtres, setFiltres] = useState({ villes: [], agences: [], formes: [] });
  const [detail, setDetail] = useState(null);
  const [options, setOptions] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [demandes, setDemandes] = useState({ count: 0, rows: [] });
  const [showDemandes, setShowDemandes] = useState(false);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const COL_COUNT = 9;

  function setFlag(name, value) {
    setFlags((prev) => ({ ...prev, [name]: value }));
    setPage(1);
  }

  /** Tri serveur : 1er clic = décroissant, 2e clic = croissant. */
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
    setPage(1);
  }

  function SortableTh({ sortKey, children }) {
    const isActive = sortBy === sortKey;
    return (
      <th className={`th-sortable ${isActive ? 'th-sorted' : ''}`} onClick={() => toggleSort(sortKey)} title="Trier">
        <span className="th-sort-label">
          {children}
          {isActive ? (
            sortDir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
          ) : (
            <ArrowUpDown size={13} className="th-sort-idle" />
          )}
        </span>
      </th>
    );
  }

  // Recherche débouncée : on n'interroge le serveur que 400 ms après la dernière frappe.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    api
      .get('/clients/filtres')
      .then((res) => setFiltres(res.data))
      .catch(() => {});
  }, []);

  // Demandes de modification de fiche en attente de validation (bouton + modale).
  useEffect(() => {
    let cancelled = false;
    api
      .get('/clients/demandes/en-attente')
      .then((res) => {
        if (!cancelled) setDemandes(res.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/clients', {
        params: {
          page,
          pageSize,
          search,
          ville,
          agence,
          forme,
          ...flags,
          ...(sortBy && { sortBy, sortDir })
        }
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setTotal(res.data.total);
        setTotalPages(res.data.totalPages);
        setError('');
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
  }, [page, pageSize, search, ville, agence, forme, flags, sortBy, sortDir, reload]);

  const rangeLabel = useMemo(() => {
    if (!total) return '0 client';
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} clients`;
  }, [page, pageSize, total]);

  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.customers_id === id ? { ...r, ...patch } : r)));
  }

  async function toggleActive(c) {
    const activer = c.active !== 1;
    const verbe = activer ? 'activer' : 'désactiver';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le client « ${c.store || c.name} » ?`)) return;
    setBusyId(c.customers_id);
    try {
      const res = await api.patch(`/clients/${c.customers_id}/active`, { active: activer ? 1 : 0 });
      patchRow(c.customers_id, { active: res.data.active });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleVerified(c) {
    const verifier = c.verified !== 1;
    const verbe = verifier ? 'marquer comme vérifié' : 'marquer comme non vérifié';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} le client « ${c.store || c.name} » ?`)) return;
    setBusyId(c.customers_id);
    try {
      const res = await api.patch(`/clients/${c.customers_id}/verified`, { verified: verifier ? 1 : 0 });
      patchRow(c.customers_id, { verified: res.data.verified });
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="utilisateurs-page">
      <div className="page-actions">
        {demandes.count > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-demandes-attente"
            onClick={() => setShowDemandes(true)}
          >
            <Hourglass size={16} /> Modifications en attente
            <span className="badge badge-attente">{demandes.count}</span>
          </button>
        )}
        <button type="button" className="btn btn-primary btn-icon" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> Ajouter nouveau client
        </button>
      </div>

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : magasin, nom, CIN, téléphone…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <SearchableSelect
          className="ss-toolbar"
          value={ville}
          onChange={(v) => {
            setVille(v);
            setPage(1);
          }}
          placeholder="Toutes les villes de ramassage"
          options={[
            { value: '', label: 'Toutes les villes de ramassage' },
            ...filtres.villes.map((v) => ({ value: v.ville_id, label: v.nom_ville }))
          ]}
        />
        <select
          className="datatable-select"
          value={agence}
          onChange={(e) => {
            setAgence(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Toutes les agences</option>
          {filtres.agences.map((a) => (
            <option key={a.agence_id} value={a.agence_id}>
              {a.agence_name}
            </option>
          ))}
        </select>
        <select
          className="datatable-select"
          value={forme}
          onChange={(e) => {
            setForme(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Toutes les formes juridiques</option>
          {filtres.formes.map((f) => (
            <option key={f.configs_id} value={f.configs_id}>
              {f.configs_val}
            </option>
          ))}
        </select>
        <FlagSelect label="Tarifs personnalisés" value={flags.customTarif} onChange={(v) => setFlag('customTarif', v)} />
        <FlagSelect label="Vérifiés" value={flags.verified} onChange={(v) => setFlag('verified', v)} />
        <FlagSelect label="Voir n° livreur" value={flags.livreurShow} onChange={(v) => setFlag('livreurShow', v)} />
        <FlagSelect label="N° vendeur sur ticket" value={flags.phoneShow} onChange={(v) => setFlag('phoneShow', v)} />
        <FlagSelect label="Colis zéro" value={flags.colisZero} onChange={(v) => setFlag('colisZero', v)} />
        <select
          className="datatable-select"
          value={flags.active}
          onChange={(e) => setFlag('active', e.target.value)}
        >
          <option value="">Tous les statuts</option>
          <option value="1">Activés</option>
          <option value="0">Désactivés</option>
        </select>
        <select
          className="datatable-select"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Nom magasin</th>
              <th>Ville de ramassage</th>
              <th>Forme juridique</th>
              <SortableTh sortKey="nb_colis">Nombre de colis</SortableTh>
              <SortableTh sortKey="taux_livraison">Livrés</SortableTh>
              <th>En cours</th>
              <SortableTh sortKey="taux_retour">Retournés</SortableTh>
              <th>Tarifs personnalisés</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={COL_COUNT} className="datatable-empty">
                  Aucun client trouvé.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.customers_id} className={c.active === 1 ? '' : 'row-inactive'}>
                  <td>
                    <div className="cell-main">{c.store || '—'}</div>
                    <div className="cell-sub">
                      {c.name || '—'}
                      {c.active !== 1 && <span className="badge badge-inactive">Désactivé</span>}
                    </div>
                  </td>
                  <td>
                    <div className="cell-main">{c.ville_ramassage || '—'}</div>
                    {/* Zone et agence dérivées de la ville de ramassage. */}
                    <div className="cell-sub">{[c.zone, c.agence].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td>{c.forme_juridique || '—'}</td>
                  <td>
                    <div className="cell-main">{formatCount(c.colis_total)}</div>
                  </td>
                  <td>
                    <div className="cell-main">{formatCount(c.colis_livres)}</div>
                    <div className="cell-sub">{formatTaux(c.colis_livres, c.colis_total) || '—'}</div>
                  </td>
                  <td>
                    <div className="cell-main">{formatCount(c.colis_en_cours)}</div>
                    <div className="cell-sub">{formatTaux(c.colis_en_cours, c.colis_total) || '—'}</div>
                  </td>
                  <td>
                    <div className="cell-main">{formatCount(c.colis_retournes)}</div>
                    <div className="cell-sub">{formatTaux(c.colis_retournes, c.colis_total) || '—'}</div>
                  </td>
                  <td>
                    <span className={`badge ${c.custom_tarif === 1 ? 'badge-active' : 'badge-neutral'}`}>
                      {c.custom_tarif === 1 ? 'Oui' : 'Non'}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-action"
                        title="Voir fiche client"
                        onClick={() => setDetail(c)}
                      >
                        <Eye size={16} />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title="Modifier la fiche"
                        onClick={() => navigate(`/admin/clients/${c.customers_id}`)}
                      >
                        <SquarePen size={16} />
                      </button>
                      <button
                        type="button"
                        className="row-action"
                        title="Options"
                        onClick={() => setOptions(c)}
                      >
                        <Settings2 size={16} />
                      </button>
                      <button
                        type="button"
                        className={`row-action ${c.verified === 1 ? 'row-action-verified' : ''}`}
                        title={c.verified === 1 ? 'Client vérifié — marquer non vérifié' : 'Client non vérifié — marquer vérifié'}
                        onClick={() => toggleVerified(c)}
                        disabled={busyId === c.customers_id}
                      >
                        <BadgeCheck size={16} />
                      </button>
                      <button
                        type="button"
                        className={`row-action ${c.active === 1 ? 'row-action-danger' : 'row-action-success'}`}
                        title={c.active === 1 ? 'Désactiver le client' : 'Activer le client'}
                        onClick={() => toggleActive(c)}
                        disabled={busyId === c.customers_id}
                      >
                        <Power size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="datatable-footer">
        <span className="datatable-range">{rangeLabel}</span>
        <div className="datatable-pager">
          <button type="button" className="page-btn" onClick={() => setPage(1)} disabled={page <= 1} title="Première page">
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n - 1)}
            disabled={page <= 1}
            title="Page précédente"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="page-info">
            Page {page.toLocaleString('fr-FR')} / {totalPages.toLocaleString('fr-FR')}
          </span>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage((n) => n + 1)}
            disabled={page >= totalPages}
            title="Page suivante"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="page-btn"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            title="Dernière page"
          >
            <ChevronsRight size={16} />
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateModal
          villes={filtres.villes}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            // Tri par défaut customers_id DESC : le nouveau client apparaît en tête de page 1.
            setSortBy('');
            setPage(1);
            setReload((n) => n + 1);
          }}
        />
      )}
      {showDemandes && (
        <DemandesModal
          rows={demandes.rows}
          onClose={() => setShowDemandes(false)}
          onOuvrir={(id) => navigate(`/admin/clients/${id}`)}
        />
      )}
      {detail && <DetailModal client={detail} onClose={() => setDetail(null)} />}
      {options && (
        <OptionsModal
          client={options}
          onClose={() => setOptions(null)}
          onSaved={(data) =>
            patchRow(data.customers_id, {
              livreur_show: data.livreur_show,
              phone_show: data.phone_show,
              colis_zero: data.colis_zero
            })
          }
        />
      )}
    </div>
  );
}
