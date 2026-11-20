import { RotateCcwIcon, XIcon } from 'lucide-react';
import type { TerminalExitReason } from '@shared/terminal';
import { Button } from '@web/ui/button';
import { useTerminalT } from '../i18n';

export interface ExitBarProps {
  exitCode: number | null;
  reason: TerminalExitReason | null;
  onRestart: () => void;
  onClose: () => void;
}

/** Below an exited terminal: "Exited with code n" (or why it ended), Restart and Close. */
export function ExitBar({ exitCode, reason, onRestart, onClose }: ExitBarProps) {
  const tt = useTerminalT();
  const text =
    reason === 'failed'
      ? tt('exit.failed')
      : exitCode === null
        ? tt('exit.unknown')
        : // A string: exit codes are not formatted as numbers (no digit grouping of -1073741510).
          tt('exit.code', { code: String(exitCode) });
  return (
    <div
      data-slot="terminal-exit-bar"
      role="status"
      className="bg-muted/40 flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-xs"
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate">{text}</span>
      <Button size="sm" variant="outline" data-action="terminal-restart" onClick={onRestart}>
        <RotateCcwIcon aria-hidden />
        {tt('exit.restart')}
      </Button>
      <Button size="sm" variant="ghost" data-action="terminal-close" onClick={onClose}>
        <XIcon aria-hidden />
        {tt('exit.close')}
      </Button>
    </div>
  );
}
