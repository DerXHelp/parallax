/**
 * Windows lookups without a shell (WP-11 owns this file; moved from claude/resolveClaude.ts in the
 * R1 fixes, R1-08 / ADR-024 – WP-13 and WP-21 use it): case-insensitive env lookup, the in-process
 * `where` (PATH × PATHEXT, never the current directory) and npm shim resolution (`.cmd`/`.ps1` →
 * the `.exe` they start). Every file system access goes through an `FsProbe`, guarded by
 * `@shared/paths` (UNC/device/ADS paths are never touched, C.10).
 *
 * WP-103: on POSIX hosts `getEnvVar` is case-sensitive and `searchPath`/`resolveExecutable` use the
 * POSIX lookup of lib/executables.ts (`PATH` at `:`, executable regular files, link targets checked).
 * The platform is a trailing parameter (default `process.platform`); Windows behaves as before.
 */
import { access, constants, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { WIN32_PATHS, windowsPathIssue, windowsPathKey, type PathRules } from '@shared/paths';
import { searchPosixPath } from './executables';
import { readFileHead } from './fileRead';
import { HOST_PATH_RULES } from './paths';

// ---- file system seam (tests use createMemoryFs) ----

export interface FsProbe {
  /** True for an existing regular file. Must not be called with unsafe paths (checked before). */
  isFile(path: string): Promise<boolean>;
  /** UTF-8 text of a (small) file or null. */
  readText(path: string): Promise<string | null>;
  /** POSIX lookup (WP-103): a regular file with execute permission. Absent (older fakes) → `isFile`. */
  isExecutable?(path: string): Promise<boolean>;
  /** POSIX lookup (WP-103): the path with every link resolved, null if missing. Absent → the path itself. */
  realpath?(path: string): Promise<string | null>;
  /**
   * WP-103: up to `length` bytes from the start of a regular file (the ELF check of `claude`), null if
   * it cannot be read. Absent → the check is skipped by callers that allow it.
   */
  readHead?(path: string, length: number): Promise<Uint8Array | null>;
}

const MAX_SHIM_BYTES = 64 * 1024;

/**
 * Real file system, guarded: unsafe paths of this host (Windows: UNC, device, ADS …; POSIX: relative,
 * `/proc` …) are never touched (C.10).
 */
export const nodeFsProbe: FsProbe = {
  async isFile(file) {
    if (HOST_PATH_RULES.issue(file) !== null) return false;
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  },
  async readText(file) {
    if (HOST_PATH_RULES.issue(file) !== null) return null;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SHIM_BYTES) return null;
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
  async isExecutable(file) {
    if (HOST_PATH_RULES.issue(file) !== null) return false;
    try {
      if (!(await stat(file)).isFile()) return false;
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async realpath(file) {
    if (HOST_PATH_RULES.issue(file) !== null) return null;
    try {
      return await realpath(file);
    } catch {
      return null;
    }
  },
  async readHead(file, length) {
    if (HOST_PATH_RULES.issue(file) !== null) return null;
    try {
      return await readFileHead(file, length);
    } catch {
      return null;
    }
  },
};

export interface MemoryFsOptions {
  /** Key rules of the lookups (default `WIN32_PATHS`: case-insensitive and `/`-tolerant like Windows). */
  rules?: PathRules;
  /** Files that exist but are not executable (POSIX lookups; every other file is). */
  notExecutable?: readonly string[];
  /** `realpath` answers (link → target); other files resolve to themselves, missing ones to null. */
  links?: Readonly<Record<string, string>>;
}

/**
 * In-memory file system for tests (also of other packages): `files` maps paths to contents;
 * lookups are case-insensitive and `/`-tolerant like Windows (windowsPathKey) unless `rules` says
 * otherwise. `touched` records every path asked for, so tests can assert that unsafe paths are
 * never accessed. `readHead` answers the first bytes of the content (one byte per UTF-16 unit,
 * `latin1`: `'\x7fELF'` is the ELF magic).
 */
export function createMemoryFs(
  files: Readonly<Record<string, string>>,
  options: MemoryFsOptions = {},
): FsProbe & { touched: string[] } {
  const rules = options.rules ?? WIN32_PATHS;
  const byKey = new Map(Object.entries(files).map(([file, text]) => [rules.key(file), text]));
  const blocked = new Set((options.notExecutable ?? []).map((file) => rules.key(file)));
  const links = new Map(
    Object.entries(options.links ?? {}).map(([file, target]) => [rules.key(file), target]),
  );
  const touched: string[] = [];
  return {
    touched,
    isFile(file) {
      touched.push(file);
      return Promise.resolve(byKey.has(rules.key(file)));
    },
    readText(file) {
      touched.push(file);
      return Promise.resolve(byKey.get(rules.key(file)) ?? null);
    },
    isExecutable(file) {
      touched.push(file);
      const key = rules.key(file);
      return Promise.resolve(byKey.has(key) && !blocked.has(key));
    },
    realpath(file) {
      touched.push(file);
      const key = rules.key(file);
      return Promise.resolve(links.get(key) ?? (byKey.has(key) ? file : null));
    },
    readHead(file, length) {
      touched.push(file);
      const text = byKey.get(rules.key(file));
      return Promise.resolve(text === undefined ? null : Buffer.from(text, 'latin1').subarray(0, length));
    },
  };
}

// ---- environment ----

/**
 * Lookup of an environment variable: case-insensitive on Windows (its env semantics), exact on
 * POSIX (`http_proxy` and `HTTP_PROXY` are two variables there, WP-101 §1.6).
 */
export function getEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return Object.hasOwn(env, name) ? env[name] : undefined;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

// ---- where ----

export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * In-process `where <name>`: every existing file `<dir>\<name>` and `<dir>\<name><ext>` for the
 * PATH directories and PATHEXT extensions of `env`, in where.exe order, without duplicates.
 * Relative, UNC and device directories are skipped without touching them. Unlike where.exe (and
 * libuv for a bare program name) this never searches the current directory (R1-04).
 * POSIX (WP-103): `searchPosixPath` (lib/executables.ts) – executable files only, no extensions.
 */
export async function searchPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform !== 'win32') return searchPosixPath(name, env, fs);
  const extensions = (getEnvVar(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[^.\\/:]+$/.test(ext));
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of (getEnvVar(env, 'PATH', platform) ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir === '' || windowsPathIssue(dir) !== null) continue;
    for (const candidate of [name, ...extensions.map((ext) => `${name}${ext}`)]) {
      const file = path.win32.join(dir, candidate);
      const key = windowsPathKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      if (windowsPathIssue(file) === null && (await fs.isFile(file))) hits.push(file);
    }
  }
  return hits;
}

// ---- npm shims ----

/** `"%dp0%\…\x.exe"` / `"%~dp0\…"` (cmd-shim) and `"$basedir/…/x.exe"` (ps1/sh shim). */
const SHIM_TARGET = /(?:%~?dp0%?|\$basedir)[\\/]([^"'\r\n%$<>|*?]+?\.exe)(?=["'\s]|$)/gi;

/**
 * The `.exe` an npm shim (`.cmd`/`.ps1`) starts, or null. `node.exe` targets (JS CLIs) are not
 * returned; `exeName` restricts the target's file name (e.g. `claude.exe`). Windows only.
 */
export async function resolveCmdShim(
  shimPath: string,
  fs: FsProbe,
  exeName?: string,
): Promise<string | null> {
  const text = await fs.readText(shimPath);
  if (text === null) return null;
  const dir = path.win32.dirname(shimPath);
  for (const match of text.matchAll(SHIM_TARGET)) {
    const relative = match[1];
    if (relative === undefined) continue;
    const base = path.win32.basename(relative).toLowerCase();
    if (base === 'node.exe') continue;
    if (exeName !== undefined && base !== exeName.toLowerCase()) continue;
    const target = path.win32.join(dir, relative);
    if (windowsPathIssue(target) !== null) continue;
    if (await fs.isFile(target)) return target;
  }
  return null;
}

/**
 * Absolute `.exe` for a bare program name (`git` → `C:\Program Files\Git\cmd\git.exe`): the first
 * `.exe` hit of searchPath, else the `.exe` behind the first npm shim. Null if none – callers never
 * pass a bare name to spawn (libuv would search the child's cwd first, R1-04).
 * POSIX (WP-103): the first executable hit of the POSIX lookup (`git` → `/usr/bin/git`).
 */
export async function resolveExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe = nodeFsProbe,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== 'win32') return (await searchPosixPath(name, env, fs))[0] ?? null;
  const hits = await searchPath(name, env, fs, platform);
  const exe = hits.find((hit) => path.win32.extname(hit).toLowerCase() === '.exe');
  if (exe !== undefined) return exe;
  for (const hit of hits) {
    const ext = path.win32.extname(hit).toLowerCase();
    if (ext !== '.cmd' && ext !== '.ps1') continue;
    const target = await resolveCmdShim(hit, fs, `${name.replace(/\.exe$/i, '')}.exe`);
    if (target !== null) return target;
  }
  return null;
}
