import { TerminalIcon } from 'lucide-react';
import { WINDOWS_SHELL_KINDS, type ShellKind } from '@shared/model';
import { Button } from '@web/ui/button';
import { useTerminalT } from '../i18n';
import { SHELL_KEYS } from '../lib/shells';

export interface TerminalEmptyProps {
  defaultShell: ShellKind;
  /** The shells of the session's computer (WP-104); default the Windows three. */
  shells?: readonly ShellKind[];
  onOpen: (shell: ShellKind) => void;
}

/** After the user closed every terminal: one button per shell (the default one emphasized). */
export function TerminalEmpty({ defaultShell, shells = WINDOWS_SHELL_KINDS, onOpen }: TerminalEmptyProps) {
  const tt = useTerminalT();
  return (
    <div
      data-slot="terminal-empty"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <TerminalIcon aria-hidden className="text-muted-foreground size-6" />
      <div className="grid gap-1">
        <p className="font-medium">{tt('empty.title')}</p>
        <p className="text-muted-foreground text-xs">{tt('empty.hint')}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {shells.map((shell) => (
          <Button
            key={shell}
            size="sm"
            variant={shell === defaultShell ? 'default' : 'outline'}
            data-shell={shell}
            onClick={() => {
              onOpen(shell);
            }}
          >
            {tt(SHELL_KEYS[shell])}
          </Button>
        ))}
      </div>
    </div>
  );
}
