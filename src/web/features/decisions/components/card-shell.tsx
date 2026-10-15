import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { DecisionKind } from '@shared/common';
import type { Decision } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { shortcutKeyLabels, useShortcut } from '@web/shell/shortcuts';
import { useSessionConnectionStatus } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button, type ButtonProps } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { STATUS_PRESENTATION } from '@web/ui/status-icon';
import { RequesterLabel } from './RequesterLabel';

/**
 * Shell of the ONE operable decision card (architecture §2.3e, Plan "Plan-Modus"): Claude waits,
 * the user never. Safety rules, all enforced here:
 * - Answers only by pointer click or by the explicit shortcut `Mod+Enter` while the focus is inside
 *   this card: it answers with the focused answer button; on another button of the card it does
 *   nothing; on the card itself or in its fields (question options, "Other", notes) it runs the
 *   card's main action. Enter or Space on a focused answer button never answers, so typing can
 *   never approve.
 * - A freshly shown decision ignores answers for `ARM_DELAY_MS` (double clicks and a decision that
 *   appears under the pointer cannot answer it).
 * - Never `autoFocus`, never `role="dialog"`; the card is focusable by script only (focusDecision).
 * - While an answer is on its way (or the host is offline) every answer button is disabled.
 */

/** A new decision is not answerable for this long (ms). */
export const ARM_DELAY_MS = 600;

/** Arm delay of the cards below (tests set 0; the playground keeps the default). */
export const DecisionArmDelayContext = createContext<number>(ARM_DELAY_MS);

/** Keyboard activation window: a click within this time after Enter/Space came from the keyboard. */
const KEY_ACTIVATION_MS = 1000;

export const RESPOND_KEYS = 'Mod+Enter';

interface CardActions {
  disabled: boolean;
  armed: boolean;
  sending: boolean;
  /** True when a click on an answer button may answer (armed, not a key activation, enabled). */
  accept(event: ReactMouseEvent): boolean;
  /** Runs an answer: disables the card until the server answered (or the answer failed). */
  respond(action: () => Promise<boolean>): void;
}

const CardActionsContext = createContext<CardActions | null>(null);

function useCardActions(): CardActions {
  const context = useContext(CardActionsContext);
  if (context === null) throw new Error('DecisionAction outside of a DecisionCardShell');
  return context;
}

/** Re-enables the buttons if an accepted answer never removed the card (defensive). */
const SENDING_FALLBACK_MS = 15_000;

function useArmed(delayMs: number): boolean {
  const [armed, setArmed] = useState(delayMs <= 0);
  useEffect(() => {
    if (armed) return undefined;
    const timer = setTimeout(() => {
      setArmed(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed, delayMs]);
  return armed;
}

export interface DecisionCardShellProps {
  sessionKey: string;
  decision: Decision;
  /** Short title line (tool, plan version …). */
  title: ReactNode;
  /** Right side of the header (queue menu, context gauge). */
  headerExtra?: ReactNode;
  children?: ReactNode;
  /** Answer buttons and menus. */
  actions: ReactNode;
  /** Answer of `Mod+Enter` when no answer button has the focus (null = none, e.g. incomplete). */
  primary: (() => Promise<boolean>) | null;
  className?: string;
}

/** Card frame + answer guard; renders `data-decision-id` (target of focusDecision). */
export function DecisionCardShell({
  sessionKey,
  decision,
  title,
  headerExtra,
  children,
  actions,
  primary,
  className,
}: DecisionCardShellProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const keyActivationAt = useRef<number | null>(null);
  const viaShortcut = useRef(false);
  const armed = useArmed(useContext(DecisionArmDelayContext));
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [sending, setSending] = useState(false);
  const disabled = sending || !online;

  useEffect(() => {
    if (!sending) return undefined;
    const timer = setTimeout(() => {
      setSending(false);
    }, SENDING_FALLBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [sending]);

  const accept = useCallback(
    (event: ReactMouseEvent) => {
      if (!armed || disabled) return false;
      if (viaShortcut.current) return true;
      const at = keyActivationAt.current;
      // detail 0 = not a pointer click: Enter/Space on the focused button (or a script).
      if (event.detail === 0 && at !== null && event.timeStamp - at < KEY_ACTIVATION_MS) return false;
      return true;
    },
    [armed, disabled],
  );

  const respond = useCallback((action: () => Promise<boolean>) => {
    setSending(true);
    void action().then((ok) => {
      if (!ok) setSending(false);
    });
  }, []);

  const value = useMemo<CardActions>(
    () => ({ disabled, armed, sending, accept, respond }),
    [disabled, armed, sending, accept, respond],
  );

  useShortcut({
    id: 'decisions.respond',
    keys: RESPOND_KEYS,
    description: 'decisions.shortcuts.respond',
    scopeRef: rootRef,
    allowInInputs: true,
    run: (event) => {
      if (!armed || disabled) return true;
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest('[data-decision-action]');
      if (button instanceof HTMLButtonElement && rootRef.current?.contains(button) === true) {
        if (!button.disabled) {
          viaShortcut.current = true;
          try {
            button.click();
          } finally {
            viaShortcut.current = false;
          }
        }
        return true;
      }
      // Focus on another control of the card ("Keep planning", "Open plan", a menu trigger …):
      // Mod+Enter must not answer with the main action behind the user's back. Options of a
      // question (radio/checkbox) belong to the answer form and keep the main action.
      const control = target?.closest('button, a[href]');
      const role = control?.getAttribute('role');
      if (control instanceof HTMLElement && role !== 'radio' && role !== 'checkbox') return true;
      if (primary !== null) respond(primary);
      return true;
    },
  });

  const onKeyDownCapture = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') keyActivationAt.current = event.timeStamp;
  };

  const kind = decision.state === 'expired' ? 'needs-resume' : NEEDS_KIND[decision.kind];
  const Icon = STATUS_PRESENTATION[kind].icon;
  const keys = shortcutKeyLabels(RESPOND_KEYS, t);

  return (
    <CardActionsContext value={value}>
      <div
        ref={rootRef}
        data-slot="decision-card"
        data-decision-id={decision.id}
        data-decision-kind={decision.kind}
        data-decision-state={decision.state}
        data-armed={armed ? 'true' : 'false'}
        tabIndex={-1}
        onKeyDownCapture={onKeyDownCapture}
        aria-busy={sending}
        className={cn(
          'group/decision bg-card text-card-foreground focus-visible:ring-ring flex max-h-[45vh] min-h-0 flex-col rounded-lg border shadow-sm outline-none focus-visible:ring-2',
          decision.state === 'open' ? 'border-status-waiting/45' : 'border-border',
          className,
        )}
      >
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2 pb-1">
          <Icon aria-hidden className={cn('size-3.5 shrink-0', STATUS_PRESENTATION[kind].tone)} />
          <span className="min-w-0 truncate font-semibold">{title}</span>
          <RequesterLabel requester={decision.requester} />
          {decision.state === 'expired' ? (
            <Badge variant="warning">{t('decisions.expired.badge')}</Badge>
          ) : null}
          {sending ? <Spinner label={t('decisions.bar.sending')} className="text-muted-foreground" /> : null}
          <span className="flex-1" />
          {headerExtra}
        </header>
        {children === undefined ? null : (
          <div className="min-h-0 overflow-y-auto px-3 py-1 text-ui">{children}</div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-2">{actions}</div>
        {online ? null : (
          <p role="status" className="text-warning px-3 pb-2 text-2xs">
            {t('decisions.bar.notConnected')}
          </p>
        )}
        {/* Only for keyboard focus: a hint appearing on a pointer click would move the buttons
            under the pointer (the click would land elsewhere). */}
        <p className="text-muted-foreground hidden px-3 pb-2 text-2xs group-has-[:focus-visible]/decision:block">
          {t('decisions.actions.shortcutHint', { keys: keys.join('+') })}
        </p>
      </div>
    </CardActionsContext>
  );
}

const NEEDS_KIND = {
  permission: 'needs-permission',
  question: 'needs-answer',
  plan: 'needs-review',
} as const satisfies Record<DecisionKind, string>;

export interface DecisionActionProps extends Omit<ButtonProps, 'onClick'> {
  /** The answer (returns true once the server accepted it). */
  onAnswer: () => Promise<boolean>;
}

/** An answer button: pointer click or Mod+Enter only (see DecisionCardShell). */
export function DecisionAction({ onAnswer, disabled, ...props }: DecisionActionProps) {
  const actions = useCardActions();
  return (
    <Button
      size="sm"
      data-decision-action=""
      aria-keyshortcuts="Control+Enter"
      disabled={actions.disabled || disabled === true}
      onClick={(event) => {
        if (!actions.accept(event)) return;
        actions.respond(onAnswer);
      }}
      {...props}
    />
  );
}

/** Runs an answer outside of an answer button (menu items, Mod+Enter inside a form). */
export function useCardRespond(): (answer: () => Promise<boolean>) => void {
  const actions = useCardActions();
  return (answer) => {
    if (actions.disabled || !actions.armed) return;
    actions.respond(answer);
  };
}

/** Whether the card's answers are disabled (sending/offline). */
export function useCardDisabled(): boolean {
  return useCardActions().disabled;
}
