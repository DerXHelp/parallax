import { BellRingIcon, KeyboardIcon, PowerIcon, SettingsIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { languageSchema, themeSchema } from '@shared/common';
import type { HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
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
import { requestShell, useShellRequestHandler, type SettingsSection } from './requests';
import { ServerShutdownDialog, openServerShutdown } from './server-shutdown/ServerShutdownDialog';
import { defaultProfileOf } from './ShellBanners';
import { HELP_KEYS, openShortcutHelp } from './ShortcutHelp';
import { shortcutKeyLabels } from './shortcuts';
import { DEFAULT_FEATURE_SLOTS, useFeatureSlots } from './slots';

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
 * check "displayed version = `claude --version`"; R3-02: FakeBackend marked). Shown in the menu
 * ("About this server") and in the section "About" of the settings page (WP-38) – one place.
 */
export function HostFacts({ hostState, className }: { hostState: HostState; className?: string }) {
  const t = useT();
  return (
    <div data-slot="host-info" className={cn('grid gap-1.5 text-2xs select-text', className)}>
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
  );
}

/** The server facts in the menu: no menu items – the arrow keys skip them, a labelled group. */
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
        <HostFacts hostState={hostState} className="px-2 pt-0.5 pb-1.5" />
      </DropdownMenuGroup>
    </>
  );
}

/**
 * The settings page (slot `SettingsPage`, WP-38) as a large dialog on the shell request
 * `{kind: 'settings', section?}` (WP-30 §4.14 C) – from the menu entry, `/settings` or a link to a
 * section. Without a wired page (placeholder slot) nobody takes the request.
 */
function SettingsPageHost() {
  const { SettingsPage } = useFeatureSlots();
  const available = SettingsPage !== DEFAULT_FEATURE_SLOTS.SettingsPage;
  const [open, setOpen] = useState<{ section: SettingsSection | null; serial: number } | null>(null);
  useShellRequestHandler('settings', (request) => {
    if (!available) return false;
    setOpen((current) => ({ section: request.section ?? null, serial: (current?.serial ?? 0) + 1 }));
    return true;
  });
  if (open === null) return null;
  return (
    <SettingsPage
      key={open.serial}
      section={open.section}
      onClose={() => {
        setOpen(null);
      }}
    />
  );
}

/**
 * Theme and language (persisted by the server in settings.json, Plan Punkt 5) + "Settings…" (the
 * full page, WP-38) + "Enable notifications" (while the browser has not been asked yet; a click
 * is the user gesture) + shortcut help + "Stop server" + the server facts (versions, data folder,
 * backend).
 */
export function SettingsMenu() {
  const t = useT();
  const settings = useSettings();
  const permission = useNotificationPermission();
  const { SettingsPage } = useFeatureSlots();
  const themeLabelId = useId();
  const languageLabelId = useId();
  /** "Settings…" opens the page once the menu has closed and returned the focus to its button. */
  const openPageAfterMenu = useRef(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('settings.label')} showTooltip={false} data-action="settings">
            <SettingsIcon aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-72"
          onCloseAutoFocus={() => {
            if (!openPageAfterMenu.current) return;
            openPageAfterMenu.current = false;
            // The menu focuses its button right after this: the page's dialog then remembers the
            // button (not the vanished menu item) and gives the focus back to it when closed.
            requestShell({ kind: 'settings' });
          }}
        >
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
          {SettingsPage === DEFAULT_FEATURE_SLOTS.SettingsPage ? null : (
            <DropdownMenuItem
              data-action="open-settings"
              onSelect={() => {
                openPageAfterMenu.current = true;
              }}
            >
              <SlidersHorizontalIcon aria-hidden />
              {t('preferences.menuItem')}
            </DropdownMenuItem>
          )}
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
      <SettingsPageHost />
    </>
  );
}
