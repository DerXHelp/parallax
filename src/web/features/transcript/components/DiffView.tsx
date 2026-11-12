import { memo, useMemo, type ComponentProps } from 'react';
import { useT } from '@web/i18n';
import { DiffView as DiffViewBase, type DiffViewLabels } from '@web/ui/diff-view';

export function useDiffViewLabels(): DiffViewLabels {
  const t = useT();
  return useMemo(
    () => ({
      oldLine: (line: number) => t('transcript.edit.oldLine', { line }),
      newLine: (line: number) => t('transcript.edit.newLine', { line }),
      moreLines: (count: number) => t('transcript.edit.moreLines', { count }),
    }),
    [t],
  );
}

/** ui/diff-view with the transcript texts. */
export const DiffView = memo(function DiffView(props: Omit<ComponentProps<typeof DiffViewBase>, 'labels'>) {
  const labels = useDiffViewLabels();
  return <DiffViewBase {...props} labels={labels} />;
});
