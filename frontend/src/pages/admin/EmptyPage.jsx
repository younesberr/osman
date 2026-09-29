import { Construction } from 'lucide-react';

/** Page vide temporaire pour les entrées du menu admin (à développer plus tard). */
export default function EmptyPage({ title }) {
  return (
    <div className="empty-page">
      <Construction size={44} className="empty-page-icon" />
      <h1>{title}</h1>
      <p>Cette page est en cours de développement.</p>
    </div>
  );
}
