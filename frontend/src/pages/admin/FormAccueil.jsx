import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCheck,
  Eye,
  Layers,
  Mail,
  MailOpen,
  MessageCircle,
  Phone,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import DateRangeSelect from '../../components/DateRangeSelect';

/*
 * Messages > Form d'accueil — reprise de la page legacy « contact » : messages
 * envoyés depuis le formulaire de la page d'accueil (delevery_home_msg).
 * Compteurs (total / nouveaux / lus / traités), onglets de statut, recherche +
 * plage de dates, datatable triable (Nom / Ville / Contact / Message / Date /
 * Statut / Actions) et modale « Ouvrir » qui marque le message Lu, avec
 * réponse email / WhatsApp / appel et note de traitement facultative.
 */

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

/** Numéro utilisable pour un lien wa.me / tel: (indicatif marocain, comme le legacy). */
function phoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('212')) return digits;
  if (digits.startsWith('0')) return `212${digits.slice(1)}`;
  return digits;
}

/** Initiales d'un nom (1 à 2 lettres), pour l'avatar. */
function initiales(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  let ini = parts[0][0].toUpperCase();
  if (parts.length > 1) ini += parts[parts.length - 1][0].toUpperCase();
  return ini;
}

/* Couleur d'avatar stable par nom (même palette que la page legacy). */
const AVATAR_PALETTE = [
  '#4361ee',
  '#7209b7',
  '#f72585',
  '#06d6a0',
  '#118ab2',
  '#ef476f',
  '#3a86ff',
  '#fb8500',
  '#8338ec',
  '#2a9d8f'
];
function couleurAvatar(seed) {
  const str = String(seed || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

/* Badge de statut d'un message (NEW → rouge, LU → orange, TRAITE → vert). */
const STATUT_BADGES = {
  NEW: { label: 'Nouveau', badge: 'badge-refuse' },
  LU: { label: 'Lu', badge: 'badge-attente' },
  TRAITE: { label: 'Traité', badge: 'badge-active' }
};
function statutBadge(statut) {
  return STATUT_BADGES[statut] || { label: statut, badge: 'badge-neutral' };
}

/** Entête de colonne triable (tri côté client, comme la page legacy). */
function SortTh({ label, k, sort, onSort }) {
  const active = sort.key === k;
  return (
    <th className="th-sort" onClick={() => onSort(k)} title="Trier">
      <span>
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp size={12} />
          ) : (
            <ArrowDown size={12} />
          )
        ) : (
          <ArrowUpDown size={12} />
        )}
      </span>
    </th>
  );
}

/**
 * Modale « Ouvrir » : détail du message (l'ouverture marque un message Nouveau
 * comme Lu, côté serveur), réponse email / WhatsApp / appel, et note de
 * traitement facultative → statut Traité. Un message traité affiche le bloc
 * « Traité par » à la place du formulaire.
 */
function MessageModal({ id, onClose, onViewed, onTreated }) {
  const [msg, setMsg] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
      .get(`/messages/form-accueil/${id}`)
      .then((res) => {
        if (cancelled) return;
        setMsg(res.data);
        onViewed(res.data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Erreur de chargement du message.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function traiter(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/messages/form-accueil/${id}/traiter`, { note });
      onTreated();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors du traitement du message.');
      setSaving(false);
    }
  }

  const badge = msg ? statutBadge(msg.statut) : null;
  const wa = phoneDigits(msg?.phone);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <div>
              <div className="cell-main">{msg?.name || 'Message de contact'}</div>
              <div className="cell-sub">Message de contact — form d'accueil</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}
        {!msg && !loadError && <div className="modal-loading">Chargement…</div>}

        {msg && (
          <>
            <div className="modal-recap">
              <div className="modal-recap-row">
                <span>Nom</span>
                <b>{msg.name || '—'}</b>
              </div>
              <div className="modal-recap-row">
                <span>Ville</span>
                <b>{msg.city || '—'}</b>
              </div>
              <div className="modal-recap-row">
                <span>Email</span>
                <b dir="ltr">{msg.email || '—'}</b>
              </div>
              <div className="modal-recap-row">
                <span>Téléphone</span>
                <b dir="ltr">{msg.phone || '—'}</b>
              </div>
              <div className="modal-recap-row">
                <span>Date</span>
                <b>{formatDate(msg.time)}</b>
              </div>
              <div className="modal-recap-row">
                <span>Statut</span>
                <span className={`badge ${badge.badge}`}>{badge.label}</span>
              </div>
            </div>

            <div className="rec-traiter-texte">
              <p>{msg.text || '—'}</p>
            </div>

            <div className="fa-msg-reply">
              {msg.email && (
                <a className="btn btn-ghost" href={`mailto:${msg.email}`}>
                  <Mail size={15} /> Répondre par email
                </a>
              )}
              {wa && (
                <>
                  <a
                    className="btn fa-msg-btn-wa"
                    href={`https://wa.me/${wa}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MessageCircle size={15} /> WhatsApp
                  </a>
                  <a className="btn btn-ghost" href={`tel:+${wa}`}>
                    <Phone size={15} /> Appeler
                  </a>
                </>
              )}
            </div>

            {msg.statut === 'TRAITE' ? (
              <div className="form-success">
                Traité par <b>{msg.traite_par || '—'}</b> — {formatDate(msg.traite_time)}
                {msg.note && (
                  <div className="cell-sub fa-msg-note">Note : {msg.note}</div>
                )}
              </div>
            ) : (
              <form onSubmit={traiter}>
                <label>
                  Note de traitement (facultatif)
                  <textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    placeholder="Note interne…"
                  />
                </label>
                {error && <div className="form-error">{error}</div>}
                <div className="modal-actions">
                  <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
                    Fermer
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    <Check size={15} /> {saving ? 'Traitement…' : 'Marquer comme traité'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const EMPTY_COUNTS = { total: 0, nouveaux: 0, lus: 0, traites: 0 };

/** Onglets de statut ('' = tous), avec compteur et couleur du legacy. */
const TABS = [
  { value: '', label: 'Tous', icon: Layers, badge: 'badge-neutral', count: 'total' },
  { value: 'NEW', label: 'Nouveaux', icon: Mail, badge: 'badge-refuse', count: 'nouveaux' },
  { value: 'LU', label: 'Lus', icon: MailOpen, badge: 'badge-attente', count: 'lus' },
  { value: 'TRAITE', label: 'Traités', icon: CheckCheck, badge: 'badge-active', count: 'traites' }
];

function defaultFilters() {
  return { search: '', dates: { from: '', to: '', preset: 'all' } };
}

/** Messages > Form d'accueil — page principale. */
export default function FormAccueil() {
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statut, setStatut] = useState('');
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [sort, setSort] = useState({ key: 'time', dir: 'desc' });
  const [modalId, setModalId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/messages/form-accueil', {
        params: {
          statut,
          search: applied.search,
          dateFrom: applied.dates.from,
          dateTo: applied.dates.to
        }
      })
      .then((res) => {
        if (cancelled) return;
        setCounts(res.data.counts || EMPTY_COUNTS);
        setRows(res.data.rows || []);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des messages.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statut, applied, reloadKey]);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === 'time') return (a.time - b.time) * dir;
      const va = String(a[sort.key] || '');
      const vb = String(b[sort.key] || '');
      return va.localeCompare(vb, 'fr', { sensitivity: 'base' }) * dir;
    });
    return list;
  }, [rows, sort]);

  const pager = usePagination(sortedRows, 'message');

  function toggleSort(key) {
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
    pager.setPage(1);
  }

  function changeStatut(value) {
    setStatut(value);
    pager.setPage(1);
  }

  function applyFilters() {
    // Nouvelle référence : recharge même si les filtres n'ont pas changé.
    setApplied({ ...draft, dates: { ...draft.dates } });
    pager.setPage(1);
  }

  /* Première ouverture d'un message Nouveau : le serveur l'a marqué Lu —
   * répercute le changement sur la ligne et les compteurs sans refetch. */
  function handleViewed(msg) {
    setRows((list) =>
      list.map((r) => (r.id === msg.id && r.statut !== msg.statut ? { ...r, statut: msg.statut } : r))
    );
    setCounts((c) => {
      const row = rows.find((r) => r.id === msg.id);
      if (!row || row.statut === msg.statut || row.statut !== 'NEW') return c;
      return { ...c, nouveaux: Math.max(0, c.nouveaux - 1), lus: c.lus + 1 };
    });
  }

  function reload() {
    setReloadKey((k) => k + 1);
  }

  async function rouvrir(msg) {
    if (!window.confirm('Remettre ce message en attente ?')) return;
    try {
      await api.post(`/messages/form-accueil/${msg.id}/rouvrir`);
      reload();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la remise en attente.');
    }
  }

  async function supprimer(msg) {
    if (!window.confirm('Voulez-vous supprimer ce message ?')) return;
    try {
      await api.delete(`/messages/form-accueil/${msg.id}`);
      reload();
    } catch (err) {
      setError(err.response?.data?.message || 'Erreur lors de la suppression du message.');
    }
  }

  return (
    <div className="platform-page fa-msg-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <Mail size={18} /> Messages du form d'accueil
          </h2>
        </div>

        <div className="rec-stats">
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-all">
              <Mail size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.total}</div>
              <div className="rec-stat-lbl">Total messages</div>
            </div>
          </div>
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-new">
              <MailOpen size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.nouveaux}</div>
              <div className="rec-stat-lbl">Nouveaux</div>
            </div>
          </div>
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-enc">
              <Eye size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.lus}</div>
              <div className="rec-stat-lbl">Lus</div>
            </div>
          </div>
          <div className="rec-stat">
            <span className="rec-stat-ic rec-ic-trt">
              <CheckCheck size={20} />
            </span>
            <div>
              <div className="rec-stat-val">{counts.traites}</div>
              <div className="rec-stat-lbl">Traités</div>
            </div>
          </div>
        </div>

        <nav className="fiche-tabs" aria-label="Filtre par statut">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.value}
                type="button"
                className={`fiche-tab ${statut === tab.value ? 'active' : ''}`}
                onClick={() => changeStatut(tab.value)}
              >
                <Icon size={14} /> {tab.label}{' '}
                <span className={`badge ${tab.badge}`}>{counts[tab.count]}</span>
              </button>
            );
          })}
        </nav>

        <div className="filters-bar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="text"
              placeholder="Nom, ville, email, téléphone, message…"
              value={draft.search}
              onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
            />
          </div>
          <DateRangeSelect
            value={draft.dates}
            onChange={(dates) => setDraft((d) => ({ ...d, dates }))}
          />
          <button type="button" className="btn-apply" onClick={applyFilters}>
            <SlidersHorizontal size={15} />
            Appliquer filtres
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <SortTh label="Nom" k="name" sort={sort} onSort={toggleSort} />
                <SortTh label="Ville" k="city" sort={sort} onSort={toggleSort} />
                <th>Contact</th>
                <th>Message</th>
                <SortTh label="Date" k="time" sort={sort} onSort={toggleSort} />
                <SortTh label="Statut" k="statut" sort={sort} onSort={toggleSort} />
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={7} className="datatable-empty">
                    Aucun message ne correspond aux filtres sélectionnés.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((msg) => {
                  const badge = statutBadge(msg.statut);
                  const wa = phoneDigits(msg.phone);
                  return (
                    <tr key={msg.id} className={msg.statut === 'NEW' ? 'is-new' : ''}>
                      <td>
                        <div className="rec-user">
                          <span className="rec-avatar" style={{ background: couleurAvatar(msg.name) }}>
                            {initiales(msg.name)}
                          </span>
                          <div className="cell-main">{msg.name || '—'}</div>
                        </div>
                      </td>
                      <td>
                        {msg.city ? <span className="badge badge-neutral">{msg.city}</span> : '—'}
                      </td>
                      <td>
                        <div className="fa-msg-contact">
                          {msg.email ? (
                            <a href={`mailto:${msg.email}`} dir="ltr">
                              <Mail size={13} /> {msg.email}
                            </a>
                          ) : (
                            <span>
                              <Mail size={13} /> —
                            </span>
                          )}
                          {msg.phone ? (
                            <a href={`tel:${msg.phone}`} dir="ltr">
                              <Phone size={13} /> {msg.phone}
                            </a>
                          ) : (
                            <span>
                              <Phone size={13} /> —
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="rec-texte" title={msg.text}>
                          {msg.text || '—'}
                        </div>
                      </td>
                      <td>{formatDate(msg.time)}</td>
                      <td>
                        <span className={`badge ${badge.badge}`}>{badge.label}</span>
                        {msg.statut === 'TRAITE' && msg.traite_par && (
                          <div className="cell-sub" title={msg.note || undefined}>
                            par {msg.traite_par}
                            {msg.traite_time ? ` — ${formatDate(msg.traite_time)}` : ''}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-action"
                            title="Ouvrir le message"
                            onClick={() => setModalId(msg.id)}
                          >
                            <Eye size={16} />
                          </button>
                          {wa && (
                            <a
                              className="row-action row-action-wa"
                              href={`https://wa.me/${wa}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Répondre sur WhatsApp"
                            >
                              <MessageCircle size={16} />
                            </a>
                          )}
                          {msg.statut === 'TRAITE' && (
                            <button
                              type="button"
                              className="row-action"
                              title="Remettre en attente"
                              onClick={() => rouvrir(msg)}
                            >
                              <RotateCcw size={16} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="row-action row-action-danger"
                            title="Supprimer"
                            onClick={() => supprimer(msg)}
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

      {modalId !== null && (
        <MessageModal
          id={modalId}
          onClose={() => setModalId(null)}
          onViewed={handleViewed}
          onTreated={() => {
            setModalId(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
