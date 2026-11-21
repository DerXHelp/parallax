import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathFlavorOf, pathRules, type PathRules } from '@shared/paths';
import { defaultDataDir } from '../../src/server/lib/dataDir';

/**
 * Test isolation (CLAUDE.md "Tests", R0-23, WP22-07): tests never touch the real data directory
 * (Windows %LOCALAPPDATA%\Parallax, Linux $XDG_DATA_HOME/parallax or ~/.local/share/parallax – the
 * one definition in src/server/lib/dataDir.ts, WP-103) or the home of a running server.
 *
 * - `PARALLAX_HOME`: an inherited value is used ONLY if it is one of our own test homes – a
 *   `parallax-test-*` folder directly inside the OS temp directory (what the Vitest globalSetup of
 *   this run created). The real data directory, a folder inside it, any non-temporary folder and
 *   any other temp folder (e.g. the temp home of a live server whose session runs these tests) is
 *   replaced by a fresh temp home. The globalSetups of Vitest and Playwright always start with a
 *   fresh one (`fresh: true`): in doubt, an own temp home.
 * - `PARALLAX_PORT` is always `0`.
 * - `TEMP`/`TMP` with long names (`useLongTempDir`; the CI runner's TEMP names the user folder `RUNNER~1`).
 * - Inherited server control variables (`SERVER_CONTROL_VARS`: backend, dev mode, validation,
 *   toasts, log level, host, entry id of a calling Parallax session, the update switches) are
 *   removed, so a test run behaves the same inside and outside a Parallax session.
 *
 * Paths are compared with the rules of the platform (`platform`, default this process; tests of the
 * guard pin one): case-insensitive with `/` and `\` alike on Windows, exact on POSIX.
 */

/**
 * Points TEMP/TMP of this process (and so `os.tmpdir()` and every child) to the long form of the
 * temp directory and returns it. Windows may hand out 8.3 short names (the GitHub runner's
 * TEMP names the user folder `RUNNER~1`), while the file service compares physical paths
 * (`realpath`, always long) – tests would see two spellings of one folder. Without a difference,
 * or if the folder cannot be resolved, nothing changes.
 */
export function useLongTempDir(): string {
  const current = os.tmpdir();
  if (process.platform !== 'win32') return current;
  let long: string;
  try {
    long = realpathSync.native(current);
  } catch {
    return current;
  }
  if (long === current) return current;
  process.env.TEMP = long;
  process.env.TMP = long;
  return long;
}

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
  // Update (WP-87): the restart deadline and the switches of the update test build.
  'PARALLAX_UPDATE_READY_TIMEOUT_S',
  'PARALLAX_TEST_UPDATE_BASE',
  'PARALLAX_TEST_RELEASE_KEYS',
  'PARALLAX_TEST_REGISTRY',
];

/** `path.win32`/`path.posix` and the ONE rule set of `@shared/paths` (CR-09: never duplicated). */
function flavor(platform: NodeJS.Platform): { path: typeof path.posix; rules: PathRules } {
  return { path: platform === 'win32' ? path.win32 : path.posix, rules: pathRules(pathFlavorOf(platform)) };
}

/**
 * True if `child` is `parent` or lies inside it (resolved first; Windows case-insensitive with `/`
 * and `\` alike – R0-23; POSIX exact).
 */
export function isPathInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const { path: paths, rules } = flavor(platform);
  return rules.isInside(paths.resolve(child), paths.resolve(parent));
}

/** A `parallax-test-*` folder directly inside the OS temp directory (and not the real home). */
export function isOwnTestHome(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: string = os.tmpdir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (home.trim() === '' || isRealHome(home, env, platform)) return false;
  const { path: paths, rules } = flavor(platform);
  const resolved = paths.resolve(home);
  return (
    rules.equal(paths.dirname(resolved), paths.resolve(tmpdir)) &&
    paths.basename(resolved).toLowerCase().startsWith(TEST_HOME_PREFIX)
  );
}

/**
 * The real data directory of `env` – or null on Windows without LOCALAPPDATA (as before WP-103:
 * nothing to compare with). POSIX always has one (`HOME` or the account's home folder).
 */
function realHomeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === 'win32' && (env.LOCALAPPDATA === undefined || env.LOCALAPPDATA === '')) return null;
  return defaultDataDir(env, platform);
}

function isRealHome(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const real = realHomeOf(env, platform);
  return real !== null && isPathInside(home, real, platform);
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
  const tmpdir = options.tmpdir ?? (env === process.env ? useLongTempDir() : os.tmpdir());
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
 * with the rules of the platform: on Windows case-insensitively with `/` and `\` alike).
 */
export function assertNotRealHome(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const real = realHomeOf(env, platform);
  if (real !== null && isRealHome(home, env, platform)) {
    throw new Error(
      `Tests must not use the real data directory ${flavor(platform).rules.key(real)} (or a folder inside it). Set PARALLAX_HOME to a temp dir.`,
    );
  }
}
