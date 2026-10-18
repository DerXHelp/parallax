import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { showTextNotice } from '@web/state/notices';
import { IconButton } from '@web/ui/icon-button';

const COPIED_MS = 1500;

/** Copies `text` to the clipboard; feedback as icon + notice (architecture §2.3i, „kopiert“). */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) {
        showTextNotice('transcript.code.copyFailed', undefined, { tone: 'error', id: 'transcript-copy' });
        return;
      }
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
      }, COPIED_MS);
      showTextNotice('transcript.code.copied', undefined, {
        tone: 'success',
        id: 'transcript-copy',
        durationMs: 2000,
      });
    });
  };

  return (
    <IconButton
      label={label ?? t('transcript.code.copy')}
      size="icon-xs"
      className={className}
      onClick={copy}
    >
      {copied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
    </IconButton>
  );
}
