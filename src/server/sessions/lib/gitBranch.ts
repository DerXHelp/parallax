/**
 * Git branch of a session's working directory (WP-13b, Plan "Git-Branch", R1-04): read at the end
 * of a turn with `git rev-parse --abbrev-ref HEAD`; when that fails (V3-11: a fresh repository
 * without a commit has no HEAD revision yet) `git branch --show-current` (git ≥ 2.22) names the
 * branch. `git` is never started by its bare name – a planted `git.exe` in a cloned repo would win
 * (libuv searches the cwd first) – but resolved with `resolveExecutable` on the session's PATH (no
 * git on the PATH → no branch).
 *
 * WP-111 (Ausbau 1): `watchGitHead` watches the `HEAD` file of the worktree's git folder (`git rev-parse
 * --absolute-git-dir`: `.git`, or `.git/worktrees/<name>` of a linked worktree whose `.git` is a file)
 * and reports a change (debounced) – a `git switch` in a terminal shows at once instead of after the next
 * turn. At most GIT_HEAD_WATCH_MAX watches at a time (the caller stops a watch it no longer needs);
 * `fs.watch` without `persistent`, so a watch never keeps the server alive.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { runFile, type RunFileFn } from '../../lib/process';
import { resolveExecutable } from '../../lib/windows';

export const GIT_BRANCH_TIMEOUT_MS = 5_000;
const BRANCH_CHARS = 200;

export interface GitBranchDeps {
  /** Default `resolveExecutable` (lib/windows.ts): absolute `.exe` or null. */
  resolve?: (name: string, env: Readonly<Record<string, string | undefined>>) => Promise<string | null>;
  runFile?: RunFileFn;
}

/** Branch name, or null (no git, no repository, detached HEAD, failure). Never throws. */
export async function readGitBranch(
  cwd: string,
  env: Record<string, string>,
  deps: GitBranchDeps = {},
): Promise<string | null> {
  try {
    const git = await (deps.resolve ?? resolveExecutable)('git', env);
    if (git === null) return null;
    const run = deps.runFile ?? runFile;
    const options = { cwd, env, timeoutMs: GIT_BRANCH_TIMEOUT_MS, maxOutputBytes: 4096 };
    const firstLine = (stdout: string): string => (stdout.split(/\r?\n/)[0] ?? '').trim();
    const head = await run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
    if (head.timedOut) return null;
    let branch: string;
    if (head.exitCode === 0) {
      branch = firstLine(head.stdout);
    } else {
      // V3-11: no commit yet (or no repository – then this fails as well).
      const current = await run(git, ['branch', '--show-current'], options);
      if (current.exitCode !== 0 || current.timedOut) return null;
      branch = firstLine(current.stdout);
    }
    if (branch === '' || branch === 'HEAD') return null;
    return branch.slice(0, BRANCH_CHARS);
  } catch {
    return null;
  }
}

/** WP-111: watches at a time (one per visible or running entry in a repository). */
export const GIT_HEAD_WATCH_MAX = 64;
/** WP-111: a burst of events (HEAD.lock, rename) reports once after this pause. */
export const GIT_HEAD_DEBOUNCE_MS = 150;

let activeWatches = 0;

export interface GitHeadWatch {
  /** The git folder that holds the watched HEAD. */
  readonly gitDir: string;
  close(): void;
}

export interface GitHeadWatchDeps extends GitBranchDeps {
  /** Default `fs.watch`. */
  watch?: (
    folder: string,
    listener: (event: string, filename: string | null) => void,
  ) => Pick<FSWatcher, 'close' | 'on'>;
  debounceMs?: number;
}

/** Number of HEAD watches running (tests). */
export function gitHeadWatchCount(): number {
  return activeWatches;
}

/**
 * Starts watching the HEAD of the worktree `cwd` belongs to; null when there is none (no git, no
 * repository, the limit reached, the folder cannot be watched). Never throws.
 */
export async function watchGitHead(
  cwd: string,
  env: Record<string, string>,
  onChange: () => void,
  deps: GitHeadWatchDeps = {},
): Promise<GitHeadWatch | null> {
  if (activeWatches >= GIT_HEAD_WATCH_MAX) return null;
  let gitDir: string;
  try {
    const git = await (deps.resolve ?? resolveExecutable)('git', env);
    if (git === null) return null;
    const run = deps.runFile ?? runFile;
    const result = await run(git, ['rev-parse', '--absolute-git-dir'], {
      cwd,
      env,
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    gitDir = (result.stdout.split(/\r?\n/)[0] ?? '').trim();
    if (gitDir === '') return null;
  } catch {
    return null;
  }
  if (activeWatches >= GIT_HEAD_WATCH_MAX) return null;
  const debounceMs = deps.debounceMs ?? GIT_HEAD_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let watcher: Pick<FSWatcher, 'close' | 'on'>;
  const listener = (_event: string, filename: string | null): void => {
    // `HEAD` itself, or the lock file git renames over it; unknown names (some platforms) count too.
    if (closed || (filename !== null && filename !== 'HEAD' && filename !== 'HEAD.lock')) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer.unref();
  };
  try {
    watcher =
      deps.watch?.(gitDir, listener) ??
      fsWatch(gitDir, { persistent: false }, (event, filename) => {
        listener(event, filename);
      });
  } catch {
    return null;
  }
  activeWatches += 1;
  const close = (): void => {
    if (closed) return;
    closed = true;
    activeWatches -= 1;
    if (timer !== null) clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // Already gone.
    }
  };
  // The folder vanished (worktree removed): the watch ends by itself.
  watcher.on('error', close);
  return { gitDir, close };
}
