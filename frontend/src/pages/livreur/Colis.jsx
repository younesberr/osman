import { useEffect, useMemo, useState } from 'react';
import { Lock, Package, Phone, PhoneCall, RefreshCw, Route, Search } from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import ColisCard, {
  formatDh,
  waUrl,
  waCallUrl,
  StatutColis,
  FlagsColis,
  statutVerrouille,
  VERROU_TITRE
} from '../../components/LivreurColisCard';
import { StatutModal, SuiviModal } from '../../components/ParcelModals';
import { statutLabel } from '../../utils/statuts';

/*
 * Liste des colis — dashboard livreur (/livreur/colis).
 * Colis en tournée (parcel_status DISTRIBUTION / IN_PROGRESS) du livreur
 * connecté, triés par ville puis zone (ordre de tournée). Tableau sur PC,
 * cartes tactiles sur mobile (bascule CSS à 900 px, classes .lvc-*) — la
 * carte et ses aides d'affichage (montant, badge statut, consignes, liens
 * WhatsApp) sont dans components/LivreurColisCard, partagées avec la page
 * « Changer statut par scan ».
 * Actions par colis : appeler, message WhatsApp prérempli (modèle configuré
 * dans Configuration > Options, balises remplacées par les données du colis),
 * appel WhatsApp (ouverture de la conversation), détail de suivi (historique
 * des statuts et modifications du colis) et changement de statut — modales
 * partagées avec l'admin, endpoints /livreurs/me/colis.
 */

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Ligne du tableau (PC) : mêmes actions que la carte, en icônes compactes. */
function ColisRow({ parcel, onSuivi, onStatut, waTemplate }) {
  const phone = parcel.parcel_phone || '';
  return (
    <tr>
      <td>
        <div className="cell-main mono">{parcel.parcel_code || '—'}</div>
        <div className="cell-sub">
          {parcel.magasin || '—'} <FlagsColis parcel={parcel} />
        </div>
      </td>
      <td>
        <div className="cell-main">{parcel.parcel_receiver || '—'}</div>
        {phone && (
          <a className="cell-sub lvc-tel" href={`tel:${phone}`}>
            {phone}
          </a>
        )}
      </td>
      <td>
        <div className="cell-main">{parcel.ville || '—'}</div>
        <div className="cell-sub">{parcel.zone || '—'}</div>
      </td>
      <td>
        <div className="cell-main">{parcel.adresse || '—'}</div>
        {parcel.parcel_note && <div className="cell-sub">{parcel.parcel_note}</div>}
      </td>
      <td>
        <span className="lvc-crbt">{formatDh(parcel.crbt)}</span>
      </td>
      <td>
        <StatutColis parcel={parcel} />
      </td>
      <td>
        <div className="row-actions">
          {phone && (
            <>
              <a className="row-action" href={`tel:${phone}`} title="Appeler">
                <Phone size={16} />
              </a>
              <a
                className="row-action row-action-wa btn-whatsapp"
                href={waUrl(parcel, waTemplate)}
                target="_blank"
                rel="noopener noreferrer"
                title="Message WhatsApp"
              >
                <i className="fab fa-whatsapp" />
              </a>
              <a
                className="row-action row-action-wa"
                href={waCallUrl(parcel)}
                target="_blank"
                rel="noopener noreferrer"
                title="Appel WhatsApp"
              >
                <PhoneCall size={16} />
              </a>
            </>
          )}
          <button type="button" className="row-action" onClick={() => onSuivi(parcel)} title="Détail suivi">
            <Route size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            onClick={() => onStatut(parcel)}
            disabled={statutVerrouille(parcel)}
            title={statutVerrouille(parcel) ? VERROU_TITRE : 'Changer statut'}
          >
            {statutVerrouille(parcel) ? <Lock size={16} /> : <RefreshCw size={16} />}
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Liste des colis en tournée du livreur connecté — tableau PC / cartes mobile. */
export default function ColisLivreur() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  const [ville, setVille] = useState('');
  const [statut, setStatut] = useState('');
  // Modale d'action de ligne : { type: 'suivi' | 'statut', parcel }.
  const [modal, setModal] = useState(null);
  const [waTemplate, setWaTemplate] = useState('');

  /* Modèle du message WhatsApp (Configuration > Options) ; défaut local sinon. */
  useEffect(() => {
    api
      .get('/livreurs/me/colis/message')
      .then((res) => setWaTemplate(res.data.template || ''))
      .catch(() => setWaTemplate(''));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/livreurs/me/colis')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des colis.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /* Options des filtres, déduites des colis chargés. */
  const villes = useMemo(() => {
    const uniques = [...new Set(rows.map((r) => r.ville).filter(Boolean))];
    return uniques.sort((a, b) => a.localeCompare(b, 'fr')).map((v) => ({ value: v, label: v }));
  }, [rows]);

  const statuts = useMemo(() => {
    const codes = [...new Set(rows.map((r) => r.statut).filter(Boolean))];
    return codes
      .map((c) => ({ value: c, label: statutLabel(c) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = normalize(search.trim());
    return rows.filter((r) => {
      if (ville && r.ville !== ville) return false;
      if (statut && r.statut !== statut) return false;
      if (!q) return true;
      return [r.parcel_code, r.parcel_receiver, r.parcel_phone, r.adresse, r.ville, r.magasin].some(
        (v) => normalize(v).includes(q)
      );
    });
  }, [rows, search, ville, statut]);

  const pager = usePagination(filtered, 'colis', 'colis');

  /* Chaque changement de filtre ramène à la première page. */
  const onSearch = (value) => {
    setSearch(value);
    pager.setPage(1);
  };
  const onVille = (value) => {
    setVille(value);
    pager.setPage(1);
  };
  const onStatutFiltre = (value) => {
    setStatut(value);
    pager.setPage(1);
  };

  /** Livré → le colis sort de la tournée ; autre statut → ligne mise à jour. */
  const onStatutChange = (id, patch) =>
    setRows((prev) =>
      patch.parcel_status === 'DELIVERED'
        ? prev.filter((r) => r.parcel_id !== id)
        : prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r))
    );

  const openSuivi = (parcel) => setModal({ type: 'suivi', parcel });
  const openStatut = (parcel) => setModal({ type: 'statut', parcel });

  const vide = rows.length === 0 ? 'Aucun colis à livrer.' : 'Aucun colis ne correspond aux filtres.';

  return (
    <div className="platform-page lvc-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Package size={18} /> Liste des colis
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            title="Actualiser la liste"
          >
            <RefreshCw size={15} /> Actualiser
          </button>
        </div>

        <div className="filters-bar">
          <SearchSelect label="Ville" options={villes} value={ville} onChange={onVille} allLabel="Toutes les villes" />
          <SearchSelect
            label="Statut"
            options={statuts}
            value={statut}
            onChange={onStatutFiltre}
            allLabel="Tous les statuts"
          />
        </div>

        <div className="datatable-topbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, destinataire, téléphone, adresse…"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable lvc-table ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Destinataire</th>
                <th>Ville</th>
                <th>Adresse</th>
                <th>CRBT</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    {vide}
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((p) => (
                  <ColisRow
                    key={p.parcel_id}
                    parcel={p}
                    onSuivi={openSuivi}
                    onStatut={openStatut}
                    waTemplate={waTemplate}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className={`lvc-cards ${loading ? 'is-loading' : ''}`}>
          {filtered.length === 0 ? (
            <p className="lvc-cards-vide">{loading ? 'Chargement…' : vide}</p>
          ) : (
            pager.pageRows.map((p) => (
              <ColisCard
                key={p.parcel_id}
                parcel={p}
                onSuivi={openSuivi}
                onStatut={openStatut}
                waTemplate={waTemplate}
              />
            ))
          )}
        </div>

        <Pager pager={pager} />
      </section>

      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} basePath="/livreurs/me/colis" onClose={() => setModal(null)} />
      )}
      {modal?.type === 'statut' && (
        <StatutModal
          parcel={modal.parcel}
          basePath="/livreurs/me/colis"
          onClose={() => setModal(null)}
          onSaved={onStatutChange}
        />
      )}
    </div>
  );
}
