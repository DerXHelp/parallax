import { MessageCircleQuestionIcon, SendHorizontalIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LIMITS, parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { SideQuestionItem, TranscriptItem } from '@shared/model';
import { tError, useT, type TranslationKey } from '@web/i18n';
import { focusElement } from '@web/lib/return-focus';
import { errorPayloadOf, getConnection } from '@web/state/connection';
import {
  selectSessionRecord,
  selectSummary,
  sendCommand,
  useItems,
  useSessionSubscription,
  useSummarySelector,
} from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { setSelectedSession } from '@web/state/selection';
import { clientStore } from '@web/state/store';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@web/ui/popover';
import { Spinner } from '@web/ui/spinner';
import { Textarea } from '@web/ui/textarea';
import { useFeatureSlots } from '../slots';
import { sessionFocusTarget } from './focus';
import { closeQuickAsk } from './quick-ask';

/**
 * WP-66 "Quick question…" (a lazy chunk, mounted by NavigationLayer): a popover at the session's
 * sidebar row with a field for a side question (`session.askSideQuestion` – a dormant session is
 * started for it, no turn). The answer shows in the popover (Markdown slot) with "Follow up" (same
 * thread) and "Open session"; the card appears in the transcript as well. Closed before the answer
 * came, the answer arrives as a window notice with its start ("Show session" opens it). Command
 * refusals show in the popover itself (ADR-126); busy and unavailable have their own words.
 */

/** How long a closed popover's question is watched at most (the server gives up after 2 minutes). */
const WATCH_MS = 5 * 60_000;
/** Characters of the answer in the notice. */
const NOTICE_ANSWER_CHARS = 160;

function failureKey(error: ErrorPayload | null): TranslationKey | null {
  if (error === null || error.code === 'CLAUDE_CONTROL_FAILED') return 'navigation.quickAsk.unavailable';
  if (error.code === 'SESSION_BUSY') return 'navigation.quickAsk.busy';
  return null;
}

function sideItem(sessionKey: string, itemId: string): SideQuestionItem | null {
  const view = selectSessionRecord(clientStore.getState(), sessionKey).view;
  const item = view?.items.find((candidate) => candidate.id === itemId);
  return item?.kind === 'side_question' ? item : null;
}

/** The finished question of a closed popover as a notice of its session. */
function notifyAnswer(sessionKey: string, item: SideQuestionItem): void {
  const id = `quick-ask.${item.id}`;
  if (item.status === 'cancelled') return;
  if (item.status === 'failed') {
    const key = failureKey(item.error);
    if (key === null && item.error !== null) showErrorNotice(item.error, { sessionKey, id });
    else
      showTextNotice(key ?? 'navigation.quickAsk.unavailable', undefined, { sessionKey, id, tone: 'error' });
    return;
  }
  const title = selectSummary(clientStore.getState(), sessionKey)?.title ?? '';
  const text = (item.response ?? '').replace(/\s+/g, ' ').trim();
  if (item.synthetic || text === '') {
    showTextNotice('navigation.quickAsk.noAnswer', undefined, { sessionKey, id });
    return;
  }
  const answer = text.length > NOTICE_ANSWER_CHARS ? `${text.slice(0, NOTICE_ANSWER_CHARS)}…` : text;
  showTextNotice('navigation.quickAsk.answered', { title, answer }, { sessionKey, id, durationMs: 20_000 });
}

/**
 * Watches the open questions of a closed popover until each is finished (keeps the session
 * subscribed meanwhile) and shows each answer as a notice. Exported for tests.
 */
export function watchQuickAnswers(sessionKey: string, itemIds: readonly string[]): void {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null || itemIds.length === 0) return;
  const open = new Set(itemIds);
  const unsubscribeSession = getConnection(parsed.hostId).subscribe(parsed.entryId);
  let stopped = false;
  const check = () => {
    for (const id of [...open]) {
      const item = sideItem(sessionKey, id);
      if (item === null || item.status === 'pending') continue;
      open.delete(id);
      notifyAnswer(sessionKey, item);
    }
    if (open.size === 0) stop();
  };
  const unsubscribeStore = clientStore.subscribe(check);
  const timer = setTimeout(() => {
    stop();
  }, WATCH_MS);
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    unsubscribeStore();
    unsubscribeSession();
  }
  check();
}

/** The row of the session in the sidebar (a virtual anchor: the row may re-render or move). */
function rowAnchor(sessionKey: string): { current: { getBoundingClientRect: () => DOMRect } } {
  return {
    current: {
      getBoundingClientRect: () =>
        document.querySelector(`[data-session-row="${sessionKey}"]`)?.getBoundingClientRect() ??
        new DOMRect(window.innerWidth / 2, 64, 0, 0),
    },
  };
}

function Entry({ item, sessionKey }: { item: SideQuestionItem; sessionKey: string }) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const entryId = parseSessionKey(sessionKey)?.entryId;
  let answer;
  if (item.status === 'pending') {
    answer = (
      <div data-slot="quick-ask-pending" className="text-muted-foreground flex items-center gap-1.5 text-2xs">
        <Spinner className="size-3" />
        {t('navigation.quickAsk.pending')}
        {entryId === undefined ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-2xs"
            onClick={() => {
              sendCommand(sessionKey, { name: 'session.cancelSideQuestion', entryId, itemId: item.id }).catch(
                () => undefined,
              );
            }}
          >
            {t('navigation.quickAsk.cancel')}
          </Button>
        )}
      </div>
    );
  } else if (item.status === 'failed') {
    const key = failureKey(item.error);
    answer = (
      <p className="text-destructive text-2xs">
        {key === null && item.error !== null
          ? tError(item.error)
          : t(key ?? 'navigation.quickAsk.unavailable')}
      </p>
    );
  } else if (item.status === 'cancelled') {
    answer = null;
  } else if (item.synthetic || item.response === null || item.response.trim() === '') {
    answer = <p className="text-muted-foreground text-2xs italic">{t('navigation.quickAsk.noAnswer')}</p>;
  } else {
    answer = (
      <div data-slot="quick-ask-answer" className="max-h-64 overflow-y-auto">
        <Markdown text={item.response} sessionKey={sessionKey} />
      </div>
    );
  }
  return (
    <div data-side-entry={item.id} data-status={item.status} className="grid min-w-0 gap-1">
      <p className="text-ui font-medium break-words whitespace-pre-wrap">{item.question}</p>
      {answer}
    </div>
  );
}

const isSide = (item: TranscriptItem | null): item is SideQuestionItem => item?.kind === 'side_question';

export function QuickAskPopover({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  useSessionSubscription(sessionKey);
  const title = useSummarySelector(sessionKey, (s) => s.title, '');
  const [anchor] = useState(() => rowAnchor(sessionKey));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [ids, setIds] = useState<readonly string[]>([]);
  const items = useItems(sessionKey, ids).filter(isSide);
  const idsRef = useRef<readonly string[]>([]);
  const mountedRef = useRef(true);
  const entryId = parseSessionKey(sessionKey)?.entryId;
  const threadId = ids[0] ?? null;
  const pending = items.some((item) => item.status === 'pending');
  const question = text.trim();
  const canAsk =
    entryId !== undefined &&
    !busy &&
    !pending &&
    question !== '' &&
    question.length <= LIMITS.sideQuestionChars;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Closed before the answer: it comes as a notice.
      const open = idsRef.current.filter((id) => sideItem(sessionKey, id)?.status === 'pending');
      watchQuickAnswers(sessionKey, open);
    };
  }, [sessionKey]);

  const ask = () => {
    if (!canAsk) return;
    setBusy(true);
    setError(null);
    sendCommand(sessionKey, { name: 'session.askSideQuestion', entryId, question, threadId }).then(
      (result) => {
        if (!mountedRef.current) {
          watchQuickAnswers(sessionKey, [result.itemId]);
          return;
        }
        idsRef.current = [...idsRef.current, result.itemId];
        setIds(idsRef.current);
        setText('');
        setBusy(false);
      },
      (caught: unknown) => {
        if (!mountedRef.current) return;
        setError(errorPayloadOf(caught));
        setBusy(false);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    ask();
  };

  const errorKey = error === null ? null : failureKey(error);
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) closeQuickAsk();
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        side="right"
        align="start"
        data-slot="quick-ask"
        aria-label={t('navigation.quickAsk.title', { title })}
        className="grid max-h-[80vh] w-96 max-w-[calc(100vw-2rem)] gap-2 overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusElement(sessionFocusTarget(sessionKey, 'sidebar'));
        }}
      >
        <div className="grid gap-0.5">
          <p className="text-side-question flex items-center gap-1.5 text-xs font-medium">
            <MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{t('navigation.quickAsk.title', { title })}</span>
          </p>
          <p className="text-muted-foreground text-2xs">{t('navigation.quickAsk.hint')}</p>
        </div>
        {items.map((item) => (
          <Entry key={item.id} item={item} sessionKey={sessionKey} />
        ))}
        {error === null ? null : (
          <Alert tone="error">{errorKey === null ? tError(error) : t(errorKey)}</Alert>
        )}
        <Textarea
          value={text}
          rows={2}
          aria-label={
            ids.length === 0 ? t('navigation.quickAsk.placeholder') : t('navigation.quickAsk.followUp')
          }
          placeholder={
            ids.length === 0 ? t('navigation.quickAsk.placeholder') : t('navigation.quickAsk.followUp')
          }
          aria-invalid={question.length > LIMITS.sideQuestionChars}
          className="border-side-question/60 max-h-40 min-h-14 border-dashed"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            data-action="quick-ask-open"
            onClick={() => {
              setSelectedSession(sessionKey);
              closeQuickAsk();
            }}
          >
            {t('navigation.quickAsk.open')}
          </Button>
          <Button size="sm" data-action="quick-ask-send" disabled={!canAsk} onClick={ask}>
            {busy ? <Spinner className="size-3" /> : <SendHorizontalIcon aria-hidden />}
            {t('navigation.quickAsk.ask')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
