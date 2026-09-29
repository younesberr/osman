import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, MapPin, MapPinned, MapPinOff, Pencil, Route, Search } from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import {
  ParcelModal,
  SuiviModal,
  InfoModal,
  EditModal,
  editVisible
} from '../../components/ClientParcelModals';

/*
 * Sans adresse (/client/sans-adresse, entrée de menu sous Liste des colis,
 * tâche membre COLIS_CONSULTATION) : pendant client de la page admin Sans
 * adresse, sans scan — liste des colis DU CLIENT scannés en agence faute
 * d'adresse exploitable, en statut second « Attente confirmation »
 * (WAITING_CONFIRMATION, utils/sansAdresse ; GET /parcels/client/sans-adresse,
 * du plus récent scan au plus ancien, sans pagination, recherche côté
 * frontend). Note en tête : le client est invité à fournir l'adresse exacte
 * du destinataire pour affecter le colis au livreur de son secteur.
 * Colonnes empilées : date du scan sous le code, téléphone (lien tel:) sous
 * le destinataire, adresse sous la ville ; actions Autres adresses (colis
 * antérieurs du même destinataire retrouvés par téléphone, limités aux colis
 * de ce client — GET /parcels/client/sans-adresse/destinataire, modale
 * AutresAdressesModal ci-dessous) / Détail de suivi / Information colis /
 * Modifier colis (même modale et mêmes conditions que la page Liste des
 * colis : colis déjà pris en charge → demande à valider par l'administration ;
 * tâche COLIS_MODIFICATION contrôlée par le serveur). Le colis sort de la
 * liste quand l'administration change son statut.
 */

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Lien tel: du destinataire (chiffres et « + » seulement), null sans numéro. */
function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : null;
}

/**
 * Modale « Autres adresses » : colis antérieurs du même destinataire parmi
 * les envois du client (recherche par téléphone, colis courant exclu), du
 * plus récent au plus ancien : code (date de création dessous), ville,
 * adresse, statut et, pour un colis livré, la date de livraison sous le
 * statut. Aide le client à retrouver une adresse exploitable avant de la
 * renseigner via « Modifier colis ».
 */
function AutresAdressesModal({ parcel, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/parcels/client/sans-adresse/destinataire', {
        params: { phone: parcel.parcel_phone, exclude: parcel.parcel_id }
      })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement.'));
  }, [parcel.parcel_id, parcel.parcel_phone]);

  return (
    <ParcelModal
      code={parcel.parcel_code}
      subtitle={`Autres adresses — ${parcel.parcel_receiver || 'Destinataire'} · ${parcel.parcel_phone}`}
      onClose={onClose}
      wide
    >
      {error && <div className="form-error">{error}</div>}
      {!data && !error && <div className="modal-loading">Chargement…</div>}
      {data && (
        <>
          <div className="sa-autres-meta">
            <b>{data.total.toLocaleString('fr-FR')}</b> autre(s) colis de votre compte pour le{' '}
            <span className="mono" dir="ltr">
              {data.phone}
            </span>
            {data.total > data.rows.length && (
              <> — les {data.rows.length} plus récents sont affichés</>
            )}
          </div>
          {data.rows.length === 0 ? (
            <div className="modal-loading">
              Aucun autre colis de votre compte pour ce numéro de téléphone.
            </div>
          ) : (
            <div className="table-wrap sa-autres-table">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Code colis</th>
                    <th>Ville</th>
                    <th>Adresse</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.parcel_id}>
                      <td className="cell-sub">{i + 1}</td>
                      <td>
                        <span className="cell-main mono">{r.parcel_code || '—'}</span>
                        <div className="cell-sub">{formatDate(r.parcel_time)}</div>
                      </td>
                      <td>
                        <span className="rs-ville">
                          <MapPin size={13} /> {r.ville || '—'}
                        </span>
                      </td>
                      <td className="sa-adresse">
                        {String(r.adresse || '').trim() || <i>Aucune adresse</i>}
                      </td>
                      <td>
                        <span
                          className="badge"
                          style={r.statut_color ? { background: r.statut_color } : undefined}
                        >
                          {statutLabel(r.statut)}
                        </span>
                        {r.parcel_status === 'DELIVERED' && (
                          <div className="cell-sub sa-autres-livre">
                            <CheckCircle2 size={12} /> Livré le{' '}
                            {r.livraison_time ? formatDate(r.livraison_time) : '—'}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </ParcelModal>
  );
}

export default function ColisSansAdresse() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  // Modale d'action de ligne : { type: 'autres' | 'suivi' | 'info' | 'edit', parcel }.
  const [modal, setModal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/parcels/client/sans-adresse')
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
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
  }, []);

  /** Lignes affichées : recherche sur code, destinataire, téléphone, ville, adresse. */
  const filtered = useMemo(() => {
    const q = normalize(searchInput.trim());
    if (!q) return rows;
    return rows.filter((r) =>
      normalize(
        [r.parcel_code, r.parcel_receiver, r.parcel_phone, r.ville, r.adresse].join(' ')
      ).includes(q)
    );
  }, [rows, searchInput]);

  /** Met à jour la ligne modifiée (modale « Modifier colis », modification directe). */
  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)));

  return (
    <div className="sa-client-page">
      <div className="rs-hero rs-hero-2">
        <div className="rs-hero-icon">
          <MapPinOff size={26} />
        </div>
        <div className="rs-hero-body">
          <h1 className="rs-hero-title">Sans adresse</h1>
          <p className="rs-hero-sub">
            Vos colis reçus sans adresse exploitable, en attente de confirmation de l'adresse du
            destinataire.
          </p>
        </div>
      </div>

      {/* Note en tête de page : consigne au client. */}
      <div className="sa-note" role="note">
        <span className="sa-note-icon">
          <Info size={20} />
        </span>
        <div>
          <p className="sa-note-text">
            Pour faciliter la livraison, veuillez nous fournir l'adresse exacte de votre client
            afin d'affecter le colis au livreur responsable de son secteur.
          </p>
          <p className="sa-note-sub">
            Utilisez l'action « Modifier colis » pour renseigner l'adresse : votre demande est
            transmise à notre équipe pour validation. « Autres adresses » retrouve les adresses
            déjà utilisées par ce destinataire dans vos envois précédents.
          </p>
        </div>
      </div>

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, destinataire, téléphone, ville, adresse…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <span className="sa-count">
          <b>{rows.length.toLocaleString('fr-FR')}</b> colis en attente de confirmation
        </span>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Code colis</th>
              <th>Destinataire</th>
              <th>Ville</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="datatable-empty">
                  {rows.length === 0
                    ? "Aucun colis en attente de confirmation d'adresse."
                    : 'Aucun colis ne correspond à la recherche.'}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const tel = telHref(r.parcel_phone);
                return (
                  <tr key={r.parcel_id}>
                    <td>
                      <span className="cell-main mono">{r.parcel_code || '—'}</span>
                      <div className="cell-sub">Depuis le {formatDate(r.parcel_last_update)}</div>
                    </td>
                    <td>
                      <span className="cell-main">{r.parcel_receiver || '—'}</span>
                      <div className="cell-sub">
                        {tel ? (
                          <a className="sa-phone mono" href={tel} dir="ltr">
                            {r.parcel_phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="rs-ville">
                        <MapPin size={13} /> {r.ville || '—'}
                      </span>
                      <div className="cell-sub sa-adresse">
                        {String(r.adresse || '').trim() || <i>Aucune adresse</i>}
                      </div>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title={
                            tel
                              ? 'Autres adresses : colis précédents de ce destinataire dans vos envois'
                              : 'Aucun numéro de téléphone'
                          }
                          disabled={!tel}
                          onClick={() => setModal({ type: 'autres', parcel: r })}
                        >
                          <MapPinned size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Détail de suivi"
                          onClick={() => setModal({ type: 'suivi', parcel: r })}
                        >
                          <Route size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action"
                          title="Information colis"
                          onClick={() => setModal({ type: 'info', parcel: r })}
                        >
                          <Info size={16} />
                        </button>
                        {editVisible(r) && (
                          <button
                            type="button"
                            className="row-action"
                            title="Modifier colis"
                            onClick={() => setModal({ type: 'edit', parcel: r })}
                          >
                            <Pencil size={16} />
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

      <div className="datatable-footer">
        <span className="datatable-range">
          {filtered.length.toLocaleString('fr-FR')} colis affiché(s)
        </span>
      </div>

      {modal?.type === 'autres' && (
        <AutresAdressesModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'info' && (
        <InfoModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'edit' && (
        <EditModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
    </div>
  );
}
