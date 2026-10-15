import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { DecisionKind } from '@shared/common';
import type { Decision } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { matchesShortcut, parseShortcut, shortcutKeyLabels, useShortcut } from '@web/shell/shortcuts';
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
const RESPOND_COMBO = parseShortcut(RESPOND_KEYS);

/**
 * Options of a question (Radix radio/checkbox items). Radix calls `preventDefault()` for Enter on
 * them (WAI-ARIA: Enter never toggles an option) – also for Mod+Enter, so the window's shortcut
 * registry, which skips prevented events, never sees it there (V2-02).
 */
const OPTION_SELECTOR = '[role="radio"], [role="checkbox"]';

interface CardActions {
  disabled: boolean;
  armed: boolean;
  sending: boolean;
  /** Id of the "Enter and Space never answer" hint (`aria-describedby` of the answer buttons). */
  hintId: string;
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

/** Keyboard focus (`:focus-visible`); false where the engine does not know the pseudo-class. */
function isFocusVisible(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return false;
  }
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
  const [keyboardHint, setKeyboardHint] = useState(false);
  const disabled = sending || !online;
  const hintId = useId();

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
    () => ({ disabled, armed, sending, hintId, accept, respond }),
    [disabled, armed, sending, hintId, accept, respond],
  );

  /** Mod+Enter with the focus on `target` inside this card (registry and option path below). */
  const answerByShortcut = (target: Element | null): void => {
    if (!armed || disabled) return;
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
      return;
    }
    // Focus on another control of the card ("Keep planning", "Open plan", a menu trigger …):
    // Mod+Enter must not answer with the main action behind the user's back. Options of a
    // question (radio/checkbox) belong to the answer form and keep the main action.
    const control = target?.closest('button, a[href]');
    const role = control?.getAttribute('role');
    if (control instanceof HTMLElement && role !== 'radio' && role !== 'checkbox') return;
    if (primary !== null) respond(primary);
  };

  useShortcut({
    id: 'decisions.respond',
    keys: RESPOND_KEYS,
    description: 'decisions.shortcuts.respond',
    scopeRef: rootRef,
    allowInInputs: true,
    run: (event) => {
      answerByShortcut(event.target instanceof Element ? event.target : null);
      return true;
    },
  });

  const onKeyDownCapture = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') keyActivationAt.current = event.timeStamp;
    // V2-02: Mod+Enter on a focused option of THIS card (its own DOM, not a portalled menu) is
    // handled here, in the capture phase – before Radix prevents it. Plain Enter/Space stay
    // untouched (they never answer); `preventDefault` keeps the registry from running it twice.
    const target = event.target instanceof Element ? event.target : null;
    const option = target?.closest(OPTION_SELECTOR) ?? null;
    if (option === null || rootRef.current?.contains(option) !== true) return;
    if (event.nativeEvent.isComposing || !matchesShortcut(event, RESPOND_COMBO)) return;
    event.preventDefault();
    answerByShortcut(option);
  };

  // The keyboard hint appears with the first keyboard focus inside the card and then stays
  // (WP-20c): a hint that vanished on the pointerdown of a click (keyboard focus was on another
  // control of the card, e.g. the "▾" trigger after its menu closed) moved the buttons, and the
  // pointerup – and with it the click – landed on another element. Only the card's own DOM counts:
  // React also bubbles the focus of portalled menus here, and a hint appearing while a "▾" menu
  // opens under the pointer made that same click select the first menu entry.
  const onFocusCapture = (event: ReactFocusEvent) => {
    if (keyboardHint) return;
    const root = rootRef.current;
    if (root === null || !(event.target instanceof Node) || !root.contains(event.target)) return;
    if (isFocusVisible(event.target)) setKeyboardHint(true);
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
        onFocusCapture={onFocusCapture}
        aria-busy={sending}
        className={cn(
          'bg-card text-card-foreground focus-visible:ring-ring flex max-h-[45vh] min-h-0 flex-col rounded-lg border shadow-sm outline-none focus-visible:ring-2',
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
        {/* Only after keyboard focus, and then it stays: a hint appearing or vanishing during a
            pointer click would move the buttons under the pointer (the click would land
            elsewhere). Screen readers get it as the description of every answer button (R2W-19). */}
        <p
          id={hintId}
          data-slot="decision-shortcut-hint"
          className={cn('text-muted-foreground px-3 pb-2 text-2xs', keyboardHint ? 'block' : 'hidden')}
        >
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
      aria-describedby={actions.hintId}
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
