/**
 * Google Chrome lookup (ADR-136, replaces lib/edge.ts of R1-08 / ADR-024): used by `pnpm preflight`
 * and the launcher (Chrome app window). Never via the PATH or the current directory (`chrome` is
 * not on the PATH; a bare name would let the cwd win) and never through a shell.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { windowsPathIssue } from '@shared/paths';
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

/** Reads the executable for `exeProductVersion`; null for unsafe paths, missing/huge files, errors. */
export async function readExeVersion(file: string): Promise<string | null> {
  if (windowsPathIssue(file) !== null) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_EXE_BYTES) return null;
    return exeProductVersion(await readFile(file));
  } catch {
    return null;
  }
}
