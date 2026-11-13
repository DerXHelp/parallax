import {
  CornerDownRightIcon,
  MessageCircleQuestionIcon,
  SendHorizontalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { memo, useState, type KeyboardEvent } from 'react';
import { LIMITS, parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { SideQuestionItem, TranscriptItem } from '@shared/model';
import type { Command } from '@shared/protocol';
import type { SessionViewState } from '@shared/sync';
import { tError, useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionSelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import { CopyButton } from '@web/ui/copy-button';
import { IconButton } from '@web/ui/icon-button';
import { Spinner } from '@web/ui/spinner';
import { Textarea } from '@web/ui/textarea';
import { notifyCopied } from '../components/CodeBlock';
import { Markdown } from '../markdown/Markdown';

/**
 * WP-66: the card of a side-question thread (`/btw`, „Kurz fragen…“) at the position of its first
 * question – a lazy chunk of its own (start-chunk budget). Dashed border on the side-question
 * surface and the hint "Side question · not in the context": the answers never reach Claude's
 * conversation. Every question of the thread follows with its answer (Markdown like assistant
 * text); pending ones say "asking…" with Cancel, a synthetic answer is muted ("no answer
 * available"), an answer of a fallback model names it. Actions: Follow up (a small field, the
 * answered questions go along as history – the server builds it), Copy (the latest answer) and
 * Delete (the whole thread). No costs: the CLI reports none for side questions.
 */

const EMPTY: readonly SideQuestionItem[] = Object.freeze([]);
const threadsCache = new WeakMap<readonly TranscriptItem[], Map<string, SideQuestionItem[]>>();

/** The side questions of every thread of the view, by order (cached per items array). */
function threadsOf(items: readonly TranscriptItem[]): Map<string, SideQuestionItem[]> {
  let threads = threadsCache.get(items);
  if (threads !== undefined) return threads;
  threads = new Map();
  for (const item of items) {
    if (item.kind !== 'side_question') continue;
    const list = threads.get(item.threadId) ?? [];
    list.push(item);
    threads.set(item.threadId, list);
  }
  for (const list of threads.values()) list.sort((a, b) => a.order - b.order);
  threadsCache.set(items, threads);
  return threads;
}

/** Failure text of a side question: busy and unavailable have their own words (WP-66 §1.2). */
function failureText(error: ErrorPayload | null, t: ReturnType<typeof useT>): string {
  if (error === null) return t('transcript.side.unavailable');
  switch (error.code) {
    case 'SESSION_BUSY':
      return t('transcript.side.busy');
    case 'SESSION_NOT_RUNNING':
      return t('transcript.side.ended');
    case 'CLAUDE_CONTROL_FAILED':
      return t('transcript.side.unavailable');
    default:
      return tError(error);
  }
}

function send(sessionKey: string, cmd: Command): Promise<boolean> {
  return sendCommand(sessionKey, cmd).then(
    () => true,
    (caught: unknown) => {
      showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `transcript.side.${sessionKey}` });
      return false;
    },
  );
}

function SideAnswer({ item, sessionKey }: { item: SideQuestionItem; sessionKey: string }) {
  const t = useT();
  const entryId = parseSessionKey(sessionKey)?.entryId;
  switch (item.status) {
    case 'pending':
      return (
        <div data-slot="side-pending" className="text-muted-foreground flex items-center gap-1.5 text-2xs">
          <Spinner className="size-3" />
          {item.retry === null
            ? t('transcript.side.pending')
            : t('transcript.side.retry', { attempt: item.retry.attempt, max: item.retry.maxRetries })}
          {entryId === undefined ? null : (
            <Button
              size="sm"
              variant="ghost"
              data-action="side-cancel"
              className="h-5 px-1.5 text-2xs"
              onClick={() => {
                void send(sessionKey, { name: 'session.cancelSideQuestion', entryId, itemId: item.id });
              }}
            >
              {t('transcript.side.cancel')}
            </Button>
          )}
        </div>
      );
    case 'answered':
      if (item.synthetic || item.response === null || item.response.trim() === '') {
        return (
          <p data-slot="side-synthetic" className="text-muted-foreground text-2xs italic">
            {t('transcript.side.synthetic')}
          </p>
        );
      }
      return (
        <div data-slot="side-answer" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
          <Markdown text={item.response} sessionKey={sessionKey} />
          {item.fallbackModel === null ? null : (
            <span className="text-muted-foreground text-2xs">
              {t('transcript.side.fallback', { model: item.fallbackModel })}
            </span>
          )}
        </div>
      );
    case 'failed':
      return (
        <p data-slot="side-failed" className="text-destructive text-2xs">
          {failureText(item.error, t)}
        </p>
      );
    case 'cancelled':
      return (
        <p data-slot="side-cancelled" className="text-muted-foreground text-2xs italic">
          {t('transcript.side.cancelled')}
        </p>
      );
  }
}

/** The small follow-up field: Enter asks, Shift+Enter breaks the line, Esc closes it. */
function FollowUp({
  sessionKey,
  threadId,
  onClose,
}: {
  sessionKey: string;
  threadId: string;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const question = text.trim();
  const entryId = parseSessionKey(sessionKey)?.entryId;
  const canAsk =
    entryId !== undefined && !busy && question !== '' && question.length <= LIMITS.sideQuestionChars;

  const ask = () => {
    if (!canAsk) return;
    setBusy(true);
    void send(sessionKey, { name: 'session.askSideQuestion', entryId, question, threadId }).then((ok) => {
      setBusy(false);
      if (ok) onClose();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    ask();
  };

  return (
    <div data-slot="side-follow-up" className="flex items-end gap-1">
      <Textarea
        // Opened by the user's click on "Follow up": the field takes the focus.
        autoFocus
        value={text}
        rows={1}
        aria-label={t('transcript.side.followUp')}
        placeholder={t('transcript.side.followUpPlaceholder')}
        aria-invalid={question.length > LIMITS.sideQuestionChars}
        className="bg-background max-h-32 min-h-8"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <IconButton label={t('transcript.side.ask')} data-action="side-ask" disabled={!canAsk} onClick={ask}>
        {busy ? <Spinner className="size-3" /> : <SendHorizontalIcon aria-hidden />}
      </IconButton>
      <IconButton label={t('transcript.side.closeFollowUp')} onClick={onClose}>
        <XIcon aria-hidden />
      </IconButton>
    </div>
  );
}

export const SideQuestionCard = memo(function SideQuestionCard({
  item,
  sessionKey,
}: {
  item: SideQuestionItem;
  sessionKey: string;
}) {
  const t = useT();
  const threadId = item.threadId;
  const thread = useSessionSelector(
    sessionKey,
    (view: SessionViewState) => threadsOf(view.items).get(threadId) ?? EMPTY,
    EMPTY,
  );
  const [following, setFollowing] = useState(false);
  // The list may not hold the item yet (the row renders from the same store); never render empty.
  const entries = thread.length === 0 ? [item] : thread;
  const last = entries.at(-1);
  const latestAnswer =
    entries.findLast((entry) => entry.status === 'answered' && !entry.synthetic)?.response ?? null;
  const entryId = parseSessionKey(sessionKey)?.entryId;
  const pending = last?.status === 'pending';

  return (
    <section
      data-item-kind="side_question"
      data-thread={threadId}
      aria-label={t('transcript.side.label')}
      className="border-side-question/50 bg-side-question-surface grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-dashed px-3 py-2"
    >
      <div className="flex items-center gap-1.5">
        <MessageCircleQuestionIcon aria-hidden className="text-side-question size-3.5 shrink-0" />
        <span className="text-side-question text-2xs font-medium">{t('transcript.side.label')}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {latestAnswer === null ? null : (
            <CopyButton text={latestAnswer} label={t('transcript.side.copy')} onCopied={notifyCopied} />
          )}
          {entryId === undefined ? null : (
            <IconButton
              label={t('transcript.side.delete')}
              size="icon-xs"
              data-action="side-delete"
              onClick={() => {
                void send(sessionKey, { name: 'session.deleteSideQuestion', entryId, threadId });
              }}
            >
              <Trash2Icon aria-hidden />
            </IconButton>
          )}
        </div>
      </div>
      {entries.map((entry, index) => (
        <div
          key={entry.id}
          data-side-entry={entry.id}
          data-status={entry.status}
          className={
            index === 0 ? 'grid min-w-0 gap-1' : 'border-side-question/25 grid min-w-0 gap-1 border-t pt-2'
          }
        >
          <p className="text-ui font-medium break-words whitespace-pre-wrap">{entry.question}</p>
          <SideAnswer item={entry} sessionKey={sessionKey} />
        </div>
      ))}
      {following ? (
        <FollowUp
          sessionKey={sessionKey}
          threadId={threadId}
          onClose={() => {
            setFollowing(false);
          }}
        />
      ) : pending || entryId === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          data-action="side-follow-up"
          className="text-muted-foreground h-6 justify-self-start px-1.5 text-2xs"
          onClick={() => {
            setFollowing(true);
          }}
        >
          <CornerDownRightIcon aria-hidden className="size-3" />
          {t('transcript.side.followUp')}
        </Button>
      )}
    </section>
  );
});
