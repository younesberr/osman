import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

const PAGE_SIZES = [10, 25, 50, 100];

/** Pagination côté client : découpe rows et affiche la barre de navigation. */
export function usePagination(rows, unit, unitPlural = `${unit}s`) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize]
  );
  const rangeLabel = useMemo(() => {
    if (!rows.length) return `0 ${unit}`;
    const start = (safePage - 1) * pageSize + 1;
    const end = Math.min(safePage * pageSize, rows.length);
    return `${start}–${end} sur ${rows.length} ${rows.length > 1 ? unitPlural : unit}`;
  }, [rows.length, safePage, pageSize, unit, unitPlural]);
  return { pageRows, page: safePage, setPage, pageSize, setPageSize, totalPages, rangeLabel };
}

/**
 * Pagination côté serveur : même barre (Pager) mais c'est l'API qui découpe.
 * total = nombre de lignes renvoyé par le serveur ; la page interroge l'API
 * avec page / pageSize et recule sur la dernière page si la sienne est vide.
 */
export function useServerPagination(total, unit, unitPlural = `${unit}s`) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeLabel = useMemo(() => {
    if (!total) return `0 ${unit}`;
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start.toLocaleString('fr-FR')}–${end.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')} ${
      total > 1 ? unitPlural : unit
    }`;
  }, [total, page, pageSize, unit, unitPlural]);
  return { page, setPage, pageSize, setPageSize, totalPages, rangeLabel };
}

export function Pager({ pager }) {
  const { page, setPage, pageSize, setPageSize, totalPages, rangeLabel } = pager;
  return (
    <div className="datatable-footer">
      <span className="datatable-range">{rangeLabel}</span>
      <div className="datatable-pager">
        <select
          className="datatable-select"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button type="button" className="page-btn" onClick={() => setPage(1)} disabled={page <= 1} title="Première page">
          <ChevronsLeft size={16} />
        </button>
        <button
          type="button"
          className="page-btn"
          onClick={() => setPage((n) => n - 1)}
          disabled={page <= 1}
          title="Page précédente"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="page-info">
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          className="page-btn"
          onClick={() => setPage((n) => n + 1)}
          disabled={page >= totalPages}
          title="Page suivante"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className="page-btn"
          onClick={() => setPage(totalPages)}
          disabled={page >= totalPages}
          title="Dernière page"
        >
          <ChevronsRight size={16} />
        </button>
      </div>
    </div>
  );
}
