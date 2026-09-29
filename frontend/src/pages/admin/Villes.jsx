import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, MapPin, Plus, Power, Save } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';
import SearchSelect from '../../components/SearchSelect';

/*
 * Configuration > Gestion villes — page en sections.
 * Section 1 : création d'une ville (delevery_tarifs), rattachée à une zone (delevery_zone_cities).
 * Section 2 : liste des villes, filtrable par agence (via les zones), zone et status,
 * triable sur les colonnes de frais.
 */

/** Options de zone pour un select : zones actives + la zone courante si désactivée. */
function zoneOptions(zones, currentId, currentNom) {
  const options = zones.filter((z) => z.active === 1);
  if (currentId && !options.some((z) => z.id === currentId)) {
    options.push({ id: currentId, nom: currentNom || `Zone #${currentId}` });
  }
  return options;
}

/** Ligne éditable du tableau des villes : ref, nom, zone et frais modifiables, activation. */
function VilleRow({ ville, zones, onSaved, onToggled }) {
  const [ref, setRef] = useState(ville.ref || '');
  const [nom, setNom] = useState(ville.nom || '');
  const [zoneId, setZoneId] = useState(ville.zoneId || '');
  const [fraisLivraison, setFraisLivraison] = useState(ville.fraisLivraison ?? '');
  const [fraisRetour, setFraisRetour] = useState(ville.fraisRetour ?? '');
  const [fraisRefuse, setFraisRefuse] = useState(ville.fraisRefuse ?? '');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const dirty =
    ref.trim().toUpperCase() !== (ville.ref || '') ||
    nom.trim() !== (ville.nom || '') ||
    Number(zoneId) !== (ville.zoneId || 0) ||
    Number(fraisLivraison) !== Number(ville.fraisLivraison) ||
    Number(fraisRetour) !== Number(ville.fraisRetour) ||
    Number(fraisRefuse) !== Number(ville.fraisRefuse);
  const actif = ville.active === 1;

  async function save() {
    if (!ref.trim()) {
      alert('La référence de la ville est obligatoire.');
      return;
    }
    if (!nom.trim()) {
      alert('Le nom de la ville est obligatoire.');
      return;
    }
    if (!zoneId) {
      alert('Veuillez sélectionner une zone.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/villes/${ville.id}`, {
        ref: ref.trim().toUpperCase(),
        nom: nom.trim(),
        zoneId: Number(zoneId),
        fraisLivraison: Number(fraisLivraison || 0),
        fraisRetour: Number(fraisRetour || 0),
        fraisRefuse: Number(fraisRefuse || 0)
      });
      onSaved(ville.id, res.data);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} la ville « ${ville.nom} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/villes/${ville.id}/active`, { active: actif ? 0 : 1 });
      onToggled(ville.id, res.data.active);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la mise à jour.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className={actif ? '' : 'row-inactive'}>
      <td>
        <input
          type="text"
          className="statut-nom-input ville-ref-input"
          value={ref}
          maxLength={50}
          onChange={(e) => setRef(e.target.value.toUpperCase())}
        />
      </td>
      <td>
        <input
          type="text"
          className="statut-nom-input"
          value={nom}
          maxLength={255}
          onChange={(e) => setNom(e.target.value)}
        />
      </td>
      <td>
        <SearchableSelect
          portal
          className="ss-cell"
          value={zoneId}
          onChange={(v) => setZoneId(Number(v))}
          placeholder="— Zone —"
          options={zoneOptions(zones, ville.zoneId, ville.zone).map((z) => ({ value: z.id, label: z.nom }))}
        />
      </td>
      <td>
        <input
          type="number"
          className="statut-nom-input frais-input"
          min="0"
          step="0.01"
          value={fraisLivraison}
          onChange={(e) => setFraisLivraison(e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          className="statut-nom-input frais-input"
          min="0"
          step="0.01"
          value={fraisRetour}
          onChange={(e) => setFraisRetour(e.target.value)}
        />
      </td>
      <td>
        <input
          type="number"
          className="statut-nom-input frais-input"
          min="0"
          step="0.01"
          value={fraisRefuse}
          onChange={(e) => setFraisRefuse(e.target.value)}
        />
      </td>
      <td>
        <span className={`badge ${actif ? 'badge-active' : 'badge-inactive'}`}>
          {actif ? 'Activé' : 'Désactivé'}
        </span>
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

/* ---------- Section 1 : Gestion Villes ---------- */

function GestionVillesSection() {
  const [villes, setVilles] = useState([]);
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [ref, setRef] = useState('');
  const [nom, setNom] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [fraisLivraison, setFraisLivraison] = useState('');
  const [fraisRetour, setFraisRetour] = useState('');
  const [fraisRefuse, setFraisRefuse] = useState('');
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [filtreAgence, setFiltreAgence] = useState('');
  const [filtreZone, setFiltreZone] = useState('');
  const [filtreActive, setFiltreActive] = useState('1');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState('desc');

  /** Agences dérivées des zones (une agence apparaît si elle possède au moins une zone). */
  const agencesFiltre = useMemo(() => {
    const vues = new Map();
    zones.forEach((z) => {
      if (z.agenceId && !vues.has(z.agenceId)) vues.set(z.agenceId, z.agence || `Agence #${z.agenceId}`);
    });
    return [...vues.entries()]
      .map(([id, nom]) => ({ id, nom }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }));
  }, [zones]);

  /** Zones proposées dans le filtre : restreintes à l'agence sélectionnée. */
  const zonesFiltre = useMemo(
    () => (filtreAgence === '' ? zones : zones.filter((z) => z.agenceId === Number(filtreAgence))),
    [zones, filtreAgence]
  );

  const villesFiltrees = useMemo(() => {
    const zoneAgence = new Map(zones.map((z) => [z.id, z.agenceId]));
    const filtrees = villes.filter(
      (v) =>
        (filtreAgence === '' || zoneAgence.get(v.zoneId) === Number(filtreAgence)) &&
        (filtreZone === '' || v.zoneId === Number(filtreZone)) &&
        (filtreActive === '' || v.active === Number(filtreActive))
    );
    if (!sortBy) return filtrees;
    const sens = sortDir === 'desc' ? -1 : 1;
    return [...filtrees].sort((a, b) => sens * (Number(a[sortBy] || 0) - Number(b[sortBy] || 0)));
  }, [villes, zones, filtreAgence, filtreZone, filtreActive, sortBy, sortDir]);

  const pager = usePagination(villesFiltrees, 'ville');

  /** Tri client : 1er clic = décroissant, 2e clic = croissant. */
  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  }

  function SortableTh({ sortKey, children }) {
    const isActive = sortBy === sortKey;
    return (
      <th
        className={`th-sortable ${isActive ? 'th-sorted' : ''}`}
        onClick={() => toggleSort(sortKey)}
        title="Trier"
      >
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

  useEffect(() => {
    Promise.all([api.get('/config/villes'), api.get('/config/zones')])
      .then(([villesRes, zonesRes]) => {
        setVilles(villesRes.data);
        setZones(zonesRes.data);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des villes.'))
      .finally(() => setLoading(false));
  }, []);

  async function addVille(e) {
    e.preventDefault();
    setFeedback(null);
    if (!ref.trim()) {
      setFeedback({ type: 'error', text: 'La référence de la ville est obligatoire.' });
      return;
    }
    if (!nom.trim()) {
      setFeedback({ type: 'error', text: 'Le nom de la ville est obligatoire.' });
      return;
    }
    if (!zoneId) {
      setFeedback({ type: 'error', text: 'Veuillez sélectionner une zone.' });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post('/config/villes', {
        ref: ref.trim().toUpperCase(),
        nom: nom.trim(),
        zoneId: Number(zoneId),
        fraisLivraison: Number(fraisLivraison || 0),
        fraisRetour: Number(fraisRetour || 0),
        fraisRefuse: Number(fraisRefuse || 0)
      });
      setVilles((prev) =>
        [...prev, res.data].sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr', { sensitivity: 'base' }))
      );
      setRef('');
      setNom('');
      setZoneId('');
      setFraisLivraison('');
      setFraisRetour('');
      setFraisRefuse('');
      setFeedback({ type: 'success', text: `Ville « ${res.data.nom} » ajoutée.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout de la ville." });
    } finally {
      setAdding(false);
    }
  }

  function handleSaved(id, data) {
    setVilles((prev) => prev.map((v) => (v.id === id ? { ...v, ...data } : v)));
  }

  function handleToggled(id, active) {
    setVilles((prev) => prev.map((v) => (v.id === id ? { ...v, active } : v)));
  }

  return (
    <>
      <section className="platform-card">
        <h2>
          <Plus size={18} /> Ajouter une ville
        </h2>

        <form className="statut-form" onSubmit={addVille}>
          <label>
            <span className="field-label">Ref ville</span>
            <input
              type="text"
              className="ville-ref-input"
              value={ref}
              maxLength={50}
              placeholder="CSA"
              onChange={(e) => setRef(e.target.value.toUpperCase())}
            />
          </label>
          <label>
            <span className="field-label">Nom ville</span>
            <input
              type="text"
              value={nom}
              maxLength={255}
              placeholder="Casablanca"
              onChange={(e) => setNom(e.target.value)}
            />
          </label>
          <div className="statut-zone-field">
            <span className="field-label">Zone</span>
            <SearchableSelect
              value={zoneId}
              onChange={(v) => setZoneId(String(v))}
              placeholder="— Sélectionner une zone —"
              options={zones.filter((z) => z.active === 1).map((z) => ({ value: z.id, label: z.nom }))}
            />
          </div>
          <label>
            <span className="field-label">Frais de livraison</span>
            <input
              type="number"
              className="frais-input"
              min="0"
              step="0.01"
              value={fraisLivraison}
              placeholder="0.00"
              onChange={(e) => setFraisLivraison(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Frais de retour</span>
            <input
              type="number"
              className="frais-input"
              min="0"
              step="0.01"
              value={fraisRetour}
              placeholder="0.00"
              onChange={(e) => setFraisRetour(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Frais de refusé</span>
            <input
              type="number"
              className="frais-input"
              min="0"
              step="0.01"
              value={fraisRefuse}
              placeholder="0.00"
              onChange={(e) => setFraisRefuse(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding}>
            <Plus size={15} /> {adding ? 'Ajout…' : 'Ajouter'}
          </button>
        </form>
        {feedback && (
          <div className={`field-${feedback.type === 'error' ? 'error' : 'success'}`}>{feedback.text}</div>
        )}
      </section>

      <section className="platform-card">
        <h2>
          <MapPin size={18} /> Liste des villes
        </h2>

        <div className="datatable-toolbar">
          <select
            className="datatable-select"
            value={filtreAgence}
            onChange={(e) => {
              setFiltreAgence(e.target.value);
              setFiltreZone('');
              pager.setPage(1);
            }}
          >
            <option value="">Toutes les agences</option>
            {agencesFiltre.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nom}
              </option>
            ))}
          </select>
          <SearchSelect
            label="Zone"
            allLabel="Toutes"
            options={zonesFiltre.map((z) => ({ value: z.id, label: z.nom }))}
            value={filtreZone}
            onChange={(v) => {
              setFiltreZone(v);
              pager.setPage(1);
            }}
          />
          <select
            className="datatable-select"
            value={filtreActive}
            onChange={(e) => {
              setFiltreActive(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Tous les statuts</option>
            <option value="1">Actives</option>
            <option value="0">Désactivées</option>
          </select>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Ref ville</th>
                <th>Nom de la ville</th>
                <th>Zone</th>
                <SortableTh sortKey="fraisLivraison">Frais de livraison</SortableTh>
                <SortableTh sortKey="fraisRetour">Frais de retour</SortableTh>
                <SortableTh sortKey="fraisRefuse">Frais de refusé</SortableTh>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {villesFiltrees.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucune ville trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((v) => (
                  <VilleRow key={v.id} ville={v} zones={zones} onSaved={handleSaved} onToggled={handleToggled} />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>
    </>
  );
}

/** Configuration > Gestion villes — page en sections. */
export default function Villes() {
  return (
    <div className="platform-page villes-page">
      <GestionVillesSection />
    </div>
  );
}
