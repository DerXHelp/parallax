/**
 * resolveClaude (Plan "Claude-Auflösung", B, C.7, F.17): which `claude.exe` a profile starts.
 *
 * Order: 1. the profile's fixed path (`executable.kind === 'path'`; Phase 1 has no settings field
 * for it) – used exclusively, no fallback; 2. `where claude` – all hits in PATH order. Only `.exe`
 * files are used: direct `.exe` hits first, then npm `.cmd`/`.ps1` shims resolved to
 * `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe`; the extensionless sh script and
 * `claude.exe.old.*` leftovers of the self-updater are skipped.
 *
 * `where` is searched in-process over PATH × PATHEXT (same order as where.exe: per directory the
 * bare name, then each extension). Unlike where.exe this never searches the current directory,
 * has no OEM-codepage output to decode (non-ASCII user names) and skips UNC/device/relative PATH
 * entries before any file system access (C.10, `@shared/paths`).
 *
 * Version rule C.7: `too_old` (red) if the CLI is older than `claudeCodeVersion` in the SDK's
 * package.json, otherwise ok (a newer CLI is the supported case).
 */
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { errnoCode, type RunFileOptions, type RunFileResult } from '../lib/process';
import { getEnvVar } from './env';

// ---- file system and process seams (tests use fakes) ----

export interface ClaudeFsDeps {
  /** True for an existing regular file. Must not be called with unsafe paths (checked before). */
  isFile(path: string): Promise<boolean>;
  /** UTF-8 text of a (small) file or null. */
  readText(path: string): Promise<string | null>;
}

const MAX_SHIM_BYTES = 64 * 1024;

/** Real file system, guarded: unsafe paths (UNC, device, ADS …) are never touched (C.10). */
export const nodeFsDeps: ClaudeFsDeps = {
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
export function createMemoryFs(
  files: Readonly<Record<string, string>>,
): ClaudeFsDeps & { touched: string[] } {
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

export type RunFileFn = (
  file: string,
  args: readonly string[],
  options: RunFileOptions,
) => Promise<RunFileResult>;

// ---- where ----

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * In-process `where <name>`: every existing file `<dir>\<name>` and `<dir>\<name><ext>` for the
 * PATH directories and PATHEXT extensions of `env`, in where.exe order, without duplicates.
 * Relative, UNC and device directories are skipped without touching them.
 */
export async function searchPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  fs: ClaudeFsDeps,
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

/** Conventional target of the npm shim of @anthropic-ai/claude-code (C.7). */
export function npmClaudeShimTarget(shimPath: string): string {
  return path.win32.join(
    path.win32.dirname(shimPath),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
}

/**
 * The `.exe` an npm shim (`.cmd`/`.ps1`) starts, or null. `node.exe` targets (JS CLIs) are not
 * returned; `exeName` restricts the target's file name (e.g. `claude.exe`).
 */
export async function resolveCmdShim(
  shimPath: string,
  fs: ClaudeFsDeps,
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

/** Target of a claude npm shim: the parsed `.exe`, else the conventional path; null if neither exists. */
export async function resolveClaudeShim(shimPath: string, fs: ClaudeFsDeps): Promise<string | null> {
  const parsed = await resolveCmdShim(shimPath, fs, 'claude.exe');
  if (parsed !== null) return parsed;
  const conventional = npmClaudeShimTarget(shimPath);
  return windowsPathIssue(conventional) === null && (await fs.isFile(conventional)) ? conventional : null;
}

// ---- candidates ----

export type ClaudeSource = 'profile' | 'path' | 'npm-shim';

export type CandidateRejection =
  | 'unsafe_path'
  | 'old_binary'
  | 'no_extension'
  | 'unsupported_extension'
  | 'missing'
  | 'shim_unresolved'
  | 'duplicate';

export interface ClaudeCandidate {
  /** As found (where hit or profile path). */
  path: string;
  /** The `.exe` it leads to, or null when rejected. */
  executable: string | null;
  source: ClaudeSource;
  rejected: CandidateRejection | null;
}

const OLD_BINARY = /^claude\.exe\.old(?:\.|$)/i;
const SHIM_EXTENSIONS: ReadonlySet<string> = new Set(['.cmd', '.ps1']);

async function classify(file: string, fromProfile: boolean, fs: ClaudeFsDeps): Promise<ClaudeCandidate> {
  const direct: ClaudeSource = fromProfile ? 'profile' : 'path';
  const reject = (rejected: CandidateRejection, source: ClaudeSource = direct): ClaudeCandidate => ({
    path: file,
    executable: null,
    source,
    rejected,
  });
  if (OLD_BINARY.test(path.win32.basename(file))) return reject('old_binary');
  if (windowsPathIssue(file) !== null) return reject('unsafe_path');
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '') return reject('no_extension');
  if (ext === '.exe') {
    return (await fs.isFile(file))
      ? { path: file, executable: file, source: direct, rejected: null }
      : reject('missing');
  }
  if (SHIM_EXTENSIONS.has(ext)) {
    const source: ClaudeSource = fromProfile ? 'profile' : 'npm-shim';
    const target = await resolveClaudeShim(file, fs);
    return target === null
      ? reject('shim_unresolved', source)
      : { path: file, executable: target, source, rejected: null };
  }
  return reject('unsupported_extension');
}

export type FindClaudeResult =
  | { ok: true; path: string; source: ClaudeSource; candidates: ClaudeCandidate[] }
  | { ok: false; error: ErrorPayload; candidates: ClaudeCandidate[] };

export interface FindClaudeDeps extends ClaudeFsDeps {
  /** All hits of `where claude`, in PATH order (default: searchPath over the built env). */
  where(name: string): Promise<string[]>;
}

/** Finds the executable without starting it. Errors: CLAUDE_NOT_FOUND {source, reason?, candidates?}. */
export async function findClaude(
  profile: Pick<Profile, 'executable'>,
  deps: FindClaudeDeps,
): Promise<FindClaudeResult> {
  if (profile.executable.kind === 'path') {
    const candidate = await classify(profile.executable.path, true, deps);
    if (candidate.executable !== null) {
      return { ok: true, path: candidate.executable, source: 'profile', candidates: [candidate] };
    }
    return {
      ok: false,
      error: makeError('CLAUDE_NOT_FOUND', { source: 'profile', reason: candidate.rejected ?? 'missing' }),
      candidates: [candidate],
    };
  }

  const candidates: ClaudeCandidate[] = [];
  const executables = new Set<string>();
  for (const hit of await deps.where('claude')) {
    const candidate = await classify(hit, false, deps);
    if (candidate.executable !== null) {
      const key = windowsPathKey(candidate.executable);
      if (executables.has(key)) {
        candidates.push({ ...candidate, executable: null, rejected: 'duplicate' });
        continue;
      }
      executables.add(key);
    }
    candidates.push(candidate);
  }
  const chosen =
    candidates.find((c) => c.rejected === null && c.source === 'path') ??
    candidates.find((c) => c.rejected === null);
  if (chosen !== undefined && chosen.executable !== null) {
    return { ok: true, path: chosen.executable, source: chosen.source, candidates };
  }
  return {
    ok: false,
    error: makeError('CLAUDE_NOT_FOUND', { source: 'path', candidates: candidates.length }),
    candidates,
  };
}

// ---- version ----

const VERSION = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;

/** `2.1.300 (Claude Code)` → `2.1.300`; null if the output does not start with a version. */
export function parseClaudeVersion(output: string): string | null {
  return VERSION.exec(output)?.[1] ?? null;
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Semver order (-1, 0, 1); build metadata ignored; null if one side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(x.pre, y.pre);
}

/** C.7: too_old if `cli` < `required`; unknown if either is missing or unparsable. */
export function cliVersionStatus(
  cli: string | null,
  required: string | null,
): ClaudeInstallStatus['versionStatus'] {
  if (cli === null || required === null) return 'unknown';
  const order = compareVersions(cli, required);
  if (order === null) return 'unknown';
  return order < 0 ? 'too_old' : 'ok';
}

export interface SdkManifest {
  /** `@anthropic-ai/claude-agent-sdk` version (0.3.296). */
  sdkVersion: string;
  /** Minimum CLI the SDK was built for (`package.json#claudeCodeVersion`). */
  claudeCodeVersion: string;
}

const sdkPackageSchema = z.looseObject({ version: z.string().min(1), claudeCodeVersion: z.string().min(1) });

/** Reads the installed SDK's package.json (not exported by the package, so via its main entry). */
export async function readSdkManifest(): Promise<SdkManifest | null> {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const text = await readFile(path.join(path.dirname(entry), 'package.json'), 'utf8');
    const pkg = sdkPackageSchema.parse(JSON.parse(text) as unknown);
    return { sdkVersion: pkg.version, claudeCodeVersion: pkg.claudeCodeVersion };
  } catch {
    return null;
  }
}

export const VERSION_TIMEOUT_MS = 15_000;

/**
 * `claude --version` with the given env (buildEnv()). Errors: CLAUDE_SPAWN_FAILED
 * {reason: 'timeout' | 'exit' | <errno>, exitCode?}.
 */
export async function readClaudeVersion(
  executable: string,
  env: Record<string, string>,
  run: RunFileFn,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<{ version: string | null; error: ErrorPayload | null }> {
  let result: RunFileResult;
  try {
    result = await run(executable, ['--version'], { env, timeoutMs, maxOutputBytes: 64 * 1024 });
  } catch (error) {
    return {
      version: null,
      error: makeError('CLAUDE_SPAWN_FAILED', { reason: errnoCode(error) ?? 'spawn' }),
    };
  }
  if (result.timedOut)
    return { version: null, error: makeError('CLAUDE_SPAWN_FAILED', { reason: 'timeout' }) };
  if (result.exitCode !== 0) {
    return {
      version: null,
      error: makeError('CLAUDE_SPAWN_FAILED', { reason: 'exit', exitCode: result.exitCode }),
    };
  }
  return { version: parseClaudeVersion(result.stdout), error: null };
}

// ---- resolveClaude ----

export interface ResolveClaudeDeps extends FindClaudeDeps {
  runFile: RunFileFn;
  /** Environment for `claude --version` (buildEnv()). */
  env: Record<string, string>;
  versionTimeoutMs?: number;
}

export type ResolveClaudeResult =
  | {
      ok: true;
      path: string;
      source: ClaudeSource;
      /** null if `--version` failed (see versionError) or printed no version. */
      version: string | null;
      versionError: ErrorPayload | null;
      candidates: ClaudeCandidate[];
    }
  | { ok: false; error: ErrorPayload; candidates: ClaudeCandidate[] };

/** findClaude + `claude --version`. */
export async function resolveClaude(
  profile: Pick<Profile, 'executable'>,
  deps: ResolveClaudeDeps,
): Promise<ResolveClaudeResult> {
  const found = await findClaude(profile, deps);
  if (!found.ok) return found;
  const { version, error } = await readClaudeVersion(
    found.path,
    deps.env,
    deps.runFile,
    deps.versionTimeoutMs,
  );
  return { ...found, version, versionError: error };
}

/** Default `where` dep: searchPath over `env` with the guarded real file system. */
export function whereOnPath(
  env: Readonly<Record<string, string | undefined>>,
  fs: ClaudeFsDeps = nodeFsDeps,
): (name: string) => Promise<string[]> {
  return (name) => searchPath(name, env, fs);
}
