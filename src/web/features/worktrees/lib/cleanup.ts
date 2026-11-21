import { gitFailedParamsSchema, worktreeDirtyParamsSchema, type ErrorPayload } from '@shared/errors';
import { liveWorktree, type SessionSummary, type WorktreeInspection } from '@shared/model';
import type { RunState } from '@shared/status';
import { selectSummary } from '@web/state/hooks';
import { selectSessionFeature } from '@web/state/hosts';
import type { ClientState } from '@web/state/store';

/**
 * Pure rules of the worktree cleanup (WP-114, ADR-250): which sessions get the dialog, the option
 * chosen first, what an option would lose, and the two refusals the dialog answers with "Delete
 * anyway" (open work → `force`, a failed teardown → `skipTeardown`).
 */

export const CLEANUP_OPTIONS = ['keep', 'worktree', 'all'] as const;
/** `keep` = nothing happens to the worktree; `worktree` = delete it, keep its branch; `all` = both. */
export type CleanupOption = (typeof CLEANUP_OPTIONS)[number];

export function isCleanupOption(value: string): value is CleanupOption {
  return CLEANUP_OPTIONS.some((option) => option === value);
}

/**
 * The request `worktree.cleanup` is taken for a session with a worktree on a host with the git service
 * (WP-117 CR5: not once the worktree was removed – the record stays for the project only).
 */
export function wantsCleanup(state: ClientState, sessionKey: string): boolean {
  const summary = selectSummary(state, sessionKey);
  if (liveWorktree(summary?.worktree) === null) return false;
  return selectSessionFeature(state, sessionKey, 'git');
}

export function hasOpenWork(inspection: WorktreeInspection): boolean {
  return inspection.dirtyFiles > 0 || inspection.unpushedCommits > 0;
}

/**
 * The option selected first: keep while something is open (or still unknown); a clean worktree is
 * deleted – with its branch when that is merged into the base, else the branch stays.
 */
export function defaultCleanupOption(inspection: WorktreeInspection | null): CleanupOption {
  if (inspection === null || hasOpenWork(inspection)) return 'keep';
  return inspection.branchMerged ? 'all' : 'worktree';
}

export interface WorkLoss {
  files: number;
  commits: number;
}

/** What `option` would discard: uncommitted files, and with the branch its commits found nowhere else. */
export function workLost(option: CleanupOption, inspection: WorktreeInspection | null): WorkLoss {
  if (option === 'keep' || inspection === null) return { files: 0, commits: 0 };
  return { files: inspection.dirtyFiles, commits: option === 'all' ? inspection.unpushedCommits : 0 };
}

export function losesWork(loss: WorkLoss): boolean {
  return loss.files > 0 || loss.commits > 0;
}

/** WORKTREE_DIRTY: the open work the server found (params read tolerantly); null = another error. */
export function dirtyWork(error: ErrorPayload): WorkLoss | null {
  if (error.code !== 'WORKTREE_DIRTY') return null;
  const parsed = worktreeDirtyParamsSchema.safeParse(error.params);
  return parsed.success
    ? { files: parsed.data.dirtyFiles, commits: parsed.data.unpushedCommits }
    : { files: 0, commits: 0 };
}

/** GIT_FAILED {op: 'teardown'}: the teardown's exit code (null = stopped/unknown); undefined = another error. */
export function teardownExit(error: ErrorPayload): number | null | undefined {
  if (error.code !== 'GIT_FAILED') return undefined;
  const parsed = gitFailedParamsSchema.safeParse(error.params);
  if (!parsed.success || parsed.data.op !== 'teardown') return undefined;
  return parsed.data.exitCode ?? null;
}

/** Run states with a Claude process the server must close before `worktree.remove` (SESSION_BUSY otherwise). */
const WITHOUT_PROCESS: ReadonlySet<RunState> = new Set<RunState>(['sleeping', 'external']);

/** `session.close` first: an active, not archived session (archived ones have no process). */
export function needsClose(summary: Pick<SessionSummary, 'archived' | 'status'> | null): boolean {
  return summary !== null && !summary.archived && !WITHOUT_PROCESS.has(summary.status.runState);
}
