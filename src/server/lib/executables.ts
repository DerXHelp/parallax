/**
 * Programs on POSIX hosts (WP-103, WP-100 §5.2) – the counterpart of the Windows lookups in
 * lib/windows.ts (`searchPath`, `resolveExecutable` dispatch here off Windows) and of `systemTool`.
 * Same rule as there: a child is only ever started from an ABSOLUTE path we resolved, never from a
 * bare name (the current directory or a relative `PATH` entry would win).
 *
 * - `PATH` (exact case) is split at `:`; empty entries (= the current directory), relative entries
 *   and entries the POSIX path rules refuse are skipped without touching them. No `PATHEXT`.
 * - A hit is a regular file with execute permission (`X_OK`) whose real path (`realpath`, links
 *   resolved) passes the POSIX path rules too (never a link into `/proc`). The PATH entry itself is
 *   returned, not the link target: multi-call programs (busybox) choose by their name.
 * - System tools: `/usr/bin/<tool>`, then `/bin/<tool>` (usrmerge makes both the same on Ubuntu).
 */
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { POSIX_PATHS } from '@shared/paths';
import type { FsProbe } from './windows';

/** Folders of the system tools, in lookup order. */
export const POSIX_SYSTEM_TOOL_DIRS = ['/usr/bin', '/bin'] as const;

/** One file name: not empty, no `/`, not `.`/`..`, no control character. */
export function isBareProgramName(name: string): boolean {
  return POSIX_PATHS.nameIssue(name) === null;
}

/** True for an existing regular file this process may execute (synchronous; system tools, spawn checks). */
export function isExecutableFileSync(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn check (`assertSpawnableFile` on POSIX): false only if `file` EXISTS and is no executable
 * regular file (a folder, a FIFO, missing `x` bit). A missing file passes: the spawn then fails with
 * ENOENT like on Windows, which callers already handle as "not installed".
 */
export function isSpawnableIfPresent(file: string): boolean {
  const info = statSync(file, { throwIfNoEntry: false });
  if (info === undefined) return true;
  if (!info.isFile()) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of a system tool (`/usr/bin/<tool>` or `/bin/<tool>`, the first that is executable;
 * neither → `/usr/bin/<tool>`, whose spawn then fails with ENOENT). `name` must be one file name.
 */
export function posixSystemTool(
  name: string,
  isExecutable: (file: string) => boolean = isExecutableFileSync,
): string {
  if (!isBareProgramName(name)) throw new TypeError(`systemTool: "${name}" is not a plain program name`);
  for (const dir of POSIX_SYSTEM_TOOL_DIRS) {
    const file = path.posix.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return path.posix.join(POSIX_SYSTEM_TOOL_DIRS[0], name);
}

async function executable(fs: FsProbe, file: string): Promise<boolean> {
  return fs.isExecutable === undefined ? fs.isFile(file) : fs.isExecutable(file);
}

async function realPathOf(fs: FsProbe, file: string): Promise<string | null> {
  return fs.realpath === undefined ? file : fs.realpath(file);
}

/**
 * In-process `which -a <name>` (see the file comment): every executable `<dir>/<name>` for the
 * absolute, safe `PATH` entries of `env`, in `PATH` order, without duplicates. Never the current
 * directory. `name` must be one file name (a path never searches).
 */
export async function searchPosixPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe,
): Promise<string[]> {
  if (!isBareProgramName(name)) return [];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '' || POSIX_PATHS.issue(dir) !== null) continue;
    const file = path.posix.join(dir, name);
    const key = POSIX_PATHS.key(file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (POSIX_PATHS.issue(file) !== null || !(await executable(fs, file))) continue;
    const real = await realPathOf(fs, file);
    if (real === null || POSIX_PATHS.issue(real) !== null) continue;
    hits.push(file);
  }
  return hits;
}
