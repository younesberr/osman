import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  CheckSquare,
  FileDown,
  Minus,
  Plus,
  ReceiptText,
  SlidersHorizontal,
  XCircle
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import SearchSelect from '../../components/SearchSelect';
import { ecrireOngletAttente, progressionOnglet } from '../../utils/pdfCapture';

/*
 * Transport > Facturation > détail d'une facture — composition de la
 * facture (portage de l'écran facture de transport_facturation.php, types
 * 1/2) : informations + statut, colis disponibles de la société (cases à
 * cocher, « Tout ajouter », filtre période — fini l'ajout un par un du
 * legacy) et colis de la facture (retrait à l'unité ou en masse). Une
 * facture payée est verrouillée : totaux figés, plus aucune modification.
 *
 * Les deux tableaux sont triables par colonne (clic sur l'en-tête) et
 * filtrables par type (envoi / retour) et ville de destination, côté
 * navigateur (toutes les lignes sont déjà chargées). « Tout cocher » et
 * « Tout ajouter » portent sur les colis affichés quand un filtre est actif.
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

/** Clé unique d'un colis de l'UNION envois + retours. */
function colisKey(c) {
  return `${c.type_colis}-${c.colis_id}`;
}

/*
 * Colonnes triables : valeur comparée + type (texte → 1er clic croissant
 * A→Z, nombre / date → 1er clic décroissant, le plus grand / récent d'abord).
 */
const COLONNES = {
  code: { type: 'text', get: (c) => c.code || '' },
  type_colis: { type: 'text', get: (c) => c.type_colis || '' },
  ville_exp: { type: 'text', get: (c) => villeLabel(c.ville_exp_ref, c.ville_exp) },
  ville_dest: { type: 'text', get: (c) => villeLabel(c.ville_dest_ref, c.ville_dest) },
  tarif: { type: 'number', get: (c) => Number(c.tarif) || 0 },
  created_time: { type: 'number', get: (c) => Number(c.created_time) || 0 }
};

/** Tri navigateur d'un tableau de colis ; sans clé, ordre du serveur (plus récent d'abord). */
function trierColis(rows, sort) {
  const col = COLONNES[sort.key];
  if (!col) return rows;
  const sens = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    const cmp =
      col.type === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'fr', { sensitivity: 'base', numeric: true });
    return sens * cmp;
  });
}

/** Filtres navigateur d'un tableau : type (envoi | retour) et ville de destination. */
function filtresVides() {
  return { type: '', ville: '' };
}

function filtreActif(filtres) {
  return Boolean(filtres.type || filtres.ville);
}

function filtrerColis(rows, filtres) {
  if (!filtreActif(filtres)) return rows;
  return rows.filter(
    (c) =>
      (!filtres.type || c.type_colis === filtres.type) &&
      (!filtres.ville || villeLabel(c.ville_dest_ref, c.ville_dest) === filtres.ville)
  );
}

/** Villes de destination présentes dans un tableau (options du filtre). */
function villesDestination(rows) {
  const set = new Set(rows.map((c) => villeLabel(c.ville_dest_ref, c.ville_dest)));
  return [...set]
    .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    .map((v) => ({ value: v, label: v }));
}

/** En-tête de colonne triable (même rendu que les autres datatables). */
function SortableTh({ sortKey, sort, onSort, children }) {
  const isActive = sort.key === sortKey;
  return (
    <th className={`th-sortable ${isActive ? 'th-sorted' : ''}`} onClick={() => onSort(sortKey)} title="Trier">
      <span className="th-sort-label">
        {children}
        {isActive ? (
          sort.dir === 'desc' ? <ArrowDown size={13} /> : <ArrowUp size={13} />
        ) : (
          <ArrowUpDown size={13} className="th-sort-idle" />
        )}
      </span>
    </th>
  );
}

/**
 * Tableau de colis (disponibles ou de la facture) avec cases à cocher, barre
 * de filtres (type, ville de destination — précédée d'éventuels filtres
 * propres à la section, `avant`), tri par colonne et pagination navigateur.
 * rows = toutes les lignes ; filtres / onFiltres = filtres contrôlés par la
 * page (elle en a besoin pour « Tout ajouter ») ; selection = Set des clés
 * cochées.
 */
function ColisTable({
  rows,
  filtres,
  onFiltres,
  avant,
  loading,
  selection,
  onToggle,
  onToggleAll,
  unit,
  action
}) {
  const [sort, setSort] = useState({ key: '', dir: 'desc' });
  const villes = useMemo(() => villesDestination(rows), [rows]);
  const visibles = useMemo(() => trierColis(filtrerColis(rows, filtres), sort), [rows, filtres, sort]);
  const pager = usePagination(visibles, unit, unit);
  const { setPage } = pager;
  const allChecked = visibles.length > 0 && visibles.every((c) => selection.has(colisKey(c)));

  function toggleSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: COLONNES[key].type === 'number' ? 'desc' : 'asc' }
    );
    setPage(1);
  }

  function changerFiltres(next) {
    onFiltres(next);
    setPage(1);
  }

  return (
    <>
      <div className="filters-bar">
        {avant}
        <select
          className="datatable-select"
          value={filtres.type}
          onChange={(e) => changerFiltres({ ...filtres, type: e.target.value })}
          title="Type"
        >
          <option value="">Tous les types</option>
          <option value="envoi">Envoi</option>
          <option value="retour">Retour</option>
        </select>
        <SearchSelect
          label="Ville destination"
          options={villes}
          value={filtres.ville}
          onChange={(v) => changerFiltres({ ...filtres, ville: v })}
          allLabel="Toutes"
        />
      </div>

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th className="transport-check-col">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => onToggleAll(visibles, !allChecked)}
                  title="Tout cocher / décocher"
                />
              </th>
              <SortableTh sortKey="code" sort={sort} onSort={toggleSort}>
                Code
              </SortableTh>
              <SortableTh sortKey="type_colis" sort={sort} onSort={toggleSort}>
                Type
              </SortableTh>
              <SortableTh sortKey="ville_exp" sort={sort} onSort={toggleSort}>
                Ville expédition
              </SortableTh>
              <SortableTh sortKey="ville_dest" sort={sort} onSort={toggleSort}>
                Ville destination
              </SortableTh>
              <SortableTh sortKey="tarif" sort={sort} onSort={toggleSort}>
                Prix
              </SortableTh>
              <SortableTh sortKey="created_time" sort={sort} onSort={toggleSort}>
                Date scan
              </SortableTh>
              {action && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 ? (
              <tr>
                <td colSpan={action ? 8 : 7} className="datatable-empty">
                  {rows.length === 0 ? 'Aucun colis.' : 'Aucun colis ne correspond aux filtres.'}
                </td>
              </tr>
            ) : (
              pager.pageRows.map((c) => (
                <tr key={colisKey(c)}>
                  <td className="transport-check-col">
                    <input
                      type="checkbox"
                      checked={selection.has(colisKey(c))}
                      onChange={() => onToggle(c)}
                    />
                  </td>
                  <td>
                    <span className="cell-main transport-code">{c.code}</span>
                  </td>
                  <td>
                    <span className={`badge ${c.type_colis === 'retour' ? 'badge-mvnt-colis' : 'badge-neutral'}`}>
                      {c.type_colis === 'retour' ? 'Retour' : 'Envoi'}
                    </span>
                  </td>
                  <td>{villeLabel(c.ville_exp_ref, c.ville_exp)}</td>
                  <td>{villeLabel(c.ville_dest_ref, c.ville_dest)}</td>
                  <td>{formatMontant(c.tarif)}</td>
                  <td>{formatDate(c.created_time)}</td>
                  {action && (
                    <td>
                      <div className="row-actions">{action(c)}</div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
    </>
  );
}

/** Nombre affiché dans le titre d'une section : « visibles / total » si filtré. */
function compteur(visibles, total, filtres) {
  return filtreActif(filtres) ? `${visibles} / ${total}` : String(total);
}

/** Transport > Facturation > détail d'une facture. */
export default function TransportFactureDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [periode, setPeriode] = useState({ debut: '', fin: '' });
  const [appliedPeriode, setAppliedPeriode] = useState({ debut: '', fin: '' });
  const [selDispo, setSelDispo] = useState(new Set());
  const [selFacture, setSelFacture] = useState(new Set());
  const [filtDispo, setFiltDispo] = useState(filtresVides);
  const [filtFacture, setFiltFacture] = useState(filtresVides);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/transport/factures/${id}`, {
        params: { debut: appliedPeriode.debut, fin: appliedPeriode.fin }
      })
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setSelDispo(new Set());
        setSelFacture(new Set());
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement de la facture.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, appliedPeriode]);

  useEffect(load, [load, reloadKey]);

  const facture = data?.facture;
  const societe = data?.societe;
  const payee = Number(facture?.statut) === 1;
  const disponibles = data?.disponibles || [];
  const colis = data?.colis || [];
  // Colis réellement affichés (filtres type / ville) : cible de « Tout ajouter ».
  const dispoVisibles = useMemo(() => filtrerColis(disponibles, filtDispo), [disponibles, filtDispo]);
  const colisVisibles = useMemo(() => filtrerColis(colis, filtFacture), [colis, filtFacture]);

  function toggle(setter) {
    return (c) =>
      setter((prev) => {
        const next = new Set(prev);
        const key = colisKey(c);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
  }

  function toggleAll(setter) {
    return (rows, checked) =>
      setter((prev) => {
        const next = new Set(prev);
        rows.forEach((c) => (checked ? next.add(colisKey(c)) : next.delete(colisKey(c))));
        return next;
      });
  }

  /** Changement de filtre : la sélection repart de zéro (on n'agit que sur ce qui est affiché). */
  function changerFiltres(setFiltres, setSelection) {
    return (next) => {
      setFiltres(next);
      setSelection(new Set());
    };
  }

  /** Set de clés → items [{ type, id }] pour l'API. */
  function itemsFromSelection(selection, rows) {
    return rows
      .filter((c) => selection.has(colisKey(c)))
      .map((c) => ({ type: c.type_colis, id: c.colis_id }));
  }

  async function run(fn, messageErreur) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.response?.data?.message || messageErreur);
    } finally {
      setBusy(false);
    }
  }

  const addSelection = () =>
    run(async () => {
      const items = itemsFromSelection(selDispo, disponibles);
      if (!items.length) throw { response: { data: { message: 'Cochez au moins un colis à ajouter.' } } };
      await api.post(`/transport/factures/${id}/colis`, { items });
    }, "Erreur lors de l'ajout des colis.");

  const addTout = () =>
    run(async () => {
      if (filtreActif(filtDispo)) {
        // Filtres type / ville actifs : on ajoute exactement les colis affichés.
        const items = dispoVisibles.map((c) => ({ type: c.type_colis, id: c.colis_id }));
        if (!items.length) throw { response: { data: { message: 'Aucun colis à ajouter.' } } };
        await api.post(`/transport/factures/${id}/colis`, { items });
        return;
      }
      await api.post(`/transport/factures/${id}/colis/tout`, {
        debut: appliedPeriode.debut,
        fin: appliedPeriode.fin
      });
    }, "Erreur lors de l'ajout des colis.");

  const addUn = (c) =>
    run(
      () => api.post(`/transport/factures/${id}/colis`, { items: [{ type: c.type_colis, id: c.colis_id }] }),
      "Erreur lors de l'ajout du colis."
    );

  const removeSelection = () =>
    run(async () => {
      const items = itemsFromSelection(selFacture, colis);
      if (!items.length) throw { response: { data: { message: 'Cochez au moins un colis à retirer.' } } };
      await api.delete(`/transport/factures/${id}/colis`, { data: { items } });
    }, 'Erreur lors du retrait des colis.');

  const removeUn = (c) =>
    run(
      () => api.delete(`/transport/factures/${id}/colis`, { data: { items: [{ type: c.type_colis, id: c.colis_id }] } }),
      'Erreur lors du retrait du colis.'
    );

  async function toggleStatut() {
    const question = payee
      ? `Repasser la facture ${facture.reference} en NON PAYÉE ?`
      : `Marquer la facture ${facture.reference} comme PAYÉE ?\nSon total (${formatMontant(
          facture.total
        )}) et sa date de paiement seront figés.`;
    if (!window.confirm(question)) return;
    await run(
      () => api.patch(`/transport/factures/${id}/statut`, { statut: payee ? 0 : 1 }),
      'Erreur lors du changement de statut.'
    );
  }

  /** PDF : mêmes données que la page, ouvert pendant le clic. */
  async function exportPdf() {
    const win = window.open('', '_blank');
    ecrireOngletAttente(win, 'Génération du PDF…');
    try {
      const [factureRes, societeRes] = await Promise.all([
        api.get(`/transport/factures/${id}`),
        api.get('/platform/societe')
      ]);
      const { genererFactureTransportPdf } = await import('../../utils/factureTransportPdf');
      const url = await genererFactureTransportPdf({
        ...factureRes.data,
        societePlateforme: societeRes.data,
        onProgress: progressionOnglet(win, 'Génération du PDF…', 'page')
      });
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (err) {
      if (win) win.close();
      alert(err.response?.data?.message || 'Erreur lors de la génération du PDF.');
    }
  }

  if (!data && loading) {
    return (
      <div className="platform-page">
        <section className="platform-card">Chargement…</section>
      </div>
    );
  }
  if (!facture) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{error || 'Facture introuvable.'}</div>
          <Link className="btn btn-ghost" to="/admin/transport/facturation">
            <ArrowLeft size={15} /> Retour à la liste
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="platform-page bons-envoi-page">
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ReceiptText size={18} /> Facture {facture.reference}
          </h2>
          <div className="row-actions">
            <Link className="btn btn-ghost" to="/admin/transport/facturation">
              <ArrowLeft size={15} /> Retour
            </Link>
            <button type="button" className="btn btn-ghost" onClick={exportPdf}>
              <FileDown size={15} /> PDF
            </button>
            <button
              type="button"
              className={`btn ${payee ? 'btn-ghost' : 'btn-primary'}`}
              onClick={toggleStatut}
              disabled={busy}
            >
              {payee ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
              {payee ? 'Repasser en non payée' : 'Marquer comme payée'}
            </button>
          </div>
        </div>

        <div className="transport-facture-infos">
          <div>
            <span className="field-label">Société facturée</span>
            <div className="cell-main">{societe?.nom || '—'}</div>
            <div className="cell-sub">{villeLabel(societe?.ville_ref, societe?.ville)}</div>
          </div>
          <div>
            <span className="field-label">Date de création</span>
            <div className="cell-main">{formatDate(facture.created_time)}</div>
          </div>
          <div>
            <span className="field-label">Colis / Total</span>
            <div className="cell-main">
              {facture.nb_colis} colis — {formatMontant(facture.total)}
            </div>
          </div>
          <div>
            <span className="field-label">Statut</span>
            <div>
              <span className={`badge ${payee ? 'badge-active' : 'badge-attente'}`}>
                {payee ? 'Payée' : 'Non payée'}
              </span>
              {facture.paid_time > 0 && (
                <div className="cell-sub">le {formatDate(facture.paid_time)}</div>
              )}
            </div>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
      </section>

      {!payee && (
        <section className="platform-card">
          <div className="bons-head">
            <h2>
              <Plus size={18} /> Colis disponibles ({compteur(dispoVisibles.length, disponibles.length, filtDispo)})
            </h2>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={addSelection}
                disabled={busy || selDispo.size === 0}
              >
                <CheckSquare size={15} /> Ajouter la sélection ({selDispo.size})
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={addTout}
                disabled={busy || dispoVisibles.length === 0}
                title={
                  filtreActif(filtDispo)
                    ? 'Ajouter tous les colis affichés (filtres actifs)'
                    : 'Ajouter tous les colis non facturés de la période'
                }
              >
                <Plus size={15} /> Tout ajouter
              </button>
            </div>
          </div>

          <ColisTable
            rows={disponibles}
            filtres={filtDispo}
            onFiltres={changerFiltres(setFiltDispo, setSelDispo)}
            avant={
              <>
                <label className="transport-periode">
                  <span className="field-label">Du</span>
                  <input
                    type="date"
                    value={periode.debut}
                    onChange={(e) => setPeriode((p) => ({ ...p, debut: e.target.value }))}
                  />
                </label>
                <label className="transport-periode">
                  <span className="field-label">Au</span>
                  <input
                    type="date"
                    value={periode.fin}
                    onChange={(e) => setPeriode((p) => ({ ...p, fin: e.target.value }))}
                  />
                </label>
                <button type="button" className="btn-apply" onClick={() => setAppliedPeriode({ ...periode })}>
                  <SlidersHorizontal size={15} />
                  Appliquer filtres
                </button>
              </>
            }
            loading={loading}
            selection={selDispo}
            onToggle={toggle(setSelDispo)}
            onToggleAll={toggleAll(setSelDispo)}
            unit="colis"
            action={(c) => (
              <button
                type="button"
                className="row-action row-action-success"
                title="Ajouter à la facture"
                disabled={busy}
                onClick={() => addUn(c)}
              >
                <Plus size={16} />
              </button>
            )}
          />
        </section>
      )}

      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <ReceiptText size={18} /> Colis de la facture ({compteur(colisVisibles.length, colis.length, filtFacture)})
          </h2>
          {!payee && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={removeSelection}
              disabled={busy || selFacture.size === 0}
            >
              <Minus size={15} /> Retirer la sélection ({selFacture.size})
            </button>
          )}
        </div>
        <ColisTable
          rows={colis}
          filtres={filtFacture}
          onFiltres={changerFiltres(setFiltFacture, setSelFacture)}
          loading={loading}
          selection={selFacture}
          onToggle={toggle(setSelFacture)}
          onToggleAll={toggleAll(setSelFacture)}
          unit="colis"
          action={
            payee
              ? null
              : (c) => (
                  <button
                    type="button"
                    className="row-action row-action-danger"
                    title="Retirer de la facture"
                    disabled={busy}
                    onClick={() => removeUn(c)}
                  >
                    <Minus size={16} />
                  </button>
                )
          }
        />
      </section>
    </div>
  );
}
