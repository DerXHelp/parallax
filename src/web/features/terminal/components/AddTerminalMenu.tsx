import { PlusIcon } from 'lucide-react';
import { useRef } from 'react';
import type { ShellKind } from '@shared/model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { useTerminalT } from '../i18n';
import { SHELL_KEYS, shellOrder } from '../lib/shells';

export interface AddTerminalMenuProps {
  defaultShell: ShellKind;
  /** The shells of the session's computer (WP-104); default the Windows three. */
  shells?: readonly ShellKind[];
  /** The entry has `max` terminals already (the shells are disabled, a label says why). */
  atLimit: boolean;
  max: number;
  onOpen: (shell: ShellKind) => void;
  /** After a shell was chosen: focus the terminal (instead of "+"), see `onCloseAutoFocus`. */
  onFocusTerminal?: () => void;
}

/** "+" next to the terminal tabs: the shells, the default of the settings first. */
export function AddTerminalMenu({
  defaultShell,
  shells,
  atLimit,
  max,
  onOpen,
  onFocusTerminal,
}: AddTerminalMenuProps) {
  const tt = useTerminalT();
  const chosen = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={tt('add.label')} data-slot="terminal-add" className="text-muted-foreground">
          <PlusIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        onCloseAutoFocus={(event) => {
          // WP-109 (CI): after a choice the focus belongs to the new terminal. Returned to "+", it
          // stayed there when the terminal became active while the menu was still open – typing
          // then reached the button (Space opens the menu, Enter starts another shell).
          if (!chosen.current) return;
          chosen.current = false;
          event.preventDefault();
          onFocusTerminal?.();
        }}
      >
        {atLimit ? (
          <DropdownMenuLabel data-slot="terminal-add-limit" className="text-muted-foreground font-normal">
            {tt('add.limit', { max })}
          </DropdownMenuLabel>
        ) : null}
        {shellOrder(defaultShell, shells).map((shell) => (
          <DropdownMenuItem
            key={shell}
            data-choice={shell}
            disabled={atLimit}
            onSelect={() => {
              chosen.current = true;
              onOpen(shell);
            }}
          >
            {tt(SHELL_KEYS[shell])}
            {shell === defaultShell ? (
              <span className="text-muted-foreground ml-auto text-xs">{tt('add.default')}</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
