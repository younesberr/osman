import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  PackagePlus,
  Store,
  Trash2,
  Upload,
  Eraser,
  Warehouse
} from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';
import { autoFixPhone, isValidPhone } from '../../utils/phone';

const MAX_ROWS = 500;

/** En-têtes du modèle Excel, dans l'ordre des colonnes du fichier. */
function templateHeaders(fromStock) {
  return [
    'CODE SUIVI',
    'DESTINATAIRE',
    'TELEPHONE',
    'VILLE',
    'ADRESSE',
    'PRIX',
    'COMMENTAIRE',
    fromStock ? 'REF PRODUIT' : 'PRODUIT',
    'QUANTITE',
    'COLIS A REMPLACER',
    'PEUT OUVRIR',
    'PEUT ESSAYER'
  ];
}

/** Normalise un texte pour la comparaison : majuscules, sans accents ni ponctuation. */
function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/* En-têtes reconnus dans le fichier importé (après normalisation) → champ interne.
   Les variantes courantes sont acceptées (QTE/QTY, MARCHANDISE, REF, OUVRIR…). */
const HEADER_FIELDS = {
  'CODE SUIVI': 'code',
  CODE: 'code',
  DESTINATAIRE: 'receiver',
  TELEPHONE: 'phone',
  TEL: 'phone',
  VILLE: 'ville',
  ADRESSE: 'address',
  PRIX: 'price',
  COMMENTAIRE: 'note',
  QUANTITE: 'qty',
  QTE: 'qty',
  QTY: 'qty',
  'COLIS A REMPLACER': 'replace',
  REMPLACER: 'replace',
  'PEUT OUVRIR': 'open',
  OUVRIR: 'open',
  'PEUT ESSAYER': 'essayage',
  ESSAYER: 'essayage',
  ESSAYAGE: 'essayage'
};

/* Colonne marchandise selon le type d'import : produit libre (colis normal)
   ou référence d'un produit du stock du client (colis de stock). */
const PRODUCT_HEADER_FIELDS = {
  PRODUIT: 'product',
  MARCHANDISE: 'product'
};
const REF_HEADER_FIELDS = {
  'REF PRODUIT': 'ref',
  REF: 'ref',
  REFERENCE: 'ref',
  'REFERENCE PRODUIT': 'ref'
};

/** Champs dont l'en-tête doit obligatoirement figurer dans le fichier. */
const REQUIRED_HEADERS = [
  ['receiver', 'DESTINATAIRE'],
  ['phone', 'TELEPHONE'],
  ['ville', 'VILLE'],
  ['address', 'ADRESSE'],
  ['price', 'PRIX']
];

/**
 * Interprète une cellule Oui/Non : 'OUI' / 'NON' si reconnue, null si vide
 * (→ valeur par défaut), undefined si la valeur n'est pas reconnue.
 */
function parseOuiNon(raw) {
  const v = normalize(raw);
  if (!v) return null;
  if (['OUI', 'YES', 'O', 'Y', '1', 'TRUE', 'VRAI'].includes(v)) return 'OUI';
  if (['NON', 'NO', 'N', '0', 'FALSE', 'FAUX'].includes(v)) return 'NON';
  return undefined;
}

/** Sélecteur Oui/Non d'une cellule du tableau d'import. */
function CellOuiNon({ value, onChange, disabled = false, label }) {
  return (
    <select
      className="ic-select"
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="OUI">OUI</option>
      <option value="NON">NON</option>
    </select>
  );
}

/**
 * Page partagée /admin/import-colis/normal et /admin/import-colis/stock —
 * importation de colis depuis un fichier Excel, au nom d'un client (magasin).
 * 1. Bouton de téléchargement du modèle Excel (ligne d'en-têtes seule).
 * 2. « Importer Excel » : le fichier est lu côté navigateur (librairie xlsx
 *    chargée à la demande) et affiché dans un tableau entièrement éditable.
 *    Les valeurs non reconnues (ville inconnue, prix ou quantité invalide,
 *    Oui/Non illisible) laissent le champ vide et sont rappelées sous celui-ci.
 *    Cellules vides → valeurs par défaut : quantité 1, OUVRIR = OUI,
 *    REMPLACER / ESSAYER = NON. TELEPHONE : normalisé à la lecture (chiffres
 *    seuls, indicatif +212 / 212 / 00212 remplacé par 0, 0 initial ajouté s'il
 *    manque — cellule numérique) ; un numéro toujours invalide reste dans le
 *    champ, la valeur du fichier rappelée en rouge dessous, et bloque l'étape 3.
 * 3. « Ajouter les colis » : validation de toutes les lignes (destinataire,
 *    téléphone, ville, adresse et prix obligatoires) puis création en masse.
 * Colis normal (fromStock = false) : colonne PRODUIT libre et facultative,
 * POST /parcels/import. Colis de stock (fromStock = true) : colonne REF PRODUIT
 * obligatoire — la cellule du tableau est une liste déroulante avec recherche
 * (comme la ville) proposant les réfs des produits actifs du client choisi ;
 * la réf lue dans le fichier est appariée automatiquement, une réf inconnue
 * (ou d'un autre client) laisse la liste vide et est rappelée en rouge sous le
 * champ ; le nom et le stock du produit choisi s'affichent sous la réf ; le
 * stock est vérifié (cumul du fichier) puis déduit à la création ;
 * POST /parcels/import/stock.
 * forClient = true : mêmes pages sur le dashboard client
 * (/client/import-colis/normal et /stock) — pas de liste des clients, les
 * colis sont ceux du client connecté (villes via /parcels/client/new, produits
 * via /stock/client/produits, création via /parcels/client/import[/stock]).
 */
export default function ImportColisPage({ fromStock = false, forClient = false }) {
  const [magasins, setMagasins] = useState([]);
  const [cities, setCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [customer, setCustomer] = useState('');
  // Produits du client choisi (mode stock) : null tant qu'ils ne sont pas chargés.
  const [products, setProducts] = useState(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [customerError, setCustomerError] = useState('');
  const [error, setError] = useState('');
  // Erreur du clic « Ajouter les colis » : affichée à côté du bouton, pas en
  // haut de page (invisible avec un long tableau).
  const [submitError, setSubmitError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const request = forClient
      ? // Dashboard client : villes actives du formulaire "Nouveau colis".
        api.get('/parcels/client/new').then((res) => {
          setCities(res.data.cities.map((c) => ({ value: c.id, label: c.label })));
        })
      : api.get('/parcels/import/data').then((res) => {
          setMagasins(res.data.magasins.map((m) => ({ value: m.id, label: m.label })));
          setCities(res.data.cities.map((c) => ({ value: c.id, label: c.label })));
        });
    request
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement.'))
      .finally(() => setLoading(false));
  }, [forClient]);

  /* Mode stock : produits actifs pour valider les réfs saisies — ceux du
     client choisi (admin) ou du client connecté (dashboard client). */
  useEffect(() => {
    if (!fromStock || (!forClient && !customer)) {
      setProducts(null);
      return;
    }
    let cancelled = false;
    setProducts(null);
    const request = forClient
      ? api
          .get('/stock/client/produits')
          .then((res) => res.data.filter((p) => Number(p.active) === 1))
      : api.get('/parcels/import/stock/products', { params: { customer } }).then((res) => res.data);
    request
      .then((list) => {
        if (!cancelled) setProducts(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Erreur de chargement des produits du client.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fromStock, forClient, customer]);

  /* Villes indexées pour retrouver la ville saisie dans le fichier : nom exact
     (minuscules) et nom normalisé (préfixé « # » — les noms non latins, ex.
     arabes, se normalisent en chaîne vide et ne doivent pas se confondre). */
  const cityByName = useMemo(() => {
    const map = new Map();
    for (const c of cities) {
      map.set(String(c.label).trim().toLowerCase(), c.value);
      const key = normalize(c.label);
      if (key) map.set(`#${key}`, c.value);
    }
    return map;
  }, [cities]);

  /* Produits indexés par réf (minuscules) pour apparier la réf lue dans le
     fichier. Une réf portée par plusieurs produits du client est ambiguë →
     marquée 'DUP', non appariée automatiquement (choix manuel dans la liste). */
  const productByRef = useMemo(() => {
    const map = new Map();
    for (const p of products || []) {
      const key = String(p.ref || '').trim().toLowerCase();
      if (!key) continue;
      map.set(key, map.has(key) ? 'DUP' : p);
    }
    return map;
  }, [products]);

  /* Produits indexés par id (valeur de la liste déroulante des réfs). */
  const productById = useMemo(() => {
    const map = new Map();
    for (const p of products || []) map.set(Number(p.id), p);
    return map;
  }, [products]);

  /* Options de la liste déroulante des réfs : toutes les réfs des produits
     actifs du client choisi (un produit sans réf reste sélectionnable par nom). */
  const productOptions = useMemo(
    () =>
      (products || []).map((p) => ({
        value: p.id,
        label: p.ref ? String(p.ref) : `(sans réf) ${p.nom}`
      })),
    [products]
  );

  /* À l'arrivée des produits du client (sélection ou changement de client) :
     ré-apparie chaque ligne — la réf du fichier retrouve son produit ; un choix
     manuel devenu invalide (autre client) est remis à zéro et la réf du fichier
     est rappelée en rouge sous le champ. */
  useEffect(() => {
    if (!fromStock || products === null) return;
    const byRef = new Map();
    for (const p of products) {
      const key = String(p.ref || '').trim().toLowerCase();
      if (!key) continue;
      byRef.set(key, byRef.has(key) ? 'DUP' : p);
    }
    const byId = new Map(products.map((p) => [Number(p.id), p]));
    setRows((prev) =>
      prev.map((row) => {
        if (row.productId !== '' && byId.has(Number(row.productId))) return row;
        const next = { ...row, productId: '', excel: { ...row.excel } };
        const match = row.ref ? byRef.get(row.ref.trim().toLowerCase()) : undefined;
        if (match && match !== 'DUP') {
          next.productId = match.id;
          delete next.excel.productId;
        } else if (row.ref) {
          next.excel.productId = row.ref;
        }
        return next;
      })
    );
  }, [fromStock, products]);

  /* Colonnes reconnues selon le type d'import. */
  const headerFields = useMemo(
    () => ({ ...HEADER_FIELDS, ...(fromStock ? REF_HEADER_FIELDS : PRODUCT_HEADER_FIELDS) }),
    [fromStock]
  );
  const requiredHeaders = useMemo(
    () => (fromStock ? [...REQUIRED_HEADERS, ['ref', 'REF PRODUIT']] : REQUIRED_HEADERS),
    [fromStock]
  );

  /** Télécharge le modèle Excel (ligne d'en-têtes seule). */
  async function downloadTemplate() {
    const XLSX = await import('xlsx');
    const headers = templateHeaders(fromStock);
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 2, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Colis');
    XLSX.writeFile(wb, fromStock ? 'modele_import_colis_stock.xlsx' : 'modele_import_colis.xlsx');
  }

  /**
   * Transforme une ligne du fichier en ligne du tableau. Les valeurs invalides
   * laissent le champ vide (ou à sa valeur par défaut pour les Oui/Non) et sont
   * conservées dans `excel` pour être affichées sous le champ concerné.
   */
  function buildRow(cells, rawCells, colFields) {
    const raw = {};
    for (let c = 0; c < colFields.length; c += 1) {
      const field = colFields[c];
      if (field) raw[field] = String(cells[c] ?? '').trim();
    }
    /* Code suivi et téléphone d'une cellule numérique : valeur brute plutôt que
       le texte formaté par Excel — un nombre de 12 chiffres ou plus s'affiche
       « 2,12612E+11 » et perdrait des chiffres. */
    for (const field of ['code', 'phone']) {
      const col = colFields.lastIndexOf(field);
      const value = col === -1 ? undefined : rawCells[col];
      if (typeof value === 'number' && Number.isFinite(value)) raw[field] = String(value);
    }

    const row = {
      code: raw.code || '',
      receiver: raw.receiver || '',
      phone: '',
      address: raw.address || '',
      note: raw.note || '',
      product: raw.product || '',
      // Mode stock : réf brute du fichier (sert au ré-appariement) + produit apparié.
      ref: raw.ref || '',
      productId: '',
      city: '',
      price: '',
      qty: '1',
      replace: 'NON',
      open: 'OUI',
      essayage: 'NON',
      excel: {}
    };

    if (raw.ville) {
      const key = normalize(raw.ville);
      const id = cityByName.get(raw.ville.trim().toLowerCase())
        ?? (key ? cityByName.get(`#${key}`) : undefined);
      if (id !== undefined) row.city = id;
      else row.excel.city = raw.ville;
    }

    /* Téléphone : chiffres seuls, indicatif +212 / 212 / 00212 remplacé par 0,
       0 initial ajouté s'il manque. Un numéro toujours invalide reste dans le
       champ (à corriger) et la valeur du fichier est rappelée en rouge dessous. */
    if (raw.phone) {
      row.phone = autoFixPhone(raw.phone);
      if (!isValidPhone(row.phone)) row.excel.phone = raw.phone;
    }

    if (raw.price) {
      const price = Number(raw.price.replace(/\s/g, '').replace(',', '.'));
      if (Number.isFinite(price) && price >= 0) row.price = String(price);
      else row.excel.price = raw.price;
    }

    if (raw.qty) {
      const qty = Number(raw.qty);
      if (Number.isInteger(qty) && qty > 0) row.qty = String(qty);
      else {
        row.qty = '';
        row.excel.qty = raw.qty;
      }
    }

    /* Réf produit : appariée aux produits du client si déjà chargés (sinon le
       ré-appariement se fera à leur arrivée) ; réf inconnue ou ambiguë →
       liste vide et réf du fichier rappelée en rouge sous le champ. */
    if (fromStock && raw.ref) {
      const match = productByRef.get(raw.ref.trim().toLowerCase());
      if (match && match !== 'DUP') row.productId = match.id;
      else row.excel.productId = raw.ref;
    }

    for (const field of ['replace', 'open', 'essayage']) {
      if (raw[field] === undefined) continue;
      const parsed = parseOuiNon(raw[field]);
      if (parsed) row[field] = parsed;
      else if (parsed === undefined) row.excel[field] = raw[field];
    }
    // Ouverture interdite → essayage forcément interdit.
    if (row.open === 'NON') row.essayage = 'NON';

    return row;
  }

  /** Lit le fichier Excel choisi et remplit le tableau d'import. */
  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setSubmitError('');
    setSuccess('');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer());
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) : [];
      // Mêmes lignes en valeurs brutes (nombres non formatés) — voir buildRow.
      const gridRaw = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) : [];

      // Première ligne non vide = en-têtes ; colonnes reconnues via headerFields.
      const headerIndex = grid.findIndex((cells) => cells.some((c) => String(c).trim() !== ''));
      const colFields = headerIndex === -1
        ? []
        : grid[headerIndex].map((cell) => headerFields[normalize(cell)] || null);

      const missing = requiredHeaders
        .filter(([field]) => !colFields.includes(field))
        .map(([, label]) => label);
      if (missing.length) {
        setError(
          `Colonnes introuvables dans le fichier : ${missing.join(', ')}. ` +
            'Veuillez utiliser le modèle Excel fourni.'
        );
        return;
      }

      const dataRows = grid
        .slice(headerIndex + 1)
        .map((cells, i) => ({ cells, rawCells: gridRaw[headerIndex + 1 + i] || [] }))
        .filter(({ cells }) => cells.some((c) => String(c).trim() !== ''));
      if (!dataRows.length) {
        setError('Le fichier ne contient aucune ligne de colis.');
        return;
      }
      if (dataRows.length > MAX_ROWS) {
        setError(`Import limité à ${MAX_ROWS} colis à la fois (${dataRows.length} lignes dans le fichier).`);
        return;
      }

      setRows(dataRows.map(({ cells, rawCells }) => buildRow(cells, rawCells, colFields)));
      setFileName(file.name);
      setFieldErrors({});
    } catch {
      setError('Impossible de lire ce fichier. Veuillez importer un fichier Excel (.xlsx).');
    }
  }

  /** Met à jour un champ d'une ligne (efface son erreur et sa valeur Excel rejetée). */
  function setCell(index, field, value) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, [field]: value, excel: { ...row.excel } };
        delete next.excel[field];
        if (field === 'open' && value === 'NON') next.essayage = 'NON';
        return next;
      })
    );
    setFieldErrors((prev) => {
      const key = `${index}:${field}`;
      return prev[key] ? { ...prev, [key]: '' } : prev;
    });
    setSubmitError('');
    setSuccess('');
  }

  function removeRow(index) {
    setRows((prev) => prev.filter((_, i) => i !== index));
    // Les erreurs sont indexées par ligne : on les efface plutôt que de les décaler.
    setFieldErrors({});
    setSubmitError('');
    setSuccess('');
  }

  function clearTable() {
    if (!window.confirm('Vider le tableau et abandonner les colis importés ?')) return;
    setRows([]);
    setFileName('');
    setFieldErrors({});
    setError('');
    setSubmitError('');
    setSuccess('');
  }

  /** Valide les lignes données ; erreurs indexées par "ligne:champ". */
  function validate(list) {
    const errors = {};
    // Mode stock : quantités cumulées par produit pour vérifier le stock disponible.
    const usedByProduct = new Map();
    list.forEach((row, i) => {
      if (!row.receiver.trim()) errors[`${i}:receiver`] = 'Destinataire obligatoire.';
      if (!row.phone.trim()) {
        errors[`${i}:phone`] = 'Téléphone obligatoire.';
      } else if (!isValidPhone(row.phone)) {
        errors[`${i}:phone`] = 'Numéro invalide (10 chiffres, commence par 0).';
      }
      if (!row.city) errors[`${i}:city`] = 'Veuillez sélectionner une ville.';
      if (!row.address.trim()) errors[`${i}:address`] = 'Adresse obligatoire.';
      const price = Number(row.price);
      if (row.price === '' || !Number.isFinite(price) || price < 0) {
        errors[`${i}:price`] = 'Prix obligatoire.';
      }
      const qty = Number(row.qty);
      const qtyValide = row.qty !== '' && Number.isInteger(qty) && qty > 0;
      if (!qtyValide) errors[`${i}:qty`] = 'Quantité invalide.';

      if (fromStock) {
        const produit = row.productId === '' ? undefined : productById.get(Number(row.productId));
        if (!produit) {
          errors[`${i}:productId`] = 'Sélectionnez une réf produit du client.';
          return;
        }
        if (qtyValide) {
          const key = Number(row.productId);
          const total = (usedByProduct.get(key) || 0) + qty;
          usedByProduct.set(key, total);
          if (total > (Number(produit.stock) || 0)) {
            errors[`${i}:productId`] = `Stock insuffisant (${produit.stock} disponible(s)).`;
          }
        }
      }
    });
    return errors;
  }

  /** Crée tous les colis du tableau (tout-ou-rien côté serveur). */
  async function handleSubmit() {
    setSubmitError('');
    setSuccess('');
    setCustomerError('');
    if (!forClient && !customer) {
      setCustomerError('Veuillez sélectionner le client (magasin) des colis.');
      return;
    }
    if (fromStock && products === null) {
      setSubmitError('Chargement des produits du client en cours, veuillez réessayer dans un instant.');
      return;
    }
    /* Numéros saisis ou corrigés à la main : mêmes règles de normalisation
       qu'à l'import (le tableau affiche ce qui sera envoyé) ; un numéro qui
       reste invalide est signalé en rouge et bloque l'ajout. */
    const fixedRows = rows.map((row) => {
      const phone = autoFixPhone(row.phone);
      return phone === row.phone ? row : { ...row, phone };
    });
    setRows(fixedRows);
    const errors = validate(fixedRows);
    setFieldErrors(errors);
    if (Object.values(errors).some(Boolean)) {
      setSubmitError('Veuillez corriger les champs signalés en rouge avant d’ajouter les colis.');
      return;
    }

    setSaving(true);
    try {
      const url = forClient
        ? fromStock ? '/parcels/client/import/stock' : '/parcels/client/import'
        : fromStock ? '/parcels/import/stock' : '/parcels/import';
      const res = await api.post(url, {
        ...(forClient ? {} : { customer: Number(customer) }),
        parcels: fixedRows.map((row) => ({
          code: row.code.trim(),
          receiver: row.receiver.trim(),
          phone: row.phone,
          city: Number(row.city),
          address: row.address.trim(),
          price: Number(row.price),
          note: row.note.trim(),
          ...(fromStock ? { productId: Number(row.productId) } : { product: row.product.trim() }),
          qty: Number(row.qty),
          replace: row.replace === 'OUI' ? 1 : 0,
          open: row.open === 'OUI' ? 1 : 0,
          essayage: row.essayage === 'OUI' ? 1 : 0
        }))
      });
      setRows([]);
      setFileName('');
      setFieldErrors({});
      setSuccess(`${res.data.count} colis importé(s) avec succès.`);
    } catch (err) {
      setSubmitError(err.response?.data?.message || "Erreur lors de l'importation des colis.");
    } finally {
      setSaving(false);
    }
  }

  /** Erreur de validation puis, à défaut, valeur Excel rejetée sous un champ. */
  function cellHints(index, field) {
    const err = fieldErrors[`${index}:${field}`];
    const excel = rows[index].excel[field];
    return (
      <>
        {err && <span className="field-error ic-cell-error">{err}</span>}
        {!err && excel !== undefined && (
          <span className="ic-cell-excel" title="Valeur du fichier Excel non reconnue">
            {excel || '—'}
          </span>
        )}
      </>
    );
  }

  /** Mode stock : nom et stock du produit sélectionné dans la liste des réfs. */
  function refHint(row) {
    if (!fromStock || row.productId === '') return null;
    const produit = productById.get(Number(row.productId));
    if (!produit) return null;
    return (
      <span className="ic-cell-produit">
        {produit.nom} — stock : {produit.stock}
      </span>
    );
  }

  if (loading) return <div className="modal-loading">Chargement…</div>;
  if (loadError) return <div className="form-error">{loadError}</div>;

  const TypeIcon = fromStock ? Warehouse : PackagePlus;

  return (
    <div className="ic-page">
      <div className="platform-card ic-card">
        <h2>
          <FileSpreadsheet size={18} /> Modèle de fichier Excel
        </h2>
        <p className="ic-hint">
          Téléchargez le modèle, remplissez une ligne par colis puis importez le fichier ci-dessous.
          Colonnes obligatoires : DESTINATAIRE, TELEPHONE, VILLE, ADRESSE, PRIX
          {fromStock
            ? ' et REF PRODUIT (la réf unique d’un produit du stock du client choisi)'
            : ''}
          . Cellules vides : QUANTITE = 1, PEUT OUVRIR = OUI, COLIS A REMPLACER et PEUT ESSAYER =
          NON ; CODE SUIVI vide = code généré automatiquement. TELEPHONE : seuls les chiffres
          sont conservés, l’indicatif +212 est remplacé par 0 et le 0 initial est ajouté s’il
          manque ; un numéro qui reste invalide est signalé en rouge et bloque l’ajout.
        </p>
        <button type="button" className="btn btn-primary btn-icon" onClick={downloadTemplate}>
          <Download size={16} /> Télécharger le modèle Excel
        </button>
      </div>

      <div className="platform-card ic-card">
        <h2>
          <TypeIcon size={18} /> Importer des colis {fromStock ? 'de stock' : 'normaux'}
        </h2>

        <div className="ic-toolbar">
          {/* Dashboard client : pas de liste des clients, colis du client connecté. */}
          {!forClient && (
            <div className="np-field ic-client">
              <span className="field-label">
                Client (magasin) <span className="np-required">*</span>
              </span>
              <SearchableSelect
                value={customer}
                onChange={(v) => {
                  setCustomer(v);
                  setCustomerError('');
                  setSuccess('');
                  setSubmitError('');
                  // Mode stock : les réfs se valident contre le nouveau client.
                  if (fromStock) setFieldErrors({});
                }}
                options={magasins}
                placeholder="— Sélectionner un client —"
              />
              {customerError && <span className="field-error ic-cell-error">{customerError}</span>}
            </div>
          )}

          <div className="ic-import">
            <button
              type="button"
              className="btn btn-primary btn-icon"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={16} /> Importer Excel
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="ic-file-input"
              onChange={handleFile}
            />
            {fileName && (
              <span className="ic-file-name">
                {fileName} — {rows.length} ligne(s)
              </span>
            )}
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}
        {success && <div className="form-success">{success}</div>}

        {rows.length === 0 ? (
          <div className="ic-empty">
            <Store size={22} />
            Aucun colis importé pour le moment. Importez un fichier Excel pour afficher les colis ici.
          </div>
        ) : (
          <>
            <div className="table-wrap ic-table-wrap">
              <table className="ic-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Code suivi</th>
                    <th>Destinataire</th>
                    <th>Téléphone</th>
                    <th>Adresse</th>
                    <th>Prix</th>
                    <th>Ville</th>
                    <th>Commentaire</th>
                    <th>{fromStock ? 'Réf produit' : 'Marchandise'}</th>
                    <th>Qty</th>
                    <th>Ouvrir</th>
                    <th>Remplacer</th>
                    <th>Essayer</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td className="ic-num">{i + 1}</td>
                      <td>
                        <input
                          type="text"
                          className="ic-input"
                          value={row.code}
                          maxLength={100}
                          placeholder="Auto"
                          onChange={(e) => setCell(i, 'code', e.target.value)}
                        />
                        {cellHints(i, 'code')}
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ic-input"
                          value={row.receiver}
                          maxLength={250}
                          placeholder="Destinataire *"
                          onChange={(e) => setCell(i, 'receiver', e.target.value)}
                        />
                        {cellHints(i, 'receiver')}
                      </td>
                      <td>
                        <input
                          type="tel"
                          className="ic-input ic-input-sm"
                          value={row.phone}
                          maxLength={50}
                          placeholder="Téléphone *"
                          onChange={(e) => setCell(i, 'phone', e.target.value)}
                        />
                        {cellHints(i, 'phone')}
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ic-input"
                          value={row.address}
                          maxLength={2000}
                          placeholder="Adresse *"
                          onChange={(e) => setCell(i, 'address', e.target.value)}
                        />
                        {cellHints(i, 'address')}
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="ic-input ic-input-xs"
                          value={row.price}
                          placeholder="Prix *"
                          onChange={(e) => setCell(i, 'price', e.target.value)}
                        />
                        {cellHints(i, 'price')}
                      </td>
                      <td className="ic-cell-ville">
                        <SearchableSelect
                          value={row.city}
                          onChange={(v) => setCell(i, 'city', v)}
                          options={cities}
                          placeholder="Ville *"
                          className="ic-ville-select"
                        />
                        {cellHints(i, 'city')}
                      </td>
                      <td>
                        <input
                          type="text"
                          className="ic-input"
                          value={row.note}
                          maxLength={2000}
                          placeholder="Commentaire"
                          onChange={(e) => setCell(i, 'note', e.target.value)}
                        />
                        {cellHints(i, 'note')}
                      </td>
                      <td className={fromStock ? 'ic-cell-ville' : undefined}>
                        {fromStock ? (
                          <>
                            <SearchableSelect
                              value={row.productId}
                              onChange={(v) => setCell(i, 'productId', v)}
                              options={productOptions}
                              placeholder="Réf produit *"
                              className="ic-ville-select"
                            />
                            {cellHints(i, 'productId')}
                            {refHint(row)}
                          </>
                        ) : (
                          <>
                            <input
                              type="text"
                              className="ic-input ic-input-sm"
                              value={row.product}
                              maxLength={250}
                              placeholder="Produit"
                              onChange={(e) => setCell(i, 'product', e.target.value)}
                            />
                            {cellHints(i, 'product')}
                          </>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          className="ic-input ic-input-xxs"
                          value={row.qty}
                          placeholder="1"
                          onChange={(e) => setCell(i, 'qty', e.target.value)}
                        />
                        {cellHints(i, 'qty')}
                      </td>
                      <td>
                        <CellOuiNon
                          value={row.open}
                          onChange={(v) => setCell(i, 'open', v)}
                          label={`Peut ouvrir — ligne ${i + 1}`}
                        />
                        {cellHints(i, 'open')}
                      </td>
                      <td>
                        <CellOuiNon
                          value={row.replace}
                          onChange={(v) => setCell(i, 'replace', v)}
                          label={`Colis à remplacer — ligne ${i + 1}`}
                        />
                        {cellHints(i, 'replace')}
                      </td>
                      <td>
                        <CellOuiNon
                          value={row.essayage}
                          onChange={(v) => setCell(i, 'essayage', v)}
                          disabled={row.open === 'NON'}
                          label={`Peut essayer — ligne ${i + 1}`}
                        />
                        {cellHints(i, 'essayage')}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="row-action row-action-danger"
                          title="Supprimer cette ligne"
                          onClick={() => removeRow(i)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ic-footer">
              {submitError && (
                <div className="form-error ic-footer-msg" role="alert">
                  {submitError}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-icon" onClick={clearTable}>
                <Eraser size={16} /> Vider le tableau
              </button>
              <button
                type="button"
                className="btn btn-primary btn-icon"
                disabled={saving}
                onClick={handleSubmit}
              >
                <TypeIcon size={16} />
                {saving ? 'Importation…' : `Ajouter les colis (${rows.length})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
