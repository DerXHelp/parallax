import { memo, useState } from 'react';
import { cn } from '@web/lib/cn';
import type { DiffRow, DiffRowKind } from '@web/lib/diff';
import { Button } from './button';

const ROW_CLASS: Readonly<Record<DiffRowKind, string>> = {
  context: '',
  add: 'bg-success/12',
  remove: 'bg-destructive/12',
  hunk: 'bg-muted/60 text-muted-foreground',
  note: 'text-muted-foreground italic',
};

const MARKER: Readonly<Record<DiffRowKind, string>> = {
  context: ' ',
  add: '+',
  remove: '−',
  hunk: '',
  note: '',
};

const MARKER_CLASS: Readonly<Record<DiffRowKind, string>> = {
  context: '',
  add: 'text-success',
  remove: 'text-destructive',
  hunk: '',
  note: '',
};

/** Rows rendered before "Show more" (long diffs stay cheap). */
export const DIFF_ROWS_INITIAL = 300;

/** Texts of the diff view (the caller translates them, like ui/lightbox). */
export interface DiffViewLabels {
  /** Tooltip of an old line number. */
  oldLine: (line: number) => string;
  /** Tooltip of a new line number. */
  newLine: (line: number) => string;
  /** Button that shows more rows (`count` = still hidden). */
  moreLines: (count: number) => string;
}

/**
 * Unified diff (Edit/Write): old/new line numbers, `+`/`−` markers (never color only), long
 * diffs paged. Plain text rows – no HTML.
 */
export const DiffView = memo(function DiffView({
  rows,
  labels,
  showOldLines = true,
  className,
}: {
  rows: readonly DiffRow[];
  labels: DiffViewLabels;
  /** False for new files (only the new line number). */
  showOldLines?: boolean;
  className?: string;
}) {
  const [limit, setLimit] = useState(DIFF_ROWS_INITIAL);
  const visible = rows.length > limit ? rows.slice(0, limit) : rows;
  const hidden = rows.length - visible.length;
  return (
    <div data-slot="diff" className={cn('bg-muted/30 min-w-0 rounded-md border', className)}>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5 [font-variant-ligatures:none]">
          <tbody>
            {visible.map((row, index) => (
              <tr key={index} data-kind={row.kind} className={ROW_CLASS[row.kind]}>
                {row.kind === 'hunk' || row.kind === 'note' ? (
                  <td colSpan={showOldLines ? 4 : 3} className="px-2.5 whitespace-pre">
                    {row.text}
                  </td>
                ) : (
                  <>
                    {showOldLines ? (
                      <td
                        className="text-muted-foreground/70 w-px border-r px-1.5 text-right text-2xs select-none"
                        title={row.oldLine === null ? undefined : labels.oldLine(row.oldLine)}
                      >
                        {row.oldLine}
                      </td>
                    ) : null}
                    <td
                      className="text-muted-foreground/70 w-px border-r px-1.5 text-right text-2xs select-none"
                      title={row.newLine === null ? undefined : labels.newLine(row.newLine)}
                    >
                      {row.newLine}
                    </td>
                    <td className={cn('w-px pr-1 pl-1.5 select-none', MARKER_CLASS[row.kind])}>
                      {MARKER[row.kind]}
                    </td>
                    <td className="pr-3 whitespace-pre">{row.text}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <div className="border-t px-2 py-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLimit((current) => current + DIFF_ROWS_INITIAL * 3);
            }}
          >
            {labels.moreLines(hidden)}
          </Button>
        </div>
      ) : null}
    </div>
  );
});
