import { defaultShellFor, shellKindsFor, type ShellKind } from '@shared/model';
import type { PathFlavor } from '@shared/paths';

/**
 * The shells to offer for a host (WP-104 §6, display only): its detected list (`shell.detect.shells`)
 * when the caller has one, else every kind of the host's flavor (`shellKindsFor`). Kinds of the other
 * flavor (a real host never reports them) are dropped; an empty result falls back to the flavor's kinds.
 */
export function shellChoices(
  flavor: PathFlavor,
  detected?: readonly ShellKind[] | null,
): readonly ShellKind[] {
  const kinds = shellKindsFor(flavor);
  if (detected === undefined || detected === null) return kinds;
  const offered = detected.filter((shell) => kinds.includes(shell));
  return offered.length === 0 ? kinds : offered;
}

/**
 * The shell to open by default on a host: the setting when the host offers it, else the flavor's
 * default (`cmd` from a Windows setting → `login` on Linux), else the first choice.
 */
export function effectiveShell(
  setting: ShellKind,
  flavor: PathFlavor,
  choices: readonly ShellKind[] = shellChoices(flavor),
): ShellKind {
  if (choices.includes(setting)) return setting;
  const fallback = defaultShellFor(flavor);
  return choices.includes(fallback) ? fallback : (choices[0] ?? fallback);
}

/** `choices` with `preferred` first – when it is one of them (menus, empty terminal). */
export function preferredFirst(preferred: ShellKind, choices: readonly ShellKind[]): ShellKind[] {
  if (!choices.includes(preferred)) return [...choices];
  return [preferred, ...choices.filter((shell) => shell !== preferred)];
}
