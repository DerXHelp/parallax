import {
  ClipboardListIcon,
  FilePenLineIcon,
  HandIcon,
  ShieldMinusIcon,
  ShieldOffIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { LOCAL_HOST_ID, parseSessionKey, type PermissionMode } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { errorPayloadOf } from '@web/state/connection';
import {
  sendCommand,
  useHostState,
  useSessionConnectionStatus,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { useShortcut } from '@web/shell/shortcuts';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Spinner } from '@web/ui/spinner';
import { cycleModes, nextPermissionMode, offeredModes } from './lib/modes';
import { effectiveModelOption } from './lib/models';

export const MODE_ICONS: Readonly<Record<PermissionMode, LucideIcon>> = {
  default: HandIcon,
  acceptEdits: FilePenLineIcon,
  plan: ClipboardListIcon,
  auto: SparklesIcon,
  dontAsk: ShieldMinusIcon,
  bypassPermissions: ShieldOffIcon,
};

/** Shift+Tab: the target is sent once the keys rest this long (quick cycling sends one command). */
export const MODE_CYCLE_SEND_DELAY_MS = 300;

/** A Shift+Tab target, bound to the session it was chosen for (the composer is not keyed by session). */
interface CycleTarget {
  sessionKey: string;
  mode: PermissionMode;
}

async function sendMode(sessionKey: string, mode: PermissionMode): Promise<void> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return;
  try {
    await sendCommand(sessionKey, { name: 'session.setPermissionMode', entryId: parsed.entryId, mode });
  } catch (caught) {
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.mode.${sessionKey}` });
  }
}

/**
 * The ACTUAL permission mode of the session (C.3: from `init`/`status`, the summary field
 * `permissionMode`; fallback `detail.init.permissionMode`), never an optimistic value for a pick:
 * picking a mode sends `session.setPermissionMode` and the label follows the server. Bypass only when the
 * session's profile allows it (`allowsBypass`), always red. Labels are the shell's
 * `shell.permissionMode.*` ("Manual" for `default`, C.3) – the same everywhere (R2W-03).
 *
 * WP-91 (GitHub #2): Shift+Tab in the composer's text field (`inputRef`) steps to the next mode
 * like the Claude Code CLI – the picker's order without unavailable modes. The target is named at
 * once (with a spinner; `data-mode` stays the actual mode, `data-target-mode` the target) and sent
 * after `MODE_CYCLE_SEND_DELAY_MS`. Not while a slash/@ menu is open (`cycleBlocked`) or offline.
 */
export const ModePicker = memo(function ModePicker({
  sessionKey,
  inputRef,
  cycleBlocked = false,
}: {
  sessionKey: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  cycleBlocked?: boolean;
}) {
  const t = useT();
  const summaryMode = useSummarySelector<PermissionMode | null>(sessionKey, (s) => s.permissionMode, null);
  const initMode = useSessionSelector<PermissionMode | null>(
    sessionKey,
    (view) => view.detail.init?.permissionMode ?? null,
    null,
  );
  /** `init` seen: a null mode is then an unknown mode of a newer CLI, not "not started yet". */
  const reported = useSessionSelector<boolean>(sessionKey, (view) => view.detail.init !== null, false);
  const profileId = useSummarySelector<string | null>(sessionKey, (s) => s.profileId, null);
  const modelSetting = useSummarySelector<string | null>(sessionKey, (s) => s.modelSetting, null);
  const claudeModel = useSummarySelector<string | null>(sessionKey, (s) => s.claudeModel, null);
  // WP-73: the row the session runs on (without a model setting: the model of Claude's settings).
  const autoSupported = useSessionSelector<boolean>(
    sessionKey,
    (view) => effectiveModelOption(view.detail.models, modelSetting, claudeModel)?.supportsAutoMode ?? true,
    true,
  );
  const hostState = useHostState(parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  const allowsBypass = hostState?.profiles.find((profile) => profile.id === profileId)?.allowsBypass === true;
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [pending, setPending] = useState<PermissionMode | null>(null);
  const [target, setTarget] = useState<CycleTarget | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const targetRef = useRef<CycleTarget | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Only the latest send clears the spinner. */
  const sendSeq = useRef(0);
  const mode = summaryMode ?? initMode;

  const options = offeredModes({ allowsBypass });
  const cycleTarget = target?.sessionKey === sessionKey ? target.mode : null;
  /** What the label names: a Shift+Tab target until it is sent and answered, else the actual mode. */
  const shown = cycleTarget ?? mode;
  const Icon = shown === null ? HandIcon : MODE_ICONS[shown];
  // V2-05: before the first start nothing is reported – Claude Code then starts with the default
  // mode of its own settings (the profile omits it, C.3), never a guess like "Manual".
  const notStarted = mode === null && !reported;
  let label: string;
  if (shown !== null) label = t(`shell.permissionMode.${shown}`);
  else label = notStarted ? t('composer.mode.notStarted') : t('composer.mode.unknown');

  const choose = async (next: PermissionMode) => {
    if (next === mode) return;
    const seq = ++sendSeq.current;
    setPending(next);
    try {
      await sendMode(sessionKey, next);
    } finally {
      if (seq === sendSeq.current) setPending(null);
    }
  };

  const stopTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const cancelCycle = () => {
    stopTimer();
    targetRef.current = null;
    setTarget(null);
  };

  /**
   * Sends a waiting Shift+Tab target (also for the previous session after a switch). The label
   * keeps naming it until the answer – then the server's mode (or, after an error, the old one).
   */
  const flushCycle = useEffectEvent(() => {
    const waiting = targetRef.current;
    stopTimer();
    targetRef.current = null;
    if (waiting === null) return;
    if (waiting.sessionKey !== sessionKey) {
      setTarget(null);
      void sendMode(waiting.sessionKey, waiting.mode);
      return;
    }
    void choose(waiting.mode).finally(() => {
      // Cycled on while this was sent: the newer target stays.
      if (targetRef.current === null) setTarget(null);
    });
  });
  useEffect(
    () => () => {
      flushCycle();
    },
    [sessionKey],
  );

  const cycle = (): boolean => {
    if (!online) return false;
    const waiting = targetRef.current?.sessionKey === sessionKey ? targetRef.current.mode : null;
    const base = waiting ?? cycleTarget ?? pending ?? mode;
    const next = nextPermissionMode(base, cycleModes({ allowsBypass, autoSupported }));
    if (next === null) return false;
    const chosen = { sessionKey, mode: next };
    targetRef.current = chosen;
    setTarget(chosen);
    setAnnouncement(t('composer.mode.announce', { mode: t(`shell.permissionMode.${next}`) }));
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      flushCycle();
    }, MODE_CYCLE_SEND_DELAY_MS);
    return true;
  };

  useShortcut(
    {
      id: 'composer.cycleMode',
      keys: 'Shift+Tab',
      description: 'composer.mode.cycleShortcut',
      allowInInputs: true,
      scopeRef: inputRef,
      run: () => (cycleBlocked ? false : cycle()),
    },
    inputRef !== undefined,
  );

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-slot="mode-picker"
            data-mode={mode ?? (notStarted ? 'not-started' : 'unknown')}
            data-target-mode={cycleTarget ?? pending ?? undefined}
            disabled={!online}
            aria-label={t('composer.mode.trigger', { mode: label })}
            className={cn(mode === 'bypassPermissions' && 'text-destructive hover:text-destructive')}
          >
            <Icon aria-hidden />
            <span>{label}</span>
            {pending === null && cycleTarget === null ? null : (
              <Spinner label={t('composer.mode.switching')} className="size-3" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>{t('composer.mode.label')}</DropdownMenuLabel>
          {notStarted ? (
            <p className="text-muted-foreground px-2 pb-1 text-2xs">{t('composer.mode.notStartedHint')}</p>
          ) : null}
          <DropdownMenuRadioGroup
            value={mode ?? ''}
            onValueChange={(value) => {
              const next = options.find((option) => option === value);
              if (next === undefined) return;
              cancelCycle();
              void choose(next);
            }}
          >
            {options.map((option) => {
              const OptionIcon = MODE_ICONS[option];
              const disabled = option === 'auto' && !autoSupported && mode !== 'auto';
              return (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  disabled={disabled}
                  className={cn('items-start', option === 'bypassPermissions' && 'text-destructive')}
                >
                  <OptionIcon
                    aria-hidden
                    className={cn('mt-0.5', option === 'bypassPermissions' && 'text-destructive')}
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span>{t(`shell.permissionMode.${option}`)}</span>
                    <span className="text-muted-foreground text-2xs">
                      {disabled ? t('composer.mode.autoUnavailable') : t(`composer.mode.hints.${option}`)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
            {mode === 'dontAsk' ? (
              <DropdownMenuRadioItem value="dontAsk" disabled className="items-start">
                <ShieldMinusIcon aria-hidden className="mt-0.5" />
                <span className="grid min-w-0 gap-0.5">
                  <span>{t('shell.permissionMode.dontAsk')}</span>
                  <span className="text-muted-foreground text-2xs">{t('composer.mode.hints.dontAsk')}</span>
                </span>
              </DropdownMenuRadioItem>
            ) : null}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* WP-91: Shift+Tab changes the label only – screen readers hear the target here. */}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
});
