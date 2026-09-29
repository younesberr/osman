import { useEffect, useState } from 'react';
import api from '../api/client';
import { isValidPhone, normalizePhone } from '../utils/phone';

/** Libellé du niveau de confiance renvoyé par l'API (seuils côté serveur : 80 % / 50 %). */
const NIVEAU_LIBELLES = {
  bon: 'Bonne personne',
  moyen: 'Personne moyenne',
  mauvais: 'Mauvaise personne'
};

/**
 * Taux de livraison du destinataire, affiché sous le champ « Téléphone du
 * destinataire » des pages « Nouveau colis » (admin : endpoint
 * /parcels/new/destinataire, client : /parcels/client/destinataire).
 * Dès que le numéro est complet et valide (10 chiffres commençant par 0),
 * l'API est interrogée après une courte attente pour ne pas appeler le serveur
 * à chaque frappe ; rien n'est affiché tant que le numéro est incomplet.
 * Format : « Taux de livraison 90 % (20 livrés / 25) » + pastille
 * « Bonne personne » / « Personne moyenne » / « Mauvaise personne ».
 * Les colis encore en attente de ramassage ne sont pas comptés.
 */
export default function TauxLivraisonDestinataire({ phone, endpoint }) {
  // Numéro normalisé (sans espaces / points / tirets), vide tant qu'il est invalide.
  const numero = isValidPhone(phone) ? normalizePhone(phone) : '';
  // Dernière réponse : { numero, total, livres, taux, niveau }.
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!numero) {
      setData(null);
      setError('');
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get(endpoint, { params: { phone: numero } })
        .then((res) => {
          if (cancelled) return;
          setData({ numero, ...res.data });
          setError('');
        })
        .catch((err) => {
          if (cancelled) return;
          setData(null);
          setError(err.response?.data?.message || 'Taux de livraison indisponible.');
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [numero, endpoint]);

  if (!numero) return null;
  if (error) return <span className="np-taux np-taux-erreur">{error}</span>;
  if (!data || data.numero !== numero) {
    return <span className="np-taux np-taux-attente">Taux de livraison : recherche…</span>;
  }
  if (!data.total) {
    return (
      <span className="np-taux np-taux-vide">Aucun colis précédent pour ce numéro.</span>
    );
  }
  return (
    <span className={`np-taux np-taux-${data.niveau}`}>
      <span>
        Taux de livraison {data.taux} % ({data.livres} livré{data.livres > 1 ? 's' : ''} / {data.total})
      </span>
      <span className="np-taux-niveau">{NIVEAU_LIBELLES[data.niveau] || ''}</span>
    </span>
  );
}
