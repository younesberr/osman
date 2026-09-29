import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import api from '../api/client';

/*
 * Onglet « Matériel(s) » des fiches Utilisateur et Livreur : affectations de
 * matériel non consommable de la personne (lecture seule — les affectations
 * et récupérations se font depuis /admin/materiel).
 * endpoint : /users/:id/materiel ou /livreurs/:id/materiel.
 */
export default function MaterielAffectations({ endpoint, title = 'Matériels affectés' }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(endpoint)
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.message || 'Erreur de chargement du matériel.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  return (
    <section className="platform-card fiche-card">
      <h2 className="fiche-section-title">
        <Wrench size={17} /> {title}
      </h2>

      {error && <div className="form-error">{error}</div>}

      <div className={`table-wrap datatable ${loading ? 'is-loading' : ''}`}>
        <table>
          <thead>
            <tr>
              <th>Matériel</th>
              <th>Quantité</th>
              <th>Référence</th>
              <th>Affecté le</th>
              <th>Récupéré le</th>
              <th>Statut</th>
              <th>Commentaire</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} className="datatable-empty">
                  Aucun matériel affecté.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const restant = r.qte - r.qte_recuperee;
                return (
                  <tr key={r.id}>
                    <td>{r.materiel}</td>
                    <td>
                      <div className="cell-main">{r.qte}</div>
                      {r.qte_recuperee > 0 && (
                        <div className="cell-sub">
                          {r.qte_recuperee} récupéré(s) · {restant} restant(s)
                        </div>
                      )}
                    </td>
                    <td>{r.reference || '—'}</td>
                    <td>{r.date_affectation}</td>
                    <td>{r.date_recuperation || '—'}</td>
                    <td>
                      <span className={`badge ${r.statut === 'recupere' ? 'badge-active' : 'badge-attente'}`}>
                        {r.statut === 'recupere' ? 'Récupéré' : 'Affecté'}
                      </span>
                    </td>
                    <td>{r.commentaire || '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
