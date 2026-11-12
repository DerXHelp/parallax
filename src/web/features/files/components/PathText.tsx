import { cn } from '@web/lib/cn';

/**
 * A path on one line, shortened from the START when it does not fit (V4-06 b):
 * `…\proj\Projekt mit Leerzeichen äöü` – the end (nearest folders, file name with extension) stays
 * visible. CSS only: the box runs right-to-left, so the content overflows and gets its ellipsis at
 * the left edge; the path itself is an isolated left-to-right run (`<bdi dir="ltr">`), so separators
 * and names keep their order. Selection, copy and screen readers get the full path.
 */
export function PathText({ path, className }: { path: string; className?: string }) {
  return (
    <span data-slot="path-text" className={cn('block min-w-0 truncate text-left [direction:rtl]', className)}>
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}
