import { WINDOWS_SHELL_KINDS, type ShellKind } from '@shared/model';
import { preferredFirst } from '@web/lib/shells';
import type { TerminalKey } from '../i18n';
import type { TerminalKind } from '../state/terminals';

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

/** Short name of each shell (tabs); WP-105: `claude` for the terminal of "Continue in terminal". */
export const SHORT_SHELL_KEYS: Readonly<Record<TerminalKind, TerminalKey>> = {
  cmd: 'short.cmd',
  powershell: 'short.powershell',
  gitbash: 'short.gitbash',
  login: 'short.login',
  bash: 'short.bash',
  zsh: 'short.zsh',
  fish: 'short.fish',
  pwsh: 'short.pwsh',
  claude: 'short.claude',
};

/**
 * The shells with `preferred` (the default of the settings) first. WP-104: `shells` = the kinds of the
 * session's computer (`shellChoices`, default the Windows three); WP-105: on Linux its `shell.detect` list.
 */
export function shellOrder(
  preferred: ShellKind,
  shells: readonly ShellKind[] = WINDOWS_SHELL_KINDS,
): ShellKind[] {
  return preferredFirst(preferred, shells);
}
