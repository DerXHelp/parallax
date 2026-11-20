import { SHELL_KINDS, type ShellKind } from '@shared/model';
import type { TerminalKey } from '../i18n';

/** Menu text of each shell. */
export const SHELL_KEYS: Readonly<Record<ShellKind, TerminalKey>> = {
  cmd: 'shells.cmd',
  powershell: 'shells.powershell',
  gitbash: 'shells.gitbash',
};

/** Short name of each shell (tabs). */
export const SHORT_SHELL_KEYS: Readonly<Record<ShellKind, TerminalKey>> = {
  cmd: 'short.cmd',
  powershell: 'short.powershell',
  gitbash: 'short.gitbash',
};

/** The shells with `preferred` (the default of the settings) first. */
export function shellOrder(preferred: ShellKind): ShellKind[] {
  return [preferred, ...SHELL_KINDS.filter((shell) => shell !== preferred)];
}
