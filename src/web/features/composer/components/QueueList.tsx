import { ClockIcon, LoaderCircleIcon, ZapIcon } from 'lucide-react';
import type { PromptPriority } from '@shared/common';
import type { QueuedPrompt } from '@shared/model';
import { useT } from '@web/i18n';
import { Badge } from '@web/ui/badge';

export interface QueueEntry {
  key: string;
  text: string;
  priority: PromptPriority;
  state: QueuedPrompt['state'];
}

/**
 * Queued messages (Plan B "Gequeuete Nachrichten", F.9): grey until Claude takes them over –
 * then they appear as user messages in the transcript and leave this list.
 */
export function QueueList({ entries }: { entries: readonly QueueEntry[] }) {
  const t = useT();
  if (entries.length === 0) return null;
  return (
    <section
      data-slot="composer-queue"
      aria-label={t('composer.queueList.label')}
      className="mb-1.5 grid gap-1"
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
        <ClockIcon aria-hidden className="size-3" />
        {t('composer.queueList.title', { count: entries.length })}
      </div>
      <ul className="grid gap-1">
        {entries.map((entry) => (
          <li
            key={entry.key}
            data-state={entry.state}
            className="bg-muted/50 text-muted-foreground flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs"
          >
            {entry.state === 'sending' ? (
              <LoaderCircleIcon aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
            ) : (
              <ClockIcon aria-hidden className="size-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.text}</span>
            {entry.priority === 'now' ? (
              <Badge variant="info">
                <ZapIcon aria-hidden />
                {t('composer.queueList.now')}
              </Badge>
            ) : null}
            <span className="shrink-0 text-2xs">
              {entry.state === 'sending' ? t('composer.queueList.sending') : t('composer.queueList.queued')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
