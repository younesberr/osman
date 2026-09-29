import { useEffect, useMemo, useState } from 'react';
import { Map, Plus, Power, Save } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Configuration > Gestion zones — page en sections.
 * Section 1 : création d'une zone (delevery_zone), rattachée à une agence (delevery_agences).
 * Section 2 : liste des zones, filtrable par agence et par status.
 */

/** Options d'agence pour un select : agences actives + l'agence courante si désactivée. */
function agenceOptions(agences, currentId, currentNom) {
  const options = agences.filter((a) => a.active === 1);
  if (currentId && !options.some((a) => a.id === currentId)) {
    options.push({ id: currentId, nom: currentNom || `Agence #${currentId}` });
  }
  return options;
}

/** Ligne éditable du tableau des zones : nom + agence modifiables, activation. */
function ZoneRow({ zone, agences, onSaved, onToggled }) {
  const [nom, setNom] = useState(zone.nom || '');
  const [agenceId, setAgenceId] = useState(zone.agenceId || '');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const dirty = nom.trim() !== (zone.nom || '') || Number(agenceId) !== (zone.agenceId || 0);
  const actif = zone.active === 1;

  async function save() {
    if (!nom.trim()) {
      alert('Le nom de la zone est obligatoire.');
      return;
    }
    if (!agenceId) {
      alert('Veuillez sélectionner une agence.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.put(`/config/zones/${zone.id}`, { nom: nom.trim(), agenceId: Number(agenceId) });
      onSaved(zone.id, res.data);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    const verbe = actif ? 'désactiver' : 'activer';
    if (!window.confirm(`Voulez-vous vraiment ${verbe} la zone « ${zone.nom} » ?`)) return;
    setToggling(true);
    try {
      const res = await api.patch(`/config/zones/${zone.id}/active`, { active: actif ? 0 : 1 });
      onToggled(zone.id, res.data.active);
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
          className="statut-nom-input"
          value={nom}
          maxLength={100}
          onChange={(e) => setNom(e.target.value)}
        />
      </td>
      <td>
        <select value={agenceId} onChange={(e) => setAgenceId(Number(e.target.value))}>
          <option value="">— Agence —</option>
          {agenceOptions(agences, zone.agenceId, zone.agence).map((a) => (
            <option key={a.id} value={a.id}>
              {a.nom}
            </option>
          ))}
        </select>
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

/* ---------- Section 1 : Gestion Zones ---------- */

function GestionZonesSection() {
  const [zones, setZones] = useState([]);
  const [agences, setAgences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [nom, setNom] = useState('');
  const [agenceId, setAgenceId] = useState('');
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [filtreAgence, setFiltreAgence] = useState('');
  const [filtreActive, setFiltreActive] = useState('1');

  const zonesFiltrees = useMemo(
    () =>
      zones.filter(
        (z) =>
          (filtreAgence === '' || z.agenceId === Number(filtreAgence)) &&
          (filtreActive === '' || z.active === Number(filtreActive))
      ),
    [zones, filtreAgence, filtreActive]
  );

  const pager = usePagination(zonesFiltrees, 'zone');

  useEffect(() => {
    Promise.all([api.get('/config/zones'), api.get('/config/agences')])
      .then(([zonesRes, agencesRes]) => {
        setZones(zonesRes.data);
        setAgences(agencesRes.data);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des zones.'))
      .finally(() => setLoading(false));
  }, []);

  async function addZone(e) {
    e.preventDefault();
    setFeedback(null);
    if (!nom.trim()) {
      setFeedback({ type: 'error', text: 'Le nom de la zone est obligatoire.' });
      return;
    }
    if (!agenceId) {
      setFeedback({ type: 'error', text: 'Veuillez sélectionner une agence.' });
      return;
    }
    setAdding(true);
    try {
      const res = await api.post('/config/zones', { nom: nom.trim(), agenceId: Number(agenceId) });
      setZones((prev) =>
        [...prev, res.data].sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr', { sensitivity: 'base' }))
      );
      setNom('');
      setAgenceId('');
      setFeedback({ type: 'success', text: `Zone « ${res.data.nom} » ajoutée.` });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Échec de l'ajout de la zone." });
    } finally {
      setAdding(false);
    }
  }

  function handleSaved(id, data) {
    setZones((prev) =>
      prev.map((z) => (z.id === id ? { ...z, nom: data.nom, agenceId: data.agenceId, agence: data.agence } : z))
    );
  }

  function handleToggled(id, active) {
    setZones((prev) => prev.map((z) => (z.id === id ? { ...z, active } : z)));
  }

  return (
    <>
      <section className="platform-card">
        <h2>
          <Plus size={18} /> Ajouter une zone
        </h2>

        <form className="statut-form" onSubmit={addZone}>
          <label>
            <span className="field-label">Nom de zone</span>
            <input
              type="text"
              value={nom}
              maxLength={100}
              placeholder="ZONE CASABLANCA"
              onChange={(e) => setNom(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Agence</span>
            <select value={agenceId} onChange={(e) => setAgenceId(e.target.value)}>
              <option value="">— Sélectionner une agence —</option>
              {agences
                .filter((a) => a.active === 1)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nom}
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
      </section>

      <section className="platform-card">
        <h2>
          <Map size={18} /> Liste des zones
        </h2>

        <div className="datatable-toolbar">
          <select
            className="datatable-select"
            value={filtreAgence}
            onChange={(e) => {
              setFiltreAgence(e.target.value);
              pager.setPage(1);
            }}
          >
            <option value="">Toutes les agences</option>
            {agences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nom}
              </option>
            ))}
          </select>
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
                <th>Nom de la zone</th>
                <th>Agence</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {zonesFiltrees.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucune zone trouvée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((z) => (
                  <ZoneRow key={z.id} zone={z} agences={agences} onSaved={handleSaved} onToggled={handleToggled} />
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

/** Configuration > Gestion zones — page en sections. */
export default function Zones() {
  return (
    <div className="platform-page zones-page">
      <GestionZonesSection />
    </div>
  );
}
