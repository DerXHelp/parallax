import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWindowsPathInside, windowsPathKey } from '@shared/paths';

/**
 * Test isolation (CLAUDE.md "Tests", R0-23, WP22-07): tests never touch the real data directory
 * (%LOCALAPPDATA%\Parallax) or the home of a running server.
 *
 * - `PARALLAX_HOME`: an inherited value is used ONLY if it is one of our own test homes – a
 *   `parallax-test-*` folder directly inside the OS temp directory (what the Vitest globalSetup of
 *   this run created). The real data directory, a folder inside it, any non-temporary folder and
 *   any other temp folder (e.g. the temp home of a live server whose session runs these tests) is
 *   replaced by a fresh temp home. The globalSetups of Vitest and Playwright always start with a
 *   fresh one (`fresh: true`): in doubt, an own temp home.
 * - `PARALLAX_PORT` is always `0`.
 * - Inherited server control variables (`SERVER_CONTROL_VARS`: backend, dev mode, validation,
 *   toasts, log level, host, entry id of a calling Parallax session) are removed, so a test run
 *   behaves the same inside and outside a Parallax session.
 */

/** Prefix of the temp homes created here (globalSetup and per-worker fallback). */
export const TEST_HOME_PREFIX = 'parallax-test-';

/** Server/session variables a test run must not inherit (HOME and PORT are handled separately). */
export const SERVER_CONTROL_VARS: readonly string[] = [
  'PARALLAX',
  'PARALLAX_ENTRY_ID',
  'PARALLAX_BACKEND',
  'PARALLAX_DEV',
  'PARALLAX_HOST',
  'PARALLAX_LOG_LEVEL',
  'PARALLAX_VALIDATE',
  'PARALLAX_TOASTS',
];

/**
 * Comparison key of a Windows path: resolved here, compared by the ONE rule of `@shared/paths`
 * (CR-09, CLAUDE.md "Windows": never duplicated) – the same verdict as `config.ts`.
 */
function pathKey(value: string): string {
  return windowsPathKey(path.win32.resolve(value));
}

/** True if `child` is `parent` or lies inside it (case-insensitive, `/` and `\` alike – R0-23). */
export function isPathInside(child: string, parent: string): boolean {
  return isWindowsPathInside(path.win32.resolve(child), path.win32.resolve(parent));
}

/** A `parallax-test-*` folder directly inside the OS temp directory (and not the real home). */
export function isOwnTestHome(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: string = os.tmpdir(),
): boolean {
  if (home.trim() === '' || isRealHome(home, env)) return false;
  const resolved = path.win32.resolve(home);
  return (
    pathKey(path.win32.dirname(resolved)) === pathKey(tmpdir) &&
    path.win32.basename(resolved).toLowerCase().startsWith(TEST_HOME_PREFIX)
  );
}

function isRealHome(home: string, env: NodeJS.ProcessEnv): boolean {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData === '') return false;
  return isPathInside(home, path.win32.join(localAppData, 'Parallax'));
}

export interface EnsureTestEnvOptions {
  /** Always create a new temp home, whatever was inherited (the globalSetups). */
  fresh?: boolean;
  /** Notes about ignored inherited values (default: stderr). */
  note?: (message: string) => void;
  /** Test seams. */
  tmpdir?: string;
  exists?: (dir: string) => boolean;
}

/**
 * Makes `env` safe for tests (see the file comment). Returns the temp home it created (the caller
 * removes it), or undefined when an own test home was kept.
 */
export function ensureTestEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: EnsureTestEnvOptions = {},
): string | undefined {
  const note = options.note ?? ((message: string) => process.stderr.write(`[test-setup] ${message}\n`));
  const tmpdir = options.tmpdir ?? os.tmpdir();
  const exists = options.exists ?? existsSync;
  for (const name of SERVER_CONTROL_VARS) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name) Reflect.deleteProperty(env, key);
    }
  }
  env.PARALLAX_PORT = '0';

  const inherited = env.PARALLAX_HOME ?? '';
  const keep = options.fresh !== true && isOwnTestHome(inherited, env, tmpdir) && exists(inherited);
  let created: string | undefined;
  if (!keep) {
    if (inherited !== '' && !isOwnTestHome(inherited, env, tmpdir)) {
      note(`ignoring the inherited PARALLAX_HOME (${inherited}): tests always use their own temp home`);
    }
    created = mkdtempSync(path.join(tmpdir, TEST_HOME_PREFIX));
    env.PARALLAX_HOME = created;
  }
  assertNotRealHome(env.PARALLAX_HOME ?? '', env);
  return created;
}

/**
 * Throws when PARALLAX_HOME is the productive data directory or lies inside it (R0-23; compared
 * case-insensitively with `/` and `\` alike, as Windows does).
 */
export function assertNotRealHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData === '') return;
  const real = pathKey(path.win32.join(localAppData, 'Parallax'));
  if (isRealHome(home, env)) {
    throw new Error(
      `Tests must not use the real data directory ${real} (or a folder inside it). Set PARALLAX_HOME to a temp dir.`,
    );
  }
}
