/**
 * Git service commands (WP-110 scaffolding; WP-111 fills it, ADR-250, ADR-252, ADR-253): `git.status`,
 * `git.diff`, `git.fileDiff`, `git.commit`, `git.branchCreate`, `git.branchSwitch`, `git.push`,
 * `worktree.list`, `worktree.inspect`, `worktree.remove`. Host-routed (no lifecycle gate: archived and
 * external entries can be read); the handler answers ENTRY_NOT_FOUND itself.
 *
 * Stub until WP-111: every command answers NOT_IMPLEMENTED.
 */
import { makeError } from '@shared/errors';
import type { HostCommandName } from '@shared/protocol';
import { CommandError, type HostCommandHandler } from '../sync/ports';

export const GIT_COMMAND_NAMES = [
  'git.status',
  'git.diff',
  'git.fileDiff',
  'git.commit',
  'git.branchCreate',
  'git.branchSwitch',
  'git.push',
  'worktree.list',
  'worktree.inspect',
  'worktree.remove',
] as const satisfies readonly HostCommandName[];

export function createGitCommands(): HostCommandHandler {
  return {
    names: GIT_COMMAND_NAMES,
    handle: (cmd) => Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }))),
  };
}
