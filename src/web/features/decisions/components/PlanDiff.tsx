import { useEffect, useMemo, useState } from 'react';
import { useT } from '@web/i18n';
import { computeFallbackRows, peekFallbackRows, type DiffRow } from '@web/lib/diff';
import { DiffView, type DiffViewLabels } from '@web/ui/diff-view';
import { Skeleton } from '@web/ui/skeleton';

interface Computed {
  oldText: string;
  newText: string;
  rows: readonly DiffRow[];
}

/**
 * "Changes to v(n−1)" of the plan tab (WP-56, ADR-148): a line diff of two plan texts with jsdiff
 * (`computeFallbackRows`, cached; `diff` itself loads lazily) in `ui/diff-view`. A chunk of its own:
 * the panel imports it with `React.lazy` only when the user switches to the changes.
 */
export default function PlanDiff({
  oldText,
  newText,
  previousVersion,
}: {
  oldText: string;
  newText: string;
  /** The version compared with (texts of the line tooltips, "No changes to vN"). */
  previousVersion: number;
}) {
  const t = useT();
  const cached = peekFallbackRows(oldText, newText);
  const [computed, setComputed] = useState<Computed | null>(null);
  const missing = cached === null;
  useEffect(() => {
    if (!missing) return undefined;
    let current = true;
    void computeFallbackRows(oldText, newText).then((rows) => {
      if (current) setComputed({ oldText, newText, rows });
    });
    return () => {
      current = false;
    };
  }, [missing, newText, oldText]);
  const labels = useMemo<DiffViewLabels>(
    () => ({
      oldLine: (line) => t('decisions.panel.oldLine', { line, version: previousVersion }),
      newLine: (line) => t('decisions.panel.newLine', { line }),
      moreLines: (count) => t('decisions.panel.moreLines', { count }),
    }),
    [previousVersion, t],
  );
  const rows =
    cached ??
    (computed !== null && computed.oldText === oldText && computed.newText === newText
      ? computed.rows
      : null);

  if (rows === null) {
    return (
      <div
        data-slot="plan-diff-loading"
        role="status"
        aria-label={t('decisions.panel.diffLoading')}
        className="grid gap-2"
      >
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p data-slot="plan-diff-empty" className="text-muted-foreground text-xs">
        {t('decisions.panel.noChanges', { version: previousVersion })}
      </p>
    );
  }
  // The panel scrolls (not the diff box): lift the diff's own height cap.
  return <DiffView rows={rows} labels={labels} className="[&>div:first-child]:max-h-none" />;
}
