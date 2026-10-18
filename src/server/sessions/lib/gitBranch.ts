/**
 * Git branch of a session's working directory (WP-13b, Plan "Git-Branch", R1-04): read at the end
 * of a turn with `git rev-parse --abbrev-ref HEAD`; when that fails (V3-11: a fresh repository
 * without a commit has no HEAD revision yet) `git branch --show-current` (git ≥ 2.22) names the
 * branch. `git` is never started by its bare name – a planted `git.exe` in a cloned repo would win
 * (libuv searches the cwd first) – but resolved with `resolveExecutable` on the session's PATH (no
 * git on the PATH → no branch). No `.git/HEAD` watch.
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
