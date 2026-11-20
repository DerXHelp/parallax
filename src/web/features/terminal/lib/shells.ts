import { WINDOWS_SHELL_KINDS, type ShellKind } from '@shared/model';
import type { TerminalKey } from '../i18n';

/** Menu text of each shell. */
export const SHELL_KEYS: Readonly<Record<ShellKind, TerminalKey>> = {
  cmd: 'shells.cmd',
  powershell: 'shells.powershell',
  gitbash: 'shells.gitbash',
  login: 'shells.login',
  bash: 'shells.bash',
  zsh: 'shells.zsh',
  fish: 'shells.fish',
  pwsh: 'shells.pwsh',
};

/** Short name of each shell (tabs). */
export const SHORT_SHELL_KEYS: Readonly<Record<ShellKind, TerminalKey>> = {
  cmd: 'short.cmd',
  powershell: 'short.powershell',
  gitbash: 'short.gitbash',
  login: 'short.login',
  bash: 'short.bash',
  zsh: 'short.zsh',
  fish: 'short.fish',
  pwsh: 'short.pwsh',
};

/**
 * The shells with `preferred` (the default of the settings) first. WP-102: still the Windows three;
 * WP-105 passes the host's `shell.detect` list.
 */
export function shellOrder(preferred: ShellKind): ShellKind[] {
  return [preferred, ...WINDOWS_SHELL_KINDS.filter((shell) => shell !== preferred)];
}
