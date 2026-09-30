import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  FileText,
  HandCoins,
  PackagePlus,
  PackageX,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Trash2,
  X
} from 'lucide-react';
import api from '../../api/client';
import { usePagination, Pager } from '../../components/Pagination';
import { factureClientStatut, ligneStatut } from './FacturesClients';

/*
 * Page de création / modification d'une facture client.
 * Section 1 : informations de la facture (référence, date, magasin, client,
 * statut, nombre de colis, montant total).
 * Section 2 : colis facturables du client — livrés non facturés, et refusés /
 * annulés avec frais de refus > 0 (frais nuls : non listés) ; dans les deux
 * cas le colis doit être dans une facture livreur enregistrée ou payée
 * (règle appliquée côté API). Ajout à l'unité
 * ou par sélection (cases à cocher) ; le frais client de chaque colis est
 * modifiable (icône crayon) avant l'ajout et envoyé au moment de l'ajout.
 * Les frais supp de livraison (parcel_extra_fees, mêmes frais que le champ
 * « Frais supplémentaires » de la modale de modification du colis) sont
 * portés par le colis lui-même : leur modification (icône crayon, brouillon
 * uniquement) est persistée immédiatement, dans les deux listes.
 * Section 3 : colis de la facture — mêmes colonnes, frais modifiable tant
 * que la facture est en brouillon, retrait à l'unité ou par sélection.
 * Section 4 : frais supplémentaires du client — frais rattachés à la facture
 * (déduits du montant total, comme la remise legacy ; rattachement
 * automatique à la création ; frais legacy en lecture seule) + frais
 * « Nouveau » non rattachés du client. En brouillon : bouton « Ajouter » sur
 * les frais non rattachés, « Retirer » sur les rattachés de l’application.
 * Facture enregistrée ou payée : lecture seule.
 * Prix : livré → COD - frais - frais supp ; refusé / annulé → -frais - frais
 * supp. Montant total = somme des prix - frais - remise.
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

/** Timestamp unix (secondes) → "JJ/MM/AAAA". */
function formatJour(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/** Prix d'une ligne : livré → COD - frais - frais supp ; refusé / annulé →
 * -frais - frais supp. */
function prixLigne(p) {
  const livre = p.line_statut === 'DELIVERED' || p.status === 'DELIVERED';
  const base = livre ? Number(p.crbt || 0) - Number(p.frais || 0) : -Number(p.frais || 0);
  return base - Number(p.frais_supp || 0);
}

/** Minuscules sans accents, pour une recherche tolérante. */
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Modale de modification du frais client d'un colis. */
function FraisModal({ title, code, value, onSave, onClose }) {
  const [montant, setMontant] = useState(String(value ?? 0));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    const n = Number(montant);
    if (!Number.isFinite(n) || n < 0) {
      setError('Montant positif attendu.');
      return;
    }
    setSaving(true);
    try {
      await onSave(Math.round(n));
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || "Erreur lors de l'enregistrement.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Pencil size={18} />
            <div>
              <div className="cell-main">{title}</div>
              <div className="cell-sub mono">{code}</div>
            </div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={save}>
          <div className="modal-form-grid">
            <label className="modal-form-full">
              <span className="field-label">Montant (DH)</span>
              <input
                type="number"
                min="0"
                step="1"
                value={montant}
                onChange={(e) => setMontant(e.target.value)}
                autoFocus
              />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Cellule frais avec icône de modification. */
function FraisCell({ value, editable, onEdit, title }) {
  return (
    <div className="facture-frais-cell">
      <span>{formatMontant(value)}</span>
      {editable && (
        <button type="button" className="row-action" title={title} onClick={onEdit}>
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

export default function FactureClientEdit() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [facture, setFacture] = useState(null);
  const [factureParcels, setFactureParcels] = useState([]);
  const [factureFrais, setFactureFrais] = useState([]);
  const [fraisDispo, setFraisDispo] = useState([]);
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState(null);

  const [searchDispo, setSearchDispo] = useState('');
  const [searchFacture, setSearchFacture] = useState('');
  const [selectedDispo, setSelectedDispo] = useState(() => new Set());
  const [selectedFacture, setSelectedFacture] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // { list: 'dispo' | 'facture', field: 'frais' | 'frais_supp', parcel } —
  // modale de modification du frais client ou des frais supp de livraison.
  const [fraisEdit, setFraisEdit] = useState(null);

  const editable = facture && Number(facture.statut) === 0;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get(`/factures-clients/${id}`), api.get(`/factures-clients/${id}/available`)])
      .then(([factureRes, dispoRes]) => {
        if (cancelled) return;
        const { parcels, frais, fraisDisponibles, ...info } = factureRes.data;
        setFacture(info);
        setFactureParcels(parcels);
        setFactureFrais(frais || []);
        setFraisDispo(fraisDisponibles || []);
        setAvailable(dispoRes.data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.message || 'Erreur de chargement de la facture.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const totaux = useMemo(
    () =>
      factureParcels.reduce(
        (acc, p) => ({ nb: acc.nb + 1, montant: acc.montant + prixLigne(p) }),
        { nb: 0, montant: 0 }
      ),
    [factureParcels]
  );
  const totalFrais = useMemo(
    () => factureFrais.reduce((acc, f) => acc + Number(f.montant || 0), 0),
    [factureFrais]
  );
  const remise = Number(facture?.remise) || 0;
  const montantNet = totaux.montant - totalFrais - remise;

  /** Colis ajoutés : passent de la liste des facturables à celle de la facture. */
  function moveToFacture(added) {
    const byId = new Map(available.map((p) => [p.id, p]));
    const enriched = added.map((a) => {
      const src = byId.get(a.id) || {};
      return {
        ...src,
        id: a.id,
        code: a.code,
        frais: a.frais,
        line_statut: src.status === 'DELIVERED' ? 'DELIVERED' : 'REFUSE'
      };
    });
    const ids = new Set(added.map((a) => a.id));
    setAvailable((prev) => prev.filter((p) => !ids.has(p.id)));
    setFactureParcels((prev) => [...enriched, ...prev]);
    setSelectedDispo(new Set());
  }

  /** Ajout de colis (à l'unité ou par sélection), frais affichés envoyés avec. */
  async function addByIds(ids) {
    if (!ids.length || busy || !editable) return;
    const byId = new Map(available.map((p) => [p.id, p]));
    const entries = ids
      .filter((pid) => byId.has(pid))
      .map((pid) => {
        const p = byId.get(pid);
        return { id: pid, frais: Number(p.frais) || 0 };
      });
    if (!entries.length) return;
    setBusy(true);
    setFeedback(null);
    try {
      // Envoi par lots de 100 (limite de taille du corps JSON côté serveur).
      const added = [];
      const skipped = [];
      for (let i = 0; i < entries.length; i += 100) {
        const res = await api.post(`/factures-clients/${id}/parcels`, {
          entries: entries.slice(i, i + 100)
        });
        added.push(...res.data.added);
        skipped.push(...res.data.skipped);
      }
      moveToFacture(added);
      if (skipped.length) {
        setFeedback({
          type: 'error',
          text: `Colis ignorés : ${skipped.map((s) => `${s.code} (${s.reason})`).join(' — ')}`
        });
      } else if (added.length) {
        setFeedback({ type: 'success', text: `${added.length} colis ajouté(s) à la facture.` });
      }
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Erreur lors de l'ajout." });
    } finally {
      setBusy(false);
    }
  }

  /** Retire un colis de la facture : repart dans la liste des facturables. */
  async function removeParcel(parcel) {
    if (busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.delete(`/factures-clients/${id}/parcels/${parcel.id}`);
      setFactureParcels((prev) => prev.filter((p) => p.id !== parcel.id));
      setAvailable((prev) => [{ ...parcel }, ...prev]);
      setSelectedFacture((prev) => {
        const next = new Set(prev);
        next.delete(parcel.id);
        return next;
      });
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait.' });
    } finally {
      setBusy(false);
    }
  }

  /** Retrait par sélection : un appel par colis (chaque retrait est atomique). */
  async function removeSelection() {
    const parcels = factureParcels.filter((p) => selectedFacture.has(p.id));
    if (!parcels.length || busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    const removed = [];
    let error = '';
    for (const parcel of parcels) {
      try {
        await api.delete(`/factures-clients/${id}/parcels/${parcel.id}`);
        removed.push(parcel);
      } catch (err) {
        error = err.response?.data?.message || 'Erreur lors du retrait.';
        break;
      }
    }
    if (removed.length) {
      const ids = new Set(removed.map((p) => p.id));
      setFactureParcels((prev) => prev.filter((p) => !ids.has(p.id)));
      setAvailable((prev) => [...removed.map((p) => ({ ...p })), ...prev]);
    }
    setSelectedFacture(new Set());
    if (error) setFeedback({ type: 'error', text: error });
    setBusy(false);
  }

  /** Enregistre la modification du frais client ou des frais supp de
   * livraison depuis la modale. */
  async function saveFrais(montant) {
    const { list, field, parcel } = fraisEdit;
    if (field === 'frais_supp') {
      // Frais supp de livraison : portés par le colis lui-même
      // (parcel_extra_fees) — mise à jour persistée quelle que soit la liste.
      await api.patch(`/factures-clients/${id}/parcels/${parcel.id}/frais-supp`, {
        frais_supp: montant
      });
      const apply = (prev) =>
        prev.map((p) => (p.id === parcel.id ? { ...p, frais_supp: montant } : p));
      if (list === 'facture') setFactureParcels(apply);
      else setAvailable(apply);
      return;
    }
    if (list === 'facture') {
      // Ligne de la facture : mise à jour persistée.
      await api.patch(`/factures-clients/${id}/parcels/${parcel.id}`, { frais: montant });
      setFactureParcels((prev) =>
        prev.map((p) => (p.id === parcel.id ? { ...p, frais: montant } : p))
      );
      return;
    }
    // Colis pas encore ajouté : gardé localement et envoyé au moment de l'ajout.
    setAvailable((prev) => prev.map((p) => (p.id === parcel.id ? { ...p, frais: montant } : p)));
  }

  /** Rattache un frais supplémentaire non rattaché du client à la facture. */
  async function ajouterFrais(frais) {
    if (busy || !editable) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.post(`/factures-clients/${id}/frais/${frais.id}`);
      setFraisDispo((prev) => prev.filter((f) => f.id !== frais.id));
      setFactureFrais((prev) => [...prev, frais]);
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || "Erreur lors de l'ajout du frais." });
    } finally {
      setBusy(false);
    }
  }

  /** Retire un frais supplémentaire de l’application de la facture (jamais un legacy). */
  async function retirerFrais(frais) {
    if (busy || !editable || frais.legacy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.delete(`/factures-clients/${id}/frais/${frais.id}`);
      setFactureFrais((prev) => prev.filter((f) => f.id !== frais.id));
      setFraisDispo((prev) => [...prev, { ...frais, statut: 0 }]);
    } catch (err) {
      setFeedback({ type: 'error', text: err.response?.data?.message || 'Erreur lors du retrait du frais.' });
    } finally {
      setBusy(false);
    }
  }

  const dispoFiltres = useMemo(() => {
    const q = normalize(searchDispo.trim());
    if (!q) return available;
    return available.filter((p) =>
      [p.code, p.ville, p.destinataire].some((v) => normalize(v).includes(q))
    );
  }, [available, searchDispo]);

  const factureFiltres = useMemo(() => {
    const q = normalize(searchFacture.trim());
    if (!q) return factureParcels;
    return factureParcels.filter((p) =>
      [p.code, p.ville, p.destinataire].some((v) => normalize(v).includes(q))
    );
  }, [factureParcels, searchFacture]);

  const dispoPager = usePagination(dispoFiltres, 'colis', 'colis');
  const facturePager = usePagination(factureFiltres, 'colis', 'colis');

  function toggleSet(setter, parcelId) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(parcelId)) next.delete(parcelId);
      else next.add(parcelId);
      return next;
    });
  }

  /** Coche/décoche tous les colis de la page courante. */
  function togglePage(setter, selected, rows) {
    const ids = rows.map((p) => p.id);
    const allChecked = ids.length > 0 && ids.every((pid) => selected.has(pid));
    setter((prev) => {
      const next = new Set(prev);
      ids.forEach((pid) => (allChecked ? next.delete(pid) : next.add(pid)));
      return next;
    });
  }

  /** Colonnes communes d'une ligne colis (code, statut + date, ville, montants). */
  function renderCells(p, list) {
    return (
      <>
        <td>
          <div className="cell-main mono">{p.code || '—'}</div>
          <div className="cell-sub">{p.destinataire || '—'}</div>
        </td>
        <td>
          <span className="badge badge-neutral">{ligneStatut(p)}</span>
          <div className="cell-sub">{formatDate(p.statut_time)}</div>
        </td>
        <td>{p.ville || '—'}</td>
        <td>{formatMontant(p.crbt)}</td>
        <td>
          <FraisCell
            value={p.frais}
            editable={editable}
            title="Modifier le frais client de ce colis"
            onEdit={() => setFraisEdit({ list, field: 'frais', parcel: p })}
          />
        </td>
        <td>
          <FraisCell
            value={p.frais_supp}
            editable={editable}
            title="Modifier les frais supp de livraison de ce colis"
            onEdit={() => setFraisEdit({ list, field: 'frais_supp', parcel: p })}
          />
        </td>
        <td className={prixLigne(p) < 0 ? 'facture-negatif' : ''}>{formatMontant(prixLigne(p))}</td>
      </>
    );
  }

  if (loadError) {
    return (
      <div className="platform-page">
        <section className="platform-card">
          <div className="form-error">{loadError}</div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/facturation-clients/factures')}
          >
            <ArrowLeft size={15} /> Retour aux factures clients
          </button>
        </section>
      </div>
    );
  }

  const statut = facture ? factureClientStatut(facture.statut) : null;

  return (
    <div className="platform-page bon-edit-page">
      {/* Section 1 : informations de la facture. */}
      <section className="platform-card">
        <div className="bons-head">
          <h2>
            <FileText size={18} /> Information de la facture
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => navigate('/admin/facturation-clients/factures')}
          >
            <ArrowLeft size={15} /> Retour aux factures clients
          </button>
        </div>
        <div className={`bon-infos ${loading ? 'is-loading' : ''}`}>
          <div className="bon-info">
            <span className="field-label">Référence</span>
            <span className="cell-main mono">{facture?.ref || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Date de création</span>
            <span className="cell-main">{facture ? formatDate(facture.time) : '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Magasin</span>
            <span className="cell-main">{facture?.store || '…'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Client</span>
            <span className="cell-main">{facture?.client_name || '—'}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Statut</span>
            {statut && <span className={`badge ${statut.badge}`}>{statut.label}</span>}
          </div>
          <div className="bon-info">
            <span className="field-label">Nombre de colis</span>
            <span className="cell-main">{totaux.nb}</span>
          </div>
          <div className="bon-info">
            <span className="field-label">Frais supplémentaires</span>
            <span className="cell-main">{formatMontant(totalFrais)}</span>
          </div>
          {remise > 0 && (
            <div className="bon-info">
              <span className="field-label">Remise</span>
              <span className="cell-main">{formatMontant(remise)}</span>
            </div>
          )}
          <div className="bon-info">
            <span className="field-label">Montant total</span>
            <span className={`cell-main ${montantNet < 0 ? 'facture-negatif' : ''}`}>
              {formatMontant(montantNet)}
            </span>
          </div>
        </div>
        {facture && !editable && (
          <div className="form-error">
            Cette facture n'est plus en brouillon : la modification des colis est désactivée.
          </div>
        )}
      </section>

      {feedback && (
        <div className={`bon-feedback field-${feedback.type === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </div>
      )}

      {/* Section 2 : colis facturables du client, à ajouter à la facture. */}
      {editable && (
        <section className="platform-card">
          <h2>
            <PackagePlus size={18} /> Colis facturables du client ({dispoFiltres.length})
          </h2>
          <p className="cell-sub facture-hint">
            Colis livrés non facturés, et colis refusés ou annulés dont les frais de refus sont
            supérieurs à 0.
          </p>

          <div className="datatable-toolbar">
            <div className="datatable-search">
              <Search size={16} className="datatable-search-icon" />
              <input
                type="search"
                placeholder="Rechercher : code, ville, destinataire…"
                value={searchDispo}
                onChange={(e) => {
                  setSearchDispo(e.target.value);
                  dispoPager.setPage(1);
                }}
              />
            </div>
          </div>

          <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th className="bon-check-col">
                    <input
                      type="checkbox"
                      checked={
                        dispoPager.pageRows.length > 0 &&
                        dispoPager.pageRows.every((p) => selectedDispo.has(p.id))
                      }
                      onChange={() => togglePage(setSelectedDispo, selectedDispo, dispoPager.pageRows)}
                      title="Tout cocher / décocher"
                    />
                  </th>
                  <th>Code d'envoi</th>
                  <th>Statut</th>
                  <th>Ville</th>
                  <th>COD</th>
                  <th>Frais</th>
                  <th title="Frais supp de livraison (portés par le colis)">Frais supp</th>
                  <th>Prix</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {dispoFiltres.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={9} className="datatable-empty">
                      Aucun colis facturable pour ce client.
                    </td>
                  </tr>
                ) : (
                  dispoPager.pageRows.map((p) => (
                    <tr key={p.id}>
                      <td className="bon-check-col">
                        <input
                          type="checkbox"
                          checked={selectedDispo.has(p.id)}
                          onChange={() => toggleSet(setSelectedDispo, p.id)}
                        />
                      </td>
                      {renderCells(p, 'dispo')}
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => addByIds([p.id])}
                          disabled={busy}
                        >
                          <Plus size={14} /> Ajouter
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pager pager={dispoPager} />

          <div className="bon-bulk-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => addByIds([...selectedDispo])}
              disabled={busy || selectedDispo.size === 0}
            >
              <PackagePlus size={15} /> Ajouter la sélection ({selectedDispo.size})
            </button>
          </div>
        </section>
      )}

      {/* Section 3 : colis de la facture. */}
      <section className="platform-card">
        <h2>
          <ReceiptText size={18} /> Colis de la facture ({factureFiltres.length})
        </h2>

        <div className="datatable-toolbar">
          <div className="datatable-search">
            <Search size={16} className="datatable-search-icon" />
            <input
              type="search"
              placeholder="Rechercher : code, ville, destinataire…"
              value={searchFacture}
              onChange={(e) => {
                setSearchFacture(e.target.value);
                facturePager.setPage(1);
              }}
            />
          </div>
        </div>

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                {editable && (
                  <th className="bon-check-col">
                    <input
                      type="checkbox"
                      checked={
                        facturePager.pageRows.length > 0 &&
                        facturePager.pageRows.every((p) => selectedFacture.has(p.id))
                      }
                      onChange={() =>
                        togglePage(setSelectedFacture, selectedFacture, facturePager.pageRows)
                      }
                      title="Tout cocher / décocher"
                    />
                  </th>
                )}
                <th>Code d'envoi</th>
                <th>Statut</th>
                <th>Ville</th>
                <th>COD</th>
                <th>Frais</th>
                <th title="Frais supp de livraison (portés par le colis)">Frais supp</th>
                <th>Prix</th>
                {editable && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {factureFiltres.length === 0 && !loading ? (
                <tr>
                  <td colSpan={editable ? 9 : 7} className="datatable-empty">
                    Aucun colis dans cette facture.
                  </td>
                </tr>
              ) : (
                facturePager.pageRows.map((p) => (
                  <tr key={p.id}>
                    {editable && (
                      <td className="bon-check-col">
                        <input
                          type="checkbox"
                          checked={selectedFacture.has(p.id)}
                          onChange={() => toggleSet(setSelectedFacture, p.id)}
                        />
                      </td>
                    )}
                    {renderCells(p, 'facture')}
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm bon-btn-danger"
                          onClick={() => removeParcel(p)}
                          disabled={busy}
                          title="Retirer de la facture"
                        >
                          <Trash2 size={14} /> Retirer
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager pager={facturePager} />

        {editable && (
          <div className="bon-bulk-actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={removeSelection}
              disabled={busy || selectedFacture.size === 0}
            >
              <PackageX size={15} /> Retirer la sélection ({selectedFacture.size})
            </button>
          </div>
        )}
      </section>

      {/* Section 4 : frais supplémentaires du client — rattachés à la facture
          (application + legacy, déduits du montant total) + non rattachés,
          ajoutables / retirables tant que la facture est en brouillon (les
          frais legacy restent en lecture seule). */}
      <section className="platform-card">
        <h2>
          <HandCoins size={18} /> Frais supplémentaires ({factureFrais.length})
        </h2>
        <p className="cell-sub facture-hint">
          Frais du client : ceux rattachés à la facture sont déduits du montant total et suivent
          son statut ; les frais « Nouveau » non rattachés peuvent être ajoutés ou retirés tant que
          la facture est en brouillon. Les frais de l'ancien système restent en lecture seule.
        </p>

        <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Titre du frais</th>
                <th>Date frais</th>
                <th>Montant</th>
                {editable && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {factureFrais.length === 0 && (!editable || fraisDispo.length === 0) && !loading ? (
                <tr>
                  <td colSpan={editable ? 4 : 3} className="datatable-empty">
                    Aucun frais supplémentaire pour ce client.
                  </td>
                </tr>
              ) : (
                <>
                  {factureFrais.map((f) => (
                    <tr key={f.id}>
                      <td>
                        {f.titre}
                        {f.legacy && <span className="cell-sub"> (ancien système)</span>}
                      </td>
                      <td>{formatJour(f.date_frais)}</td>
                      <td>{formatMontant(f.montant)}</td>
                      {editable && (
                        <td>
                          {!f.legacy && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm bon-btn-danger"
                              onClick={() => retirerFrais(f)}
                              disabled={busy}
                              title="Retirer ce frais de la facture"
                            >
                              <Trash2 size={14} /> Retirer
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {factureFrais.length > 0 && (
                    <tr className="facture-total-row">
                      <td colSpan={2}>Total frais supplémentaires</td>
                      <td>{formatMontant(totalFrais)}</td>
                      {editable && <td />}
                    </tr>
                  )}
                  {editable &&
                    fraisDispo.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <div className="cell-main">{f.titre}</div>
                          <span className="badge badge-neutral">Non rattaché</span>
                        </td>
                        <td>{formatJour(f.date_frais)}</td>
                        <td>{formatMontant(f.montant)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => ajouterFrais(f)}
                            disabled={busy}
                            title="Ajouter ce frais à la facture"
                          >
                            <Plus size={14} /> Ajouter
                          </button>
                        </td>
                      </tr>
                    ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {fraisEdit && (
        <FraisModal
          title={
            fraisEdit.field === 'frais_supp'
              ? 'Modifier les frais supp de livraison'
              : 'Modifier le frais client'
          }
          code={fraisEdit.parcel.code}
          value={
            fraisEdit.field === 'frais_supp' ? fraisEdit.parcel.frais_supp : fraisEdit.parcel.frais
          }
          onSave={saveFrais}
          onClose={() => setFraisEdit(null)}
        />
      )}
    </div>
  );
}
