import { useEffect, useMemo, useState } from 'react';
import { BellRing, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import api from '../api/client';
import { usePagination, Pager } from './Pagination';
import MultiSearchSelect from './MultiSearchSelect';
import { adminPages } from '../config/adminMenu';
import { clientPages } from '../config/clientMenu';
import { livreurPages } from '../config/livreurMenu';

/*
 * Gestion des notifications par bannières (pages /admin/notifications/clients
 * et /admin/notifications/employes — service NOTIFICATIONS_EMPLOYES, fonctions
 * 1/2). Composant partagé entre les deux pages via la prop audience :
 *  - 'client'  : bannières des pages /client/*, ciblées tous les clients ou
 *    une sélection de clients ;
 *  - 'employe' : bannières des pages /admin/* et /livreur/*, ciblées par
 *    fonction (= users_type, la base n'a pas de fonction distincte), par
 *    agence ou par utilisateur.
 * L'affichage côté destinataires est assuré par NotificationsBanner.
 */

const IMPORTANCES = [
  { value: 'info', label: 'Info' },
  { value: 'succes', label: 'Succès' },
  { value: 'avertissement', label: 'Avertissement' },
  { value: 'urgent', label: 'Urgent' }
];

const FONCTIONS = [
  { value: 1, label: 'Super admin' },
  { value: 2, label: 'Responsable service' },
  { value: 3, label: "Responsable d'agence" },
  { value: 4, label: "Agent d'agence" },
  { value: 5, label: 'Livreur' },
  { value: 6, label: 'Ramasseur' }
];
const FONCTION_LABELS = Object.fromEntries(FONCTIONS.map((f) => [f.value, f.label]));

const MODES = {
  client: [
    { value: 'TOUS', label: 'Tous les clients' },
    { value: 'CLIENTS', label: 'Sélection de clients' }
  ],
  employe: [
    { value: 'FONCTIONS', label: 'Par fonction' },
    { value: 'AGENCES', label: 'Par agence' },
    { value: 'USERS', label: 'Par utilisateur' }
  ]
};

/** Pages proposées au ciblage (les catalogues des menus excluent l'Accueil). */
function pageOptions(audience) {
  if (audience === 'client') {
    return [
      { value: '/client', label: 'Accueil' },
      ...clientPages().map((p) => ({ value: p.path, label: p.label }))
    ];
  }
  return [
    { value: '/admin', label: 'Admin — Accueil' },
    ...adminPages().map((p) => ({ value: p.path, label: `Admin — ${p.label}` })),
    { value: '/livreur', label: 'Livreur — Accueil' },
    ...livreurPages().map((p) => ({ value: p.path, label: `Livreur — ${p.label}` }))
  ];
}

/** "AAAA-MM-JJTHH:mm" → "JJ/MM/AAAA HH:mm". */
function formatDateTime(value) {
  if (!value) return null;
  const [date, heure] = value.split('T');
  const [annee, mois, jour] = date.split('-');
  return `${jour}/${mois}/${annee} ${heure}`;
}

function periodeLabel(notif) {
  const debut = formatDateTime(notif.date_debut);
  const fin = formatDateTime(notif.date_fin);
  if (!debut && !fin) return '—';
  if (debut && fin) return `${debut} → ${fin}`;
  return debut ? `À partir du ${debut}` : `Jusqu'au ${fin}`;
}

function cibleResume(notif) {
  if (notif.cible_mode === 'TOUS') return 'Tous les clients';
  if (notif.cible_mode === 'FONCTIONS') {
    return `Fonctions : ${notif.cibles.map((c) => FONCTION_LABELS[c.id] || c.id).join(', ')}`;
  }
  const unite = { CLIENTS: 'client', AGENCES: 'agence', USERS: 'utilisateur' }[notif.cible_mode];
  const n = notif.cibles.length;
  return `${n} ${unite}${n > 1 ? 's' : ''}`;
}

/** Modale « Ajouter / Modifier une notification ». */
function NotifModal({ audience, notif, cibles, pages, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    titre: notif?.titre || '',
    message: notif?.message || '',
    importance: notif?.importance || 'info',
    groupable: Number(notif?.groupable) === 1,
    active: notif ? Number(notif.active) === 1 : true,
    pages: notif?.pages || [],
    cible_mode: notif?.cible_mode || (audience === 'client' ? 'TOUS' : 'FONCTIONS'),
    cibles: notif ? notif.cibles.map((c) => c.id) : [],
    date_debut: notif?.date_debut || '',
    date_fin: notif?.date_fin || ''
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setMode = (mode) => setForm((f) => ({ ...f, cible_mode: mode, cibles: [] }));

  function toggleFonction(value) {
    setForm((f) => ({
      ...f,
      cibles: f.cibles.includes(value) ? f.cibles.filter((c) => c !== value) : [...f.cibles, value]
    }));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    if (!form.pages.length) {
      setError('Veuillez choisir au moins une page où afficher la notification.');
      return;
    }
    if (form.cible_mode !== 'TOUS' && !form.cibles.length) {
      setError('Veuillez choisir au moins une cible.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        audience,
        titre: form.titre,
        message: form.message,
        importance: form.importance,
        groupable: form.groupable,
        active: form.active,
        pages: form.pages,
        cible_mode: form.cible_mode,
        cibles: form.cible_mode === 'TOUS' ? [] : form.cibles.map(Number),
        date_debut: form.date_debut || null,
        date_fin: form.date_fin || null
      };
      if (notif) await api.put(`/notifications/${notif.id}`, body);
      else await api.post('/notifications', body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement de la notification.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <BellRing size={18} />
            <div className="cell-main">
              {notif ? 'Modifier la notification' : 'Ajouter une notification'}
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Titre (optionnel)</span>
              <input type="text" value={form.titre} onChange={setField('titre')} maxLength={255} />
            </label>
            <label className="modal-form-full">
              <span className="field-label">Message</span>
              <textarea value={form.message} onChange={setField('message')} rows={3} maxLength={2000} required />
            </label>
            <label>
              <span className="field-label">Importance</span>
              <select value={form.importance} onChange={setField('importance')}>
                {IMPORTANCES.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="notif-check">
              <input
                type="checkbox"
                checked={form.groupable}
                onChange={(e) => setForm((f) => ({ ...f, groupable: e.target.checked }))}
              />
              <span>Regrouper avec les autres notifications de la page</span>
            </label>
            <div className="modal-form-full">
              <span className="field-label">Pages où afficher la notification</span>
              <MultiSearchSelect
                value={form.pages}
                onChange={(v) => setForm((f) => ({ ...f, pages: v }))}
                options={pages}
                placeholder="— Choisir les pages —"
              />
            </div>
            <div className="modal-form-full">
              <span className="field-label">
                {audience === 'client' ? 'Clients ciblés' : 'Employés ciblés'}
              </span>
              <div className="notif-modes">
                {MODES[audience].map((m) => (
                  <label key={m.value} className="notif-check">
                    <input
                      type="radio"
                      name="cible_mode"
                      checked={form.cible_mode === m.value}
                      onChange={() => setMode(m.value)}
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
              {form.cible_mode === 'CLIENTS' && (
                <MultiSearchSelect
                  value={form.cibles}
                  onChange={(v) => setForm((f) => ({ ...f, cibles: v }))}
                  options={cibles.clients}
                  placeholder="— Choisir les clients —"
                />
              )}
              {form.cible_mode === 'FONCTIONS' && (
                <div className="notif-modes">
                  {FONCTIONS.map((f) => (
                    <label key={f.value} className="notif-check">
                      <input
                        type="checkbox"
                        checked={form.cibles.includes(f.value)}
                        onChange={() => toggleFonction(f.value)}
                      />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.cible_mode === 'AGENCES' && (
                <MultiSearchSelect
                  value={form.cibles}
                  onChange={(v) => setForm((f) => ({ ...f, cibles: v }))}
                  options={cibles.agences}
                  placeholder="— Choisir les agences —"
                />
              )}
              {form.cible_mode === 'USERS' && (
                <MultiSearchSelect
                  value={form.cibles}
                  onChange={(v) => setForm((f) => ({ ...f, cibles: v }))}
                  options={cibles.users.map((u) => ({
                    value: u.value,
                    label: `${u.label} — ${FONCTION_LABELS[u.type] || ''}`
                  }))}
                  placeholder="— Choisir les utilisateurs —"
                />
              )}
            </div>
            <label>
              <span className="field-label">Début d'affichage (optionnel)</span>
              <input type="datetime-local" value={form.date_debut} onChange={setField('date_debut')} />
            </label>
            <label>
              <span className="field-label">Fin d'affichage (optionnel)</span>
              <input type="datetime-local" value={form.date_fin} onChange={setField('date_fin')} />
            </label>
            <label className="notif-check">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              />
              <span>Active</span>
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

/** Liste + gestion des notifications d'une audience. */
export default function NotificationsAdmin({ audience }) {
  const [notifs, setNotifs] = useState([]);
  const [cibles, setCibles] = useState({ clients: [], users: [], agences: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(null); // null | 'new' | notification (édition)

  const pages = useMemo(() => pageOptions(audience), [audience]);
  const pageLabels = useMemo(() => Object.fromEntries(pages.map((p) => [p.value, p.label])), [pages]);
  const pager = usePagination(notifs, 'notification');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get('/notifications', { params: { audience } })
      .then((res) => {
        if (cancelled) return;
        setNotifs(res.data.notifications);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement des notifications.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audience, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/notifications/cibles')
      .then((res) => {
        if (!cancelled) setCibles(res.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleActive(notif) {
    const question =
      Number(notif.active) === 1
        ? 'Désactiver cette notification ? Elle ne sera plus affichée.'
        : 'Réactiver cette notification ?';
    if (!window.confirm(question)) return;
    try {
      await api.patch(`/notifications/${notif.id}/active`, { active: Number(notif.active) !== 1 });
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors du changement de statut.');
    }
  }

  async function remove(notif) {
    if (!window.confirm('Supprimer définitivement cette notification ?')) return;
    try {
      await api.delete(`/notifications/${notif.id}`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || 'Erreur lors de la suppression.');
    }
  }

  function handleSaved() {
    setModal(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="platform-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <BellRing size={18} />{' '}
            {audience === 'client' ? 'Notifications clients' : 'Notifications employés'}
          </h2>
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Plus size={15} /> Ajouter une notification
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Notification</th>
                <th>Importance</th>
                <th>Pages</th>
                <th>Cible</th>
                <th>Période</th>
                <th>Fermetures</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {notifs.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="datatable-empty">
                    Aucune notification enregistrée.
                  </td>
                </tr>
              ) : (
                pager.pageRows.map((notif) => (
                  <tr key={notif.id}>
                    <td>
                      <div className="cell-main">{notif.titre || 'Sans titre'}</div>
                      <div className="cell-sub" title={notif.message}>
                        {Number(notif.groupable) === 1 ? 'Groupable · ' : ''}
                        {notif.message.length > 80 ? `${notif.message.slice(0, 80)}…` : notif.message}
                      </div>
                    </td>
                    <td>
                      <span className={`badge notif-badge-${notif.importance}`}>
                        {IMPORTANCES.find((i) => i.value === notif.importance)?.label || notif.importance}
                      </span>
                    </td>
                    <td title={notif.pages.map((p) => pageLabels[p] || p).join(', ')}>
                      {notif.pages.length} page{notif.pages.length > 1 ? 's' : ''}
                    </td>
                    <td title={notif.cibles.map((c) => c.label).filter(Boolean).join(', ')}>
                      {cibleResume(notif)}
                    </td>
                    <td>{periodeLabel(notif)}</td>
                    <td>{notif.fermetures}</td>
                    <td>
                      <span className={`badge ${Number(notif.active) === 1 ? 'badge-active' : 'badge-inactive'}`}>
                        {Number(notif.active) === 1 ? 'Active' : 'Désactivée'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="row-action"
                          title="Modifier la notification"
                          onClick={() => setModal(notif)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className={`row-action ${Number(notif.active) === 1 ? 'row-action-danger' : 'row-action-success'}`}
                          title={Number(notif.active) === 1 ? 'Désactiver' : 'Réactiver'}
                          onClick={() => toggleActive(notif)}
                        >
                          <Power size={16} />
                        </button>
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          title="Supprimer la notification"
                          onClick={() => remove(notif)}
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
        <Pager pager={pager} />
      </section>

      {modal && (
        <NotifModal
          audience={audience}
          notif={modal === 'new' ? null : modal}
          cibles={cibles}
          pages={pages}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
