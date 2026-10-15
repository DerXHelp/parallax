import { KeyboardIcon, SettingsIcon } from 'lucide-react';
import { languageSchema, themeSchema } from '@shared/common';
import { useT } from '@web/i18n';
import { updateSettings, useSettings } from '@web/state/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { HELP_KEYS, openShortcutHelp } from './ShortcutHelp';
import { shortcutKeyLabels } from './shortcuts';

function save(patch: Parameters<typeof updateSettings>[0]): void {
  // The optimistic change is reverted on failure (state/settings.ts).
  updateSettings(patch).catch(() => undefined);
}

/** Theme and language (persisted by the server in settings.json, Plan Punkt 5) + shortcut help. */
export function SettingsMenu() {
  const t = useT();
  const settings = useSettings();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('settings.label')} showTooltip={false}>
          <SettingsIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{t('settings.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
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
        <DropdownMenuLabel>{t('settings.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
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
        <DropdownMenuItem onSelect={openShortcutHelp}>
          <KeyboardIcon aria-hidden />
          {t('settings.shortcuts')}
          <DropdownMenuShortcut>{shortcutKeyLabels(HELP_KEYS, t).join('+')}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
