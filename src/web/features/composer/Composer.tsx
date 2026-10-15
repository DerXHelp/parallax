import {
  ChevronDownIcon,
  CircleDotIcon,
  CornerDownRightIcon,
  ReplyIcon,
  SendHorizontalIcon,
  SquareIcon,
  ZapIcon,
} from 'lucide-react';
import { memo, useContext, useEffect, useRef, useState } from 'react';
import type { DecisionId, PromptPriority } from '@shared/common';
import type { Decision } from '@shared/model';
import type { RunState } from '@shared/status';
import { useT, type t as translateFn } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useEscapeHandler } from '@web/shell/shortcuts';
import { useDecisions, useSessionConnectionStatus, useSummarySelector } from '@web/state/hooks';
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
import { DecisionArmDelayContext } from '../decisions/components/card-shell';
import { requesterText } from '../decisions/components/RequesterLabel';
import { respondToDecision } from '../decisions/lib/respond';
import {
  markLocalResolution,
  pickDisplayedDecision,
  useSelectedDecisionId,
} from '../decisions/state/bar-store';
import { ContextGauge } from './ContextGauge';
import { answerFromText, interruptSession, isSingleQuestion, sendPrompt, textLimit } from './lib/commands';
import { ModelPicker } from './ModelPicker';
import { ModePicker } from './ModePicker';
import { clearDraft, getDraft, setDraft, useDraft } from './state/drafts';
import { useComposerFocusTarget } from './state/focus';

/** `primary` = Enter / main button, `answer` = explicit "Send as answer" (decision not the Enter target). */
type Via = 'primary' | 'answer' | 'message' | 'now';

type TargetKind = 'permission' | 'question' | 'questions' | 'plan';

/** The counter appears from this share of the limit on. */
const COUNTER_FROM = 0.8;

function isWorking(runState: RunState | null): boolean {
  return runState === 'working' || runState === 'starting';
}

function targetKind(decision: Decision): TargetKind {
  if (decision.kind === 'question') return isSingleQuestion(decision) ? 'question' : 'questions';
  return decision.kind;
}

/** Hint above the field: `target` = Enter answers it, `pending` = it is open, Enter sends a message. */
function decisionHint(decision: Decision, variant: 'target' | 'pending', t: typeof translateFn): string {
  const requester = requesterText(decision.requester, t);
  switch (decision.kind) {
    case 'permission':
      return t(`composer.${variant}.permission`, {
        tool: decision.displayName ?? decision.toolName,
        requester,
      });
    case 'question':
      return isSingleQuestion(decision)
        ? t(`composer.${variant}.question`, { requester })
        : t(`composer.${variant}.questions`, { requester });
    case 'plan':
      return t(`composer.${variant}.plan`, { version: decision.version });
  }
}

/**
 * Slot `Composer` (Plan "Chat-Ansicht → Interaktion", B "Tastatur", "Entwürfe"):
 * - Enter sends, Shift+Enter breaks the line (IME composition never sends).
 * - While Claude works, messages are queued (`priority: 'next'`; the transcript shows them grey,
 *   the header counts them – R2W-04); "Send now" sends with `priority: 'now'`; Stop (and Esc in
 *   an empty composer) interrupts.
 * - Open decision (the one the bar shows) – target lock (R2W-01, ADR-040): Enter answers it only
 *   if it was already shown (≥ arm delay) when the current draft began, and only for the main
 *   agent – permission deny + message, one question answered with the text, several questions
 *   declined + message, plan revise ("Keep planning with feedback"); it can never approve. A
 *   decision that appears while typing (or a subagent's, or a restored draft) leaves Enter as a
 *   normal send; the composer then offers "Send as answer" explicitly. "Keep planning" in the bar
 *   sets the target explicitly.
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
  const targetId = target?.id ?? null;
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const armDelayMs = useContext(DecisionArmDelayContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** When the composer first saw the current target (arm delay, like the cards). */
  const shownRef = useRef<{ id: DecisionId; at: number } | null>(null);
  /** The decision Enter answers – fixed when the draft begins (R2W-01). */
  const [lockedId, setLockedId] = useState<DecisionId | null>(null);
  const [sending, setSending] = useState(0);
  const working = isWorking(runState);

  useEffect(() => {
    if (targetId !== null && shownRef.current?.id !== targetId) {
      shownRef.current = { id: targetId, at: performance.now() };
    }
  }, [targetId]);

  /** Shown for at least the arm delay – a decision appearing right before a key stroke is not taken. */
  const isArmed = (decision: Decision): boolean => {
    const shown = shownRef.current;
    return shown?.id === decision.id && performance.now() - shown.at >= armDelayMs;
  };

  // Enter answers the target only when the draft was begun for it. An empty field shows what the
  // first key stroke will fix (the main agent's decision), so placeholder and hint fit.
  const enterAnswers =
    target !== null && (lockedId === target.id || (text === '' && target.requester.kind === 'main'));
  const answerTarget = enterAnswers ? target : null;
  const pendingTarget = target !== null && !enterAnswers ? target : null;

  const value = text.trim();
  const limit = textLimit(answerTarget);
  const tooLong = value.length > limit;
  const canSend = online && value !== '' && !tooLong;
  const canAnswer =
    pendingTarget !== null && online && value !== '' && value.length <= textLimit(pendingTarget);

  useComposerFocusTarget(sessionKey, (decisionId) => {
    // "Keep planning" chose the decision explicitly: Enter answers it.
    if (decisionId !== null) setLockedId(decisionId);
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

  const changeText = (next: string) => {
    if (getDraft(sessionKey) === '' && next !== '') {
      // The draft begins: fix its Enter target (an explicit choice for the same decision stays).
      let lock: DecisionId | null = null;
      if (
        target !== null &&
        (lockedId === target.id || (target.requester.kind === 'main' && isArmed(target)))
      ) {
        lock = target.id;
      }
      setLockedId(lock);
    } else if (next === '') {
      setLockedId(null);
    }
    setDraft(sessionKey, next);
    reportTyping();
  };

  const submit = (via: Via) => {
    const message = getDraft(sessionKey).trim();
    let answer: Decision | null = null;
    if (via === 'primary' && target !== null && lockedId === target.id) answer = target;
    if (via === 'answer') {
      if (target === null || !isArmed(target)) return;
      answer = target;
    }
    if (!online || message === '' || message.length > textLimit(answer)) return;
    clearDraft(sessionKey);
    setLockedId(null);
    const restore = (lock: DecisionId | null) => {
      if (getDraft(sessionKey) !== '') return;
      setDraft(sessionKey, message);
      setLockedId(lock);
    };
    setSending((count) => count + 1);
    if (answer !== null) {
      const decision = answer;
      void respondToDecision(sessionKey, decision, answerFromText(decision, message)).then((ok) => {
        setSending((count) => count - 1);
        if (!ok) restore(decision.id);
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
    void sendPrompt(sessionKey, message, priority).then((ok) => {
      setSending((count) => count - 1);
      if (!ok) restore(null);
    });
  };

  let placeholder: string;
  if (answerTarget !== null) placeholder = t(`composer.placeholder.${targetKind(answerTarget)}`);
  else placeholder = working ? t('composer.placeholder.working') : t('composer.placeholder.idle');

  const answerLabel = (decision: Decision) =>
    decision.kind === 'plan' ? t('composer.answerPlan') : t('composer.answer');
  let sendLabel: string;
  if (answerTarget !== null) sendLabel = answerLabel(answerTarget);
  else sendLabel = working ? t('composer.queue') : t('composer.send');

  let mode: string;
  if (answerTarget !== null) mode = `answer-${answerTarget.kind}`;
  else if (pendingTarget !== null) mode = `pending-${pendingTarget.kind}`;
  else mode = working ? 'queue' : 'idle';

  const inputId = `composer-${sessionKey}`;
  const hintId = `${inputId}-hint`;
  const hintTarget = answerTarget ?? pendingTarget;

  return (
    <div
      ref={rootRef}
      data-slot="composer"
      data-shortcut-scope="composer"
      data-mode={mode}
      className="border-t px-3 pt-2 pb-2"
    >
      {hintTarget === null ? null : (
        <p
          id={hintId}
          data-slot={answerTarget === null ? 'composer-pending' : 'composer-target'}
          className={cn(
            'mb-1 flex items-start gap-1.5 text-2xs',
            answerTarget === null ? 'text-status-waiting' : 'text-muted-foreground',
          )}
        >
          {answerTarget === null ? (
            <CircleDotIcon aria-hidden className="mt-px size-3 shrink-0" />
          ) : (
            <CornerDownRightIcon aria-hidden className="mt-px size-3 shrink-0" />
          )}
          {decisionHint(hintTarget, answerTarget === null ? 'pending' : 'target', t)}
        </p>
      )}
      <Textarea
        id={inputId}
        ref={textareaRef}
        value={text}
        aria-label={t('composer.label')}
        aria-describedby={hintTarget === null ? undefined : hintId}
        aria-invalid={tooLong}
        placeholder={placeholder}
        rows={1}
        className="max-h-60 min-h-9 resize-none"
        onChange={(event) => {
          changeText(event.target.value);
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
        {value.length > limit * COUNTER_FROM ? (
          <span
            data-slot="composer-counter"
            className={cn('text-2xs tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')}
          >
            {t('composer.counter', { count: value.length, max: limit })}
          </span>
        ) : null}
        {/* Left of the send buttons: appearing while the user types never moves them (R2W-01). */}
        {pendingTarget === null ? null : (
          <Button
            variant="outline"
            size="sm"
            data-action="answer"
            disabled={!canAnswer}
            onClick={() => {
              submit('answer');
            }}
          >
            <ReplyIcon aria-hidden />
            {answerLabel(pendingTarget)}
          </Button>
        )}
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
        {working && answerTarget === null ? (
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
            className={cn(answerTarget !== null && 'rounded-r-none')}
            onClick={() => {
              submit('primary');
            }}
          >
            {sending > 0 ? <Spinner className="size-3" /> : <SendHorizontalIcon aria-hidden />}
            {sendLabel}
          </Button>
          {answerTarget === null ? null : (
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
