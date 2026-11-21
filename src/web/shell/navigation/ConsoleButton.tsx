import { ChevronDownIcon, PanelRightOpenIcon, SettingsIcon, TerminalIcon } from 'lucide-react';
import { useRef } from 'react';
import type { SessionSummary } from '@shared/model';
import { useT } from '@web/i18n';
import { effectiveShell } from '@web/lib/shells';
import { useSessionPaths } from '@web/state/host-platform';
import { useTerminalAvailable } from '@web/state/hosts';
import { useSettings } from '@web/state/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { Kbd } from '@web/ui/kbd';
import { requestShell } from '../requests';
import { shortcutKeyLabels } from '../shortcuts';
import {
  OPEN_SHELL_KEYS,
  OPEN_TERMINAL_KEYS,
  openShellIn,
  openTerminalPanel,
  SHELL_LABELS,
  useSessionShells,
} from './session-actions';

/**
 * "Open shell in folder" in the session header (WP-97, ADR-238): a split button – the icon opens
 * the default shell of the settings (Alt+K), the chevron offers cmd, PowerShell and Git Bash (WP-105:
 * on Linux the shells that computer has) plus the console settings; WP-99: "Terminal in panel" (Alt+T) when this computer has a pseudo console.
 * Shown by the header only for a session of this computer
 * (`sessionAllows(sessionKey, 'session.openShell')`) and only in a wide header – in a narrow one
 * the "…" menu has the same submenu. Outside the `<header>` status line (ADR-042).
 */
export function ConsoleButton({ sessionKey, summary }: { sessionKey: string; summary: SessionSummary }) {
  const t = useT();
  // WP-104: the shells of the session's computer; a setting it does not offer falls back to its default.
  // WP-105: on Linux the installed ones (`shell.detect` of that computer).
  const flavor = useSessionPaths(sessionKey).flavor;
  const choices = useSessionShells(sessionKey);
  const preferred = effectiveShell(useSettings().console.defaultShell, flavor, choices);
  const keys = shortcutKeyLabels(OPEN_SHELL_KEYS, t).join('+');
  const terminalKeys = shortcutKeyLabels(OPEN_TERMINAL_KEYS, t).join('+');
  const terminal = useTerminalAvailable(sessionKey);
  // The terminal takes the focus – the menu must not hand it back to the chevron.
  const keepFocus = useRef(false);
  return (
    <div
      role="group"
      aria-label={t('navigation.shells.group')}
      data-slot="console-button"
      className="flex items-center"
    >
      <IconButton
        label={t('navigation.shells.open', { shell: t(SHELL_LABELS[preferred]) })}
        shortcut={<Kbd>{keys}</Kbd>}
        tooltipSide="bottom"
        data-shell={preferred}
        className="text-muted-foreground"
        onClick={() => {
          openShellIn(sessionKey, summary, preferred);
        }}
      >
        <TerminalIcon aria-hidden />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={t('navigation.shells.choose')}
            tooltipSide="bottom"
            data-slot="console-button-menu"
            className="text-muted-foreground w-4"
          >
            <ChevronDownIcon aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-56"
          onCloseAutoFocus={(event) => {
            if (!keepFocus.current) return;
            keepFocus.current = false;
            event.preventDefault();
          }}
        >
          {choices.map((shell) => (
            <DropdownMenuItem
              key={shell}
              data-choice={shell}
              onSelect={() => {
                openShellIn(sessionKey, summary, shell);
              }}
            >
              {t(SHELL_LABELS[shell])}
              {shell === preferred ? (
                <>
                  <span className="text-muted-foreground text-xs">{t('navigation.shells.default')}</span>
                  <DropdownMenuShortcut>{keys}</DropdownMenuShortcut>
                </>
              ) : null}
            </DropdownMenuItem>
          ))}
          {terminal ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-choice="terminal"
                onSelect={() => {
                  keepFocus.current = true;
                  openTerminalPanel(sessionKey);
                }}
              >
                <PanelRightOpenIcon aria-hidden />
                {t('navigation.actions.openTerminal')}
                <DropdownMenuShortcut>{terminalKeys}</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-choice="settings"
            onSelect={() => {
              requestShell({ kind: 'settings', section: 'console' });
            }}
          >
            <SettingsIcon aria-hidden />
            {t('navigation.shells.settings')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
