import {
  BellIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleStopIcon,
  ClockIcon,
  FileIcon,
  MessageSquareDashedIcon,
  MessagesSquareIcon,
  NetworkIcon,
  PencilLineIcon,
  RadioIcon,
  SmartphoneIcon,
  SquareSlashIcon,
  Undo2Icon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AssistantTextItem, BlobRef, QueuedPrompt, ThinkingItem, UserMessageItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Spinner } from '@web/ui/spinner';
import { CappedContent } from '../components/CappedContent';
import { Disclosure } from '../components/Disclosure';
import { ImageThumb } from '../components/ImageThumb';
import { QueuedIdsContext } from '../context';
import { useLazyTranscriptT } from '../i18n-lazy';
import { renameEchoTitle, renameTitle } from '../lib/rename';
import { collapsedPreview, countLines, foreignPreview } from '../lib/text';
import { withdrawQueuedMessage } from '../lib/withdraw';
import { Markdown } from '../markdown/Markdown';
import { expansionKey, useExpanded } from '../state/expansion';

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

/** WP-66 §1.5 „Zurückholen“ of a waiting message (its text goes back into the composer). */
function WithdrawButton({ sessionKey, messageUuid }: { sessionKey: string; messageUuid: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <IconButton
      label={t('transcript.user.withdraw')}
      size="icon-xs"
      data-action="withdraw"
      disabled={busy}
      className="ml-auto"
      onClick={() => {
        setBusy(true);
        void withdrawQueuedMessage(sessionKey, messageUuid).finally(() => {
          setBusy(false);
        });
      }}
    >
      {busy ? <Spinner className="size-3" /> : <Undo2Icon aria-hidden />}
    </IconButton>
  );
}

function UserBubble({
  text,
  queued,
  sending = false,
  withdraw = null,
  children,
}: {
  text: ReactNode;
  queued: boolean;
  sending?: boolean;
  /** WP-66: the waiting message that „Zurückholen“ takes back. */
  withdraw?: { sessionKey: string; messageUuid: string } | null;
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
        <span className="text-muted-foreground flex items-center gap-1 text-2xs">
          <ClockIcon aria-hidden className="size-3" />
          {sending ? t('transcript.user.sending') : t('transcript.user.queued')}
          {withdraw === null ? null : <WithdrawButton {...withdraw} />}
        </span>
      ) : null}
      {text}
      {children}
    </div>
  );
}

/**
 * The text of a user message; a long one (a pasted log, V4-07) starts collapsed to its first lines
 * (`collapsedPreview`) with "Show all n lines" – the choice survives the virtualized list
 * (expansion state).
 */
function UserText({ text, stateKey }: { text: string; stateKey: string }) {
  const t = useT();
  const [open, setOpen] = useExpanded(stateKey, false);
  const preview = useMemo(() => collapsedPreview(text), [text]);
  if (preview === null) return <p className="text-ui break-words whitespace-pre-wrap">{text}</p>;
  return (
    <div data-slot="user-text" data-state={open ? 'expanded' : 'collapsed'} className="grid min-w-0 gap-1">
      <p className="text-ui break-words whitespace-pre-wrap">{open ? text : preview}</p>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        className="text-muted-foreground h-6 justify-self-start px-1.5 text-2xs"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? (
          <ChevronUpIcon aria-hidden className="size-3" />
        ) : (
          <ChevronDownIcon aria-hidden className="size-3" />
        )}
        {open ? t('transcript.user.showLess') : t('transcript.user.showAll', { count: countLines(text) })}
      </Button>
    </div>
  );
}

interface ForeignOrigin {
  icon: LucideIcon;
  /** Key under `transcript.user.origin`. */
  label: 'peer' | 'coordinator' | 'notification' | 'channel' | 'unknown';
}

/** WP-72: the known origins of a message not typed by the user (`originKind`), others are `unknown`. */
const FOREIGN_ORIGINS: ReadonlyMap<string, ForeignOrigin> = new Map<string, ForeignOrigin>([
  ['peer', { icon: MessagesSquareIcon, label: 'peer' }],
  ['coordinator', { icon: NetworkIcon, label: 'coordinator' }],
  ['task-notification', { icon: BellIcon, label: 'notification' }],
  ['channel', { icon: RadioIcon, label: 'channel' }],
]);

const UNKNOWN_ORIGIN: ForeignOrigin = { icon: MessageSquareDashedIcon, label: 'unknown' };

function foreignOrigin(kind: string | null): ForeignOrigin {
  return (kind === null ? undefined : FOREIGN_ORIGINS.get(kind)) ?? UNKNOWN_ORIGIN;
}

/**
 * WP-72: a message not typed by the user (another session, the coordinator, an automatic
 * notification, a channel) – one quiet collapsed line with its origin and a preview instead of a
 * user bubble; opening it shows the whole text. Its own row in the compact view (it triggers
 * Claude's next answer).
 */
const ForeignMessageRow = memo(function ForeignMessageRow({
  item,
  sessionKey,
}: {
  item: UserMessageItem;
  sessionKey: string;
}) {
  const t = useT();
  const origin = foreignOrigin(item.originKind);
  const Icon = origin.icon;
  const preview = useMemo(() => foreignPreview(item.text.text), [item.text.text]);
  const label = t(`transcript.user.origin.${origin.label}`);
  const title = preview === '' ? label : `${label} · ${preview}`;
  return (
    <div
      data-item-kind="user_message"
      data-origin="other"
      data-origin-kind={item.originKind ?? undefined}
      className="min-w-0"
    >
      <Disclosure
        stateKey={expansionKey(sessionKey, item.id)}
        header={
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{title}</span>
          </span>
        }
      >
        <div className="text-muted-foreground mt-1 ml-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-l pl-3">
          <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
            {(text) => <UserText text={text} stateKey={expansionKey(sessionKey, item.id, 'text')} />}
          </CappedContent>
          <Attachments attachments={item.attachments} />
        </div>
      </Disclosure>
    </div>
  );
});

/**
 * WP-95: `/rename <title>` – Parallax sends it itself (automatic title with Remote Control,
 * "Regenerate title", renaming in the UI), or it was typed in the Claude app: one quiet line instead
 * of a user bubble (the CLI's answer is hidden, `lib/rename.ts`).
 */
function RenameRow({
  title,
  source,
  queued = false,
}: {
  title: string;
  source: UserMessageItem['source'];
  /** Still in `detail.queue` (no item yet): no item kind, so it never counts as a message. */
  queued?: boolean;
}) {
  const lt = useLazyTranscriptT();
  return (
    <div
      data-item-kind={queued ? undefined : 'user_message'}
      data-slot="rename"
      data-source={source}
      data-queued={queued ? 'true' : undefined}
      className={cn('text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs', queued && 'opacity-60')}
    >
      <PencilLineIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        {source === 'remote' ? lt('user.renamedRemote', { title }) : lt('user.renamed', { title })}
      </span>
    </div>
  );
}

/**
 * A user message: the user's own as a bubble, one not typed by the user as a collapsed line (WP-72),
 * a `/rename <title>` as a quiet line (WP-95).
 */
export const UserMessageRow = memo(function UserMessageRow({
  item,
  sessionKey,
}: {
  item: UserMessageItem;
  sessionKey: string;
}) {
  if (item.origin === 'other') return <ForeignMessageRow item={item} sessionKey={sessionKey} />;
  const title = renameEchoTitle(item);
  if (title !== null) return <RenameRow title={title} source={item.source} />;
  return <OwnMessageRow item={item} sessionKey={sessionKey} />;
});

function OwnMessageRow({ item, sessionKey }: { item: UserMessageItem; sessionKey: string }) {
  const t = useT();
  const queuedIds = useContext(QueuedIdsContext);
  const queued = queuedIds.has(item.id);
  return (
    <UserBubble
      queued={queued}
      withdraw={queued ? { sessionKey, messageUuid: item.id } : null}
      text={
        <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
          {(text) => <UserText text={text} stateKey={expansionKey(sessionKey, item.id, 'text')} />}
        </CappedContent>
      }
    >
      <Attachments attachments={item.attachments} />
      {item.slashCommand === null && item.priority !== 'now' && item.source === 'local' ? null : (
        <div className="flex flex-wrap gap-1">
          {/* WP-64: typed in the Claude app (Remote Control). */}
          {item.source === 'remote' ? (
            <Badge variant="outline" data-slot="user-remote">
              <SmartphoneIcon aria-hidden />
              {t('transcript.user.fromClaudeApp')}
            </Badge>
          ) : null}
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
        </div>
      )}
    </UserBubble>
  );
}

/** A prompt in `detail.queue` that has no item yet (grey until the CLI takes it over, F.9). */
export const QueuedPromptRow = memo(function QueuedPromptRow({
  prompt,
  sessionKey,
}: {
  prompt: QueuedPrompt;
  sessionKey: string;
}) {
  // WP-95: Parallax's own `/rename <title>` waits like a prompt – the same quiet line, greyed.
  const title = renameTitle(prompt.text.text);
  if (title !== null) return <RenameRow title={title} source="local" queued />;
  return (
    <UserBubble
      queued
      sending={prompt.state === 'sending'}
      withdraw={{ sessionKey, messageUuid: prompt.messageUuid }}
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
