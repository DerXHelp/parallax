import { BellRingIcon, KeyboardIcon, PowerIcon, SettingsIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { languageSchema, themeSchema } from '@shared/common';
import { useT } from '@web/i18n';
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
import { HostFacts } from './HostFacts';
import { enableNotifications } from './NotificationPermissionBanner';
import { requestShell, useShellRequestHandler, type SettingsSection } from './requests';
import { ServerShutdownDialog, openServerShutdown } from './server-shutdown/ServerShutdownDialog';
import { HELP_KEYS, openShortcutHelp } from './ShortcutHelp';
import { shortcutKeyLabels } from './shortcuts';
import { DEFAULT_FEATURE_SLOTS, useFeatureSlots } from './slots';

function save(patch: Parameters<typeof updateSettings>[0]): void {
  // The optimistic change is reverted on failure (state/settings.ts); the user gets a hint.
  updateSettings(patch).catch(() => {
    showTextNotice('settings.saveFailed', undefined, { tone: 'error', id: 'settings.saveFailed' });
  });
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
 * section. Without a wired page (placeholder slot) nobody takes the request. A request while the
 * page is open only changes `section` (R4W-01 c): the page is never mounted anew, an unsaved
 * profile draft in it survives (the page of WP-38 also takes such requests itself).
 */
function SettingsPageHost() {
  const { SettingsPage } = useFeatureSlots();
  const available = SettingsPage !== DEFAULT_FEATURE_SLOTS.SettingsPage;
  const [open, setOpen] = useState<{ section: SettingsSection | null } | null>(null);
  useShellRequestHandler('settings', (request) => {
    if (!available) return false;
    setOpen((current) => ({ section: request.section ?? current?.section ?? null }));
    return true;
  });
  if (open === null) return null;
  return (
    <SettingsPage
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
