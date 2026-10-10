import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Package,
  PackagePlus,
  Warehouse,
  Eraser,
  Save,
  Coins,
  Plus,
  Minus,
  Search,
  X,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import TauxLivraisonDestinataire from '../../components/TauxLivraisonDestinataire';
import { isValidPhone, normalizePhone, PHONE_ERROR } from '../../utils/phone';
import { isValidParcelCode, PARCEL_CODE_ERROR } from '../../utils/parcelCode';

/** État initial des champs de saisie du formulaire. */
function emptyForm() {
  return {
    code: '',
    receiver: '',
    phone: '',
    city: '',
    address: '',
    price: '',
    product: '',
    qty: '',
    note: ''
  };
}

/**
 * Petite fenêtre de notification (succès ou erreur) affichée par-dessus la
 * page après la soumission du formulaire. Se ferme automatiquement au bout de
 * quelques secondes (ou au clic).
 */
function FlashModal({ flash, onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, flash.type === 'success' ? 3000 : 4000);
    return () => clearTimeout(timer);
  }, [flash, onClose]);

  return (
    <div className="flash-overlay" onClick={onClose}>
      <div
        className={`flash-modal ${flash.type === 'success' ? 'flash-success' : 'flash-error'}`}
        role="alert"
        onClick={(e) => e.stopPropagation()}
      >
        {flash.type === 'success' ? <CheckCircle2 size={36} /> : <AlertTriangle size={36} />}
        <p>{flash.message}</p>
      </div>
    </div>
  );
}

/** Boutons Oui / Non d'une option du colis (échange, ouverture, essayage). */
function OuiNon({ value, onChange, label, disabled = false }) {
  return (
    <div className={`np-ouinon ${disabled ? 'np-ouinon-disabled' : ''}`} role="group" aria-label={label}>
      <button
        type="button"
        className={`np-ouinon-btn ${value ? 'np-ouinon-oui' : ''}`}
        disabled={disabled}
        onClick={() => onChange(true)}
      >
        Oui
      </button>
      <button
        type="button"
        className={`np-ouinon-btn ${!value ? 'np-ouinon-non' : ''}`}
        disabled={disabled}
        onClick={() => onChange(false)}
      >
        Non
      </button>
    </div>
  );
}

/**
 * Modale « Ajouter produit de stock » : tableau des produits actifs du client
 * (API /stock/client/produits). Le bouton + réserve une unité pour le colis
 * (le stock affiché diminue d'autant), le bouton − la retire. « Enregistrer »
 * renvoie la sélection à la page ; rien n'est écrit en base à ce stade — le
 * stock n'est réellement déduit qu'à l'enregistrement du colis.
 */
function StockProduitsModal({ selection, onClose, onSave }) {
  const [produits, setProduits] = useState(null);
  const [error, setError] = useState('');
  const [recherche, setRecherche] = useState('');
  // Quantités choisies par produit (id → quantité), reprises de la sélection courante.
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(selection.map((p) => [p.id, p.qty]))
  );

  useEffect(() => {
    api
      .get('/stock/client/produits')
      .then((res) => setProduits(res.data.filter((p) => Number(p.active) === 1)))
      .catch((err) => setError(err.response?.data?.message || 'Erreur de chargement des produits.'));
  }, []);

  const visibles = useMemo(() => {
    if (!produits) return [];
    const q = recherche.trim().toLowerCase();
    if (!q) return produits;
    return produits.filter((p) =>
      [p.nom, p.ref].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }, [produits, recherche]);

  function ajouter(p) {
    setQtys((prev) => {
      const qty = Number(prev[p.id]) || 0;
      if (qty >= (Number(p.stock) || 0)) return prev;
      return { ...prev, [p.id]: qty + 1 };
    });
  }

  function retirer(p) {
    setQtys((prev) => {
      const qty = Number(prev[p.id]) || 0;
      if (qty <= 0) return prev;
      return { ...prev, [p.id]: qty - 1 };
    });
  }

  function save() {
    const list = (produits || [])
      .filter((p) => (Number(qtys[p.id]) || 0) > 0)
      .map((p) => ({ id: p.id, nom: p.nom, ref: p.ref, qty: Number(qtys[p.id]) }));
    onSave(list);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-stock" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Warehouse size={18} />
            <div className="cell-main">Ajouter produit de stock</div>
          </div>
          <button type="button" className="row-action" onClick={onClose} title="Fermer">
            <X size={18} />
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}
        {!error && !produits && <p className="modal-loading">Chargement…</p>}

        {produits && (
          <>
            <div className="datatable-search">
              <Search size={16} className="datatable-search-icon" />
              <input
                type="text"
                placeholder="Rechercher : produit, réf…"
                value={recherche}
                onChange={(e) => setRecherche(e.target.value)}
              />
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nom du produit</th>
                    <th>Stock disponible</th>
                    <th>Quantité ajoutée au colis</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="datatable-empty">
                        Aucun produit trouvé.
                      </td>
                    </tr>
                  ) : (
                    visibles.map((p) => {
                      const qty = Number(qtys[p.id]) || 0;
                      const restant = Math.max(0, (Number(p.stock) || 0) - qty);
                      return (
                        <tr key={p.id}>
                          <td>
                            {p.nom || '—'}
                            {p.ref ? ` (${p.ref})` : ''}
                          </td>
                          <td>
                            <div className="stock-cell">
                              <span>{restant}</span>
                              <button
                                type="button"
                                className="row-action row-action-success"
                                title="Ajouter au colis"
                                onClick={() => ajouter(p)}
                                disabled={restant <= 0}
                              >
                                <Plus size={16} />
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="stock-cell">
                              <button
                                type="button"
                                className="row-action row-action-danger"
                                title="Réduire la quantité"
                                onClick={() => retirer(p)}
                                disabled={qty <= 0}
                              >
                                <Minus size={16} />
                              </button>
                              <span className={qty > 0 ? 'stock-qty-active' : ''}>{qty}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Annuler
              </button>
              <button type="button" className="btn btn-primary btn-icon" onClick={save}>
                <Save size={16} /> Enregistrer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Page /client/nouveau-colis — saisie d'un nouveau colis par le client.
 * Type "Colis normal" / "Colis de stock" (parcel_from_stock) choisi en haut :
 * en mode stock, les champs produit et quantité sont remplacés par le bouton
 * « Ajouter produit de stock » (modale de sélection dans le stock du client ;
 * les quantités sont déduites du stock à l'enregistrement du colis). Les options
 * « ouverture » et « essayage » sont préremplies avec les valeurs par défaut
 * du compte (customers_default_open / customers_default_essayage).
 * Attention : les options affichées sont « interdire l'ouverture » et
 * « interdire l'essayage », alors qu'en base parcel_open = 1 / parcel_essayage
 * = 1 signifient autorisé — les valeurs envoyées sont donc inversées.
 * « Interdire l'essayage » est préremplie depuis la configuration du compte
 * (customers_default_essayage = 0 → interdit) et liée à « interdire
 * l'ouverture » : ouverture interdite → essayage interdit, non modifiable.
 */
export default function NouveauColis() {
  const [cities, setCities] = useState([]);
  const [defaults, setDefaults] = useState({ open: false, essayage: false });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [fromStock, setFromStock] = useState(false);
  // Produits de stock sélectionnés pour le colis : [{ id, nom, ref, qty }].
  const [stockProduits, setStockProduits] = useState([]);
  const [stockModal, setStockModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [replace, setReplace] = useState(false);
  const [interdireOuverture, setInterdireOuverture] = useState(false);
  const [interdireEssayage, setInterdireEssayage] = useState(true);

  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Fenêtre de notification auto-fermante : { type: 'success' | 'error', message }.
  const [flash, setFlash] = useState(null);

  // Tarifs de la ville sélectionnée (livraison / retour / refusé / délai).
  const [tarif, setTarif] = useState(null);
  const [tarifError, setTarifError] = useState('');

  useEffect(() => {
    if (!form.city) {
      setTarif(null);
      setTarifError('');
      return;
    }
    let cancelled = false;
    api
      .get('/parcels/client/tarif', { params: { city: form.city } })
      .then((res) => {
        if (!cancelled) {
          setTarif(res.data);
          setTarifError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTarif(null);
          setTarifError(err.response?.data?.message || 'Tarifs indisponibles pour cette ville.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form.city]);

  useEffect(() => {
    api
      .get('/parcels/client/new')
      .then((res) => {
        // def.essayage = interdire l'essayage par défaut (colonne inversée :
        // customers_default_essayage = 1 signifie essayage autorisé).
        const def = {
          open: Number(res.data.default_open) === 1,
          essayage: Number(res.data.default_essayage) === 0
        };
        setCities(res.data.cities.map((c) => ({ value: c.id, label: c.label })));
        setDefaults(def);
        setInterdireOuverture(def.open);
        setInterdireEssayage(def.open ? true : def.essayage);
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, []);

  function setField(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setFieldErrors((e) => (e[field] ? { ...e, [field]: '' } : e));
  }

  function resetForm() {
    setForm(emptyForm());
    setStockProduits([]);
    setReplace(false);
    setInterdireOuverture(defaults.open);
    setInterdireEssayage(defaults.open ? true : defaults.essayage);
    setFieldErrors({});
    setError('');
  }

  /* Ouverture interdite → essayage forcément interdit (verrouillé) ;
     déverrouillage → retour à la valeur par défaut configurée. */
  function changeInterdireOuverture(v) {
    setInterdireOuverture(v);
    setInterdireEssayage(v ? true : defaults.essayage);
  }

  function handleReset() {
    if (window.confirm('Effacer toutes les informations saisies dans le formulaire ?')) {
      resetForm();
    }
  }

  function validate() {
    const errors = {};
    // Code colis facultatif (généré si vide) ; saisi = lettres et chiffres, 5 min.
    if (form.code.trim() && !isValidParcelCode(form.code.trim())) errors.code = PARCEL_CODE_ERROR;
    if (!form.receiver.trim()) errors.receiver = 'Le nom du destinataire est obligatoire.';
    if (!form.phone.trim()) {
      errors.phone = 'Le téléphone du destinataire est obligatoire.';
    } else if (!isValidPhone(form.phone)) {
      errors.phone = PHONE_ERROR;
    }
    if (!form.city) errors.city = 'Veuillez sélectionner une ville.';
    if (!form.address.trim()) errors.address = "L'adresse est obligatoire.";
    const price = Number(form.price);
    if (form.price === '' || !Number.isFinite(price) || price < 0) {
      errors.price = 'Veuillez saisir le montant total du colis.';
    } else if (!Number.isInteger(price)) {
      errors.price = 'Le montant doit être un nombre entier, sans virgule (ex. 250).';
    }
    if (!fromStock && form.qty !== '' && (!Number.isInteger(Number(form.qty)) || Number(form.qty) <= 0)) {
      errors.qty = 'Quantité invalide.';
    }
    if (fromStock && stockProduits.length === 0) {
      errors.stockProduits = 'Veuillez ajouter au moins un produit de stock au colis.';
    }
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setFlash(null);
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFlash({ type: 'error', message: 'Veuillez vérifier les champs erronés du formulaire.' });
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/parcels/client', {
        code: form.code.trim(),
        receiver: form.receiver.trim(),
        phone: normalizePhone(form.phone),
        city: Number(form.city),
        address: form.address.trim(),
        price: Number(form.price),
        product: fromStock ? '' : form.product.trim(),
        qty: fromStock ? '' : form.qty,
        note: form.note.trim(),
        products: fromStock ? stockProduits.map((p) => ({ id: p.id, qty: p.qty })) : [],
        fromStock: fromStock ? 1 : 0,
        replace: replace ? 1 : 0,
        open: interdireOuverture ? 0 : 1,
        essayage: interdireEssayage ? 0 : 1
      });
      resetForm();
      setFlash({
        type: 'success',
        message: `Colis « ${res.data.parcel_code} » enregistré avec succès.`
      });
    } catch (err) {
      const message = err.response?.data?.message || "Erreur lors de l'enregistrement du colis.";
      setError(message);
      setFlash({ type: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="modal-loading">Chargement…</div>;
  if (loadError) return <div className="form-error">{loadError}</div>;

  return (
    <div className="np-page">
      <div className="np-header">
        <Link to="/client/colis" className="btn btn-ghost btn-icon">
          <Package size={16} /> Liste des colis
        </Link>
        <div className="np-type-switch" role="group" aria-label="Type de colis">
          <button
            type="button"
            className={`np-type-btn ${!fromStock ? 'np-type-active' : ''}`}
            onClick={() => setFromStock(false)}
          >
            <PackagePlus size={15} /> Colis normal
          </button>
          <button
            type="button"
            className={`np-type-btn ${fromStock ? 'np-type-active' : ''}`}
            onClick={() => setFromStock(true)}
          >
            <Warehouse size={15} /> Colis de stock
          </button>
        </div>
      </div>

      <form className="platform-card np-card" onSubmit={handleSubmit} noValidate>
        <h2>
          <PackagePlus size={18} /> Nouveau colis {fromStock ? 'de stock' : 'normal'}
        </h2>

        <div className="np-grid">
          <label className="np-field np-field-full">
            <span className="field-label">Code colis</span>
            <input
              type="text"
              value={form.code}
              maxLength={100}
              placeholder="Code personnalisé"
              onChange={(e) => setField('code', e.target.value)}
            />
            <span className="np-hint">
              Laisser vide si vous n'avez pas de codes personnalisés. Sinon : lettres et chiffres
              uniquement, 5 caractères minimum.
            </span>
            {fieldErrors.code && <span className="field-error">{fieldErrors.code}</span>}
          </label>

          <label className="np-field">
            <span className="field-label">
              Nom du destinataire <span className="np-required">*</span>
            </span>
            <input
              type="text"
              value={form.receiver}
              maxLength={250}
              placeholder="Nom complet du destinataire"
              onChange={(e) => setField('receiver', e.target.value)}
            />
            {fieldErrors.receiver && <span className="field-error">{fieldErrors.receiver}</span>}
          </label>

          <label className="np-field">
            <span className="field-label">
              Téléphone du destinataire <span className="np-required">*</span>
            </span>
            <input
              type="tel"
              value={form.phone}
              maxLength={50}
              placeholder="0600000000"
              onChange={(e) => setField('phone', e.target.value)}
            />
            {fieldErrors.phone && <span className="field-error">{fieldErrors.phone}</span>}
            <TauxLivraisonDestinataire phone={form.phone} endpoint="/parcels/client/destinataire" />
          </label>

          <div className="np-field">
            <span className="field-label">
              Ville <span className="np-required">*</span>
            </span>
            <SearchableSelect
              value={form.city}
              onChange={(v) => setField('city', v)}
              options={cities}
              placeholder="— Sélectionner une ville —"
            />
            {fieldErrors.city && <span className="field-error">{fieldErrors.city}</span>}
          </div>

          <label className="np-field">
            <span className="field-label">
              Adresse <span className="np-required">*</span>
            </span>
            <input
              type="text"
              value={form.address}
              maxLength={2000}
              placeholder="Adresse de livraison"
              onChange={(e) => setField('address', e.target.value)}
            />
            {fieldErrors.address && <span className="field-error">{fieldErrors.address}</span>}
          </label>

          <label className="np-field np-field-quarter">
            <span className="field-label">
              CRBT (montant) <span className="np-required">*</span>
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={form.price}
              placeholder="Montant total"
              onChange={(e) => setField('price', e.target.value)}
            />
            {fieldErrors.price && <span className="field-error">{fieldErrors.price}</span>}
          </label>

          <label className="np-field np-field-rest">
            <span className="field-label">Commentaire</span>
            <textarea
              rows={3}
              value={form.note}
              maxLength={2000}
              placeholder="Autre n° de téléphone, heures de disponibilité…"
              onChange={(e) => setField('note', e.target.value)}
            />
          </label>

          {!fromStock && (
            <div className="np-row-produit">
              <label className="np-field">
                <span className="field-label">Produit</span>
                <input
                  type="text"
                  value={form.product}
                  maxLength={250}
                  placeholder="Nom du produit (facultatif)"
                  onChange={(e) => setField('product', e.target.value)}
                />
              </label>
              <label className="np-field">
                <span className="field-label">Quantité</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.qty}
                  placeholder="1"
                  onChange={(e) => setField('qty', e.target.value)}
                />
                {fieldErrors.qty && <span className="field-error">{fieldErrors.qty}</span>}
              </label>
            </div>
          )}

          {fromStock && (
            <div className="np-field np-field-full np-stock">
              <span className="field-label">
                Produits de stock <span className="np-required">*</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-icon np-stock-btn"
                onClick={() => setStockModal(true)}
              >
                <Warehouse size={16} /> Ajouter produit de stock
              </button>
              {fieldErrors.stockProduits && (
                <span className="field-error">{fieldErrors.stockProduits}</span>
              )}
              {stockProduits.length > 0 && (
                <div className="np-stock-list">
                  {stockProduits.map((p) => (
                    <div key={p.id} className="np-stock-item">
                      <span>
                        {p.nom || '—'}
                        {p.ref ? ` (${p.ref})` : ''}
                      </span>
                      <span className="np-stock-item-qte">× {p.qty}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="np-tarifs">
          <div className="np-tarifs-head">
            <Coins size={14} /> Tarifs de la ville sélectionnée
          </div>
          {!form.city ? (
            <div className="np-tarifs-empty">
              Sélectionnez une ville pour afficher les frais et le délai de livraison.
            </div>
          ) : tarifError ? (
            <div className="np-tarifs-empty">{tarifError}</div>
          ) : (
            <div className="np-tarifs-grid">
              <div className="np-tarif">
                <span className="np-tarif-label">Frais de livraison</span>
                <span className="np-tarif-value">{tarif ? `${tarif.livraison} DH` : '…'}</span>
              </div>
              <div className="np-tarif">
                <span className="np-tarif-label">Frais de retour</span>
                <span className="np-tarif-value">{tarif ? `${tarif.retour} DH` : '…'}</span>
              </div>
              <div className="np-tarif">
                <span className="np-tarif-label">Frais de refusé</span>
                <span className="np-tarif-value">{tarif ? `${tarif.refuse} DH` : '…'}</span>
              </div>
              <div className="np-tarif">
                <span className="np-tarif-label">Délai de livraison</span>
                <span className="np-tarif-value">{tarif ? tarif.delai || '--' : '…'}</span>
              </div>
            </div>
          )}
        </div>

        <div className="np-flags">
          <div className="np-flag">
            <span className="np-flag-label">Colis à remplacer (échange)</span>
            <OuiNon value={replace} onChange={setReplace} label="Colis à remplacer (échange)" />
          </div>
          <div className="np-flag">
            <span className="np-flag-label">
              Interdire l'ouverture
              <span className="np-flag-ar" dir="rtl">لا يسمح بفتح الطلبية</span>
            </span>
            <OuiNon
              value={interdireOuverture}
              onChange={changeInterdireOuverture}
              label="Interdire l'ouverture"
            />
          </div>
          <div className="np-flag">
            <span className="np-flag-label">
              Interdire l'essayage
              <span className="np-flag-ar" dir="rtl">لا يسمح بالتجربة او القياس</span>
              {interdireOuverture && (
                <span className="np-flag-locked">verrouillé : ouverture interdite</span>
              )}
            </span>
            <OuiNon
              value={interdireEssayage}
              onChange={setInterdireEssayage}
              label="Interdire l'essayage"
              disabled={interdireOuverture}
            />
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="np-footer">
          <button type="button" className="btn btn-ghost btn-icon" onClick={handleReset}>
            <Eraser size={16} /> Réinitialiser
          </button>
          <button type="submit" className="btn btn-primary btn-icon" disabled={saving}>
            <Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>

      {stockModal && (
        <StockProduitsModal
          selection={stockProduits}
          onClose={() => setStockModal(false)}
          onSave={(list) => {
            setStockProduits(list);
            setFieldErrors((e) => (e.stockProduits ? { ...e, stockProduits: '' } : e));
          }}
        />
      )}

      {flash && <FlashModal flash={flash} onClose={() => setFlash(null)} />}
    </div>
  );
}
