import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Boxes,
  Car,
  Fuel,
  History,
  Monitor,
  Package,
  PackageMinus,
  PackagePlus,
  Paperclip,
  Pencil,
  Plus,
  Power,
  Search,
  Trash2,
  Undo2,
  UserPlus,
  Wrench,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Matériel (page /admin/materiel — service MATERIEL, fonctions 1 et 2) :
 * catalogue et stock du matériel de la société, en 4 types :
 *  - Auto            : stock principal, consommé sur un véhicule du parc ;
 *  - Emballage       : stock principal + stock par agence (transferts /
 *    retours), vendu aux clients via Frais supplémentaires clients ;
 *  - Consommable     : même circuit que l'emballage ;
 *  - Non consommable : affecté à une agence ou à une personne puis récupéré
 *    (suivi par quantité, récupérations partielles).
 * Un 5e onglet Historique liste le journal des mouvements.
 * API : /api/materiel (materiel.controller).
 */

const TYPES = [
  { code: 'auto', label: 'Auto', icon: Car },
  { code: 'emballage', label: 'Emballage', icon: Package },
  { code: 'consommable', label: 'Consommable', icon: Paperclip },
  { code: 'non_consommable', label: 'Non consommable', icon: Monitor }
];

const TABS = [...TYPES, { code: 'historique', label: 'Historique', icon: History }];

const TYPE_LABELS = Object.fromEntries(TYPES.map((t) => [t.code, t.label]));
const TYPE_BADGES = {
  auto: 'badge-mat-auto',
  emballage: 'badge-mat-emballage',
  consommable: 'badge-mat-consommable',
  non_consommable: 'badge-mat-non-consommable'
};

/* Mouvements saisissables par type d'article (miroir backend MVNT_PAR_TYPE). */
const ACTIONS_MVNT = {
  auto: ['entree', 'sortie', 'consommation'],
  emballage: ['entree', 'sortie', 'transfert_agence', 'retour_agence'],
  consommable: ['entree', 'sortie', 'transfert_agence', 'retour_agence'],
  non_consommable: ['entree', 'sortie']
};

const MVNT_UI = {
  entree: { label: 'Entrée stock', icon: PackagePlus, sens: 'entree' },
  sortie: { label: 'Sortie stock', icon: PackageMinus, sens: 'sortie' },
  transfert_agence: { label: 'Transfert vers agence', icon: ArrowRightLeft, sens: 'sortie' },
  retour_agence: { label: 'Retour agence', icon: Undo2, sens: 'entree' },
  consommation: { label: 'Consommation véhicule', icon: Fuel, sens: 'sortie' }
};

/** Date du jour au format AAAA-MM-JJ (input date). */
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Prix affiché : "12,50 DH" ou tiret si absent. */
function formatPrix(value) {
  if (value == null) return '—';
  return `${Number(value).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} DH`;
}

/** Modale « Nouvel article » / « Modifier article » (type figé en édition). */
function ArticleModal({ article, typeInitial, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    type: article ? article.type : typeInitial,
    nom: article ? article.nom : '',
    reference: article ? article.reference : '',
    unite: article ? article.unite : '',
    prixAchat: article?.prix_achat != null ? String(article.prix_achat) : '',
    prixVente: article?.prix_vente != null ? String(article.prix_vente) : '',
    seuilAlerte: article?.seuil_alerte ? String(article.seuil_alerte) : ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const vendable = form.type === 'emballage' || form.type === 'consommable';

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = {
        type: form.type,
        nom: form.nom,
        reference: form.reference,
        unite: form.unite,
        prixAchat: form.prixAchat,
        prixVente: form.prixVente,
        seuilAlerte: form.seuilAlerte
      };
      if (article) await api.put(`/materiel/${article.id}`, body);
      else await api.post('/materiel', body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de l'article.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Wrench size={18} />
            <div className="cell-main">{article ? 'Modifier article' : 'Nouvel article'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Type de matériel</span>
              {/* Type figé en édition : le changer corromprait stocks et affectations. */}
              <select value={form.type} onChange={setField('type')} disabled={Boolean(article)} required>
                {TYPES.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="modal-form-full">
              <span className="field-label">Nom de l'article</span>
              <input
                type="text"
                value={form.nom}
                onChange={setField('nom')}
                maxLength={150}
                placeholder="Ex. : carton 40×40, gilet jaune…"
                required
              />
            </label>
            <label>
              <span className="field-label">Référence</span>
              <input type="text" value={form.reference} onChange={setField('reference')} maxLength={100} />
            </label>
            <label>
              <span className="field-label">Unité</span>
              <input
                type="text"
                value={form.unite}
                onChange={setField('unite')}
                maxLength={30}
                placeholder="pièce, litre, rame…"
              />
            </label>
            <label>
              <span className="field-label">Prix d'achat (DH)</span>
              <input type="number" min="0" step="0.01" value={form.prixAchat} onChange={setField('prixAchat')} />
            </label>
            <label>
              <span className="field-label">Prix de vente (DH){vendable ? '' : ' — optionnel'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.prixVente}
                onChange={setField('prixVente')}
                required={vendable}
              />
            </label>
            <label>
              <span className="field-label">Seuil d'alerte stock</span>
              <input
                type="number"
                min="0"
                step="1"
                value={form.seuilAlerte}
                onChange={setField('seuilAlerte')}
                placeholder="0 = pas d'alerte"
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale de mouvement de stock (entrée, sortie, transfert, retour, consommation). */
function MouvementModal({ article, mode, filtres, onClose, onSaved }) {
  const ui = MVNT_UI[mode];
  const [form, setForm] = useState({ qte: '', agence: '', moyen: '', commentaire: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const besoinAgence = mode === 'transfert_agence' || mode === 'retour_agence';

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post(`/materiel/${article.id}/mouvements`, {
        type: mode,
        qte: Number(form.qte),
        agence: besoinAgence ? Number(form.agence) : undefined,
        moyen: mode === 'consommation' ? Number(form.moyen) : undefined,
        commentaire: form.commentaire
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du mouvement.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal modal-mvnt ${ui.sens === 'entree' ? 'modal-mvnt-entree' : 'modal-mvnt-sortie'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">
            <ui.icon size={18} />
            <div>
              <div className="cell-main">{ui.label}</div>
              <div className="cell-sub">{article.nom}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className={besoinAgence || mode === 'consommation' ? '' : 'modal-form-full'}>
              <span className="field-label">Quantité{article.unite ? ` (${article.unite})` : ''}</span>
              <input type="number" min="1" step="1" value={form.qte} onChange={setField('qte')} required />
            </label>
            {besoinAgence && (
              <div>
                <span className="field-label">Agence</span>
                <SearchableSelect
                  value={form.agence}
                  onChange={(v) => setForm((f) => ({ ...f, agence: String(v) }))}
                  placeholder="— Sélectionner une agence —"
                  options={filtres.agences.map((a) => ({ value: String(a.id), label: a.nom }))}
                />
              </div>
            )}
            {mode === 'consommation' && (
              <div>
                <span className="field-label">Véhicule</span>
                <SearchableSelect
                  value={form.moyen}
                  onChange={(v) => setForm((f) => ({ ...f, moyen: String(v) }))}
                  placeholder="— Sélectionner un véhicule —"
                  options={filtres.moyens.map((m) => ({ value: String(m.id), label: m.label }))}
                />
              </div>
            )}
            <label className="modal-form-full">
              <span className="field-label">Commentaire</span>
              <input type="text" value={form.commentaire} onChange={setField('commentaire')} maxLength={255} />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale détail du stock d'un article par agence. */
function StockAgencesModal({ article, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/materiel/${article.id}/agences`)
      .then((res) => {
        if (!cancelled) setRows(res.data.rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du stock par agence.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [article.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Boxes size={18} />
            <div>
              <div className="cell-main">Stock par agence</div>
              <div className="cell-sub">{article.nom}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Agence</th>
                <th>Quantité</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={2} className="datatable-empty">
                    Aucun stock en agence.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.agence_id}>
                    <td>{r.agence || `Agence n°${r.agence_id}`}</td>
                    <td>{r.qte}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

/** Modale « Affecter » (non consommable) : agence ou personne + quantité. */
function AffectationModal({ article, filtres, onClose, onSaved }) {
  const [form, setForm] = useState({
    dimension: 'USER',
    cible: '',
    qte: '',
    reference: '',
    date: todayStr(),
    commentaire: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const cibleOptions =
    form.dimension === 'AGENCE'
      ? filtres.agences.map((a) => ({ value: String(a.id), label: a.nom }))
      : filtres.users.map((u) => ({ value: String(u.id), label: u.nom }));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post('/materiel/affectations', {
        materiel: article.id,
        dimension: form.dimension,
        cible: Number(form.cible),
        qte: Number(form.qte),
        reference: form.reference,
        date: form.date,
        commentaire: form.commentaire
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de l'affectation.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <UserPlus size={18} />
            <div>
              <div className="cell-main">Affecter du matériel</div>
              <div className="cell-sub">
                {article.nom} — {article.qte} disponible(s)
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Affecter à</span>
              <select
                value={form.dimension}
                onChange={(e) => setForm((f) => ({ ...f, dimension: e.target.value, cible: '' }))}
              >
                <option value="USER">Une personne</option>
                <option value="AGENCE">Une agence</option>
              </select>
            </label>
            <div>
              <span className="field-label">{form.dimension === 'AGENCE' ? 'Agence' : 'Personne'}</span>
              <SearchableSelect
                value={form.cible}
                onChange={(v) => setForm((f) => ({ ...f, cible: String(v) }))}
                placeholder={form.dimension === 'AGENCE' ? '— Sélectionner une agence —' : '— Sélectionner une personne —'}
                options={cibleOptions}
              />
            </div>
            <label>
              <span className="field-label">Quantité</span>
              <input type="number" min="1" step="1" value={form.qte} onChange={setField('qte')} required />
            </label>
            <label>
              <span className="field-label">Date d'affectation</span>
              <input type="date" value={form.date} onChange={setField('date')} required />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Référence (n° série…)</span>
              <input type="text" value={form.reference} onChange={setField('reference')} maxLength={100} />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Commentaire</span>
              <input type="text" value={form.commentaire} onChange={setField('commentaire')} maxLength={255} />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Affecter'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Récupérer » : récupération (partielle) d'une affectation. */
function RecuperationModal({ affectation, onClose, onSaved }) {
  const restant = affectation.qte - affectation.qte_recuperee;
  const [form, setForm] = useState({ qte: String(restant), date: todayStr(), commentaire: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.post(`/materiel/affectations/${affectation.id}/recuperation`, {
        qte: Number(form.qte),
        date: form.date,
        commentaire: form.commentaire
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la récupération.');
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-mvnt modal-mvnt-entree" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Undo2 size={18} />
            <div>
              <div className="cell-main">Récupérer du matériel</div>
              <div className="cell-sub">
                {affectation.materiel} — {affectation.cible} ({restant} restant(s))
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Quantité récupérée</span>
              <input type="number" min="1" max={restant} step="1" value={form.qte} onChange={setField('qte')} required />
            </label>
            <label>
              <span className="field-label">Date de récupération</span>
              <input type="date" value={form.date} onChange={setField('date')} required />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Commentaire</span>
              <input type="text" value={form.commentaire} onChange={setField('commentaire')} maxLength={255} />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Undo2 size={15} /> {saving ? 'Enregistrement…' : 'Récupérer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Carte « Affectations » de l'onglet Non consommable. */
function AffectationsCard({ articles, reloadKey, onRecuperer }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtreMateriel, setFiltreMateriel] = useState('');
  const [filtreDimension, setFiltreDimension] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/materiel/affectations')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des affectations.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const rowsFiltres = useMemo(
    () =>
      rows.filter((r) => {
        if (filtreMateriel && String(r.materiel_id) !== filtreMateriel) return false;
        if (filtreDimension && r.dimension !== filtreDimension) return false;
        if (filtreStatut && r.statut !== filtreStatut) return false;
        return true;
      }),
    [rows, filtreMateriel, filtreDimension, filtreStatut]
  );

  const pager = usePagination(rowsFiltres, 'affectation');

  return (
    <section className="platform-card mt-affectations-card">
      <div className="bons-head">
        <h2>
          <UserPlus size={18} /> Affectations
        </h2>
      </div>

      <div className="filters-bar">
        <SearchableSelect
          className="ss-toolbar"
          value={filtreMateriel}
          onChange={(v) => {
            setFiltreMateriel(String(v));
            pager.setPage(1);
          }}
          placeholder="Tous les articles"
          options={[
            { value: '', label: 'Tous les articles' },
            ...articles.map((a) => ({ value: String(a.id), label: a.nom }))
          ]}
        />
        <select
          className="datatable-select"
          value={filtreDimension}
          onChange={(e) => {
            setFiltreDimension(e.target.value);
            pager.setPage(1);
          }}
        >
          <option value="">Toutes les cibles</option>
          <option value="AGENCE">Agences</option>
          <option value="USER">Personnes</option>
        </select>
        <select
          className="datatable-select"
          value={filtreStatut}
          onChange={(e) => {
            setFiltreStatut(e.target.value);
            pager.setPage(1);
          }}
        >
          <option value="">Tous les statuts</option>
          <option value="affecte">Affectés</option>
          <option value="recupere">Récupérés</option>
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Matériel</th>
              <th>Cible</th>
              <th>Quantité</th>
              <th>Référence</th>
              <th>Affecté le</th>
              <th>Récupéré le</th>
              <th>Statut</th>
              <th>Commentaire</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rowsFiltres.length === 0 && !loading ? (
              <tr>
                <td colSpan={9} className="datatable-empty">
                  Aucune affectation trouvée.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => {
                const restant = r.qte - r.qte_recuperee;
                return (
                  <tr key={r.id}>
                    <td>{r.materiel}</td>
                    <td>
                      <div className="cell-main">{r.cible || `N°${r.cible_id}`}</div>
                      <div className="cell-sub">{r.dimension === 'AGENCE' ? 'Agence' : 'Personne'}</div>
                    </td>
                    <td>
                      <div className="cell-main">{r.qte}</div>
                      {r.qte_recuperee > 0 && (
                        <div className="cell-sub">
                          {r.qte_recuperee} récupéré(s) · {restant} restant(s)
                        </div>
                      )}
                    </td>
                    <td>{r.reference || '—'}</td>
                    <td>{r.date_affectation}</td>
                    <td>{r.date_recuperation || '—'}</td>
                    <td>
                      <span className={`badge ${r.statut === 'recupere' ? 'badge-active' : 'badge-attente'}`}>
                        {r.statut === 'recupere' ? 'Récupéré' : 'Affecté'}
                      </span>
                    </td>
                    <td>{r.commentaire || '—'}</td>
                    <td>
                      <div className="row-actions">
                        {r.statut === 'affecte' && (
                          <button
                            type="button"
                            className="row-action row-action-success"
                            onClick={() => onRecuperer(r)}
                            title="Récupérer"
                          >
                            <Undo2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/** Onglet Historique : journal des mouvements, filtres serveur. */
function HistoriqueCard({ filtres, articles, reloadKey }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ typeMateriel: '', materiel: '', mvnt: '', agence: '' });
  const [applied, setApplied] = useState(draft);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/materiel/mouvements', { params: applied })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || "Erreur de chargement de l'historique.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, reloadKey]);

  const pager = usePagination(rows, 'mouvement');

  /** Contexte du mouvement : agence, véhicule, personne ou frais lié. */
  function contexte(r) {
    if (r.mvnt === 'consommation') return r.moyen;
    if (r.mvnt === 'vente') return `${r.agence}${r.frais_id ? ` · frais n°${r.frais_id}` : ''}`;
    if (r.mvnt === 'affectation' || r.mvnt === 'recuperation') return r.agence || r.cible_user;
    return r.agence;
  }

  return (
    <section className="platform-card">
      <div className="bons-head">
        <h2>
          <History size={18} /> Historique des mouvements
        </h2>
      </div>

      <div className="filters-bar">
        <select
          className="datatable-select"
          value={draft.typeMateriel}
          onChange={(e) => setDraft((d) => ({ ...d, typeMateriel: e.target.value }))}
        >
          <option value="">Tous les types de matériel</option>
          {TYPES.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <SearchableSelect
          className="ss-toolbar"
          value={draft.materiel}
          onChange={(v) => setDraft((d) => ({ ...d, materiel: String(v) }))}
          placeholder="Tous les articles"
          options={[
            { value: '', label: 'Tous les articles' },
            ...articles.map((a) => ({ value: String(a.id), label: a.nom }))
          ]}
        />
        <select
          className="datatable-select"
          value={draft.mvnt}
          onChange={(e) => setDraft((d) => ({ ...d, mvnt: e.target.value }))}
        >
          <option value="">Tous les mouvements</option>
          {filtres.mvntTypes.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          className="datatable-select"
          value={draft.agence}
          onChange={(e) => setDraft((d) => ({ ...d, agence: e.target.value }))}
        >
          <option value="">Toutes les agences</option>
          {filtres.agences.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nom}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary btn-apply"
          onClick={() => {
            setApplied({ ...draft });
            pager.setPage(1);
          }}
        >
          Appliquer
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Matériel</th>
              <th>Mouvement</th>
              <th>Quantité</th>
              <th>Agence / Véhicule / Cible</th>
              <th>Commentaire</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="datatable-empty">
                  Aucun mouvement trouvé.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => {
                const type = filtres.mvntTypes.find((t) => t.code === r.mvnt);
                const sens = type?.sens || 'sortie';
                return (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>
                      <div className="cell-main">{r.materiel}</div>
                      <div className="cell-sub">
                        <span className={`badge ${TYPE_BADGES[r.type_materiel] || 'badge-neutral'}`}>
                          {TYPE_LABELS[r.type_materiel] || r.type_materiel}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${sens === 'entree' ? 'badge-mvnt-entree' : 'badge-mvnt-sortie'}`}>
                        {type?.label || r.mvnt}
                      </span>
                    </td>
                    <td className={sens === 'entree' ? 'mvnt-qte-entree' : 'mvnt-qte-sortie'}>
                      {r.qte}
                      {r.unite ? ` ${r.unite}` : ''}
                    </td>
                    <td>{contexte(r) || '—'}</td>
                    <td>{r.commentaire || '—'}</td>
                    <td>{r.par || '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/** Tableau du catalogue pour un type de matériel donné. */
function CatalogueCard({ type, rows, loading, error, onAction }) {
  const [search, setSearch] = useState('');
  const [filtreActif, setFiltreActif] = useState('1');

  const estVendable = type === 'emballage' || type === 'consommable';
  const estNonConso = type === 'non_consommable';

  const rowsFiltres = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filtreActif !== '' && String(r.active) !== filtreActif) return false;
      if (!q) return true;
      return [r.nom, r.reference].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, search, filtreActif]);

  const pager = usePagination(rowsFiltres, 'article');

  const typeInfo = TYPES.find((t) => t.code === type);
  const nbColonnes = 6 + (estVendable ? 2 : 0) + (estNonConso ? 1 : 0);

  return (
    <section className="platform-card">
      <div className="bons-head">
        <h2>
          <typeInfo.icon size={18} /> Matériel {typeInfo.label.toLowerCase()}
        </h2>
        <button type="button" className="btn btn-primary" onClick={() => onAction('article', null)}>
          <Plus size={15} /> Nouvel article
        </button>
      </div>

      <div className="filters-bar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="text"
            placeholder="Rechercher : nom, référence…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              pager.setPage(1);
            }}
          />
        </div>
        <select
          className="datatable-select"
          value={filtreActif}
          onChange={(e) => {
            setFiltreActif(e.target.value);
            pager.setPage(1);
          }}
        >
          <option value="1">Actifs</option>
          <option value="0">Inactifs</option>
          <option value="">Tous</option>
        </select>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Article</th>
              <th>Unité</th>
              <th>Prix d'achat</th>
              {estVendable && <th>Prix de vente</th>}
              <th>{estNonConso ? 'Disponible' : 'Stock principal'}</th>
              {estVendable && <th>Stock agences</th>}
              {estNonConso && <th>Affecté</th>}
              <th>Statut</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rowsFiltres.length === 0 && !loading ? (
              <tr>
                <td colSpan={nbColonnes} className="datatable-empty">
                  Aucun article trouvé.
                </td>
              </tr>
            ) : (
              pager.pageRows.map((r) => {
                const alerte = r.seuil_alerte > 0 && r.qte <= r.seuil_alerte;
                return (
                  <tr key={r.id} className={r.active ? '' : 'row-inactive'}>
                    <td>
                      <div className="cell-main">{r.nom}</div>
                      {r.reference && <div className="cell-sub">Réf : {r.reference}</div>}
                    </td>
                    <td>{r.unite || '—'}</td>
                    <td>{formatPrix(r.prix_achat)}</td>
                    {estVendable && <td>{formatPrix(r.prix_vente)}</td>}
                    <td>
                      <span className={alerte ? 'mt-qte-alerte' : ''} title={alerte ? `Seuil d'alerte : ${r.seuil_alerte}` : undefined}>
                        {r.qte}
                      </span>
                    </td>
                    {estVendable && (
                      <td>
                        {r.stock_agences > 0 ? (
                          <button
                            type="button"
                            className="mt-stock-btn"
                            onClick={() => onAction('agences', r)}
                            title="Voir le détail par agence"
                          >
                            {r.stock_agences}
                          </button>
                        ) : (
                          0
                        )}
                      </td>
                    )}
                    {estNonConso && <td>{r.affecte}</td>}
                    <td>
                      <span className={`badge ${r.active ? 'badge-active' : 'badge-inactive'}`}>
                        {r.active ? 'Actif' : 'Inactif'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {(ACTIONS_MVNT[type] || []).map((mode) => {
                          const ui = MVNT_UI[mode];
                          return (
                            <button
                              key={mode}
                              type="button"
                              className={`row-action ${ui.sens === 'entree' ? 'row-action-success' : ''}`}
                              onClick={() => onAction('mvnt', r, mode)}
                              title={ui.label}
                            >
                              <ui.icon size={16} />
                            </button>
                          );
                        })}
                        {estNonConso && (
                          <button
                            type="button"
                            className="row-action"
                            onClick={() => onAction('affectation', r)}
                            title="Affecter à une agence ou une personne"
                          >
                            <UserPlus size={16} />
                          </button>
                        )}
                        <button type="button" className="row-action" onClick={() => onAction('article', r)} title="Modifier">
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => onAction('statut', r)}
                          title={r.active ? 'Désactiver' : 'Activer'}
                        >
                          <Power size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          onClick={() => onAction('supprimer', r)}
                          title="Supprimer"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </section>
  );
}

/** Matériel — page principale : 4 onglets par type + Historique. */
export default function Materiel() {
  const [filtres, setFiltres] = useState({ types: [], mvntTypes: [], agences: [], users: [], moyens: [] });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('auto');
  const [modal, setModal] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api
      .get('/materiel/filtres')
      .then((res) => setFiltres(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/materiel')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du matériel.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const rowsDuTab = useMemo(() => rows.filter((r) => r.type === tab), [rows, tab]);
  const reload = () => setReloadKey((k) => k + 1);

  /** Actions des tableaux : ouvre la modale ou exécute l'action directe. */
  async function handleAction(kind, article, mode) {
    if (kind === 'statut') {
      const verbe = article.active ? 'Désactiver' : 'Activer';
      if (!window.confirm(`${verbe} l'article « ${article.nom} » ?`)) return;
      try {
        await api.patch(`/materiel/${article.id}/statut`, { active: article.active ? 0 : 1 });
        reload();
      } catch (err) {
        window.alert(err.response?.data?.message || 'Erreur lors du changement de statut.');
      }
      return;
    }
    if (kind === 'supprimer') {
      if (!window.confirm(`Supprimer définitivement l'article « ${article.nom} » ?`)) return;
      try {
        await api.delete(`/materiel/${article.id}`);
        reload();
      } catch (err) {
        window.alert(err.response?.data?.message || 'Erreur lors de la suppression.');
      }
      return;
    }
    setModal({ kind, article, mode });
  }

  const closeModal = () => setModal(null);
  const savedModal = () => {
    setModal(null);
    reload();
  };

  return (
    <div className="platform-page materiel-page">
      <nav className="fiche-tabs mt-tabs" aria-label="Types de matériel">
        {TABS.map((t) => (
          <button
            key={t.code}
            type="button"
            className={`fiche-tab ${tab === t.code ? 'active' : ''}`}
            onClick={() => setTab(t.code)}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </nav>

      {tab === 'historique' ? (
        <HistoriqueCard filtres={filtres} articles={rows} reloadKey={reloadKey} />
      ) : (
        <>
          <CatalogueCard type={tab} rows={rowsDuTab} loading={loading} error={error} onAction={handleAction} />
          {tab === 'non_consommable' && (
            <AffectationsCard
              articles={rowsDuTab}
              reloadKey={reloadKey}
              onRecuperer={(affectation) => setModal({ kind: 'recuperation', affectation })}
            />
          )}
        </>
      )}

      {modal?.kind === 'article' && (
        <ArticleModal article={modal.article} typeInitial={tab} onClose={closeModal} onSaved={savedModal} />
      )}
      {modal?.kind === 'mvnt' && (
        <MouvementModal article={modal.article} mode={modal.mode} filtres={filtres} onClose={closeModal} onSaved={savedModal} />
      )}
      {modal?.kind === 'agences' && <StockAgencesModal article={modal.article} onClose={closeModal} />}
      {modal?.kind === 'affectation' && (
        <AffectationModal article={modal.article} filtres={filtres} onClose={closeModal} onSaved={savedModal} />
      )}
      {modal?.kind === 'recuperation' && (
        <RecuperationModal affectation={modal.affectation} onClose={closeModal} onSaved={savedModal} />
      )}
    </div>
  );
}
