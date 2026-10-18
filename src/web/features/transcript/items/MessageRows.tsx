import { BrainIcon, CircleStopIcon, ClockIcon, FileIcon, SquareSlashIcon, ZapIcon } from 'lucide-react';
import { memo, useContext, type ReactNode } from 'react';
import type { AssistantTextItem, BlobRef, QueuedPrompt, ThinkingItem, UserMessageItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Badge } from '@web/ui/badge';
import { Spinner } from '@web/ui/spinner';
import { CappedContent } from '../components/CappedContent';
import { Disclosure } from '../components/Disclosure';
import { ImageThumb } from '../components/ImageThumb';
import { ModelBadge } from '../components/ModelBadge';
import { QueuedIdsContext } from '../context';
import { Markdown } from '../markdown/Markdown';
import { expansionKey } from '../state/expansion';

/** User text, assistant text (streaming Markdown), thinking and queued prompts. */

function Attachments({ attachments }: { attachments: readonly BlobRef[] }) {
  const t = useT();
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {attachments.map((attachment) => {
        const name = attachment.name ?? t('transcript.user.unnamed');
        if (attachment.mediaType.startsWith('image/')) {
          return (
            <ImageThumb
              key={attachment.blobId}
              image={attachment}
              className="h-auto max-h-40 w-auto max-w-60 object-cover"
            />
          );
        }
        return (
          <span
            key={attachment.blobId}
            className="text-muted-foreground inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs"
          >
            <FileIcon aria-hidden className="size-3" />
            {t('transcript.user.attachment', { name })}
          </span>
        );
      })}
    </div>
  );
}

function UserBubble({
  text,
  queued,
  sending = false,
  children,
}: {
  text: ReactNode;
  queued: boolean;
  sending?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div
      data-item-kind="user_message"
      data-queued={queued ? 'true' : undefined}
      className={cn(
        'bg-secondary/70 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border px-3 py-2',
        queued && 'border-dashed bg-transparent opacity-70',
      )}
    >
      <span className="sr-only">{t('transcript.user.label')}</span>
      {queued ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-2xs">
          <ClockIcon aria-hidden className="size-3" />
          {sending ? t('transcript.user.sending') : t('transcript.user.queued')}
        </span>
      ) : null}
      {text}
      {children}
    </div>
  );
}

export const UserMessageRow = memo(function UserMessageRow({
  item,
  sessionKey,
}: {
  item: UserMessageItem;
  sessionKey: string;
}) {
  const t = useT();
  const queuedIds = useContext(QueuedIdsContext);
  return (
    <UserBubble
      queued={queuedIds.has(item.id)}
      text={
        <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
          {(text) => <p className="text-ui break-words whitespace-pre-wrap">{text}</p>}
        </CappedContent>
      }
    >
      <Attachments attachments={item.attachments} />
      {item.slashCommand === null && item.origin === 'human' && item.priority !== 'now' ? null : (
        <div className="flex flex-wrap gap-1">
          {item.slashCommand === null ? null : (
            <Badge variant="outline">
              <SquareSlashIcon aria-hidden />
              {t('transcript.user.slashCommand')}
            </Badge>
          )}
          {item.priority === 'now' ? (
            <Badge variant="outline">
              <ZapIcon aria-hidden />
              {t('transcript.user.sendNow')}
            </Badge>
          ) : null}
          {item.origin === 'other' ? (
            <Badge variant="outline">{t('transcript.user.otherOrigin')}</Badge>
          ) : null}
        </div>
      )}
    </UserBubble>
  );
});

/** A prompt in `detail.queue` that has no item yet (grey until the CLI takes it over, F.9). */
export const QueuedPromptRow = memo(function QueuedPromptRow({ prompt }: { prompt: QueuedPrompt }) {
  return (
    <UserBubble
      queued
      sending={prompt.state === 'sending'}
      text={<p className="text-ui break-words whitespace-pre-wrap">{prompt.text.text}</p>}
    >
      <Attachments attachments={prompt.attachments} />
    </UserBubble>
  );
});

export const AssistantTextRow = memo(function AssistantTextRow({
  item,
  sessionKey,
}: {
  item: AssistantTextItem;
  sessionKey: string;
}) {
  const t = useT();
  return (
    <div
      data-item-kind="assistant_text"
      data-streaming={item.streaming ? 'true' : undefined}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1"
    >
      <span className="sr-only">{t('transcript.assistant.label')}</span>
      {item.localCommand === null ? null : (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-2xs">
          <SquareSlashIcon aria-hidden className="size-3" />
          {t('transcript.assistant.localCommand', { command: item.localCommand.command })}
        </span>
      )}
      <ModelBadge model={item.model} blockIndex={null} />
      <Markdown text={item.text} streaming={item.streaming} sessionKey={sessionKey} />
      {item.streaming ? (
        <span
          aria-hidden
          className="bg-foreground/60 inline-block h-3.5 w-1.5 rounded-[1px] motion-safe:animate-pulse"
        />
      ) : null}
      {item.streaming ? <span className="sr-only">{t('transcript.assistant.streaming')}</span> : null}
      {item.aborted ? (
        <span className="text-muted-foreground inline-flex items-center gap-1 text-2xs">
          <CircleStopIcon aria-hidden className="size-3" />
          {t('transcript.assistant.aborted')}
        </span>
      ) : null}
    </div>
  );
});

export const ThinkingRow = memo(function ThinkingRow({
  item,
  sessionKey,
}: {
  item: ThinkingItem;
  sessionKey: string;
}) {
  const t = useT();
  if (item.redacted) {
    return (
      <div data-item-kind="thinking" className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <BrainIcon aria-hidden className="size-3.5" />
        {t('transcript.thinking.redacted')}
      </div>
    );
  }
  const header = (
    <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 text-xs">
      <BrainIcon aria-hidden className="size-3.5 shrink-0" />
      {item.streaming ? t('transcript.thinking.streaming') : t('transcript.thinking.label')}
      {item.streaming ? <Spinner className="size-3" label={t('transcript.thinking.streaming')} /> : null}
      <ModelBadge model={item.model} blockIndex={item.blockIndex} />
    </span>
  );
  return (
    <div data-item-kind="thinking" className="min-w-0">
      <Disclosure stateKey={expansionKey(sessionKey, item.id)} header={header}>
        <div className="mt-1 ml-5 border-l pl-3">
          {item.text.text.trim() === '' ? (
            <p className="text-muted-foreground text-xs italic">{t('transcript.thinking.empty')}</p>
          ) : (
            <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
              {(text) => (
                <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">{text}</p>
              )}
            </CappedContent>
          )}
        </div>
      </Disclosure>
    </div>
  );
});
