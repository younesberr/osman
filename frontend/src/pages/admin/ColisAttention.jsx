import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  Hourglass,
  Layers,
  MapPin,
  Pencil,
  PhoneOff,
  PhoneOutgoing,
  RefreshCw,
  Route,
  Search,
  SearchCheck,
  Truck,
  TriangleAlert
} from 'lucide-react';
import api from '../../api/client';
import { statutLabel } from '../../utils/statuts';
import SearchSelect from '../../components/SearchSelect';
import { useAuth } from '../../context/AuthContext';
import { hasTypeAccess } from '../../config/adminMenu';
import { SuiviModal, EditModal, StatutModal } from '../../components/ParcelModals';

/*
 * Colis besoin d'attention, structure de l'ancien système (colis_bloques)
 * répartie sur deux pages :
 * - « Colis alerte 00H00 » : colis dont le dernier changement de statut date
 *   d'avant minuit (alerte à partir de 00h00 du jour suivant le changement) —
 *   onglets Tous / Colis relancés / Distribution / Programmés ;
 * - « Colis à suivre » : dès le changement de statut, sans délai — onglets
 *   Tous / À vérifier / Sans réponse / Annulés, y compris les colis passés
 *   RETURNED dont le dernier statut avant le retour est un statut de la page
 *   (affichés « Retourné (statut avant) »). Colonnes empilées (magasin sous le
 *   code, adresse sous la ville, zone sous le livreur, inactivité sous la
 *   dernière MAJ) + commentaire livreur, et action « Traiter » (confirmation) :
 *   le colis marqué disparaît de la page et ne réapparaît que si son statut
 *   change à nouveau.
 * Tuiles-onglets avec compteurs, recherche + filtre livreur, tableau complet
 * (sans pagination) et actions de ligne : Suivi / Changer statut / Modifier.
 */

/* Groupes (onglets) de la page « à suivre » : sert à reclasser ou retirer une
   ligne après un changement de statut depuis la modale. */
const GROUPES_SUIVRE = {
  verifier: ['OUT_OF_AREA', 'ERR', 'EN_VOYAGE'],
  sans_reponse: ['NOANSWER', 'DEUX', 'TROIS', 'BV', 'UNREACHABLE'],
  annule: ['CANCELED', 'REFUSE']
};

const PAGES = {
  alerte: {
    titre: 'Colis alerte 00H00',
    sousTitre:
      'Colis en alerte à partir de 00h00 (minuit) du jour suivant leur dernier changement de statut.',
    hero: 'rs-hero-3',
    autres: [
      { path: '/admin/colis-attention/a-suivre', label: 'Colis à suivre' },
      { path: '/admin/colis-attention/programme-double', label: 'Programmé doublé', types: [1, 2] }
    ],
    tabs: [
      { key: 'tous', label: 'Tous', icon: Layers, color: '#64748b' },
      { key: 'relance', label: 'Colis relancés', icon: PhoneOutgoing, color: '#0d6efd' },
      { key: 'distribution', label: 'Distribution', icon: Truck, color: '#0891b2' },
      { key: 'programme', label: 'Programmés', icon: CalendarClock, color: '#d97706' }
    ]
  },
  suivre: {
    titre: 'Colis à suivre',
    sousTitre:
      'Colis à suivre dès leur changement de statut, y compris les colis retournés sur un statut à suivre.',
    hero: 'rs-hero-1',
    autres: [
      { path: '/admin/colis-attention/alerte', label: 'Colis alerte 00H00' },
      { path: '/admin/colis-attention/programme-double', label: 'Programmé doublé', types: [1, 2] }
    ],
    tabs: [
      { key: 'tous', label: 'Tous', icon: Layers, color: '#64748b' },
      { key: 'verifier', label: 'À vérifier', icon: SearchCheck, color: '#7c3aed' },
      { key: 'sans_reponse', label: 'Sans réponse', icon: PhoneOff, color: '#dc2626' },
      { key: 'annule', label: 'Annulés', icon: Ban, color: '#b91c1c' }
    ]
  }
};

/* Statuts (bruts) d'un colis dont le statut peut être changé depuis la modale. */
const STATUTS_CHANGEABLES = ['DISTRIBUTION', 'IN_PROGRESS'];

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

/** parcel_report_time est stocké en "JJ/MM/AAAA" ou "AAAA-MM-JJ" → "JJ/MM/AAAA". */
function formatReportDate(value) {
  if (!value) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value.trim();
}

/** Libellé du statut d'une ligne : « Retourné (statut avant) » pour un colis RETURNED. */
function statutRowLabel(r) {
  if (r.parcel_status === 'RETURNED' && r.statut_avant) {
    return `${statutLabel('RETURNED')} (${statutLabel(r.statut_avant)})`;
  }
  return statutLabel(r.statut);
}

function ColisAttention({ page }) {
  const cfg = PAGES[page];
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  // Horloge du serveur au chargement : l'inactivité est calculée avec elle.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('tous');
  const [searchInput, setSearchInput] = useState('');
  const [livreur, setLivreur] = useState('');
  // Modale d'action de ligne : { type: 'suivi' | 'statut' | 'edit', parcel }.
  const [modal, setModal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTab('tous');
    setLivreur('');
    setSearchInput('');
    api
      .get('/parcels/attention', { params: { page } })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setNow(res.data.now);
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
  }, [page]);

  /** Inactivité d'une ligne : "Xj Yh" (ou "Xh"), rouge à partir de 2 jours. */
  const inactif = (r) => {
    const elapsed = Math.max(0, now - Number(r.parcel_last_update));
    const jours = Math.floor(elapsed / 86400);
    const heures = Math.floor((elapsed % 86400) / 3600);
    return { texte: jours > 0 ? `${jours}j ${heures}h` : `${heures}h`, critique: jours >= 2 };
  };

  /** Compteurs des tuiles-onglets, sur l'ensemble des colis de la page. */
  const counts = useMemo(() => {
    const c = { tous: rows.length };
    rows.forEach((r) => {
      if (r.groupe) c[r.groupe] = (c[r.groupe] || 0) + 1;
    });
    return c;
  }, [rows]);

  /** Livreurs présents dans la liste (options du filtre). */
  const livreurs = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      if (Number(r.parcel_livreur) > 0 && r.livreur) map.set(String(r.parcel_livreur), r.livreur);
    });
    return [...map.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  /** Lignes affichées : onglet + filtre livreur + recherche. */
  const filtered = useMemo(() => {
    const q = normalize(searchInput.trim());
    return rows.filter((r) => {
      if (tab !== 'tous' && r.groupe !== tab) return false;
      if (livreur && String(r.parcel_livreur) !== livreur) return false;
      if (!q) return true;
      return normalize(
        [
          r.parcel_code,
          r.magasin,
          r.livreur,
          r.ville,
          r.adresse,
          r.zone,
          r.commentaire,
          statutRowLabel(r)
        ].join(' ')
      ).includes(q);
    });
  }, [rows, tab, livreur, searchInput]);

  /** Met à jour la ligne modifiée (modale "Modifier colis"). */
  const patchRow = (id, patch) =>
    setRows((prev) => prev.map((r) => (r.parcel_id === id ? { ...r, ...patch } : r)));

  /**
   * Après "Changer statut" : le colis vient de bouger, il sort de la page
   * alerte ; page à suivre : reclassé selon son nouveau statut, ou retiré si
   * ce statut n'est plus un statut à suivre.
   */
  const onStatutSaved = (id, patch) =>
    setRows((prev) =>
      prev.flatMap((r) => {
        if (r.parcel_id !== id) return [r];
        if (page === 'alerte') return [];
        const groupe = Object.keys(GROUPES_SUIVRE).find((g) =>
          GROUPES_SUIVRE[g].includes(patch.statut)
        );
        if (!groupe) return [];
        return [{ ...r, ...patch, groupe, statut_avant: null, parcel_last_update: now }];
      })
    );

  /**
   * "Traiter" (page à suivre, après confirmation) : masque le colis sans
   * changer son statut ; il ne réapparaîtra que si son statut change à nouveau.
   */
  const traiter = async (r) => {
    if (
      !window.confirm(
        `Marquer le colis « ${r.parcel_code} » comme traité ?\n` +
          'Il disparaîtra de cette page et ne réapparaîtra que si son statut change à nouveau.'
      )
    ) {
      return;
    }
    try {
      await api.post(`/parcels/${r.parcel_id}/traiter`);
      setRows((prev) => prev.filter((x) => x.parcel_id !== r.parcel_id));
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du marquage du colis.');
    }
  };

  // Page « à suivre » : colonnes empilées (magasin / adresse / zone / inactivité
  // sous la colonne principale) + commentaire livreur.
  const compact = page === 'suivre';
  const colonnes = compact ? 8 : 10;

  return (
    <div className="rs-page">
      <div className={`rs-hero ${cfg.hero}`}>
        <div className="rs-hero-icon">
          <TriangleAlert size={26} />
        </div>
        <div className="rs-hero-body">
          <h1 className="rs-hero-title">{cfg.titre}</h1>
          <p className="rs-hero-sub">{cfg.sousTitre}</p>
        </div>
        <div className="rs-hero-nav">
          {cfg.autres
            .filter((p) => hasTypeAccess(user, p.types))
            .map((p) => (
              <Link key={p.path} to={p.path} className="rs-hero-btn">
                {p.label} <ArrowRight size={15} />
              </Link>
            ))}
        </div>
      </div>

      <div className="ca-tiles">
        {cfg.tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              className={`ca-tile ${tab === t.key ? 'ca-tile-active' : ''}`}
              style={{ '--ca-c': t.color }}
              onClick={() => setTab(t.key)}
            >
              <span className="ca-tile-ico">
                <Icon size={19} />
              </span>
              <span>
                <span className="ca-tile-count">{counts[t.key] || 0}</span>
                <span className="ca-tile-lbl">{t.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="datatable-toolbar">
        <div className="datatable-search">
          <Search size={16} className="datatable-search-icon" />
          <input
            type="search"
            placeholder="Rechercher : code, client, livreur, ville…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <SearchSelect
          label="Livreur"
          options={livreurs}
          value={livreur}
          onChange={setLivreur}
          allLabel="Tous les livreurs"
        />
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            {compact ? (
              <tr>
                <th>#</th>
                <th>Code Colis</th>
                <th>Ville</th>
                <th>Commentaire livreur</th>
                <th>Livreur</th>
                <th>Statut</th>
                <th>Dernière MAJ</th>
                <th>Actions</th>
              </tr>
            ) : (
              <tr>
                <th>#</th>
                <th>Code Colis</th>
                <th>Client</th>
                <th>Ville</th>
                <th>Livreur</th>
                <th>Statut</th>
                <th>Date programmée</th>
                <th>Dernière MAJ</th>
                <th>Inactif depuis</th>
                <th>Actions</th>
              </tr>
            )}
          </thead>
          <tbody>
            {filtered.length === 0 && !loading ? (
              <tr>
                <td colSpan={colonnes} className="datatable-empty">
                  Aucun colis dans cette catégorie — tout est à jour.
                </td>
              </tr>
            ) : (
              filtered.map((r, i) => {
                const ina = inactif(r);
                const badgeStatut = (
                  <span
                    className="badge"
                    style={r.statut_color ? { background: r.statut_color } : undefined}
                  >
                    {statutRowLabel(r)}
                  </span>
                );
                const badgeInactif = (
                  <span className={`rs-days rs-days-${ina.critique ? 'critical' : 'warning'}`}>
                    <Hourglass size={12} /> {ina.texte}
                  </span>
                );
                const btnSuivi = (
                  <button
                    type="button"
                    className="row-action"
                    title="Détail de suivi"
                    onClick={() => setModal({ type: 'suivi', parcel: r })}
                  >
                    <Route size={16} />
                  </button>
                );
                const btnModifier = (
                  <button
                    type="button"
                    className="row-action"
                    title="Modifier colis"
                    onClick={() => setModal({ type: 'edit', parcel: r })}
                  >
                    <Pencil size={16} />
                  </button>
                );
                if (compact) {
                  return (
                    <tr key={r.parcel_id}>
                      <td className="cell-sub">{i + 1}</td>
                      <td>
                        <span className="cell-main mono">{r.parcel_code || '—'}</span>
                        <div className="cell-sub">{r.magasin || '—'}</div>
                      </td>
                      <td>
                        <span className="rs-ville">
                          <MapPin size={13} /> {r.ville || '—'}
                        </span>
                        <div className="cell-sub ca-adresse">{r.adresse || '—'}</div>
                      </td>
                      <td>
                        {r.commentaire ? (
                          <div className="ca-comment">{r.commentaire}</div>
                        ) : (
                          <span className="cell-sub">—</span>
                        )}
                      </td>
                      <td>
                        <span className="rs-livreur">
                          <span className="rs-avatar">
                            {(r.livreur || '—').trim().charAt(0).toUpperCase()}
                          </span>
                          {r.livreur || '—'}
                        </span>
                        <div className="cell-sub">{r.zone || '—'}</div>
                      </td>
                      <td>{badgeStatut}</td>
                      <td>
                        <div className="cell-sub">{formatDate(r.parcel_last_update)}</div>
                        <div className="ca-stack-sub">{badgeInactif}</div>
                      </td>
                      <td>
                        <div className="row-actions">
                          {btnSuivi}
                          {btnModifier}
                          <button
                            type="button"
                            className="row-action row-action-success"
                            title="Marquer comme traité — disparaît de la page sans changer le statut"
                            onClick={() => traiter(r)}
                          >
                            <Check size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={r.parcel_id}>
                    <td className="cell-sub">{i + 1}</td>
                    <td>
                      <span className="cell-main mono">{r.parcel_code || '—'}</span>
                    </td>
                    <td>{r.magasin || '—'}</td>
                    <td>
                      <span className="rs-ville">
                        <MapPin size={13} /> {r.ville || '—'}
                      </span>
                    </td>
                    <td>
                      <span className="rs-livreur">
                        <span className="rs-avatar">
                          {(r.livreur || '—').trim().charAt(0).toUpperCase()}
                        </span>
                        {r.livreur || '—'}
                      </span>
                    </td>
                    <td>{badgeStatut}</td>
                    <td>
                      {['PROGRAMMER', 'POSTPONED'].includes(r.statut) && r.report_time ? (
                        <span className="ca-date-prog">{formatReportDate(r.report_time)}</span>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                    <td className="cell-sub">{formatDate(r.parcel_last_update)}</td>
                    <td>{badgeInactif}</td>
                    <td>
                      <div className="row-actions">
                        {btnSuivi}
                        {STATUTS_CHANGEABLES.includes(r.parcel_status) && (
                          <button
                            type="button"
                            className="row-action"
                            title="Changer statut"
                            onClick={() => setModal({ type: 'statut', parcel: r })}
                          >
                            <RefreshCw size={16} />
                          </button>
                        )}
                        {btnModifier}
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

      {modal?.type === 'suivi' && (
        <SuiviModal parcel={modal.parcel} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'statut' && (
        <StatutModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={onStatutSaved} />
      )}
      {modal?.type === 'edit' && (
        <EditModal parcel={modal.parcel} onClose={() => setModal(null)} onSaved={patchRow} />
      )}
    </div>
  );
}

export function ColisAlerte() {
  return <ColisAttention page="alerte" />;
}

export function ColisASuivre() {
  return <ColisAttention page="suivre" />;
}
