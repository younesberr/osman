import { useState } from 'react';
import { BRAND } from '../config/brand';
import { Copy, Check } from 'lucide-react';

/*
 * Briques des pages « Documentation API » : dashboard livreur (/livreur/api)
 * et dashboard client (/client/api/documentation). Bouton copier, bloc de
 * code, carte d'endpoint, tableau de paramètres, section ancrée et sommaire.
 * Styles : bloc « Documentation API » de styles.css (.api-*).
 */

/** URL de base de l'API (production). */
export const BASE_URL = BRAND.apiBaseUrl;

/** Bouton copier : icône Copy → Check pendant 1,6 s après la copie. */
export function CopyBtn({ text, title = 'Copier' }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Presse-papiers indisponible (HTTP non sécurisé) : bouton sans effet. */
    }
  };

  return (
    <button type="button" className="api-copy" onClick={copy} title={title} aria-label={title}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

/** Bloc de code (requête / réponse) avec bouton copier. */
export function Code({ label, children }) {
  return (
    <div className="api-code">
      <div className="api-code-head">
        <span>{label}</span>
        <CopyBtn text={children} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** Carte d'un endpoint : badge méthode + chemin copiable + contenu libre. */
export function Endpoint({ method, path, desc, children }) {
  return (
    <article className="api-endpoint">
      <header className="api-endpoint-head">
        <span className={`api-method api-method-${method.toLowerCase()}`}>{method}</span>
        <code className="api-path">{path}</code>
        <CopyBtn text={`${BASE_URL}${path}`} title="Copier l’URL complète" />
      </header>
      <p className="api-endpoint-desc">{desc}</p>
      {children}
    </article>
  );
}

/** Tableau de paramètres : [nom, emplacement, description, obligatoire?]. */
export function Params({ rows }) {
  return (
    <div className="table-wrap api-table">
      <table>
        <thead>
          <tr>
            <th>Paramètre</th>
            <th>Où</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([nom, ou, desc, obligatoire]) => (
            <tr key={nom}>
              <td>
                <span className="mono">{nom}</span>
                {obligatoire && <span className="api-required">obligatoire</span>}
              </td>
              <td>{ou}</td>
              <td className="api-cell-wrap">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Titre de section avec ancre pour le sommaire. */
export function Section({ id, title, intro, children }) {
  return (
    <section id={id} className="dash-section api-section">
      <h2>{title}</h2>
      {intro && <p className="api-section-intro">{intro}</p>}
      {children}
    </section>
  );
}

/** Sommaire : chips-ancres vers les sections ({ id, label }), défilement doux. */
export function ApiToc({ sections }) {
  const goTo = (e, id) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className="api-toc" aria-label="Sommaire">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} onClick={(e) => goTo(e, s.id)}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}
