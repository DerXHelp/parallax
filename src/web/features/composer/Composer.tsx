import { ChevronDownIcon, CornerDownRightIcon, SendHorizontalIcon, SquareIcon, ZapIcon } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import type { PromptPriority } from '@shared/common';
import type { Decision, QueuedPrompt } from '@shared/model';
import type { RunState } from '@shared/status';
import type { SessionViewState } from '@shared/sync';
import { useT, type t as translateFn } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useEscapeHandler } from '@web/shell/shortcuts';
import {
  useDecisions,
  useSessionConnectionStatus,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { reportTyping } from '@web/state/presence';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Spinner } from '@web/ui/spinner';
import { Textarea } from '@web/ui/textarea';
import { requesterText } from '../decisions/components/RequesterLabel';
import { respondToDecision } from '../decisions/lib/respond';
import {
  markLocalResolution,
  pickDisplayedDecision,
  useSelectedDecisionId,
} from '../decisions/state/bar-store';
import { QueueList, type QueueEntry } from './components/QueueList';
import { ContextGauge } from './ContextGauge';
import { answerFromText, interruptSession, sendPrompt, textLimit } from './lib/commands';
import { ModelPicker } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { clearDraft, getDraft, setDraft, useDraft } from './state/drafts';
import { useComposerFocusTarget } from './state/focus';

const EMPTY_QUEUE: readonly QueuedPrompt[] = [];
const selectQueue = (view: SessionViewState) => view.detail.queue;

interface PendingSend {
  id: number;
  text: string;
  priority: PromptPriority;
}

let pendingCounter = 0;

type Via = 'primary' | 'message' | 'now';

function isWorking(runState: RunState | null): boolean {
  return runState === 'working' || runState === 'starting';
}

function targetHint(target: Decision, t: typeof translateFn): string {
  switch (target.kind) {
    case 'permission':
      return t('composer.target.permission', {
        tool: target.displayName ?? target.toolName,
        requester: requesterText(target.requester, t),
      });
    case 'question':
      return t('composer.target.question', { requester: requesterText(target.requester, t) });
    case 'plan':
      return t('composer.target.plan', { version: target.version });
  }
}

/**
 * Slot `Composer` (Plan "Chat-Ansicht → Interaktion", B "Tastatur", "Entwürfe"):
 * - Enter sends, Shift+Enter breaks the line (IME composition never sends).
 * - While Claude works, messages are queued (`priority: 'next'`, visible until taken over);
 *   "Send now" sends with `priority: 'now'`; Stop (and Esc in an empty composer) interrupts.
 * - While a decision is open (the one the bar shows), the text answers it: permission deny +
 *   message, question decline + message, plan revise ("Keep planning with feedback") – it can
 *   never approve. "Send as new message instead" queues it as a normal prompt.
 * - Drafts per session survive remounts and reloads (state/drafts.ts); typing reports presence.
 * - Sending needs an open connection; failures restore the text and show a notice.
 */
export const Composer = memo(function Composer({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const text = useDraft(sessionKey);
  const runState = useSummarySelector<RunState | null>(sessionKey, (s) => s.status.runState, null);
  const decisions = useDecisions(sessionKey);
  const selectedId = useSelectedDecisionId(sessionKey);
  const displayed = pickDisplayedDecision(decisions, selectedId);
  const target = displayed?.state === 'open' ? displayed : null;
  const queue = useSessionSelector(sessionKey, selectQueue, EMPTY_QUEUE);
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  const [answering, setAnswering] = useState(0);
  const working = isWorking(runState);

  const value = text.trim();
  const limit = textLimit(target);
  const tooLong = value.length > limit;
  const canSend = online && value !== '' && !tooLong;

  useComposerFocusTarget(sessionKey, () => {
    textareaRef.current?.focus();
  });

  const stop = () => {
    // The interrupt cancels every open decision of the session (WP-13 §3.4): no "elsewhere" hints.
    markLocalResolution(decisions.filter((decision) => decision.state === 'open').map((d) => d.id));
    void interruptSession(sessionKey);
  };

  useEscapeHandler(
    () => {
      if (getDraft(sessionKey) !== '' || !online) return false;
      stop();
      return true;
    },
    working,
    { scopeRef: rootRef },
  );

  const submit = (via: Via) => {
    const message = getDraft(sessionKey).trim();
    const answerTarget = via === 'primary' ? target : null;
    if (!online || message === '' || message.length > textLimit(answerTarget)) return;
    clearDraft(sessionKey);
    const restore = () => {
      if (getDraft(sessionKey) === '') setDraft(sessionKey, message);
    };
    if (answerTarget !== null) {
      setAnswering((count) => count + 1);
      void respondToDecision(sessionKey, answerTarget, answerFromText(answerTarget, message)).then((ok) => {
        setAnswering((count) => count - 1);
        if (!ok) restore();
      });
      return;
    }
    const priority: PromptPriority = via === 'now' ? 'now' : 'next';
    if (priority === 'now') {
      // "Send now" cancels the main agent's open decisions (WP-13 §3.4).
      markLocalResolution(
        decisions.filter((d) => d.state === 'open' && d.requester.kind === 'main').map((d) => d.id),
      );
    }
    const entry: PendingSend = { id: ++pendingCounter, text: message, priority };
    setPending((current) => [...current, entry]);
    void sendPrompt(sessionKey, message, priority).then((ok) => {
      setPending((current) => current.filter((candidate) => candidate.id !== entry.id));
      if (!ok) restore();
    });
  };

  const queuedTexts = new Set(queue.map((prompt) => prompt.text.text));
  const entries: QueueEntry[] = [
    ...queue.map((prompt) => ({
      key: prompt.messageUuid,
      text: prompt.text.text,
      priority: prompt.priority,
      state: prompt.state,
    })),
    ...pending
      .filter((entry) => !queuedTexts.has(entry.text))
      .map((entry) => ({
        key: `pending-${String(entry.id)}`,
        text: entry.text,
        priority: entry.priority,
        state: 'sending' as const,
      })),
  ];

  let placeholder: string;
  if (target !== null) placeholder = t(`composer.placeholder.${target.kind}`);
  else placeholder = working ? t('composer.placeholder.working') : t('composer.placeholder.idle');

  let sendLabel: string;
  if (target?.kind === 'plan') sendLabel = t('composer.answerPlan');
  else if (target !== null) sendLabel = t('composer.answer');
  else sendLabel = working ? t('composer.queue') : t('composer.send');

  const busy = answering > 0 || pending.length > 0;
  const inputId = `composer-${sessionKey}`;
  const hintId = `${inputId}-hint`;

  return (
    <div
      ref={rootRef}
      data-slot="composer"
      data-shortcut-scope="composer"
      data-mode={target === null ? (working ? 'queue' : 'idle') : `answer-${target.kind}`}
      className="border-t px-3 pt-2 pb-2"
    >
      <QueueList entries={entries} />
      {target === null ? null : (
        <p
          id={hintId}
          data-slot="composer-target"
          className="text-muted-foreground mb-1 flex items-start gap-1.5 text-2xs"
        >
          <CornerDownRightIcon aria-hidden className="mt-px size-3 shrink-0" />
          {targetHint(target, t)}
        </p>
      )}
      <Textarea
        id={inputId}
        ref={textareaRef}
        value={text}
        aria-label={t('composer.label')}
        aria-describedby={target === null ? undefined : hintId}
        aria-invalid={tooLong}
        placeholder={placeholder}
        rows={1}
        className="max-h-60 min-h-9 resize-none"
        onChange={(event) => {
          setDraft(sessionKey, event.target.value);
          reportTyping();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
          event.preventDefault();
          submit('primary');
        }}
      />
      {tooLong ? (
        <p role="alert" className="text-destructive mt-1 text-2xs">
          {t('composer.tooLong', { max: limit })}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <div
          role="group"
          aria-label={t('composer.toolbar')}
          className="flex min-w-0 flex-wrap items-center gap-0.5"
        >
          <ModePicker sessionKey={sessionKey} />
          <ModelPicker sessionKey={sessionKey} />
          <ContextGauge sessionKey={sessionKey} />
        </div>
        <span className="flex-1" />
        {online ? null : <span className="text-warning text-2xs">{t('composer.notConnected')}</span>}
        {working ? (
          <Button
            variant="outline"
            size="sm"
            data-action="stop"
            title={t('composer.stopHint')}
            disabled={!online}
            onClick={stop}
          >
            <SquareIcon aria-hidden className="fill-current" />
            {t('composer.stop')}
          </Button>
        ) : null}
        {working && target === null ? (
          <Button
            variant="outline"
            size="sm"
            data-action="send-now"
            title={t('composer.sendNowHint')}
            disabled={!canSend}
            onClick={() => {
              submit('now');
            }}
          >
            <ZapIcon aria-hidden />
            {t('composer.sendNow')}
          </Button>
        ) : null}
        <span className="inline-flex items-center gap-px">
          <Button
            size="sm"
            data-action="send"
            disabled={!canSend}
            className={cn(target !== null && 'rounded-r-none')}
            onClick={() => {
              submit('primary');
            }}
          >
            {busy ? <Spinner className="size-3" /> : <SendHorizontalIcon aria-hidden />}
            {sendLabel}
          </Button>
          {target === null ? null : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  aria-label={t('composer.moreSend')}
                  title={t('composer.moreSend')}
                  disabled={!canSend}
                  className="rounded-l-none"
                >
                  <ChevronDownIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    submit('message');
                  }}
                >
                  {t('composer.sendAsMessage')}
                </DropdownMenuItem>
                {working ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      submit('now');
                    }}
                  >
                    {t('composer.sendNow')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
    </div>
  );
});
