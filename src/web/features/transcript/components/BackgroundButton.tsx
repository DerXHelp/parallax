import { ArrowDownToLineIcon } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@web/i18n';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { moveToBackground } from '../state/tasks';

/**
 * WP-65 §1.5: "Move to background" on a running Bash call (`ToolCallRow`) or subagent (`AgentCard`).
 * Stays busy after a success until the item reports `background` (the row then drops the button);
 * a refusal shows as a notice and frees the button again.
 */
export function BackgroundButton({
  sessionKey,
  toolUseId,
  title,
}: {
  sessionKey: string;
  toolUseId: string;
  /** What runs (description, command) – for the accessible name. */
  title: string;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      data-action="background"
      disabled={busy}
      aria-label={t('transcript.tool.backgroundLabel', { title })}
      title={t('transcript.tool.backgroundHint')}
      className="h-6 shrink-0 px-2 text-2xs"
      onClick={() => {
        setBusy(true);
        void moveToBackground(sessionKey, toolUseId).then((ok) => {
          if (!ok) setBusy(false);
        });
      }}
    >
      {busy ? <Spinner className="size-3" /> : <ArrowDownToLineIcon aria-hidden className="size-3" />}
      {t('transcript.tool.background')}
    </Button>
  );
}
