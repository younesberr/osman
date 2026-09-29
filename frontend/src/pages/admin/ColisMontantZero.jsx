import { useEffect, useMemo, useState } from 'react';
import { Bell, Check, List, Search, Tag, Truck, X } from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import { usePagination, Pager } from '../../components/Pagination';

/*
 * Colis montant zéro (/admin/colis-montant-zero) — colis à prix 0 déjà
 * ramassés dont les frais de livraison restent à encaisser auprès du magasin
 * (même logique que colis_zero.php legacy, clients exemptés exclus).
 * Contrairement au legacy qui listait tous les colis, le tableau liste les
 * magasins avec leurs compteurs par situation CRBT ; le détail des colis d'un
 * magasin s'ouvre en modale (onglet courant appliqué) avec les actions
 * Payé / Avisé. Une seconde modale liste les colis en cours du magasin
 * ramassés après ses colis montant zéro non payés (colis en circuit sur
 * lesquels les frais impayés peuvent encore être récupérés).
 */

/** Montant → "1 234,56 DH". */
function formatMontant(value) {
  return `${Number(value || 0).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} DH`;
}

/** Timestamp unix (secondes) → "JJ/MM/AAAA HH:MM". */
function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* Onglets par situation CRBT (`key` = compteur des lignes magasin). */
const TABS = [
  { value: 'EN_ATTENTE', label: 'En attente', key: 'en_attente' },
  { value: 'PAYE', label: 'Payé', key: 'paye' },
  { value: 'AVISE', label: 'Avisé', key: 'avise' },
  { value: 'TOUS', label: 'Tous', key: 'total' }
];

/* Badge de situation CRBT d'un colis (parcel_crbt_zero). */
const CRBT_BADGES = {
  0: { label: 'En attente', badge: 'badge-attente' },
  1: { label: 'Payé', badge: 'badge-active' },
  2: { label: 'Avisé', badge: 'badge-affecte' }
};

/** Ligne de la modale : un colis montant zéro + actions Payé / Avisé. */
function ColisRow({ colis, onAction, onError }) {
  const [busy, setBusy] = useState(false);
  const crbt = CRBT_BADGES[colis.crbt] || CRBT_BADGES[0];

  async function marquer(action, confirmText) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api.post(`/colis-zero/${colis.id}/${action}`);
      onAction();
    } catch (err) {
      onError(err.response?.data?.message || 'Erreur lors de la mise à jour du colis.');
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="mono">{colis.code || '—'}</td>
      <td>{colis.ville_ramassage || '—'}</td>
      <td>{colis.ville || '—'}</td>
      <td>{formatMontant(colis.frais)}</td>
      <td>
        {colis.statut ? (
          <span
            className="badge"
            style={colis.statut_color ? { background: colis.statut_color } : undefined}
          >
            {statutLabel(colis.statut)}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td>
        <span className={`badge ${crbt.badge}`}>{crbt.label}</span>
      </td>
      <td>
        <div className="row-actions">
          {colis.crbt !== 1 && (
            <button
              type="button"
              className="row-action row-action-success"
              title="Marquer payé"
              onClick={() => marquer('paye', `Marquer le colis ${colis.code} comme payé ?`)}
              disabled={busy}
            >
              <Check size={16} />
            </button>
          )}
          {colis.crbt !== 2 && (
            <button
              type="button"
              className="row-action"
              title="Marquer avisé"
              onClick={() => marquer('avise', `Marquer le colis ${colis.code} comme avisé ?`)}
              disabled={busy}
            >
              <Bell size={16} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Modale « Colis du magasin » : colis montant zéro du magasin pour l'onglet
 * courant, recherche par code, actions Payé / Avisé (les compteurs du tableau
 * des magasins sont rechargés via onChanged).
 */
function ColisModal({ magasin, statut, onChanged, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [recherche, setRecherche] = useState('');
  const [reload, setReload] = useState(0);

  const tabLabel = TABS.find((t) => t.value === statut)?.label || '';

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/colis-zero/magasins/${magasin.customer_id}/colis`, { params: { statut } })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des colis.');
      });
    return () => {
      cancelled = true;
    };
  }, [magasin.customer_id, statut, reload]);

  const filtres = useMemo(() => {
    if (!rows) return [];
    const q = recherche.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => String(c.code || '').toLowerCase().includes(q));
  }, [rows, recherche]);

  const pager = usePagination(filtres, 'colis', 'colis');

  /** Après Payé / Avisé : recharge la modale et les compteurs du tableau. */
  function handleAction() {
    setError('');
    setReload((n) => n + 1);
    onChanged();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">
                {magasin.store}
                {magasin.code_store ? ` — ${magasin.code_store}` : ''}
              </div>
              <div className="cell-sub">Colis montant zéro — {tabLabel}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher par code colis…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}
        {!rows && !error && <div className="modal-loading">Chargement…</div>}

        {rows && (
          <>
            <div className="table-wrap datatable">
              <table>
                <thead>
                  <tr>
                    <th>Code colis</th>
                    <th>Ville ramassage</th>
                    <th>Ville livraison</th>
                    <th>Frais de livraison</th>
                    <th>Statut colis</th>
                    <th>Statut CRBT</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtres.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="datatable-empty">
                        Aucun colis montant zéro trouvé.
                      </td>
                    </tr>
                  ) : (
                    pager.pageRows.map((c) => (
                      <ColisRow key={c.id} colis={c} onAction={handleAction} onError={setError} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <Pager pager={pager} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Modale « Colis en cours » : colis en cours du magasin (ramassés, ni livrés
 * ni retournés, montant non nul) ramassés après le plus récent colis montant
 * zéro non payé du magasin — recherche par code / destinataire / téléphone.
 */
function ColisEnCoursModal({ magasin, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [recherche, setRecherche] = useState('');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/colis-zero/magasins/${magasin.customer_id}/colis-en-cours`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des colis.');
      });
    return () => {
      cancelled = true;
    };
  }, [magasin.customer_id]);

  const rows = data?.rows || [];
  const reference = data?.reference || null;

  const filtres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) =>
      [c.code, c.destinataire, c.telephone].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }, [rows, recherche]);

  const pager = usePagination(filtres, 'colis', 'colis');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">
                {magasin.store}
                {magasin.code_store ? ` — ${magasin.code_store}` : ''}
              </div>
              <div className="cell-sub">
                {reference
                  ? `Colis en cours ramassés après le ${formatDate(reference.pickup_time)} (plus récent colis montant zéro non payé)`
                  : 'Colis en cours ramassés après les colis montant zéro'}
              </div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher par code, destinataire ou téléphone…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}
        {!data && !error && <div className="modal-loading">Chargement…</div>}

        {data && (
          <>
            <div className="table-wrap datatable">
              <table>
                <thead>
                  <tr>
                    <th>Code colis</th>
                    <th>Destinataire</th>
                    <th>Ville livraison</th>
                    <th>Montant</th>
                    <th>Statut colis</th>
                    <th>Livreur</th>
                    <th>Date ramassage</th>
                  </tr>
                </thead>
                <tbody>
                  {filtres.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="datatable-empty">
                        {reference
                          ? 'Aucun colis en cours ramassé après les colis montant zéro.'
                          : 'Aucun colis montant zéro non payé pour ce magasin.'}
                      </td>
                    </tr>
                  ) : (
                    pager.pageRows.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.code || '—'}</td>
                        <td>
                          <div className="cell-main">{c.destinataire || '—'}</div>
                          {c.telephone && <div className="cell-sub">{c.telephone}</div>}
                        </td>
                        <td>{c.ville || '—'}</td>
                        <td>{formatMontant(c.montant)}</td>
                        <td>
                          {c.statut ? (
                            <span
                              className="badge"
                              style={c.statut_color ? { background: c.statut_color } : undefined}
                            >
                              {statutLabel(c.statut)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{c.livreur || '—'}</td>
                        <td>{formatDate(c.pickup_time)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <Pager pager={pager} />
          </>
        )}
      </div>
    </div>
  );
}

/** Ligne du tableau : un magasin et ses compteurs de colis montant zéro. */
function MagasinRow({ magasin, onDetail, onEnCours }) {
  return (
    <tr>
      <td>
        <div className="cell-main">{magasin.store}</div>
        {magasin.code_store && <div className="cell-sub">{magasin.code_store}</div>}
      </td>
      <td>{magasin.en_attente}</td>
      <td>{magasin.paye}</td>
      <td>{magasin.avise}</td>
      <td>{magasin.total}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="row-action" title="Voir les colis" onClick={onDetail}>
            <List size={16} />
          </button>
          <button
            type="button"
            className="row-action"
            title="Colis en cours ramassés après les colis montant zéro"
            onClick={onEnCours}
          >
            <Truck size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Colis montant zéro — onglets CRBT + tableau des magasins, détail en modale. */
export default function ColisMontantZero() {
  const [statut, setStatut] = useState('EN_ATTENTE');
  const [magasins, setMagasins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recherche, setRecherche] = useState('');
  const [modal, setModal] = useState(null);
  const [modalEnCours, setModalEnCours] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/colis-zero/magasins')
      .then((res) => {
        if (cancelled) return;
        setMagasins(res.data);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des magasins.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** Compteurs des onglets : somme des compteurs de tous les magasins. */
  const totaux = useMemo(() => {
    const t = { en_attente: 0, paye: 0, avise: 0, total: 0 };
    magasins.forEach((m) => {
      t.en_attente += m.en_attente;
      t.paye += m.paye;
      t.avise += m.avise;
      t.total += m.total;
    });
    return t;
  }, [magasins]);

  const tabKey = TABS.find((t) => t.value === statut)?.key || 'total';

  /** Magasins de l'onglet courant (au moins un colis), filtrés par recherche. */
  const magasinsFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return magasins.filter((m) => {
      if (!m[tabKey]) return false;
      if (!q) return true;
      return [m.store, m.code_store].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [magasins, tabKey, recherche]);

  const pager = usePagination(magasinsFiltres, 'magasin');

  return (
    <div className="platform-page remb-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Tag size={18} /> Colis montant zéro
          </h2>
        </div>

        <nav className="fiche-tabs" aria-label="Filtre par situation CRBT">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`fiche-tab ${statut === tab.value ? 'active' : ''}`}
              onClick={() => {
                setStatut(tab.value);
                pager.setPage(1);
              }}
            >
              {tab.label}
              {totaux[tab.key] > 0 && (
                <span className={`badge ${tab.value === 'PAYE' ? 'badge-active' : tab.value === 'AVISE' ? 'badge-affecte' : tab.value === 'TOUS' ? 'badge-neutral' : 'badge-attente'}`}>
                  {totaux[tab.key]}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Rechercher un magasin…"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                pager.setPage(1);
              }}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Magasin</th>
                <th>En attente</th>
                <th>Payé</th>
                <th>Avisé</th>
                <th>Total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {magasinsFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="datatable-empty">
                    Aucun magasin avec des colis montant zéro.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((m) => (
                  <MagasinRow
                    key={m.customer_id}
                    magasin={m}
                    onDetail={() => setModal(m)}
                    onEnCours={() => setModalEnCours(m)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} />
      </section>

      {modal && (
        <ColisModal
          magasin={modal}
          statut={statut}
          onChanged={() => setReload((n) => n + 1)}
          onClose={() => setModal(null)}
        />
      )}

      {modalEnCours && (
        <ColisEnCoursModal magasin={modalEnCours} onClose={() => setModalEnCours(null)} />
      )}
    </div>
  );
}
