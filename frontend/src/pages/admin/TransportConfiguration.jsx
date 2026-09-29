import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Coins,
  Pencil,
  Plus,
  Power,
  Route,
  Settings2,
  Trash2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchableSelect from '../../components/SearchableSelect';
import MultiSearchSelect from '../../components/MultiSearchSelect';

/*
 * Transport > Configuration — référentiel du module (portage de
 * transport_configuration.php, types 1/2) : sociétés partenaires (jamais
 * supprimées, seulement désactivées), tarif standard global et grille de
 * tarifs personnalisés société × ville de destination. Le code société
 * (2-3 lettres, préfixe/suffixe des tickets) est unique — correction du
 * legacy qui acceptait les doublons.
 *
 * Section « Trajets » (bons de transport) : un trajet = un nom + des zones
 * (une zone n'appartient qu'à un seul trajet). Les envois / retours dont la
 * ville de destination est dans une zone du trajet rejoignent le bon de
 * transport du jour de ce trajet. Un trajet ayant des bons ne se supprime
 * pas (historique) : on modifie ses zones.
 */

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/** Ville en "REF - Nom" comme le legacy. */
function villeLabel(ref, nom) {
  if (!ref && !nom) return '—';
  return [ref, nom].filter(Boolean).join(' - ');
}

/** Modale « Ajouter / Modifier société ». */
function SocieteModal({ societe, villes, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    nom: societe?.nom || '',
    code: societe?.code || '',
    ville: societe ? String(societe.ville_id || '') : '',
    telephone: societe?.telephone || '',
    ice: societe?.ice || '',
    adresse: societe?.adresse || '',
    tarif_personnalise: Number(societe?.tarif_personnalise) === 1,
    statut: societe ? Number(societe.statut) : 1
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.ville) {
      setError('Veuillez sélectionner la ville de la société.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        nom: form.nom,
        code: form.code,
        ville: Number(form.ville),
        telephone: form.telephone,
        ice: form.ice,
        adresse: form.adresse,
        tarif_personnalise: form.tarif_personnalise,
        statut: form.statut
      };
      if (societe) await api.patch(`/transport/configuration/societes/${societe.id}`, body);
      else await api.post('/transport/configuration/societes', body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de la société.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Building2 size={18} />
            <div className="cell-main">{societe ? 'Modifier la société' : 'Ajouter une société'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label>
              <span className="field-label">Nom de la société</span>
              <input type="text" value={form.nom} onChange={setField('nom')} maxLength={255} required />
            </label>
            <label>
              <span className="field-label">Code (2-3 lettres)</span>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                pattern="[A-Za-z]{2,3}"
                maxLength={3}
                placeholder="Ex. LIV"
                title="2 à 3 lettres — préfixe/suffixe des codes tickets"
                required
              />
            </label>
            <div className="modal-form-full">
              <span className="field-label">Ville</span>
              <SearchableSelect
                value={form.ville}
                onChange={(v) => setForm((f) => ({ ...f, ville: String(v) }))}
                placeholder="— Sélectionner une ville —"
                options={villes.map((v) => ({ value: v.id, label: villeLabel(v.ref, v.nom) }))}
              />
            </div>
            <label>
              <span className="field-label">Téléphone</span>
              <input type="text" value={form.telephone} onChange={setField('telephone')} maxLength={50} />
            </label>
            <label>
              <span className="field-label">ICE</span>
              <input type="text" value={form.ice} onChange={setField('ice')} maxLength={50} />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Adresse</span>
              <input type="text" value={form.adresse} onChange={setField('adresse')} maxLength={1000} />
            </label>
            <label>
              <span className="field-label">Tarif personnalisé</span>
              <select
                value={form.tarif_personnalise ? '1' : '0'}
                onChange={(e) => setForm((f) => ({ ...f, tarif_personnalise: e.target.value === '1' }))}
              >
                <option value="0">Non — tarif standard</option>
                <option value="1">Oui — grille par ville</option>
              </select>
            </label>
            {societe && (
              <label>
                <span className="field-label">Statut</span>
                <select
                  value={String(form.statut)}
                  onChange={(e) => setForm((f) => ({ ...f, statut: Number(e.target.value) }))}
                >
                  <option value="1">Active</option>
                  <option value="0">Désactivée</option>
                </select>
              </label>
            )}
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

/** Modale « Ajouter / Modifier un tarif » de la grille d'une société. */
function TarifModal({ tarif, societe, villes, grille, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    ville: tarif ? String(tarif.ville_id) : '',
    tarif: tarif ? String(tarif.tarif) : ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Villes non encore tarifées pour cette société (le couple est unique).
  const villesDispo = useMemo(() => {
    if (tarif) return villes.filter((v) => v.id === tarif.ville_id);
    const prises = new Set(grille.map((g) => g.ville_id));
    return villes.filter((v) => !prises.has(v.id));
  }, [tarif, villes, grille]);

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.ville) {
      setError('Veuillez sélectionner la ville de destination.');
      return;
    }
    setSaving(true);
    try {
      if (tarif) {
        await api.patch(`/transport/configuration/tarifs/${tarif.id}`, { tarif: form.tarif });
      } else {
        await api.post('/transport/configuration/tarifs', {
          societe: societe.id,
          ville: Number(form.ville),
          tarif: form.tarif
        });
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du tarif.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Coins size={18} />
            <div className="cell-main">
              {tarif ? 'Modifier le tarif' : 'Ajouter un tarif'} — {societe.nom}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div className="modal-form-full">
              <span className="field-label">Ville de destination</span>
              {tarif ? (
                <input type="text" value={villeLabel(tarif.ville_ref, tarif.ville)} disabled />
              ) : (
                <SearchableSelect
                  value={form.ville}
                  onChange={(v) => setForm((f) => ({ ...f, ville: String(v) }))}
                  placeholder="— Sélectionner une ville —"
                  options={villesDispo.map((v) => ({ value: v.id, label: villeLabel(v.ref, v.nom) }))}
                />
              )}
            </div>
            <label className="modal-form-full">
              <span className="field-label">Tarif (DH)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.tarif}
                onChange={(e) => setForm((f) => ({ ...f, tarif: e.target.value }))}
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
              <Plus size={15} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Modale « Ajouter / Modifier un trajet » : nom + zones (multi-sélection). */
function TrajetModal({ trajet, zones, onClose, onSaved }) {
  const [nom, setNom] = useState(trajet?.nom || '');
  const [zoneIds, setZoneIds] = useState(() => (trajet ? trajet.zones.map((z) => z.id) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Zones libres, ou déjà rattachées à CE trajet (une zone = un seul trajet).
  const options = useMemo(
    () =>
      zones
        .filter((z) => !z.trajet_id || (trajet && z.trajet_id === trajet.id))
        .map((z) => ({ value: z.id, label: z.agence ? `${z.nom} — ${z.agence}` : z.nom })),
    [zones, trajet]
  );
  const zonesPrises = zones.filter((z) => z.trajet_id && !(trajet && z.trajet_id === trajet.id));

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!zoneIds.length) {
      setError('Veuillez sélectionner au moins une zone.');
      return;
    }
    setSaving(true);
    try {
      const body = { nom, zones: zoneIds.map(Number) };
      if (trajet) await api.patch(`/transport/configuration/trajets/${trajet.id}`, body);
      else await api.post('/transport/configuration/trajets', body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement du trajet.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Route size={18} />
            <div className="cell-main">{trajet ? 'Modifier le trajet' : 'Ajouter un trajet'}</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Nom du trajet</span>
              <input
                type="text"
                value={nom}
                onChange={(e) => setNom(e.target.value)}
                maxLength={100}
                placeholder="Ex. Casablanca → Marrakech"
                required
              />
            </label>
            <div className="modal-form-full">
              <span className="field-label">Zones du trajet</span>
              <MultiSearchSelect
                value={zoneIds}
                onChange={setZoneIds}
                placeholder="— Sélectionner une ou plusieurs zones —"
                options={options}
              />
              <p className="upload-hint">
                Les colis dont la ville de destination appartient à l'une de ces zones rejoignent le
                bon du jour de ce trajet.
                {zonesPrises.length > 0 &&
                  ` Zones déjà rattachées à un autre trajet (non proposées) : ${zonesPrises
                    .map((z) => `${z.nom} (${z.trajet})`)
                    .join(', ')}.`}
              </p>
            </div>
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

/** Transport > Configuration — sociétés, tarif standard, grille et trajets. */
export default function TransportConfiguration() {
  const [societes, setSocietes] = useState([]);
  const [villes, setVilles] = useState([]);
  const [tarifStandard, setTarifStandard] = useState('');
  const [tarifStandardSaved, setTarifStandardSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(null); // null | 'new' | société (édition)

  // Trajets des bons de transport.
  const [trajets, setTrajets] = useState([]);
  const [zones, setZones] = useState([]);
  const [trajetsDisponibles, setTrajetsDisponibles] = useState(true);
  const [trajetModal, setTrajetModal] = useState(null); // null | 'new' | trajet (édition)

  // Grille de tarifs personnalisés.
  const [grilleSociete, setGrilleSociete] = useState('');
  const [grille, setGrille] = useState([]);
  const [grilleLoading, setGrilleLoading] = useState(false);
  const [tarifModal, setTarifModal] = useState(null); // null | 'new' | tarif (édition)

  const pager = usePagination(societes, 'société');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/transport/configuration')
      .then((res) => {
        if (cancelled) return;
        setSocietes(res.data.societes);
        setVilles(res.data.villes);
        setTarifStandard(String(res.data.tarif_standard));
        setTarifStandardSaved(String(res.data.tarif_standard));
        setTrajets(res.data.trajets || []);
        setZones(res.data.zones || []);
        setTrajetsDisponibles(res.data.trajets_disponibles !== false);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement de la configuration.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Sociétés actives en tarif personnalisé (grille).
  const societesGrille = useMemo(
    () => societes.filter((s) => s.statut === 1 && s.tarif_personnalise === 1),
    [societes]
  );
  const societeGrille = societesGrille.find((s) => String(s.id) === String(grilleSociete)) || null;

  useEffect(() => {
    if (!grilleSociete) {
      setGrille([]);
      return undefined;
    }
    let cancelled = false;
    setGrilleLoading(true);
    api
      .get('/transport/configuration/tarifs', { params: { societe: grilleSociete } })
      .then((res) => {
        if (!cancelled) setGrille(res.data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setGrilleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [grilleSociete, reloadKey]);

  async function saveTarifStandard(e) {
    e.preventDefault();
    try {
      await api.patch('/transport/configuration/tarif-standard', { tarif: tarifStandard });
      setTarifStandardSaved(tarifStandard);
    } catch (err) {
      alert(err.response?.data?.message || "Erreur lors de l'enregistrement du tarif standard.");
    }
  }

  async function toggleSociete(societe) {
    const question =
      societe.statut === 1
        ? `Désactiver ${societe.nom} ? Ses tickets ne seront plus scannables.`
        : `Réactiver ${societe.nom} ?`;
    if (!window.confirm(question)) return;
    try {
      await api.patch(`/transport/configuration/societes/${societe.id}/statut`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors du changement de statut.');
    }
  }

  async function removeTarif(tarif) {
    if (!window.confirm(`Supprimer le tarif vers ${villeLabel(tarif.ville_ref, tarif.ville)} ?`)) return;
    try {
      await api.delete(`/transport/configuration/tarifs/${tarif.id}`);
      setGrille((prev) => prev.filter((t) => t.id !== tarif.id));
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  async function removeTrajet(trajet) {
    if (!window.confirm(`Supprimer le trajet « ${trajet.nom} » ? Ses zones redeviendront libres.`)) return;
    try {
      await api.delete(`/transport/configuration/trajets/${trajet.id}`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression du trajet.');
    }
  }

  function handleSaved() {
    setModal(null);
    setTarifModal(null);
    setTrajetModal(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Building2 size={18} /> Sociétés de transport
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Plus size={15} /> Ajouter une société
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Société</th>
                <th>Code</th>
                <th>Ville</th>
                <th>Téléphone</th>
                <th>ICE</th>
                <th>Tarif</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {societes.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucune société enregistrée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((societe) => (
                  <tr key={societe.id}>
                    <td>
                      <div className="cell-main">{societe.nom}</div>
                      <div className="cell-sub">{societe.adresse || ''}</div>
                    </td>
                    <td>
                      <span className="cell-main transport-code">{societe.code || '—'}</span>
                    </td>
                    <td>{villeLabel(societe.ville_ref, societe.ville)}</td>
                    <td>{societe.telephone || '—'}</td>
                    <td>{societe.ice || '—'}</td>
                    <td>
                      <span className={`badge ${societe.tarif_personnalise === 1 ? 'badge-mvnt-colis' : 'badge-neutral'}`}>
                        {societe.tarif_personnalise === 1 ? 'Personnalisé' : 'Standard'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${societe.statut === 1 ? 'badge-active' : 'badge-refuse'}`}>
                        {societe.statut === 1 ? 'Active' : 'Désactivée'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Modifier la société"
                          onClick={() => setModal(societe)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className={`row-action ${societe.statut === 1 ? 'row-action-danger' : 'row-action-success'}`}
                          title={societe.statut === 1 ? 'Désactiver' : 'Réactiver'}
                          onClick={() => toggleSociete(societe)}
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
        <Pager pager={pager} />
      </section>

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Settings2 size={18} /> Tarification
          </h2>
        </div>

        <form className="transport-tarif-standard" onSubmit={saveTarifStandard}>
          <label>
            <span className="field-label">Tarif standard (DH) — sociétés sans grille personnalisée</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={tarifStandard}
              onChange={(e) => setTarifStandard(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={tarifStandard === tarifStandardSaved}>
            Enregistrer
          </button>
        </form>

        <div className="filters-bar">
          <div style={{ minWidth: 260 }}>
            <SearchableSelect
              value={grilleSociete}
              onChange={(v) => setGrilleSociete(String(v))}
              placeholder="— Grille d'une société (tarif personnalisé) —"
              options={societesGrille.map((s) => ({ value: s.id, label: `${s.nom} [${s.code}]` }))}
            />
          </div>
          {societeGrille && (
            <button type="button" className="btn btn-primary" onClick={() => setTarifModal('new')}>
              <Plus size={15} /> Ajouter un tarif
            </button>
          )}
        </div>

        {!societeGrille ? (
          <p className="cell-sub">
            Sélectionnez une société en tarif personnalisé pour gérer sa grille par ville de
            destination. Les sociétés en tarif standard utilisent le tarif global ci-dessus
            ({formatMontant(tarifStandardSaved)}).
          </p>
        ) : (
          <div className={`table-wrap datatable ${grilleLoading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Ville de destination</th>
                  <th>Tarif</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {grille.length === 0 && !grilleLoading ? (
                  <tr>
                    <td colSpan={3} className="datatable-empty">
                      Aucun tarif : le tarif standard ({formatMontant(tarifStandardSaved)}) s'applique.
                    </td>
                  </tr>
                ) : (
                  grille.map((tarif) => (
                    <tr key={tarif.id}>
                      <td>{villeLabel(tarif.ville_ref, tarif.ville)}</td>
                      <td>{formatMontant(tarif.tarif)}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="Modifier le tarif"
                            onClick={() => setTarifModal(tarif)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer le tarif"
                            onClick={() => removeTarif(tarif)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Route size={18} /> Trajets
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setTrajetModal('new')}
            disabled={!trajetsDisponibles}
          >
            <Plus size={15} /> Ajouter un trajet
          </button>
        </div>
        <p className="upload-hint">
          Un trajet regroupe des zones : chaque envoi ou retour scanné dont la ville de destination
          appartient à une zone du trajet rejoint automatiquement le bon de transport du jour de ce
          trajet (journée de 06:00 à 06:00). Une zone n'appartient qu'à un seul trajet.
        </p>

        {!trajetsDisponibles && (
          <div className="form-error">
            Section indisponible : exécuter la migration sql/2026-09-18_transport-bons.sql.
          </div>
        )}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Nom du trajet</th>
                <th>Zones</th>
                <th>Bons</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trajets.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="datatable-empty">
                    Aucun trajet : les colis scannés restent sans bon de transport.
                  </td>
                </tr>
              ) : (
                trajets.map((trajet) => (
                  <tr key={trajet.id}>
                    <td>
                      <div className="cell-main">{trajet.nom}</div>
                    </td>
                    <td>
                      <div className="ms-tags">
                        {trajet.zones.map((z) => (
                          <span key={z.id} className="badge badge-neutral">
                            {z.nom}
                          </span>
                        ))}
                        {trajet.zones.length === 0 && <span className="cell-sub">—</span>}
                      </div>
                    </td>
                    <td>{trajet.nb_bons}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Modifier le trajet"
                          onClick={() => setTrajetModal(trajet)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          title={
                            trajet.nb_bons > 0
                              ? 'Trajet avec des bons : suppression impossible, modifiez ses zones'
                              : 'Supprimer le trajet'
                          }
                          onClick={() => removeTrajet(trajet)}
                          disabled={trajet.nb_bons > 0}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {modal && (
        <SocieteModal
          societe={modal === 'new' ? null : modal}
          villes={villes}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
      {trajetModal && (
        <TrajetModal
          trajet={trajetModal === 'new' ? null : trajetModal}
          zones={zones}
          onClose={() => setTrajetModal(null)}
          onSaved={handleSaved}
        />
      )}
      {tarifModal && societeGrille && (
        <TarifModal
          tarif={tarifModal === 'new' ? null : tarifModal}
          societe={societeGrille}
          villes={villes}
          grille={grille}
          onClose={() => setTarifModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
