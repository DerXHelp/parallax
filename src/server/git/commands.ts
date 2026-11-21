/**
 * Git service commands (WP-111; ADR-250, ADR-252, ADR-253): `git.status`, `git.diff`, `git.fileDiff`,
 * `git.commit`, `git.branchCreate`, `git.branchSwitch`, `git.push`, `worktree.list`, `worktree.inspect`,
 * `worktree.remove`. Host-routed (no lifecycle gate: archived and external entries can be read); the
 * handler answers ENTRY_NOT_FOUND itself. Every git call goes through `runner.ts` (absolute `git` on the
 * session's PATH, argument arrays, reads hardened) and `repo.ts`.
 *
 * - Every command of an entry runs in its `cwd` (a worktree session: the worktree folder) with the
 *   session's environment (`GitCommandDeps.env`).
 * - Diff base (ADR-253): `session` = the merge base of `worktree.baseRef` and `HEAD` (worktree
 *   sessions; `worktree.baseSha` when it cannot be computed), else `Entry.baseSha` (HEAD at
 *   `session.create`); an entry from before WP-111 without one takes the current HEAD once and keeps it
 *   (`setBaseSha`). No commit yet → the empty tree. `onlySessionFiles` keeps the files of
 *   `files.session` (`sessionFiles`; unknown → no filter).
 * - After a commit or a branch change `headChanged` refreshes `Entry.gitBranch` at once.
 * - `worktree.remove` needs the session engine (busy check, teardown, terminals, the entry) –
 *   `removeWorktree` of the deps (sessions/worktrees.ts).
 *
 * Wiring: the session engine routes these names here itself (sessions/commands.ts → sessions/worktrees.ts
 * `engineGitCommands`). `createGitCommands()` without deps (the scaffolding's call in compose.ts) answers
 * NOT_IMPLEMENTED and is never reached – WP-117 drops it from `hostCommands`.
 */
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { WorktreeRef } from '@shared/model';
import type { PathRules } from '@shared/paths';
import type { CommandOf, CommandResult, HostCommand, HostCommandName } from '@shared/protocol';
import { HOST_PATH_RULES } from '../lib/paths';
import { CommandError, type CommandContext, type HostCommandHandler } from '../sync/ports';
import {
  absoluteIn,
  commit,
  createBranch,
  diffList,
  fileDiff,
  headCommit,
  inspectWorktree,
  listWorktrees,
  mergeBase,
  push,
  readStatus,
  requireRoot,
  resolveCommit,
  switchBranch,
  type DiffSpec,
  type GitContext,
} from './repo';
import type { GitRunner } from './runner';

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

export type GitCommandName = (typeof GIT_COMMAND_NAMES)[number];
export type GitCommand = Extract<HostCommand, { name: GitCommandName }>;

const NAMES: ReadonlySet<string> = new Set(GIT_COMMAND_NAMES);

export function isGitCommand(cmd: HostCommand): cmd is GitCommand {
  return NAMES.has(cmd.name);
}

/** What the git commands need to know about an entry. */
export interface GitEntry {
  /** Exactly as stored (a worktree session: the worktree folder). */
  cwd: string;
  worktree: WorktreeRef | null;
  baseSha: string | null;
}

export interface GitCommandDeps {
  runner: GitRunner;
  /** Default: the host's rules. */
  rules?: PathRules;
  /** null = unknown entry (ENTRY_NOT_FOUND). */
  entry(entryId: EntryId): GitEntry | null;
  /** The session's environment (PATH decides which `git` runs). */
  env(entryId: EntryId): Promise<Record<string, string>>;
  /** Environment of calls without an entry (`worktree.list`). */
  hostEnv(): Record<string, string>;
  /** Absolute paths of the files the session touched; null = unknown (no filter). */
  sessionFiles(entryId: EntryId, ctx: CommandContext): Promise<string[] | null>;
  /** An entry from before WP-111 got its diff base (kept from now on). */
  setBaseSha(entryId: EntryId, sha: string): void;
  /** A commit or branch change happened in the entry's folder. */
  headChanged(entryId: EntryId): void;
  /** `worktree.remove` with the engine's checks (busy, teardown, terminals, the entry). */
  removeWorktree(cmd: CommandOf<'worktree.remove'>, ctx: CommandContext): Promise<void>;
}

function notImplemented(name: string): CommandError {
  return new CommandError(makeError('NOT_IMPLEMENTED', { command: name }));
}

/**
 * The commit a `session` diff starts at (see the file comment); null = no commit yet (empty tree).
 * Exported for the engine's tests.
 */
export async function sessionDiffBase(
  ctx: GitContext,
  entry: GitEntry,
  remember: (sha: string) => void,
): Promise<string | null> {
  const cwd = entry.cwd;
  if (entry.worktree !== null) {
    const base = await resolveCommit(ctx, cwd, entry.worktree.baseRef);
    const merged = base === null ? null : await mergeBase(ctx, cwd, base, 'HEAD');
    if (merged !== null) return merged;
    return (await resolveCommit(ctx, cwd, entry.worktree.baseSha)) ?? (await headCommit(ctx, cwd));
  }
  if (entry.baseSha !== null) {
    const known = await resolveCommit(ctx, cwd, entry.baseSha);
    // A base that is gone (history rewritten, another repository): the current HEAD, not stored.
    if (known !== null) return known;
    return headCommit(ctx, cwd);
  }
  const head = await headCommit(ctx, cwd);
  if (head !== null) remember(head);
  return head;
}

export function createGitCommands(deps?: GitCommandDeps): HostCommandHandler {
  if (deps === undefined) {
    return {
      names: GIT_COMMAND_NAMES,
      handle: (cmd) => Promise.reject(notImplemented(cmd.name)),
    };
  }
  const rules = deps.rules ?? HOST_PATH_RULES;

  const entryOf = (entryId: EntryId): GitEntry => {
    const entry = deps.entry(entryId);
    if (entry === null) throw new CommandError(makeError('ENTRY_NOT_FOUND', { entryId }));
    return entry;
  };

  const contextOf = async (entryId: EntryId): Promise<{ entry: GitEntry; ctx: GitContext }> => {
    const entry = entryOf(entryId);
    return { entry, ctx: { runner: deps.runner, env: await deps.env(entryId), rules } };
  };

  const specOf = async (
    entryId: EntryId,
    entry: GitEntry,
    ctx: GitContext,
    scope: DiffSpec['scope'],
  ): Promise<DiffSpec> => {
    if (scope !== 'session') return { scope, base: null };
    return {
      scope,
      base: await sessionDiffBase(ctx, entry, (sha) => {
        deps.setBaseSha(entryId, sha);
      }),
    };
  };

  /** Keeps the files the session touched (absolute paths compared by the host's rules). */
  const sessionFilter = async (
    entryId: EntryId,
    root: string,
    context: CommandContext,
  ): Promise<((path: string, origPath: string | null) => boolean) | null> => {
    const files = await deps.sessionFiles(entryId, context);
    if (files === null) return null;
    const keys = new Set(files.map((file) => rules.key(file)));
    const touched = (rel: string | null): boolean => {
      if (rel === null) return false;
      const full = absoluteIn(root, rel, rules);
      return full !== null && keys.has(rules.key(full));
    };
    return (path, origPath) => touched(path) || touched(origPath);
  };

  const handle = async (cmd: GitCommand, context: CommandContext): Promise<unknown> => {
    switch (cmd.name) {
      case 'git.status': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        return { status: await readStatus(ctx, entry.cwd) } satisfies CommandResult<'git.status'>;
      }
      case 'git.diff': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        const root = await requireRoot(ctx, entry.cwd);
        const spec = await specOf(cmd.entryId, entry, ctx, cmd.scope);
        const keep = cmd.onlySessionFiles ? await sessionFilter(cmd.entryId, root, context) : null;
        const list = await diffList(ctx, root, spec, keep);
        return {
          root: list.root,
          base: spec.base,
          files: list.files,
          truncated: list.truncated,
        } satisfies CommandResult<'git.diff'>;
      }
      case 'git.fileDiff': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        const spec = await specOf(cmd.entryId, entry, ctx, cmd.scope);
        return {
          file: await fileDiff(ctx, entry.cwd, spec, cmd.path),
        } satisfies CommandResult<'git.fileDiff'>;
      }
      case 'git.commit': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        const sha = await commit(ctx, entry.cwd, cmd.message, cmd.paths ?? null);
        deps.headChanged(cmd.entryId);
        return { sha } satisfies CommandResult<'git.commit'>;
      }
      case 'git.branchCreate': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        await createBranch(ctx, entry.cwd, cmd.branch, cmd.switch);
        if (cmd.switch) deps.headChanged(cmd.entryId);
        return {} satisfies CommandResult<'git.branchCreate'>;
      }
      case 'git.branchSwitch': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        await switchBranch(ctx, entry.cwd, cmd.branch);
        deps.headChanged(cmd.entryId);
        return {} satisfies CommandResult<'git.branchSwitch'>;
      }
      case 'git.push': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        await push(ctx, entry.cwd);
        return {} satisfies CommandResult<'git.push'>;
      }
      case 'worktree.list': {
        const ctx: GitContext = { runner: deps.runner, env: deps.hostEnv(), rules };
        return (await listWorktrees(ctx, cmd.cwd)) satisfies CommandResult<'worktree.list'>;
      }
      case 'worktree.inspect': {
        const { entry, ctx } = await contextOf(cmd.entryId);
        const worktree = entry.worktree;
        if (worktree === null) {
          throw new CommandError(makeError('VALIDATION_FAILED', { field: 'worktree', reason: 'none' }));
        }
        return (await inspectWorktree(ctx, worktree.path, worktree.repoRoot, worktree.branch, {
          ref: worktree.baseRef,
          sha: worktree.baseSha,
        })) satisfies CommandResult<'worktree.inspect'>;
      }
      case 'worktree.remove':
        entryOf(cmd.entryId);
        await deps.removeWorktree(cmd, context);
        return {} satisfies CommandResult<'worktree.remove'>;
    }
  };

  return {
    names: GIT_COMMAND_NAMES,
    handle: (cmd, context) => {
      if (!isGitCommand(cmd)) return Promise.reject(notImplemented(cmd.name));
      return handle(cmd, context);
    },
  };
}
