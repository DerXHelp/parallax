/**
 * Windows lookups without a shell (WP-11 owns this file; moved from claude/resolveClaude.ts in the
 * R1 fixes, R1-08 / ADR-024 – WP-13 and WP-21 use it): case-insensitive env lookup, the in-process
 * `where` (PATH × PATHEXT, never the current directory) and npm shim resolution (`.cmd`/`.ps1` →
 * the `.exe` they start). Every file system access goes through an `FsProbe`, guarded by
 * `@shared/paths` (UNC/device/ADS paths are never touched, C.10).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';

// ---- file system seam (tests use createMemoryFs) ----

export interface FsProbe {
  /** True for an existing regular file. Must not be called with unsafe paths (checked before). */
  isFile(path: string): Promise<boolean>;
  /** UTF-8 text of a (small) file or null. */
  readText(path: string): Promise<string | null>;
}

const MAX_SHIM_BYTES = 64 * 1024;

/** Real file system, guarded: unsafe paths (UNC, device, ADS …) are never touched (C.10). */
export const nodeFsProbe: FsProbe = {
  async isFile(file) {
    if (windowsPathIssue(file) !== null) return false;
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  },
  async readText(file) {
    if (windowsPathIssue(file) !== null) return null;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_SHIM_BYTES) return null;
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * In-memory file system for tests (also of other packages): `files` maps paths to contents;
 * lookups are case-insensitive and `/`-tolerant like Windows (windowsPathKey). `touched` records
 * every path asked for, so tests can assert that unsafe paths are never accessed.
 */
export function createMemoryFs(files: Readonly<Record<string, string>>): FsProbe & { touched: string[] } {
  const byKey = new Map(Object.entries(files).map(([file, text]) => [windowsPathKey(file), text]));
  const touched: string[] = [];
  return {
    touched,
    isFile(file) {
      touched.push(file);
      return Promise.resolve(byKey.has(windowsPathKey(file)));
    },
    readText(file) {
      touched.push(file);
      return Promise.resolve(byKey.get(windowsPathKey(file)) ?? null);
    },
  };
}

// ---- environment ----

/** Case-insensitive lookup (Windows env semantics). */
export function getEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
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
 */
export async function searchPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe,
): Promise<string[]> {
  const extensions = (getEnvVar(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => /^\.[^.\\/:]+$/.test(ext));
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of (getEnvVar(env, 'PATH') ?? '').split(';')) {
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
 * returned; `exeName` restricts the target's file name (e.g. `claude.exe`).
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
 */
export async function resolveExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: FsProbe = nodeFsProbe,
): Promise<string | null> {
  const hits = await searchPath(name, env, fs);
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
