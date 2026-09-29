import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Info, Plus, RotateCcw, Search, TriangleAlert, Truck, X } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';
import SearchSelect from '../../components/SearchSelect';

/*
 * Logistiques — parc des moyens logistiques (motos, VL, PL) : liste avec
 * filtres (recherche, type, marque, énergie, statut, documents manquants /
 * expirés), ajout en modale (type + marque + n° de châssis) et accès à la
 * fiche détaillée (/admin/logistiques/:id). Les marques se gèrent dans
 * Configuration > Options ; « Financement » et « Fin crédit » seront remplis
 * quand l'onglet Financement de la fiche sera développé.
 */

/** Filtres à vide (bouton de réinitialisation). */
function defaultFilters() {
  return { q: '', type: '', marque: '', energie: '', statut: '', docs: '', expires: '' };
}

/** Libellé d'un code dans une liste [{ code, label }] du backend. */
function labelOf(list, code) {
  return list.find((item) => item.code === code)?.label || code;
}

/** Badge de statut d'un moyen : couleur selon le code. */
const STATUT_BADGES = {
  actif: 'badge-active',
  en_maintenance: 'badge-attente',
  immobilise: 'badge-affecte',
  vendu: 'badge-neutral',
  hors_service: 'badge-refuse'
};

/**
 * Modale « Nouveau moyen logistique » : type, marque (uniquement celles du
 * type sélectionné) et n° de châssis. Réutilisée par la fiche (bouton
 * Ajouter). onSaved reçoit l'id du moyen créé.
 */
export function NouveauMoyenModal({ filtres, onClose, onSaved }) {
  const [form, setForm] = useState({ type: '', marqueId: '', chassis: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const marques = useMemo(
    () => (filtres.marques || []).filter((m) => m.type === form.type),
    [filtres.marques, form.type]
  );

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.type) {
      setError('Veuillez choisir le type de moyen.');
      return;
    }
    if (!form.marqueId) {
      setError('Veuillez choisir la marque.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/logistiques', {
        type: form.type,
        marqueId: Number(form.marqueId),
        chassis: form.chassis
      });
      onSaved(res.data.id);
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du moyen.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Truck size={18} />
            <div className="cell-main">Nouveau moyen logistique</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Type *</span>
              <select
                value={form.type}
                onChange={(e) => setForm({ type: e.target.value, marqueId: '', chassis: form.chassis })}
                required
              >
                <option value="">— Choisir un type —</option>
                {(filtres.types || []).map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-form-full">
              <span className="field-label">Marque *</span>
              {form.type ? (
                <SearchableSelect
                  value={form.marqueId}
                  onChange={(v) => setForm((f) => ({ ...f, marqueId: v }))}
                  options={marques.map((m) => ({ value: String(m.id), label: m.nom }))}
                  placeholder="— Choisir la marque —"
                  emptyText="Aucune marque de ce type (Configuration > Options)."
                />
              ) : (
                <select disabled>
                  <option>— Choisir d'abord un type —</option>
                </select>
              )}
              <p className="cell-sub lg-modal-hint">
                La liste ne présente que les marques du type sélectionné.
              </p>
            </div>
            <label className="modal-form-full">
              <span className="field-label">N° de châssis *</span>
              <input
                type="text"
                value={form.chassis}
                onChange={(e) => setForm((f) => ({ ...f, chassis: e.target.value }))}
                maxLength={100}
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

/** Logistiques — liste du parc : filtres, tableau et ajout d'un moyen. */
export default function Logistiques() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [filtres, setFiltres] = useState({
    types: [],
    energies: [],
    statuts: [],
    methodes: [],
    marques: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [f, setF] = useState(defaultFilters);
  const [modal, setModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get('/logistiques'), api.get('/logistiques/filtres')])
      .then(([listRes, filtresRes]) => {
        if (cancelled) return;
        setRows(listRes.data.rows);
        setFiltres(filtresRes.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du parc.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Le filtre marque ne propose que les marques du type filtré (comme la modale).
  const marqueOptions = useMemo(() => {
    const list = f.type ? filtres.marques.filter((m) => m.type === f.type) : filtres.marques;
    return list.map((m) => ({
      value: String(m.id),
      label: f.type ? m.nom : `${m.nom} (${labelOf(filtres.types, m.type)})`
    }));
  }, [filtres.marques, filtres.types, f.type]);

  const filteredRows = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const cible = `${r.marque} ${r.chassis} ${r.immat} ${r.immat_ww}`.toLowerCase();
        if (!cible.includes(q)) return false;
      }
      if (f.type && r.type !== f.type) return false;
      if (f.marque && String(r.marque_id) !== f.marque) return false;
      if (f.energie && r.energie !== f.energie) return false;
      if (f.statut && r.statut !== f.statut) return false;
      if (f.docs === 'avec' && r.docs_manquants === 0) return false;
      if (f.docs === 'complet' && r.docs_manquants > 0) return false;
      if (f.expires === 'avec' && r.docs_expires === 0) return false;
      if (f.expires === 'sans' && r.docs_expires > 0) return false;
      return true;
    });
  }, [rows, f]);

  const pager = usePagination(filteredRows, 'moyen');

  function handleSaved(id) {
    setModal(false);
    // La fiche s'ouvre directement pour compléter les caractéristiques.
    navigate(`/admin/logistiques/${id}`);
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Truck size={18} /> Logistiques
            <span className="fiche-hint lg-head-sub">
              Parc des moyens logistiques — liste, documents &amp; statuts
            </span>
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal(true)}>
            <Plus size={15} /> Ajouter
          </button>
        </div>

        <div className="filters-bar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Marque, châssis ou immatriculation…"
              value={f.q}
              onChange={(e) => setF((prev) => ({ ...prev, q: e.target.value }))}
            />
          </div>
          <select
            className="datatable-select"
            value={f.type}
            onChange={(e) => setF((prev) => ({ ...prev, type: e.target.value, marque: '' }))}
            title="Type"
          >
            <option value="">Tous types</option>
            {filtres.types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
          <SearchSelect
            label="Marque"
            options={marqueOptions}
            value={f.marque}
            onChange={(v) => setF((prev) => ({ ...prev, marque: v }))}
            allLabel="Toutes"
          />
          <select
            className="datatable-select"
            value={f.energie}
            onChange={(e) => setF((prev) => ({ ...prev, energie: e.target.value }))}
            title="Énergie"
          >
            <option value="">Toutes énergies</option>
            {filtres.energies.map((en) => (
              <option key={en.code} value={en.code}>
                {en.label}
              </option>
            ))}
          </select>
          <select
            className="datatable-select"
            value={f.statut}
            onChange={(e) => setF((prev) => ({ ...prev, statut: e.target.value }))}
            title="Statut"
          >
            <option value="">Tous statuts</option>
            {filtres.statuts.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className="datatable-select"
            value={f.docs}
            onChange={(e) => setF((prev) => ({ ...prev, docs: e.target.value }))}
            title="Documents manquants"
          >
            <option value="">Doc. manquants : tous</option>
            <option value="avec">Avec manquants</option>
            <option value="complet">Dossier complet</option>
          </select>
          <select
            className="datatable-select"
            value={f.expires}
            onChange={(e) => setF((prev) => ({ ...prev, expires: e.target.value }))}
            title="Documents expirés"
          >
            <option value="">Doc. expirés : tous</option>
            <option value="avec">Avec expirés</option>
            <option value="sans">Sans expirés</option>
          </select>
          <button
            type="button"
            className="btn btn-ghost lg-reset-btn"
            title="Réinitialiser les filtres"
            onClick={() => setF(defaultFilters())}
          >
            <RotateCcw size={15} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Marque</th>
                <th>Immatriculation</th>
                <th>Énergie</th>
                <th>Statut</th>
                <th>Financement</th>
                <th>Fin crédit</th>
                <th>Doc. manquants</th>
                <th>Doc. expirés</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={10} className="datatable-empty">
                    Aucun moyen logistique trouvé.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className={`badge badge-moyen-${r.type}`}>
                        {labelOf(filtres.types, r.type)}
                      </span>
                    </td>
                    <td>
                      <div className="cell-main">{r.marque}</div>
                      <div className="cell-sub">Châssis : {r.chassis}</div>
                    </td>
                    <td>
                      {r.immat ? (
                        <div className="cell-main">{r.immat}</div>
                      ) : r.immat_ww ? (
                        <>
                          <div className="cell-main">{r.immat_ww}</div>
                          <div className="cell-sub">Provisoire (WW)</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{r.energie ? labelOf(filtres.energies, r.energie) : '—'}</td>
                    <td>
                      <span className={`badge ${STATUT_BADGES[r.statut] || 'badge-neutral'}`}>
                        {labelOf(filtres.statuts, r.statut)}
                      </span>
                    </td>
                    {/* Méthode d'achat et fin de crédit : onglet Financement de la fiche. */}
                    <td>{r.financement ? labelOf(filtres.methodes, r.financement) : '—'}</td>
                    <td>{r.fin_credit || '—'}</td>
                    <td>
                      {r.docs_manquants > 0 ? (
                        <span className="badge badge-attente lg-docs-badge">
                          <TriangleAlert size={12} /> {r.docs_manquants} manquant
                          {r.docs_manquants > 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="badge badge-active">Complet</span>
                      )}
                    </td>
                    <td>
                      {r.docs_expires > 0 ? (
                        <span className="badge badge-refuse lg-docs-badge">
                          <TriangleAlert size={12} /> {r.docs_expires} expiré
                          {r.docs_expires > 1 ? 's' : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost lg-info-btn"
                        onClick={() => navigate(`/admin/logistiques/${r.id}`)}
                      >
                        <Info size={14} /> Plus d'info
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {modal && (
        <NouveauMoyenModal
          filtres={filtres}
          onClose={() => setModal(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
