import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Image, PackageSearch, Save, Trash2, Upload } from 'lucide-react';
import api from '../../api/client';

/*
 * Gestion stock > Liste des produits > Fiche produit — modification d'un
 * produit du client connecté : même formulaire que la fiche admin mais sans
 * liste déroulante magasin (le produit reste rattaché au client). L'image déjà
 * chargée est affichée avec les boutons Modifier / Supprimer ; l'enregistrement
 * envoie tout en une seule requête multipart (removeImage=1 si retirée).
 */

export default function FicheProduit() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [nom, setNom] = useState('');
  const [ref, setRef] = useState('');
  const [description, setDescription] = useState('');

  // Image : URL de l'image déjà enregistrée, nouveau fichier choisi, drapeau de suppression.
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const [imageRemoved, setImageRemoved] = useState(false);
  const fileInputRef = useRef(null);

  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get(`/stock/client/produits/${id}`)
      .then((res) => {
        const p = res.data;
        setNom(p.nom || '');
        setRef(p.ref || '');
        setDescription(p.description || '');
        setImageUrl(p.imageUrl || '');
      })
      .catch((err) => setLoadError(err.response?.data?.message || 'Erreur de chargement du produit.'))
      .finally(() => setLoading(false));
  }, [id]);

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

  /** Retire l'image affichée : nouveau fichier annulé et/ou image existante supprimée. */
  function removeImage() {
    setImageFile(null);
    setImagePreview('');
    if (imageUrl) setImageRemoved(true);
  }

  // Image affichée dans le cadre : nouveau fichier choisi, sinon image enregistrée non retirée.
  const shownImage = imagePreview || (!imageRemoved ? imageUrl : '');

  async function save(e) {
    e.preventDefault();
    const errors = {};
    if (!nom.trim()) errors.nom = 'Le nom du produit est obligatoire.';
    setFieldErrors(errors);
    setSaveError('');
    if (Object.keys(errors).length) return;

    setSaving(true);
    try {
      const form = new FormData();
      form.append('nom', nom.trim());
      form.append('ref', ref.trim());
      form.append('description', description.trim());
      if (imageFile) form.append('image', imageFile);
      else if (imageRemoved) form.append('removeImage', '1');
      await api.put(`/stock/client/produits/${id}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      navigate('/client/stock/produits');
    } catch (err) {
      setSaveError(err.response?.data?.message || "Erreur lors de l'enregistrement du produit.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="cell-sub">Chargement de la fiche produit…</p>;

  return (
    <div className="platform-page">
      <section className="platform-card">
        <div className="card-head-actions">
          <h2>
            <PackageSearch size={18} /> Fiche produit
          </h2>
          <Link to="/client/stock/produits" className="btn btn-ghost btn-sm">
            <ArrowLeft size={15} /> Retour à la liste des produits
          </Link>
        </div>

        {loadError && <div className="form-error">{loadError}</div>}

        {!loadError && (
          <form onSubmit={save}>
            <div className="modal-form-grid">
              <label className="modal-form-full">
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
              <label className="modal-form-full">
                <span className="field-label">Réf du produit</span>
                <input type="text" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} />
              </label>
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
                    {shownImage ? (
                      <img src={shownImage} alt="Image du produit" />
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
                      <Upload size={15} /> {shownImage ? 'Modifier' : 'Choisir un fichier'}
                    </button>
                    {shownImage && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={removeImage}>
                        <Trash2 size={15} /> Supprimer
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
              <Link to="/client/stock/produits" className="btn btn-ghost">
                Annuler
              </Link>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                <Save size={16} /> {saving ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
