/**
 * Git runner (WP-111, ADR-252): the ONE way the git service starts `git`.
 *
 * - `git` is never started by its bare name: `resolveExecutable('git', env)` on the session's PATH
 *   (absolute `.exe` on Windows, an executable file on POSIX; a planted `git.exe` in the repository
 *   never wins). The result is cached per PATH value for a minute.
 * - Every call goes through `runFile` (argument array, no shell, hidden window, the whole process tree
 *   ends on a timeout). Callers put paths after `--`.
 * - Environment: the session's env plus `GIT_TERMINAL_PROMPT=0` (a credential prompt without a terminal
 *   would hang) and `LANGUAGE=en` (messages the push classification understands); the variables that
 *   point git at another repository (`GIT_DIR`, `GIT_WORK_TREE`, …) are dropped.
 * - Reading calls (`status`, `diff`, `rev-parse`, `ls-files`, `worktree list`, …) run with
 *   `-c core.fsmonitor=false` and `GIT_OPTIONAL_LOCKS=0`: the configuration of a foreign repository must
 *   not start a program on a mere read, and a read never takes the index lock. Writing calls (commit,
 *   push, worktree add/remove, branch switch) run the repository's hooks like a terminal would.
 * - Limits: reading 10 s, `worktree add`/`push`/commit 120 s; output per stream capped (`maxOutputBytes`,
 *   `truncated` tells when the cap was hit).
 * - Errors: no `git` → GIT_NOT_FOUND; timeout → GIT_FAILED {op, detail: 'timeout'}; "not a git
 *   repository" → NOT_A_GIT_REPO {path}; any other exit code ≠ 0 (where the caller asks for success)
 *   → GIT_FAILED {op, exitCode, detail} with the first line of git's message, scrubbed (credentials in
 *   URLs removed, control characters dropped, ≤ 300 chars). Output is never logged.
 */
import { makeError, type GitOperation } from '@shared/errors';
import { deleteEnvVar, setEnvVar } from '../claude/env';
import { logger } from '../lib/logger';
import { errnoCode, runFile, type RunFileFn } from '../lib/process';
import { getEnvVar, resolveExecutable } from '../lib/windows';
import { CommandError } from '../sync/ports';

/** Reading calls (status, diff, rev-parse, ls-files, worktree list). */
export const GIT_READ_TIMEOUT_MS = 10_000;
/** `worktree add`, `push`, commit (hooks), worktree removal. */
export const GIT_LONG_TIMEOUT_MS = 120_000;
/** Default output cap per stream (status lists, diff lists). */
export const GIT_DEFAULT_OUTPUT_BYTES = 8 * 1024 * 1024;
/** `params.detail` of GIT_FAILED / GIT_PUSH_FAILED. */
export const GIT_DETAIL_CHARS = 300;
/** How long a resolved `git` is reused for the same PATH value. */
const RESOLVE_CACHE_MS = 60_000;

/** Variables that would point git at another repository than the one of `cwd`. */
const REPO_REDIRECT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const;

export type GitMode = 'read' | 'write';

export interface GitCall {
  cwd: string;
  /** The session's environment (PATH decides which `git` runs). */
  env: Readonly<Record<string, string>>;
  /** Arguments after `git` (and after the read hardening). */
  args: readonly string[];
  /** For the error (`GIT_FAILED.params.op`). */
  op: GitOperation;
  mode: GitMode;
  /** Default: GIT_READ_TIMEOUT_MS for reads, GIT_LONG_TIMEOUT_MS for writes. */
  timeoutMs?: number;
  /** Per stream; default GIT_DEFAULT_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout reached `maxOutputBytes` (the rest was dropped). */
  truncated: boolean;
}

export interface GitRunnerDeps {
  /** Default `resolveExecutable` (absolute `git`, or null). */
  resolve?: (name: string, env: Readonly<Record<string, string | undefined>>) => Promise<string | null>;
  runFile?: RunFileFn;
  /** Env semantics (default `process.platform`). */
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface GitRunner {
  /** Runs git; resolves for every exit code. Throws GIT_NOT_FOUND, GIT_FAILED (timeout). */
  run(call: GitCall): Promise<GitResult>;
  /** Like `run`, but an exit code ≠ 0 throws (NOT_A_GIT_REPO or GIT_FAILED {op, exitCode, detail}). */
  ok(call: GitCall): Promise<GitResult>;
  /** The absolute `git` for this env, or null. */
  executable(env: Readonly<Record<string, string>>): Promise<string | null>;
}

const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * The first non-empty line of git's message, without credentials in URLs (`https://user:token@host` →
 * `https://***@host`) and control characters, at most GIT_DETAIL_CHARS.
 */
export function scrubGitMessage(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is dropped
  const clean = line.replace(CREDENTIALS_IN_URL, '$1***@').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.slice(0, GIT_DETAIL_CHARS);
}

/** git's "not a repository" message (exit 128). */
export function isNotARepoMessage(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** The environment of one git call (see the file comment). */
export function gitEnvironment(
  base: Readonly<Record<string, string>>,
  mode: GitMode,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  for (const name of REPO_REDIRECT_VARS) deleteEnvVar(env, name, platform);
  setEnvVar(env, 'GIT_TERMINAL_PROMPT', '0', platform);
  setEnvVar(env, 'LANGUAGE', 'en', platform);
  if (mode === 'read') setEnvVar(env, 'GIT_OPTIONAL_LOCKS', '0', platform);
  return env;
}

/** The full argument list: `--no-pager`, for reads `-c core.fsmonitor=false`, then the call's. */
export function gitArguments(args: readonly string[], mode: GitMode): string[] {
  return mode === 'read' ? ['--no-pager', '-c', 'core.fsmonitor=false', ...args] : ['--no-pager', ...args];
}

/** GIT_FAILED for a call that ended with an exit code ≠ 0 (or NOT_A_GIT_REPO). */
export function gitFailure(call: Pick<GitCall, 'op' | 'cwd'>, result: GitResult): CommandError {
  if (isNotARepoMessage(result.stderr)) {
    return new CommandError(makeError('NOT_A_GIT_REPO', { path: call.cwd }));
  }
  const detail = scrubGitMessage(result.stderr === '' ? result.stdout : result.stderr);
  return new CommandError(
    makeError('GIT_FAILED', {
      op: call.op,
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      ...(detail === '' ? {} : { detail }),
    }),
  );
}

export function createGitRunner(deps: GitRunnerDeps = {}): GitRunner {
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolve ?? resolveExecutable;
  const run = deps.runFile ?? runFile;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; git: string | null }>();

  const executable = async (env: Readonly<Record<string, string>>): Promise<string | null> => {
    const key = getEnvVar(env, 'PATH', platform) ?? '';
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < RESOLVE_CACHE_MS) return hit.git;
    const git = await resolve('git', env);
    cache.set(key, { at: now(), git });
    if (cache.size > 32) cache.delete(cache.keys().next().value ?? key);
    return git;
  };

  const runGit = async (call: GitCall): Promise<GitResult> => {
    const git = await executable(call.env);
    if (git === null) throw new CommandError(makeError('GIT_NOT_FOUND'));
    const max = call.maxOutputBytes ?? GIT_DEFAULT_OUTPUT_BYTES;
    let result;
    try {
      result = await run(git, gitArguments(call.args, call.mode), {
        cwd: call.cwd,
        env: gitEnvironment(call.env, call.mode, platform),
        timeoutMs: call.timeoutMs ?? (call.mode === 'read' ? GIT_READ_TIMEOUT_MS : GIT_LONG_TIMEOUT_MS),
        // One byte more than the cap: reaching it means the output was cut.
        maxOutputBytes: max + 1,
      });
    } catch (error) {
      // The executable vanished (ENOENT/EACCES) or the folder is gone: the cache entry is stale.
      cache.clear();
      const code = errnoCode(error);
      logger.debug({ op: call.op, code }, 'git could not be started');
      if (code === 'ENOENT' || code === 'EACCES') throw new CommandError(makeError('GIT_NOT_FOUND'));
      throw new CommandError(makeError('GIT_FAILED', { op: call.op, detail: 'spawn' }));
    }
    if (result.timedOut) {
      logger.warn({ op: call.op }, 'git call timed out');
      throw new CommandError(makeError('GIT_FAILED', { op: call.op, detail: 'timeout' }));
    }
    const truncated = Buffer.byteLength(result.stdout, 'utf8') > max;
    return {
      exitCode: result.exitCode,
      stdout: truncated ? result.stdout.slice(0, max) : result.stdout,
      stderr: result.stderr,
      truncated,
    };
  };

  return {
    run: runGit,
    async ok(call) {
      const result = await runGit(call);
      if (result.exitCode !== 0) throw gitFailure(call, result);
      return result;
    },
    executable,
  };
}
