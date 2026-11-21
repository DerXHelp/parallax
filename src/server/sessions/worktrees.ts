/**
 * Worktrees of sessions (WP-111; ADR-250, ADR-251, ADR-253) – the session side of the git service:
 *
 * - `session.create` with `worktree` (`createSessionWorktree`, before the entry exists – a refusal
 *   creates nothing): `new` checks git, the repository (NOT_A_GIT_REPO), the base (`baseRef`, default
 *   the current branch of the main worktree; VALIDATION_FAILED {field: 'worktree.baseRef'}), the branch
 *   (BRANCH_EXISTS) and the folder `<repoRoot>/.claude/worktrees/<branch with / → ->` (WORKTREE_EXISTS),
 *   and reserves the port block. The entry then exists at once (cwd = the worktree folder) with
 *   `worktreeSetup: creating`; `finishSessionWorktree` runs `git worktree add -b <branch> <path>
 *   <baseSha>`, keeps `.claude/worktrees/` out of the main worktree's status (`info/exclude`), copies the
 *   `.worktreeinclude` files, then the project's setup command in a terminal tab "Setup" (state `setup`;
 *   exit ≠ 0 → `failed` with the exit code). A start prompt of `session.create` waits (`heldStart`)
 *   and goes out after exit 0 – or with "Start anyway" (`session.resume`/`sendPrompt`,
 *   `releaseHeldStart`). `existing` picks a worktree of `worktree.list` (no creation, no setup).
 * - Port block (ADR-251): with `settings.projects[repoRoot].ports` the first free block of 10 from
 *   41000 up to 49990 (no other entry's `portBase`, every port free on 127.0.0.1), kept in
 *   `WorktreeRef.portBase`; an existing worktree reuses the block of an entry in the same folder.
 *   `PARALLAX_WORKTREE_PORT` reaches claude (`withWorktreePort`, compose.ts), setup/teardown and the
 *   entry's terminals (`TerminalServiceOptions.entryEnv`, compose.ts: `worktreePortEnv(portBase)`).
 * - `worktree.remove` (`removeSessionWorktree`): not while the session runs (SESSION_BUSY); open work
 *   without `force` → WORKTREE_DIRTY; the project's teardown in a tab "Teardown" (exit ≠ 0 → GIT_FAILED
 *   {op: 'teardown', exitCode}; `skipTeardown`); the entry's terminals end (they hold the folder), then
 *   `git worktree remove [--force]`, the entry keeps `worktree: null`, then `git branch -d|-D`.
 * - `engineGitCommands`: the git service's commands with the engine's entries, environments and
 *   session files (sessions/commands.ts routes the names here).
 *
 * Without project settings nothing extra happens (no ports, no setup, no teardown). Setup and teardown
 * through the relay start with `origin: 'remote'`.
 */
import { lstat } from 'node:fs/promises';
import net from 'node:net';
import type { EntryId, ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ProjectSettings, ProjectSettingsMap, WorktreeRef } from '@shared/model';
import type { PathRules } from '@shared/paths';
import { commandResultSchemas, type CommandOf, type SessionWorktreeRequest } from '@shared/protocol';
import { WORKTREE_PORT_ENV, setEnvVar, worktreePortEnv } from '../claude/env';
import type { ClaudeIntegration } from '../claude/ports';
import { createGitCommands, type GitCommand } from '../git/commands';
import * as repo from '../git/repo';
import { createGitRunner, type GitRunner } from '../git/runner';
import { HOST_PATH_RULES, fsErrorCode } from '../lib/paths';
import { guiEnvironment } from '../lib/process';
import { getEnvVar } from '../lib/windows';
import type { CommandError, CommandContext, HostCommandHandler } from '../sync/ports';
import type { TerminalOrigin } from '../terminal/ports';
import { commandError, errorPayloadOf, isExternal, type EngineCore, type EntryState } from './entryState';
import { deliverPrompt, startRuntime } from './runtime';

/** ADR-251: blocks of 10 ports, the first at 41000, the last at 49990. */
export const WORKTREE_PORTS: { readonly first: number; readonly last: number; readonly size: number } = {
  first: 41_000,
  last: 49_990,
  size: 10,
};
/** Tab titles of the project commands (TerminalScriptSpec.title). */
export const SETUP_TITLE = 'Setup';
export const TEARDOWN_TITLE = 'Teardown';
/** Longest folder name made from a branch. */
const FOLDER_NAME_CHARS = 100;

/** What the worktree functions need of the engine (CommandEngine satisfies it). */
export interface WorktreeEngine {
  readonly core: EngineCore;
  state(entryId: string): EntryState | undefined;
  readonly hostCommands: readonly HostCommandHandler[];
}

let sharedRunner: GitRunner | null = null;

/** One git runner for the engine (its cache of the resolved `git` per PATH). */
export function engineGitRunner(): GitRunner {
  sharedRunner ??= createGitRunner();
  return sharedRunner;
}

/** The server's neutral environment for git calls without an entry. */
export function hostGitEnv(): Record<string, string> {
  return guiEnvironment();
}

/** `env` with a PATH (the server's neutral one filled in when it has none – fake launches). */
function withPath(env: Record<string, string>): Record<string, string> {
  return getEnvVar(env, 'PATH') === undefined ? { ...hostGitEnv(), ...env } : env;
}

/** Origin of a project command: a window of this computer or remote access (ADR-251, WP-76 §B.13). */
export function scriptOrigin(ctx: Pick<CommandContext, 'access'>): TerminalOrigin {
  return (ctx.access ?? 'local') === 'local' ? 'local' : 'remote';
}

// ---- project settings and ports ----

/** The settings of the project `repoRoot` (exact key first, else equal by the host's rules); null = none. */
export function projectSettingsOf(
  projects: ProjectSettingsMap,
  repoRoot: string,
  rules: PathRules = HOST_PATH_RULES,
): ProjectSettings | null {
  const exact = projects[repoRoot];
  if (exact !== undefined) return exact;
  for (const [key, value] of Object.entries(projects)) if (rules.equal(key, repoRoot)) return value;
  return null;
}

/** True when nothing listens on `port` of 127.0.0.1 (a short exclusive listen). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * The first block of 10 free ports (ADR-251) whose start no entry uses; null = none left. `probe`
 * checks one port (default `portFree`).
 */
export async function allocatePortBlock(
  used: ReadonlySet<number>,
  probe: (port: number) => Promise<boolean> = portFree,
): Promise<number | null> {
  for (let base = WORKTREE_PORTS.first; base <= WORKTREE_PORTS.last; base += WORKTREE_PORTS.size) {
    if (used.has(base)) continue;
    let free = true;
    for (let port = base; port < base + WORKTREE_PORTS.size && free; port += 1) free = await probe(port);
    if (free) return base;
  }
  return null;
}

function usedPortBases(core: EngineCore): Set<number> {
  const used = new Set<number>();
  for (const entry of core.stores.registry.list()) {
    const base = entry.worktree?.portBase;
    if (base !== undefined && base !== null) used.add(base);
  }
  return used;
}

/** The folder name of a new worktree: the branch with `/` → `-`, characters a file name cannot hold → `-`. */
export function worktreeFolderName(branch: string, rules: PathRules = HOST_PATH_RULES): string {
  const name = branch
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
    .replace(/[\\/<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '')
    .slice(0, FOLDER_NAME_CHARS);
  return name !== '' && rules.nameIssue(name) === null ? name : 'worktree';
}

/**
 * The decorator of compose.ts (WP-117): every launch of an entry with a port block gets
 * `PARALLAX_WORKTREE_PORT` (SDK start and the external console; also the copy command's env).
 */
export function withWorktreePort(
  claude: ClaudeIntegration,
  portOf: (entryId: EntryId) => number | null | undefined,
  platform: NodeJS.Platform = process.platform,
): ClaudeIntegration {
  const add = (env: Record<string, string>, entryId: EntryId): Record<string, string> => {
    const port = portOf(entryId);
    if (port === null || port === undefined) return env;
    const next = { ...env };
    setEnvVar(next, WORKTREE_PORT_ENV, String(port), platform);
    return next;
  };
  return {
    get profiles() {
      return claude.profiles;
    },
    launchSpecFor: async (profileId, entryId) => {
      const spec = await claude.launchSpecFor(profileId, entryId);
      return { ...spec, env: add(spec.env, entryId) };
    },
    checkProfile: (profileId) => claude.checkProfile(profileId),
    consoleLaunchFor: async (req) => {
      const spec = await claude.consoleLaunchFor(req);
      return { ...spec, env: add(spec.env, req.entryId), explicitEnv: add(spec.explicitEnv, req.entryId) };
    },
  };
}

// ---- session.create ----

/** What `session.create` built (the entry takes `ref`); `create` = `finishSessionWorktree` still runs. */
export interface WorktreePlan {
  ref: WorktreeRef;
  create: boolean;
  project: ProjectSettings | null;
  env: Record<string, string>;
  /** Releases the reservation of path and branch (after the creation or a failure). */
  release(): void;
}

/** Paths and branches of worktrees being created (two quick creates never race for one). */
const pending = new Set<string>();

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return fsErrorCode(error) !== 'ENOENT';
  }
}

/** The env of git calls before the entry exists: a launch spec of the profile, else the server's. */
async function creationEnv(
  core: EngineCore,
  profileId: ProfileId,
  entryId: EntryId,
): Promise<Record<string, string>> {
  try {
    return withPath((await core.claude.launchSpecFor(profileId, entryId)).env);
  } catch (error) {
    core.log.debug({ err: error }, 'no launch env for the worktree – the server environment is used');
    return hostGitEnv();
  }
}

/**
 * `session.create`: HEAD of `cwd` as the diff base of a session without a worktree (ADR-253); null when
 * `cwd` is in no repository or git is missing. Never throws.
 */
export async function sessionBaseSha(
  core: EngineCore,
  cwd: string,
  profileId: ProfileId,
  entryId: EntryId,
): Promise<string | null> {
  // No folder here (a remote path, a test cwd): no launch spec, no git.
  if (HOST_PATH_RULES.issue(cwd) !== null || !(await repo.isFolder(cwd))) return null;
  try {
    const ctx: repo.GitContext = {
      runner: engineGitRunner(),
      env: await creationEnv(core, profileId, entryId),
      rules: HOST_PATH_RULES,
    };
    const root = await repo.worktreeRoot(ctx, cwd);
    return root === null ? null : await repo.headCommit(ctx, root);
  } catch (error) {
    core.log.debug({ err: error }, 'no diff base for the new session');
    return null;
  }
}

/** Checks and reserves the worktree of a new session (see the file comment). Throws CommandError. */
export async function createSessionWorktree(
  core: EngineCore,
  cwd: string,
  request: SessionWorktreeRequest,
  ids: { profileId: ProfileId; entryId: EntryId },
): Promise<WorktreePlan> {
  const rules = HOST_PATH_RULES;
  const env = await creationEnv(core, ids.profileId, ids.entryId);
  const ctx: repo.GitContext = { runner: engineGitRunner(), env, rules };
  const listed = await repo.listWorktrees(ctx, cwd);
  const repoRoot = listed.repoRoot;
  if (repoRoot === null) throw commandError('NOT_A_GIT_REPO', { path: cwd });
  const project = projectSettingsOf(core.stores.settings.get().projects, repoRoot, rules);
  const now = core.now().toISOString();
  const defaultBase = async (): Promise<string> => (await repo.currentBranch(ctx, repoRoot)) ?? 'HEAD';

  if (request.mode === 'existing') {
    const target = listed.worktrees.find((w) => rules.equal(w.path, request.path));
    if (target === undefined)
      throw commandError('VALIDATION_FAILED', { field: 'worktree.path', reason: 'not_a_worktree' });
    if (target.main)
      throw commandError('VALIDATION_FAILED', { field: 'worktree.path', reason: 'main_worktree' });
    if (target.branch === null)
      throw commandError('VALIDATION_FAILED', { field: 'worktree.path', reason: 'detached' });
    const baseRef = await defaultBase();
    const baseSha = (await repo.resolveCommit(ctx, repoRoot, baseRef)) ?? target.head;
    if (baseSha === null)
      throw commandError('VALIDATION_FAILED', { field: 'worktree.baseRef', reason: 'not_found' });
    const shared = core.stores.registry
      .list()
      .find((e) => typeof e.worktree?.portBase === 'number' && rules.equal(e.worktree.path, request.path));
    const portBase =
      shared?.worktree?.portBase ??
      (project?.ports === true ? await allocatePortBlock(usedPortBases(core)) : null);
    return {
      ref: {
        repoRoot,
        path: request.path,
        branch: target.branch,
        baseRef,
        baseSha,
        portBase,
        createdAt: now,
      },
      create: false,
      project,
      env,
      release: () => undefined,
    };
  }

  const baseRef = request.baseRef ?? (await defaultBase());
  const baseSha = await repo.resolveCommit(ctx, repoRoot, baseRef);
  if (baseSha === null)
    throw commandError('VALIDATION_FAILED', { field: 'worktree.baseRef', reason: 'not_found' });
  const branchKey = `${rules.key(repoRoot)}\0${request.branch}`;
  if (pending.has(branchKey) || (await repo.branchExists(ctx, repoRoot, request.branch))) {
    throw commandError('BRANCH_EXISTS', { branch: request.branch });
  }
  const path = rules.join(
    rules.join(rules.join(repoRoot, repo.WORKTREES_DIR[0]), repo.WORKTREES_DIR[1]),
    worktreeFolderName(request.branch, rules),
  );
  if (rules.issue(path) !== null)
    throw commandError('VALIDATION_FAILED', { field: 'worktree.branch', reason: 'path' });
  const pathKey = rules.key(path);
  if (
    pending.has(pathKey) ||
    (await exists(path)) ||
    listed.worktrees.some((w) => rules.equal(w.path, path))
  ) {
    throw commandError('WORKTREE_EXISTS', { path });
  }
  const portBase = project?.ports === true ? await allocatePortBlock(usedPortBases(core)) : null;
  if (project?.ports === true && portBase === null) core.log.warn('no free port block for the new worktree');
  // Checked again after the awaits: another create may have taken them meanwhile.
  if (pending.has(branchKey)) throw commandError('BRANCH_EXISTS', { branch: request.branch });
  if (pending.has(pathKey)) throw commandError('WORKTREE_EXISTS', { path });
  pending.add(branchKey);
  pending.add(pathKey);
  return {
    ref: { repoRoot, path, branch: request.branch, baseRef, baseSha, portBase, createdAt: now },
    create: true,
    project,
    env,
    release: () => {
      pending.delete(branchKey);
      pending.delete(pathKey);
    },
  };
}

/** The setup ended unsuccessfully: state `failed`, the reason as a system row of the session. */
function failSetup(
  s: EntryState,
  exitCode: number | null,
  terminalId: string | null,
  error: ErrorPayload | null,
): void {
  s.setWorktreeSetup({ state: 'failed', exitCode, terminalId });
  if (error !== null) s.addSystemError(error);
}

/**
 * The asynchronous part of a new worktree (see the file comment). Never throws; the outcome shows in
 * `worktreeSetup` (and a system row on a failure).
 */
export async function finishSessionWorktree(
  core: EngineCore,
  s: EntryState,
  plan: WorktreePlan,
  origin: TerminalOrigin,
): Promise<void> {
  const { ref } = plan;
  const ctx: repo.GitContext = { runner: engineGitRunner(), env: plan.env, rules: HOST_PATH_RULES };
  try {
    s.setWorktreeSetup({ state: 'creating', exitCode: null, terminalId: null });
    try {
      await repo.addWorktree(ctx, ref.repoRoot, ref.path, ref.branch, ref.baseSha);
    } catch (error) {
      core.log.warn({ err: error, entryId: s.id }, 'git worktree add failed');
      failSetup(s, null, null, errorPayloadOf(error, makeError('GIT_FAILED', { op: 'worktree_add' })));
      return;
    } finally {
      plan.release();
    }
    try {
      await repo.ensureExcluded(ctx, ref.repoRoot, repo.WORKTREES_DIR.join('/'));
    } catch (error) {
      core.log.warn({ err: error, entryId: s.id }, 'worktree folder could not be excluded');
    }
    try {
      const included = await repo.copyWorktreeInclude(ctx, ref.repoRoot, ref.path);
      if (included.copied > 0 || included.limited)
        core.log.info({ entryId: s.id, ...included }, 'worktree include files copied');
    } catch (error) {
      core.log.warn({ err: error, entryId: s.id }, 'worktree include files not copied');
    }
    core.log.info({ entryId: s.id, portBase: ref.portBase }, 'worktree created');
    void s.refreshGitBranch();
    if (s.removed) return;
    await runSetup(core, s, plan.project, ref, origin);
  } catch (error) {
    core.reportError(error, 'worktree setup');
    failSetup(s, null, null, null);
  }
}

async function runSetup(
  core: EngineCore,
  s: EntryState,
  project: ProjectSettings | null,
  ref: WorktreeRef,
  origin: TerminalOrigin,
): Promise<void> {
  const command = project?.setup ?? '';
  if (project === null || command.trim() === '') {
    await releaseHeldStart(core, s);
    return;
  }
  const runScript = core.terminal?.runScript;
  if (runScript === undefined) {
    failSetup(s, null, null, makeError('TERMINAL_UNAVAILABLE', { reason: 'none' }));
    return;
  }
  const shell = project.shell ?? core.stores.settings.get().console.defaultShell;
  const started = await runScript(
    s.id,
    { title: SETUP_TITLE, shell, command, env: worktreePortEnv(ref.portBase) },
    origin,
  );
  if (started.kind === 'failed') {
    failSetup(s, null, null, started.error);
    return;
  }
  s.setWorktreeSetup({ state: 'setup', exitCode: null, terminalId: started.terminalId });
  const code = await started.exit;
  if (s.removed || s.worktreeSetup?.state !== 'setup') return;
  if (code === 0) {
    core.log.info({ entryId: s.id }, 'worktree setup done');
    await releaseHeldStart(core, s);
    return;
  }
  core.log.info({ entryId: s.id, exitCode: code }, 'worktree setup failed');
  failSetup(s, code, started.terminalId, null);
}

/** True while the worktree is created or its setup runs (start commands answer SESSION_BUSY). */
export function setupRunning(s: EntryState): boolean {
  const state = s.worktreeSetup?.state;
  return state === 'creating' || state === 'setup';
}

/**
 * The setup is done (or "Start anyway"): the state goes, a held start prompt starts the session and
 * goes out. Returns its message uuid (null = none held, or the start failed – shown on the entry).
 */
export async function releaseHeldStart(core: EngineCore, s: EntryState): Promise<string | null> {
  s.setWorktreeSetup(null);
  const held = s.heldStart;
  s.heldStart = null;
  if (held === null) return null;
  try {
    return await s.lifecycle.run(async () => {
      if (s.removed || s.entry.archived || isExternal(s)) return null;
      if (s.runtime === null) await startRuntime(s, core, { byClientId: held.clientId });
      return deliverPrompt(s, core, held.text, 'next', {
        attachments: held.attachments,
        pastes: held.pastes,
      });
    });
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, 'held start prompt could not be sent');
    return null;
  }
}

// ---- worktree.remove ----

async function runTeardown(
  core: EngineCore,
  s: EntryState,
  ref: WorktreeRef,
  origin: TerminalOrigin,
): Promise<void> {
  const project = projectSettingsOf(core.stores.settings.get().projects, ref.repoRoot);
  const command = project?.teardown ?? '';
  if (project === null || command.trim() === '' || !(await repo.isFolder(ref.path))) return;
  const runScript = core.terminal?.runScript;
  if (runScript === undefined) {
    throw commandError('GIT_FAILED', { op: 'teardown', detail: 'TERMINAL_UNAVAILABLE' });
  }
  const shell = project.shell ?? core.stores.settings.get().console.defaultShell;
  const started = await runScript(
    s.id,
    { title: TEARDOWN_TITLE, shell, command, env: worktreePortEnv(ref.portBase) },
    origin,
  );
  if (started.kind === 'failed')
    throw commandError('GIT_FAILED', { op: 'teardown', detail: started.error.code });
  const code = await started.exit;
  if (code !== 0) {
    throw commandError('GIT_FAILED', { op: 'teardown', ...(code === null ? {} : { exitCode: code }) });
  }
}

/** `worktree.remove` (see the file comment). */
export async function removeSessionWorktree(
  engine: WorktreeEngine,
  cmd: CommandOf<'worktree.remove'>,
  context: Pick<CommandContext, 'access'>,
): Promise<void> {
  const core = engine.core;
  const s = engine.state(cmd.entryId);
  if (s === undefined || s.removed) throw commandError('ENTRY_NOT_FOUND', { entryId: cmd.entryId });
  if (s.entry.worktree === null)
    throw commandError('VALIDATION_FAILED', { field: 'worktree', reason: 'none' });
  if (setupRunning(s)) throw commandError('SESSION_BUSY', { entryId: s.id });
  s.cancelRetry();
  await s.lifecycle.run(async () => {
    const ref = s.entry.worktree;
    if (s.removed) throw commandError('ENTRY_NOT_FOUND', { entryId: s.id });
    if (ref === null) return;
    if (s.runtime !== null || s.phase !== 'dormant' || isExternal(s) || setupRunning(s)) {
      throw commandError('SESSION_BUSY', { entryId: s.id });
    }
    const ctx: repo.GitContext = { runner: engineGitRunner(), env: await s.gitEnv(), rules: HOST_PATH_RULES };
    const inspection = await repo.inspectWorktree(ctx, ref.path, ref.repoRoot, ref.branch, {
      ref: ref.baseRef,
      sha: ref.baseSha,
    });
    const losing = inspection.dirtyFiles > 0 || (cmd.deleteBranch && inspection.unpushedCommits > 0);
    if (losing && !cmd.force) {
      throw commandError('WORKTREE_DIRTY', {
        dirtyFiles: inspection.dirtyFiles,
        unpushedCommits: inspection.unpushedCommits,
      });
    }
    if (!cmd.skipTeardown) await runTeardown(core, s, ref, scriptOrigin(context));
    // The entry's shells hold the folder (Windows refuses to delete it); the HEAD watch too.
    core.terminal?.closeEntry?.(s.id, 'removed');
    s.stopHeadWatch();
    await repo.removeWorktree(ctx, ref.repoRoot, ref.path, cmd.force);
    s.patch((e) => ({ ...e, worktree: null }));
    s.setWorktreeSetup(null);
    s.heldStart = null;
    core.log.info({ entryId: s.id, deleteBranch: cmd.deleteBranch, force: cmd.force }, 'worktree removed');
    if (cmd.deleteBranch) {
      // Nothing unpushed: `-D` (the branch may live on a remote only, `-d` would refuse it).
      await repo.deleteBranch(ctx, ref.repoRoot, ref.branch, cmd.force || inspection.unpushedCommits === 0);
    }
  });
  void s.refreshGitBranch();
}

// ---- the git commands with the engine ----

/** `files.session` of the file service (zod at the boundary); null = no handler or a failure. */
async function sessionFilesOf(
  engine: WorktreeEngine,
  entryId: EntryId,
  ctx: CommandContext,
): Promise<string[] | null> {
  const handler = engine.hostCommands.find((h) => h.names.includes('files.session'));
  if (handler === undefined) return null;
  try {
    const raw = await handler.handle({ name: 'files.session', entryId }, ctx);
    const parsed = commandResultSchemas['files.session'].safeParse(raw);
    return parsed.success ? parsed.data.files.map((f) => f.path) : null;
  } catch (error) {
    engine.core.log.debug({ err: error, entryId }, 'session files unavailable for the diff');
    return null;
  }
}

const handlers = new WeakMap<WorktreeEngine, HostCommandHandler>();

/** The git commands of `engine` (built once per engine). */
export function engineGitCommands(engine: WorktreeEngine): HostCommandHandler {
  let handler = handlers.get(engine);
  if (handler !== undefined) return handler;
  const live = (entryId: EntryId): EntryState | null => {
    const s = engine.state(entryId);
    return s === undefined || s.removed ? null : s;
  };
  handler = createGitCommands({
    runner: engineGitRunner(),
    entry: (entryId) => {
      const s = live(entryId);
      return s === null ? null : { cwd: s.entry.cwd, worktree: s.entry.worktree, baseSha: s.entry.baseSha };
    },
    env: async (entryId) => (await live(entryId)?.gitEnv()) ?? hostGitEnv(),
    hostEnv: hostGitEnv,
    sessionFiles: (entryId, ctx) => sessionFilesOf(engine, entryId, ctx),
    setBaseSha: (entryId, sha) => {
      live(entryId)?.patch((e) => (e.baseSha === null ? { ...e, baseSha: sha } : e));
    },
    headChanged: (entryId) => {
      void live(entryId)?.refreshGitBranch();
    },
    removeWorktree: (cmd, ctx) => removeSessionWorktree(engine, cmd, ctx),
  });
  handlers.set(engine, handler);
  return handler;
}

/** Routes one git/worktree command of the engine (sessions/commands.ts). */
export function handleGitCommand(
  engine: WorktreeEngine,
  cmd: GitCommand,
  ctx: CommandContext,
): Promise<unknown> {
  return engineGitCommands(engine).handle(cmd, ctx);
}

/** The error a start command gets while the worktree is created or set up. */
export function setupBusy(s: EntryState): CommandError {
  return commandError('SESSION_BUSY', { entryId: s.id, reason: 'worktree_setup' });
}
