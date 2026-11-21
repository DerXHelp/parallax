/**
 * Worktree of a new session (WP-110 scaffolding; WP-111 fills it, ADR-250, ADR-251):
 * `session.create` with `worktree` creates `<repo>/.claude/worktrees/<name>` on a new branch (or picks
 * an existing worktree), copies `.worktreeinclude` files, reserves the port block and runs the
 * project's setup command in a terminal tab; the session then runs with `cwd` = the worktree folder.
 *
 * Stub until WP-111: `session.create` with `worktree` answers NOT_IMPLEMENTED before anything is
 * created (commands.ts calls this before the entry exists).
 */
import type { WorktreeRef } from '@shared/model';
import type { SessionWorktreeRequest } from '@shared/protocol';
import { commandError, type EngineCore } from './entryState';

export function createSessionWorktree(
  _core: EngineCore,
  _cwd: string,
  request: SessionWorktreeRequest,
): Promise<WorktreeRef> {
  return Promise.reject(
    commandError('NOT_IMPLEMENTED', { command: `session.create.worktree.${request.mode}` }),
  );
}
