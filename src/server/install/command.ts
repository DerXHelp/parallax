/**
 * The `parallax` command on Linux (WP-108, WP-100 E7): `<binDir>/parallax` (default `~/.local/bin`,
 * `defaultBinDir`) is a two-line POSIX script that runs `<root>/parallax` – stable across updates;
 * the version-specific start script is the root's `parallax` (from the package's `root/`).
 *
 * Ownership like the Start menu shortcut on Windows: the marker line names the installation root.
 * The installer writes the command when it is missing or names the same root; a command of another
 * installation (`--dir`), a foreign file or a link stays untouched (`ok: false` with the reason –
 * the installation works anyway through `<root>/parallax`). The uninstaller removes only the
 * command of its own root; anything else counts as done. Tests pass their own bin folder
 * (`assertNotRealUserFolder`).
 */
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { toError } from '../lib/async';
import { writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { COMMAND_NAME, START_SH, assertNotRealUserFolder, installPathRules } from './layout';
import { commandScript, commandScriptRoot } from './templates';

/** `rwxr-xr-x`: the command and the start script of the root. */
export const SCRIPT_MODE = 0o755;

export type CommandResult = { ok: true; file: string } | { ok: false; file: string; reason: string };

export interface CommandOptions {
  /** The installation root (`<root>/parallax` is what the command runs). */
  root: string;
  /** The folder of the command, e.g. `~/.local/bin`. */
  binDir: string;
}

type Found = { kind: 'missing' } | { kind: 'own'; text: string } | { kind: 'other'; reason: string };

const rules = installPathRules('linux');

function commandFile(binDir: string): string {
  return path.posix.join(binDir, COMMAND_NAME);
}

/** What is at `file` now, seen from `root`. */
async function inspect(file: string, root: string): Promise<Found> {
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (!info.isFile()) return { kind: 'other', reason: `${file} exists and is no file written by Parallax` };
  const text = await readFile(file, 'utf8');
  const owner = commandScriptRoot(text);
  if (owner === null) return { kind: 'other', reason: `${file} belongs to another program` };
  if (!rules.equal(owner, root)) {
    return { kind: 'other', reason: `${file} belongs to the Parallax installation in ${owner}` };
  }
  return { kind: 'own', text };
}

/** Writes (or refreshes) the command of `root`; never replaces a foreign one. */
export async function ensureCommand(options: CommandOptions): Promise<CommandResult> {
  assertNotRealUserFolder(options.binDir);
  const file = commandFile(options.binDir);
  const content = commandScript(options.root, path.posix.join(options.root, START_SH));
  try {
    const found = await inspect(file, options.root);
    if (found.kind === 'other') return { ok: false, file, reason: found.reason };
    if (found.kind === 'missing' || found.text !== content) {
      await mkdir(options.binDir, { recursive: true });
      await writeFileAtomic(file, content);
    }
    await chmod(file, SCRIPT_MODE);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, reason: toError(error).message };
  }
}

/** Removes the command of `root`; a missing or foreign command counts as done. */
export async function removeCommand(options: CommandOptions): Promise<CommandResult> {
  assertNotRealUserFolder(options.binDir);
  const file = commandFile(options.binDir);
  try {
    if ((await inspect(file, options.root)).kind === 'own') await rm(file, { force: true });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, reason: toError(error).message };
  }
}

/** True when `binDir` is one of the absolute entries of `PATH` (then `parallax` alone starts it). */
export function isOnPath(binDir: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(':').some((entry) => entry !== '' && rules.equal(entry, binDir));
}
