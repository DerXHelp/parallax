import { RotateCcwIcon, TerminalIcon, XIcon } from 'lucide-react';
import type { ShellKind } from '@shared/model';
import type { TerminalCommand, TerminalExitReason } from '@shared/terminal';
import { Button } from '@web/ui/button';
import { useTerminalT } from '../i18n';
import { SHORT_SHELL_KEYS } from '../lib/shells';

export interface ExitBarProps {
  exitCode: number | null;
  reason: TerminalExitReason | null;
  /** WP-105: what ran (`claude` = "Continue in terminal") and the shell "Restart" opens. */
  command?: TerminalCommand;
  shell?: ShellKind;
  onRestart: () => void;
  onClose: () => void;
}

/**
 * Below an exited terminal: "Exited with code n" (or why it ended), Restart and Close. WP-105: after
 * claude ("Continue in terminal") the session is back in Parallax; "Restart" then opens the shell
 * (`TerminalInfo.shell`) and says so.
 */
export function ExitBar({ exitCode, reason, command = 'shell', shell, onRestart, onClose }: ExitBarProps) {
  const tt = useTerminalT();
  const claude = command === 'claude';
  // A string: exit codes are not formatted as numbers (no digit grouping of -1073741510).
  const code = exitCode === null ? null : String(exitCode);
  let text: string;
  if (claude) {
    text =
      reason === 'failed'
        ? tt('exit.claudeFailed')
        : code === null
          ? tt('exit.claudeUnknown')
          : tt('exit.claude', { code });
  } else {
    text =
      reason === 'failed'
        ? tt('exit.failed')
        : code === null
          ? tt('exit.unknown')
          : tt('exit.code', { code });
  }
  const opensShell = claude && shell !== undefined;
  return (
    <div
      data-slot="terminal-exit-bar"
      role="status"
      className="bg-muted/40 flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs"
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate">{text}</span>
      <Button size="sm" variant="outline" data-action="terminal-restart" onClick={onRestart}>
        {opensShell ? <TerminalIcon aria-hidden /> : <RotateCcwIcon aria-hidden />}
        {opensShell ? tt('exit.shell', { shell: tt(SHORT_SHELL_KEYS[shell]) }) : tt('exit.restart')}
      </Button>
      <Button size="sm" variant="ghost" data-action="terminal-close" onClick={onClose}>
        <XIcon aria-hidden />
        {tt('exit.close')}
      </Button>
    </div>
  );
}
