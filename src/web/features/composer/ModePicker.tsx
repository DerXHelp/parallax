import {
  ClipboardListIcon,
  FilePenLineIcon,
  HandIcon,
  ShieldMinusIcon,
  ShieldOffIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useState } from 'react';
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

export const MODE_ICONS: Readonly<Record<PermissionMode, LucideIcon>> = {
  default: HandIcon,
  acceptEdits: FilePenLineIcon,
  plan: ClipboardListIcon,
  auto: SparklesIcon,
  dontAsk: ShieldMinusIcon,
  bypassPermissions: ShieldOffIcon,
};

/** Offered modes (Plan "Kopfleiste": Manual / accept edits / plan / auto; `dontAsk` never). */
const OFFERED: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

/**
 * The ACTUAL permission mode of the session (C.3: from `init`/`status`, the summary field
 * `permissionMode`; fallback `detail.init.permissionMode`), never an optimistic value; picking a
 * mode sends `session.setPermissionMode` and the label follows the server. Bypass only when the
 * session's profile allows it (`allowsBypass`), always red. Labels are the shell's
 * `shell.permissionMode.*` ("Manual" for `default`, C.3) – the same everywhere (R2W-03).
 */
export const ModePicker = memo(function ModePicker({ sessionKey }: { sessionKey: string }) {
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
  const autoSupported = useSessionSelector<boolean>(
    sessionKey,
    (view) =>
      view.detail.models?.find((model) => model.value === (modelSetting ?? 'default'))?.supportsAutoMode ??
      true,
    true,
  );
  const hostState = useHostState(parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  const allowsBypass = hostState?.profiles.find((profile) => profile.id === profileId)?.allowsBypass === true;
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [pending, setPending] = useState<PermissionMode | null>(null);
  const mode = summaryMode ?? initMode;

  const options: PermissionMode[] = [...OFFERED];
  if (allowsBypass) options.push('bypassPermissions');
  const Icon = mode === null ? HandIcon : MODE_ICONS[mode];
  // V2-05: before the first start nothing is reported – Claude Code then starts with the default
  // mode of its own settings (the profile omits it, C.3), never a guess like "Manual".
  const notStarted = mode === null && !reported;
  let label: string;
  if (mode !== null) label = t(`shell.permissionMode.${mode}`);
  else label = notStarted ? t('composer.mode.notStarted') : t('composer.mode.unknown');

  const choose = async (next: PermissionMode) => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null || next === mode) return;
    setPending(next);
    try {
      await sendCommand(sessionKey, {
        name: 'session.setPermissionMode',
        entryId: parsed.entryId,
        mode: next,
      });
    } catch (caught) {
      showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.mode.${sessionKey}` });
    } finally {
      setPending(null);
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-slot="mode-picker"
          data-mode={mode ?? (notStarted ? 'not-started' : 'unknown')}
          disabled={!online}
          aria-label={t('composer.mode.trigger', { mode: label })}
          className={cn(mode === 'bypassPermissions' && 'text-destructive hover:text-destructive')}
        >
          <Icon aria-hidden />
          <span>{label}</span>
          {pending === null ? null : <Spinner label={t('composer.mode.switching')} className="size-3" />}
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
            if (next !== undefined) void choose(next);
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
  );
});
