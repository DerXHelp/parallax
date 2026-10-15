import { BellRingIcon, KeyboardIcon, PowerIcon, SettingsIcon } from 'lucide-react';
import { useId } from 'react';
import { languageSchema, themeSchema } from '@shared/common';
import type { HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { knownVersion } from '@web/lib/version';
import { useNotificationPermission } from '@web/notifications/permission';
import { useHostState } from '@web/state/hooks';
import { showTextNotice } from '@web/state/notices';
import { updateSettings, useSettings } from '@web/state/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { enableNotifications } from './NotificationPermissionBanner';
import { ServerShutdownDialog, openServerShutdown } from './server-shutdown/ServerShutdownDialog';
import { defaultProfileOf } from './ShellBanners';
import { HELP_KEYS, openShortcutHelp } from './ShortcutHelp';
import { shortcutKeyLabels } from './shortcuts';

function save(patch: Parameters<typeof updateSettings>[0]): void {
  // The optimistic change is reverted on failure (state/settings.ts); the user gets a hint.
  updateSettings(patch).catch(() => {
    showTextNotice('settings.saveFailed', undefined, { tone: 'error', id: 'settings.saveFailed' });
  });
}

/** The default profile's claude (B "Claude-Auflösung": path + `claude --version`, rule C.7). */
function ClaudeInfo({ hostState }: { hostState: HostState }) {
  const t = useT();
  const claude = defaultProfileOf(hostState)?.claude;
  if (claude === undefined) return null;
  const version = knownVersion(claude.version);
  let line: string;
  if (claude.state === 'checking') line = t('shell.info.claudeChecking');
  else if (claude.state === 'not_found') line = t('shell.info.claudeMissing');
  else if (version === null) line = t('shell.info.claudeUnknown');
  else line = t('shell.info.claude', { version });
  return (
    <div data-info="claude" data-version-status={claude.versionStatus} className="grid gap-0.5">
      <span className={claude.versionStatus === 'too_old' ? 'text-destructive' : undefined}>{line}</span>
      {claude.path === null ? null : (
        <span className="text-muted-foreground font-mono break-all">{claude.path}</span>
      )}
      {claude.versionStatus === 'too_old' ? (
        <span className="text-destructive">
          {t('shell.info.claudeTooOld', { required: hostState.sdkClaudeCodeVersion })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Read-only facts of the server (R3-01: the installed Claude Code and the Agent SDK – the WP-22
 * check "displayed version = `claude --version`"; R3-02: FakeBackend marked). No menu items: the
 * arrow keys skip it, screen readers read it as a labelled group.
 */
function HostInfo() {
  const t = useT();
  const hostState = useHostState();
  const labelId = useId();
  if (hostState === null) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup aria-labelledby={labelId}>
        <DropdownMenuLabel id={labelId}>{t('shell.info.title')}</DropdownMenuLabel>
        <div data-slot="host-info" className="grid gap-1.5 px-2 pt-0.5 pb-1.5 text-2xs select-text">
          <ClaudeInfo hostState={hostState} />
          <span data-info="sdk">
            {t('shell.info.sdk', {
              version: hostState.sdkVersion,
              required: hostState.sdkClaudeCodeVersion,
            })}
          </span>
          <span data-info="parallax" className="text-muted-foreground">
            {t('shell.info.parallax', { version: hostState.serverVersion })}
          </span>
          <span data-info="data" className="text-muted-foreground break-all">
            {t('shell.info.data', { path: hostState.dataDirLabel })}
          </span>
          {hostState.backend === 'fake' ? (
            <span data-info="backend" className="text-warning font-medium">
              {t('shell.info.backendFake')}
            </span>
          ) : null}
        </div>
      </DropdownMenuGroup>
    </>
  );
}

/**
 * Theme and language (persisted by the server in settings.json, Plan Punkt 5) + "Enable
 * notifications" (while the browser has not been asked yet; a click is the user gesture) +
 * shortcut help + "Stop server" + the server facts (versions, data folder, backend).
 */
export function SettingsMenu() {
  const t = useT();
  const settings = useSettings();
  const permission = useNotificationPermission();
  const themeLabelId = useId();
  const languageLabelId = useId();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('settings.label')} showTooltip={false} data-action="settings">
          <SettingsIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel id={themeLabelId}>{t('settings.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-labelledby={themeLabelId}
          value={settings.theme}
          onValueChange={(value) => {
            const theme = themeSchema.safeParse(value);
            if (theme.success) save({ theme: theme.data });
          }}
        >
          <DropdownMenuRadioItem value="dark">{t('settings.themes.dark')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t('settings.themes.light')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t('settings.themes.system')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel id={languageLabelId}>{t('settings.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-labelledby={languageLabelId}
          value={settings.language}
          onValueChange={(value) => {
            const language = languageSchema.safeParse(value);
            if (language.success) save({ language: language.data });
          }}
        >
          <DropdownMenuRadioItem value="en" lang="en">
            {t('settings.languages.en')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="de" lang="de">
            {t('settings.languages.de')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {permission === 'default' ? (
          <DropdownMenuItem onSelect={enableNotifications}>
            <BellRingIcon aria-hidden />
            {t('shell.notifications.permission.enable')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={openShortcutHelp}>
          <KeyboardIcon aria-hidden />
          {t('settings.shortcuts')}
          <DropdownMenuShortcut>{shortcutKeyLabels(HELP_KEYS, t).join('+')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={openServerShutdown}>
          <PowerIcon aria-hidden />
          {t('serverShutdown.menuItem')}
        </DropdownMenuItem>
        <HostInfo />
      </DropdownMenuContent>
      {/* WP-21: confirmation of "Stop server" (Radix root renders no DOM; the dialog portals out). */}
      <ServerShutdownDialog />
    </DropdownMenu>
  );
}
