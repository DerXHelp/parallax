import { memo, useMemo } from 'react';
import { useT } from '@web/i18n';
import { showTextNotice } from '@web/state/notices';
import { CodeBlock as CodeBlockBase, type CodeBlockLabels, type CodeBlockProps } from '@web/ui/code-block';

/** Notice after a copy attempt (architecture §2.3i, „kopiert“). */
export function notifyCopied(ok: boolean): void {
  if (ok) {
    showTextNotice('transcript.code.copied', undefined, {
      tone: 'success',
      id: 'transcript-copy',
      durationMs: 2000,
    });
  } else {
    showTextNotice('transcript.code.copyFailed', undefined, { tone: 'error', id: 'transcript-copy' });
  }
}

export function useCodeBlockLabels(): CodeBlockLabels {
  const t = useT();
  return useMemo(() => ({ plain: t('transcript.code.plain'), copy: t('transcript.code.copy') }), [t]);
}

/** ui/code-block with the transcript texts and copy notices. */
export const CodeBlock = memo(function CodeBlock(props: Omit<CodeBlockProps, 'labels' | 'onCopied'>) {
  const labels = useCodeBlockLabels();
  return <CodeBlockBase {...props} labels={labels} onCopied={notifyCopied} />;
});
