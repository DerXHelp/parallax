/**
 * Git branch of a session's working directory (WP-13b, Plan "Git-Branch", R1-04): read at the end
 * of a turn with `git rev-parse --abbrev-ref HEAD`. `git` is never started by its bare name – a
 * planted `git.exe` in a cloned repo would win (libuv searches the cwd first) – but resolved with
 * `resolveExecutable` on the session's PATH (no git on the PATH → no branch). No `.git/HEAD` watch.
 */
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
    const result = await (deps.runFile ?? runFile)(git, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      env,
      timeoutMs: GIT_BRANCH_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    const branch = (result.stdout.split(/\r?\n/)[0] ?? '').trim();
    if (branch === '' || branch === 'HEAD') return null;
    return branch.slice(0, BRANCH_CHARS);
  } catch {
    return null;
  }
}
