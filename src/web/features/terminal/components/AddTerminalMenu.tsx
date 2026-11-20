import { PlusIcon } from 'lucide-react';
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
  /** The entry has `max` terminals already (the shells are disabled, a label says why). */
  atLimit: boolean;
  max: number;
  onOpen: (shell: ShellKind) => void;
}

/** "+" next to the terminal tabs: the shells, the default of the settings first. */
export function AddTerminalMenu({ defaultShell, atLimit, max, onOpen }: AddTerminalMenuProps) {
  const tt = useTerminalT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={tt('add.label')} data-slot="terminal-add" className="text-muted-foreground">
          <PlusIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {atLimit ? (
          <DropdownMenuLabel data-slot="terminal-add-limit" className="text-muted-foreground font-normal">
            {tt('add.limit', { max })}
          </DropdownMenuLabel>
        ) : null}
        {shellOrder(defaultShell).map((shell) => (
          <DropdownMenuItem
            key={shell}
            data-choice={shell}
            disabled={atLimit}
            onSelect={() => {
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
