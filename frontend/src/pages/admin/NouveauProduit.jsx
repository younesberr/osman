import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Image, PackagePlus, Save, Trash2, Upload } from 'lucide-react';
import api from '../../api/client';
import SearchableSelect from '../../components/SearchableSelect';

/*
 * Gestion de stock > Inventaire > Nouveau produit — création d'un produit
 * (delevery_product) : magasin (liste déroulante avec recherche, obligatoire),
 * nom (obligatoire), réf, position (parmi celles de Configuration > Options),
 * description et image facultative. L'enregistrement envoie tout en une seule
 * requête multipart ; created_by est déterminé côté serveur à partir de
 * l'employé connecté.
 */

export default function NouveauProduit() {
  const navigate = useNavigate();

  const [magasins, setMagasins] = useState([]);
  const [positions, setPositions] = useState([]);
  const [loadError, setLoadError] = useState('');

  const [magasinId, setMagasinId] = useState('');
  const [nom, setNom] = useState('');
  const [ref, setRef] = useState('');
  const [position, setPosition] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const fileInputRef = useRef(null);

  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get('/stock/magasins')
      .then((res) => setMagasins(res.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement des magasins.'));
    // Positions configurées (Configuration > Options), tri naturel B2 < B12.
    api
      .get('/stock/positions')
      .then((res) =>
        setPositions(
          [...res.data].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true }))
        )
      )
      .catch(() => {});
  }, []);

  // Libère l'aperçu local de l'image quand il change ou au démontage.
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  function handleImageChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function removeImage() {
    setImageFile(null);
    setImagePreview('');
  }

  async function save(e) {
    e.preventDefault();
    const errors = {};
    if (!magasinId) errors.magasin = 'Le nom du magasin est obligatoire.';
    if (!nom.trim()) errors.nom = 'Le nom du produit est obligatoire.';
    setFieldErrors(errors);
    setSaveError('');
    if (Object.keys(errors).length) return;

    setSaving(true);
    try {
      const form = new FormData();
      form.append('magasinId', magasinId);
      form.append('nom', nom.trim());
      form.append('ref', ref.trim());
      form.append('position', position);
      form.append('description', description.trim());
      if (imageFile) form.append('image', imageFile);
      await api.post('/stock/produits', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      navigate('/admin/stock/inventaire');
    } catch (err) {
      setSaveError(err.response?.data?.message || "Erreur lors de l'enregistrement du produit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="platform-page">
      <section className="platform-card">
        <div className="card-head-actions">
          <h2>
            <PackagePlus size={18} /> Nouveau produit
          </h2>
          <Link to="/admin/stock/inventaire" className="btn btn-ghost btn-sm">
            <ArrowLeft size={15} /> Retour à l'inventaire
          </Link>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        <form onSubmit={save}>
          <div className="modal-form-grid">
            <div>
              <span className="field-label">Nom du magasin *</span>
              <SearchableSelect
                value={magasinId}
                onChange={(v) => {
                  setMagasinId(v);
                  setFieldErrors((prev) => ({ ...prev, magasin: '' }));
                }}
                placeholder="— Sélectionner un magasin —"
                options={magasins.map((m) => ({ value: m.id, label: m.label }))}
              />
              {fieldErrors.magasin && <span className="field-error">{fieldErrors.magasin}</span>}
            </div>
            <label>
              <span className="field-label">Nom du produit *</span>
              <input
                type="text"
                value={nom}
                maxLength={255}
                onChange={(e) => {
                  setNom(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, nom: '' }));
                }}
              />
              {fieldErrors.nom && <span className="field-error">{fieldErrors.nom}</span>}
            </label>
            <label>
              <span className="field-label">Réf du produit</span>
              <input type="text" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} />
            </label>
            <div>
              <span className="field-label">Position</span>
              <SearchableSelect
                value={position}
                onChange={setPosition}
                placeholder="Choisir une position…"
                options={positions.map((p) => ({ value: p, label: p }))}
              />
              {positions.length === 0 && (
                <span className="upload-hint">
                  Aucune position configurée : ajoutez-en dans Configuration &gt; Options &gt; Position.
                </span>
              )}
            </div>
            <label className="modal-form-full">
              <span className="field-label">Description du produit</span>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="modal-form-full upload-field">
              <span className="field-label">Image du produit</span>
              <div className="upload-row">
                <div className="upload-preview">
                  {imagePreview ? (
                    <img src={imagePreview} alt="Aperçu du produit" />
                  ) : (
                    <Image size={26} className="upload-placeholder" />
                  )}
                </div>
                <div className="upload-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={15} /> {imageFile ? 'Remplacer' : 'Choisir un fichier'}
                  </button>
                  {imageFile && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={removeImage}>
                      <Trash2 size={15} /> Retirer l'image
                    </button>
                  )}
                  <span className="upload-hint">png, jpg ou webp — 2 Mo max.</span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp"
                  hidden
                  onChange={handleImageChange}
                />
              </div>
            </div>
          </div>

          {saveError && <div className="form-error">{saveError}</div>}

          <div className="modal-actions">
            <Link to="/admin/stock/inventaire" className="btn btn-ghost">
              Annuler
            </Link>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              <Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
