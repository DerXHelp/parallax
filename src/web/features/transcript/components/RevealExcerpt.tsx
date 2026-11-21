import { TextSearchIcon, XIcon } from 'lucide-react';
import { cn } from '@web/lib/cn';
import { IconButton } from '@web/ui/icon-button';
import { useLazyTranscriptT } from '../i18n-lazy';
import { TranscriptItemView } from '../items/TranscriptRow';
import type { RevealExcerpt as Excerpt } from '../state/reveal';

/**
 * WP-115: a search hit that is not part of the list (another conversation, or further back than the
 * transcript loads for a jump): the items around it from `transcript.loadAround`, drawn like the
 * list, the hit marked – a card above the list, closable.
 */
export function RevealExcerpt({
  sessionKey,
  excerpt,
  onClose,
}: {
  sessionKey: string;
  excerpt: Excerpt;
  onClose: () => void;
}) {
  const lt = useLazyTranscriptT();
  const title = excerpt.otherConversation ? lt('reveal.otherConversation') : lt('reveal.notLoaded');
  return (
    <section
      aria-label={lt('reveal.label')}
      data-slot="reveal-excerpt"
      data-other-conversation={excerpt.otherConversation || undefined}
      className="bg-card absolute inset-x-3 top-3 z-10 mx-auto flex max-h-[60%] max-w-4xl flex-col overflow-hidden rounded-md border shadow-md"
    >
      <header className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-2xs">
        <TextSearchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <IconButton label={lt('reveal.close')} size="icon-xs" data-action="close-reveal" onClick={onClose}>
          <XIcon aria-hidden />
        </IconButton>
      </header>
      <div className="min-h-0 overflow-y-auto px-1 py-1">
        {excerpt.items.map((item) => (
          <div
            key={item.id}
            data-revealed={item.id === excerpt.itemId || undefined}
            className={cn('rounded-sm px-3 py-1', item.id === excerpt.itemId && 'bg-warning/15')}
          >
            <TranscriptItemView item={item} sessionKey={sessionKey} />
          </div>
        ))}
      </div>
    </section>
  );
}
