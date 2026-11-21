import { useEffect, useState } from 'react';
import type { HostId } from '@shared/common';
import type { GitWorktree } from '@shared/model';
import { sendHostCommand } from '@web/state/hosts';

/**
 * WP-114: the repository of the folder in "New session" – `worktree.list {cwd}` on the chosen
 * computer, `delayMs` after the last change of the folder (typing). `none` = no repository (or any
 * refusal: NOT_A_GIT_REPO, CWD_NOT_FOUND, GIT_NOT_FOUND … – the worktree switch then stays hidden;
 * the folder field reports a bad folder itself when the session is created).
 */
export type RepoLookup =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'repo'; repoRoot: string; worktrees: readonly GitWorktree[] };

const OFF: RepoLookup = { status: 'off' };
const LOADING: RepoLookup = { status: 'loading' };
const NONE: RepoLookup = { status: 'none' };

/** Wait after the last key stroke before asking git. */
export const REPO_LOOKUP_DELAY_MS = 300;

export function useRepoWorktrees(
  hostId: HostId,
  cwd: string,
  enabled: boolean,
  delayMs = REPO_LOOKUP_DELAY_MS,
): RepoLookup {
  const key = enabled ? `${hostId}\n${cwd}` : null;
  const [answer, setAnswer] = useState<{ key: string; lookup: RepoLookup } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let active = true;
    const timer = setTimeout(() => {
      sendHostCommand(hostId, { name: 'worktree.list', cwd }).then(
        (result) => {
          if (!active) return;
          setAnswer({
            key,
            lookup:
              result.repoRoot === null
                ? NONE
                : { status: 'repo', repoRoot: result.repoRoot, worktrees: result.worktrees },
          });
        },
        () => {
          if (active) setAnswer({ key, lookup: NONE });
        },
      );
    }, delayMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, hostId, cwd, delayMs]);
  if (key === null) return OFF;
  return answer?.key === key ? answer.lookup : LOADING;
}
