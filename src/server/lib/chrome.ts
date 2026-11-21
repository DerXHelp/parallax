/**
 * Google Chrome lookup (ADR-136, replaces lib/edge.ts of R1-08 / ADR-024): used by `pnpm preflight`
 * and the launcher (Chrome app window). Never via the current directory and never through a shell.
 * Windows: never via the PATH (`chrome` is not on the PATH; a bare name would let the cwd win).
 *
 * Linux (WP-106, WP-100 §5.3): a configured program, then `google-chrome-stable`, `google-chrome`,
 * `chromium`, `chromium-browser` on the `PATH` (absolute, safe entries only – lib/executables.ts),
 * then `/snap/bin/chromium`. The version comes from `<chrome> --version` (no PE resource there; on
 * Linux the switch prints and exits without opening a window).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { POSIX_PATHS, WIN32_PATHS, windowsPathIssue, type PathRules } from '@shared/paths';
import { searchPosixPath } from './executables';
import { HOST_PATH_RULES } from './paths';
import { runFile, type RunFileFn } from './process';
import { parseRegDefaultValue, type RegQuery } from './registry';
import { getEnvVar, type FsProbe } from './windows';

const CHROME_APP_PATH = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe';

/**
 * chrome.exe of the stable channel, or null if none exists. Order: App Paths HKCU, then HKLM (64,
 * 32 bit) – the order in which Windows itself resolves `chrome` (Run dialog, ShellExecute), so a
 * per-user install the user runs wins –, then the usual install folders: Program Files (system
 * install, current default), Program Files (x86) (older system installs), %LOCALAPPDATA% (per-user
 * install). Every candidate is checked with `@shared/paths` and must be an existing `.exe`
 * (absolute path, so it can be passed to spawnHidden directly, R1-04).
 */
export async function findChrome(deps: {
  regQuery: RegQuery;
  fs: FsProbe;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string | null> {
  const fromRegistry: string[] = [];
  for (const [key, view] of [
    [`HKCU\\${CHROME_APP_PATH}`, 64],
    [`HKLM\\${CHROME_APP_PATH}`, 64],
    [`HKLM\\${CHROME_APP_PATH}`, 32],
  ] as const) {
    const output = await deps.regQuery(key, view);
    const value = output === null ? null : parseRegDefaultValue(output, deps.env);
    if (value !== null) fromRegistry.push(value);
  }
  const folders = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
    .map((name) => getEnvVar(deps.env, name))
    .filter((value): value is string => value !== undefined && value !== '')
    .map((root) => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const candidate of [...fromRegistry, ...folders]) {
    if (windowsPathIssue(candidate) !== null) continue;
    if (path.win32.extname(candidate).toLowerCase() !== '.exe') continue;
    if (await deps.fs.isFile(candidate)) return candidate;
  }
  return null;
}

/** UTF-16LE key of the version resource (`VS_VERSIONINFO.szKey`, with its terminating NUL). */
const VERSION_KEY = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
/** `VS_FIXEDFILEINFO.dwSignature` and `.dwStrucVersion`. */
const FIXED_INFO_SIGNATURE = 0xfeef04bd;
const FIXED_INFO_STRUC_VERSION = 0x00010000;
/**
 * Offset of `VS_FIXEDFILEINFO` from the key: the key follows three WORDs (6 bytes) and takes 32
 * bytes; the value is aligned to 32 bit from the (aligned) start of the structure → 40 - 6.
 */
const FIXED_INFO_FROM_KEY = 34;

/**
 * Product version (`a.b.c.d`) from the version resource of a Windows executable, without starting
 * it (chrome.exe has no console output and `--version` would open a window). The signature alone
 * also occurs in code, so the fixed info is only read right behind the `VS_VERSION_INFO` key.
 */
export function exeProductVersion(bytes: Buffer): string | null {
  for (let key = bytes.indexOf(VERSION_KEY); key !== -1; key = bytes.indexOf(VERSION_KEY, key + 1)) {
    const info = key + FIXED_INFO_FROM_KEY;
    if (info + 52 > bytes.length) continue;
    if (bytes.readUInt32LE(info) !== FIXED_INFO_SIGNATURE) continue;
    if (bytes.readUInt32LE(info + 4) !== FIXED_INFO_STRUC_VERSION) continue;
    const ms = bytes.readUInt32LE(info + 16);
    const ls = bytes.readUInt32LE(info + 20);
    return `${String(ms >>> 16)}.${String(ms & 0xffff)}.${String(ls >>> 16)}.${String(ls & 0xffff)}`;
  }
  return null;
}

/** chrome.exe is a few MiB (the browser lives in chrome.dll); anything far larger is not read. */
const MAX_EXE_BYTES = 64 * 1024 * 1024;

/**
 * Reads the executable for `exeProductVersion`; null for unsafe paths (`rules`, default those of this
 * host), missing/huge files, errors.
 */
export async function readExeVersion(
  file: string,
  rules: PathRules = HOST_PATH_RULES,
): Promise<string | null> {
  if (rules.issue(file) !== null) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_EXE_BYTES) return null;
    return exeProductVersion(await readFile(file));
  } catch {
    return null;
  }
}

// ---- Linux (WP-106) ----

/** Program names on the `PATH`, in lookup order (stable Google Chrome first, then Chromium). */
export const LINUX_CHROME_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
] as const;
/** Chromium as a Snap (Ubuntu's `chromium` package installs it); `/snap/bin` is not always on the PATH. */
export const SNAP_CHROMIUM = '/snap/bin/chromium';

/**
 * Chrome or Chromium on Linux (see the file comment), or null: `configured` (an absolute program, e.g.
 * from a setting) wins when it is executable; then the names on `PATH`; then the Snap. Every candidate
 * passes the POSIX path rules and is an executable regular file.
 */
export async function findChromeLinux(deps: {
  fs: FsProbe;
  env: Readonly<Record<string, string | undefined>>;
  configured?: string | null;
}): Promise<string | null> {
  const executable = (file: string): Promise<boolean> =>
    deps.fs.isExecutable === undefined ? deps.fs.isFile(file) : deps.fs.isExecutable(file);
  const configured = deps.configured ?? null;
  if (configured !== null && POSIX_PATHS.issue(configured) === null && (await executable(configured))) {
    return configured;
  }
  for (const name of LINUX_CHROME_NAMES) {
    const [hit] = await searchPosixPath(name, deps.env, deps.fs);
    if (hit !== undefined) return hit;
  }
  return (await executable(SNAP_CHROMIUM)) ? SNAP_CHROMIUM : null;
}

/** True for Chromium as a Snap (its confinement hides dot folders in `$HOME`, WP-100 §5.3). */
export function isSnapChrome(file: string): boolean {
  return file === SNAP_CHROMIUM || file.startsWith('/snap/');
}

/** `Google Chrome 158.0.7712.55 unknown`, `Chromium 158.0.7712.55 snap` → `158.0.7712.55`. */
export function parseChromeVersion(output: string): string | null {
  const match = /\b(?:Chrome|Chromium)\b[^\d\n]*(\d+(?:\.\d+){1,3})/i.exec(output);
  return match?.[1] ?? null;
}

const CHROME_VERSION_TIMEOUT_MS = 10_000;

/**
 * Linux: `<chrome> --version` (argument array, no shell, bounded) → the version, or null for unsafe
 * paths, failures and unknown output. Never throws.
 */
export async function readChromeVersionLinux(file: string, run: RunFileFn = runFile): Promise<string | null> {
  if (POSIX_PATHS.issue(file) !== null) return null;
  try {
    const result = await run(file, ['--version'], {
      timeoutMs: CHROME_VERSION_TIMEOUT_MS,
      maxOutputBytes: 4 * 1024,
    });
    if (result.timedOut || result.exitCode !== 0) return null;
    return parseChromeVersion(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The Chrome version on this kind of host: Windows reads the version resource (`readExeVersion`,
 * `--version` would open a window there), Linux asks `--version`.
 */
export function readChromeVersion(
  file: string,
  platform: NodeJS.Platform = process.platform,
  run: RunFileFn = runFile,
): Promise<string | null> {
  return platform === 'win32' ? readExeVersion(file, WIN32_PATHS) : readChromeVersionLinux(file, run);
}
