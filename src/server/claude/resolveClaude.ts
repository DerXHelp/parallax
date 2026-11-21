/**
 * resolveClaude (Plan "Claude-Auflösung", B, C.7, F.17): which `claude.exe` a profile starts.
 *
 * Order: 1. the profile's fixed path (`executable.kind === 'path'`; Phase 1 has no settings field
 * for it) – used exclusively, no fallback; 2. `where claude` – all hits in PATH order. Only `.exe`
 * files are used: direct `.exe` hits first, then npm `.cmd`/`.ps1` shims resolved to
 * `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe`; the extensionless sh script and
 * `claude.exe.old.*` leftovers of the self-updater are skipped.
 *
 * `where` is searched in-process over PATH × PATHEXT (`searchPath`, lib/windows.ts – same order as
 * where.exe: per directory the bare name, then each extension). Unlike where.exe this never
 * searches the current directory, has no OEM-codepage output to decode (non-ASCII user names) and
 * skips UNC/device/relative PATH entries before any file system access (C.10, `@shared/paths`).
 *
 * Version rule C.7: `too_old` (red) if the CLI is older than `claudeCodeVersion` in the SDK's
 * package.json, otherwise ok (a newer CLI is the supported case).
 *
 * POSIX hosts (WP-103, WP-100 §5.2; `FindClaudeDeps.platform`): 1. the profile's fixed path;
 * 2. `~/.local/bin/claude` (native installer: a link to `~/.local/share/claude/versions/<v>`);
 * 3. the `PATH` hits (lib/executables.ts). A candidate is an absolute path by the POSIX rules, an
 * executable file, its real path (links resolved) passes the POSIX rules too and starts with the ELF
 * magic – the native build. The JS variant (`cli.js` with a `node` shebang, e.g. an old
 * `npm i -g`) is refused as `not_native` (logged with a hint) like the JS shim on Windows. No
 * extension rules (`no_extension`/`unsafe_path` of a Windows name never apply there, B3). The link
 * is returned, not its target, so a self-update of the native installer is picked up.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { Profile } from '@shared/model';
import { POSIX_PATHS, pathFlavorOf, pathRules, windowsPathIssue } from '@shared/paths';
import { logger } from '../lib/logger';
import { errnoCode, type RunFileFn, type RunFileResult } from '../lib/process';
import { nodeFsProbe, resolveCmdShim, searchPath, type FsProbe } from '../lib/windows';

// ---- npm shims ----

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

/** Target of a claude npm shim: the parsed `.exe`, else the conventional path; null if neither exists. */
export async function resolveClaudeShim(shimPath: string, fs: FsProbe): Promise<string | null> {
  const parsed = await resolveCmdShim(shimPath, fs, 'claude.exe');
  if (parsed !== null) return parsed;
  const conventional = npmClaudeShimTarget(shimPath);
  return windowsPathIssue(conventional) === null && (await fs.isFile(conventional)) ? conventional : null;
}

// ---- candidates ----

/** `native-installer`: `~/.local/bin/claude` on POSIX hosts (WP-103). */
export type ClaudeSource = 'profile' | 'path' | 'npm-shim' | 'native-installer';

export type CandidateRejection =
  | 'unsafe_path'
  | 'old_binary'
  | 'no_extension'
  | 'unsupported_extension'
  | 'missing'
  | 'shim_unresolved'
  | 'duplicate'
  /** POSIX (WP-103): no ELF file – the JS variant (`cli.js`) or a script. */
  | 'not_native';

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

async function classify(file: string, fromProfile: boolean, fs: FsProbe): Promise<ClaudeCandidate> {
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

// ---- POSIX (WP-103) ----

/** Where the native installer puts `claude` on Linux (a link into `~/.local/share/claude/versions`). */
export function nativeInstallerClaude(home: string): string {
  return path.posix.join(home, '.local', 'bin', 'claude');
}

/** `\x7fELF` – the native build of Claude Code on Linux. */
const ELF_MAGIC: readonly number[] = [0x7f, 0x45, 0x4c, 0x46];

export function isElfHeader(head: Uint8Array): boolean {
  return ELF_MAGIC.every((byte, i) => head[i] === byte);
}

async function classifyPosix(file: string, source: ClaudeSource, fs: FsProbe): Promise<ClaudeCandidate> {
  const reject = (rejected: CandidateRejection): ClaudeCandidate => ({
    path: file,
    executable: null,
    source,
    rejected,
  });
  if (POSIX_PATHS.issue(file) !== null) return reject('unsafe_path');
  const executable = fs.isExecutable === undefined ? await fs.isFile(file) : await fs.isExecutable(file);
  if (!executable) return reject('missing');
  const real = fs.realpath === undefined ? file : await fs.realpath(file);
  if (real === null) return reject('missing');
  if (POSIX_PATHS.issue(real) !== null) return reject('unsafe_path');
  const head = fs.readHead === undefined ? null : await fs.readHead(real, ELF_MAGIC.length);
  if (head === null) return reject('missing');
  if (!isElfHeader(head)) {
    logger.info(
      { candidate: file },
      'claude candidate is no native build (JS variant or script) – install Claude Code with the native installer',
    );
    return reject('not_native');
  }
  return { path: file, executable: file, source, rejected: null };
}

export type FindClaudeResult =
  | { ok: true; path: string; source: ClaudeSource; candidates: ClaudeCandidate[] }
  | { ok: false; error: ErrorPayload; candidates: ClaudeCandidate[] };

export interface FindClaudeDeps extends FsProbe {
  /** All hits of `where claude`, in PATH order (default: searchPath over the built env). */
  where(name: string): Promise<string[]>;
  /** Lookup rules of this platform (default `process.platform`, WP-103). */
  platform?: NodeJS.Platform;
  /** POSIX: the user folder of `~/.local/bin/claude` (default `os.homedir()`). */
  home?: string;
}

/** Finds the executable without starting it. Errors: CLAUDE_NOT_FOUND {source, reason?, candidates?}. */
export async function findClaude(
  profile: Pick<Profile, 'executable'>,
  deps: FindClaudeDeps,
): Promise<FindClaudeResult> {
  if ((deps.platform ?? process.platform) !== 'win32') return findClaudePosix(profile, deps);
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
      const key = pathRules('win32').key(candidate.executable);
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

/** findClaude on POSIX hosts (see the file comment): profile path, `~/.local/bin/claude`, PATH. */
async function findClaudePosix(
  profile: Pick<Profile, 'executable'>,
  deps: FindClaudeDeps,
): Promise<FindClaudeResult> {
  if (profile.executable.kind === 'path') {
    const candidate = await classifyPosix(profile.executable.path, 'profile', deps);
    if (candidate.executable !== null) {
      return { ok: true, path: candidate.executable, source: 'profile', candidates: [candidate] };
    }
    return {
      ok: false,
      error: makeError('CLAUDE_NOT_FOUND', { source: 'profile', reason: candidate.rejected ?? 'missing' }),
      candidates: [candidate],
    };
  }

  const rules = pathRules(pathFlavorOf(deps.platform ?? process.platform));
  const candidates: ClaudeCandidate[] = [];
  const executables = new Set<string>();
  const add = (candidate: ClaudeCandidate): void => {
    if (candidate.executable !== null) {
      const key = rules.key(candidate.executable);
      if (executables.has(key)) {
        candidates.push({ ...candidate, executable: null, rejected: 'duplicate' });
        return;
      }
      executables.add(key);
    }
    candidates.push(candidate);
  };
  const home = deps.home ?? os.homedir();
  if (POSIX_PATHS.issue(home) === null) {
    const local = await classifyPosix(nativeInstallerClaude(home), 'native-installer', deps);
    // A convention, not a hit: listed only when something is there.
    if (local.rejected !== 'missing') add(local);
  }
  for (const hit of await deps.where('claude')) add(await classifyPosix(hit, 'path', deps));
  const chosen = candidates.find((c) => c.rejected === null);
  if (chosen !== undefined && chosen.executable !== null) {
    return { ok: true, path: chosen.executable, source: chosen.source, candidates };
  }
  const notNative = candidates.some((c) => c.rejected === 'not_native');
  return {
    ok: false,
    error: makeError('CLAUDE_NOT_FOUND', {
      source: 'path',
      candidates: candidates.length,
      ...(notNative ? { reason: 'not_native' } : {}),
    }),
    candidates,
  };
}

// ---- version ----

const VERSION = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;

/** `2.1.300 (Claude Code)` → `2.1.300`; null if the output does not start with a version. */
export function parseClaudeVersion(output: string): string | null {
  return VERSION.exec(output)?.[1] ?? null;
}

/** C.7 version rule – one implementation in `@shared/version` (WP-30 §4.9), re-exported here. */
export { cliVersionStatus, compareVersions } from '@shared/version';

export interface SdkManifest {
  /** `@anthropic-ai/claude-agent-sdk` version (0.3.322). */
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
  fs: FsProbe = nodeFsProbe,
  platform: NodeJS.Platform = process.platform,
): (name: string) => Promise<string[]> {
  return (name) => searchPath(name, env, fs, platform);
}
