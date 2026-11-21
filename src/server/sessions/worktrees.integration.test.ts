/**
 * WP-111 (ADR-250 … ADR-254) – the git service through the real engine (FakeBackend, memory stores)
 * on real git repositories below the test home: the diff base of `session.create`, `git.*` of an
 * entry, review comments with their ops, `session.create` with a new worktree (asynchronous creation,
 * port block, setup in a fake terminal, the held start prompt, "Start anyway"), and `worktree.remove`
 * (busy, dirty, teardown, branch).
 */
import { access, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  SAMPLE_TIME,
  sampleEntry,
  sampleId,
  sampleProjectSettings,
  sampleSessionFile,
} from '@shared/samples';
import type { SessionOp } from '@shared/protocol';
import type { TerminalScriptSpec } from '../terminal/ports';
import { headCommit } from '../git/repo';
import { createTestRepo, type TestRepo } from '../git/testRepo';
import { makeTempHome } from '../http/testServer';
import type { ClientPresence, HostCommandHandler } from '../sync/ports';
import type { EngineTerminal } from './entryState';
import { gitHeadWatchCount } from './lib/gitBranch';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';
import { WORKTREE_PORTS } from './worktrees';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

interface ScriptRun {
  entryId: EntryId;
  spec: TerminalScriptSpec;
  origin: string | undefined;
  finish(code: number | null): void;
}

/** An engine terminal whose scripts end when the test says so. */
function scriptTerminal() {
  const runs: ScriptRun[] = [];
  const closed: EntryId[] = [];
  let next = 1;
  const terminal: EngineTerminal = {
    openClaude: () => Promise.resolve({ kind: 'failed', error: makeError('NOT_IMPLEMENTED') }),
    claudeState: () => 'ended',
    remoteEpoch: () => 0,
    runScript: (entryId, spec, origin) => {
      let finish: (code: number | null) => void = () => undefined;
      const exit = new Promise<number | null>((resolve) => {
        finish = resolve;
      });
      runs.push({
        entryId,
        spec,
        origin,
        finish: (code) => {
          finish(code);
        },
      });
      const terminalId = `tm_${(next++).toString(16).padStart(32, '0')}`;
      return Promise.resolve({ kind: 'started', terminalId, exit });
    },
    closeEntry: (entryId) => {
      closed.push(entryId);
    },
  };
  return { terminal, runs, closed };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function useProject(h: EngineHarness, repo: TestRepo, p: Parameters<typeof sampleProjectSettings>[0]) {
  await h.cmd({ name: 'settings.update', patch: { projects: { [repo.root]: sampleProjectSettings(p) } } });
}

describe('git commands of an entry (WP-111)', () => {
  it('session.create records HEAD as the diff base; git.status, git.diff, git.fileDiff, git.commit', async () => {
    const repo = await createTestRepo();
    const head = await headCommit(repo.ctx, repo.root);
    const h = await setup();
    const entryId = await h.create(null, { cwd: repo.root });
    expect(h.stores.registry.get(entryId)?.baseSha).toBe(head);

    await repo.write('README.md', 'hello\nmore\n');
    await repo.commitAll('second');
    await repo.write('notes.txt', 'n1\nn2\n');
    const status = await h.cmd({ name: 'git.status', entryId });
    expect(status.status).toMatchObject({ isRepo: true, root: repo.root, branch: 'main' });
    expect(status.status.files.map((f) => [f.path, f.kind])).toEqual([['notes.txt', 'untracked']]);

    const session = await h.cmd({ name: 'git.diff', entryId, scope: 'session' });
    expect(session.base).toBe(head);
    expect(session.files.map((f) => [f.path, f.kind, f.additions]).sort()).toEqual([
      ['README.md', 'modified', 1],
      ['notes.txt', 'added', 2],
    ]);
    const uncommitted = await h.cmd({ name: 'git.diff', entryId, scope: 'uncommitted' });
    expect(uncommitted.base).toBeNull();
    expect(uncommitted.files.map((f) => f.path)).toEqual(['notes.txt']);
    const file = await h.cmd({ name: 'git.fileDiff', entryId, scope: 'session', path: 'README.md' });
    expect(file.file.patch).toContain('+more');

    const committed = await h.cmd({ name: 'git.commit', entryId, message: 'notes' });
    expect(committed.sha).toBe(await headCommit(repo.ctx, repo.root));
    expect((await h.cmd({ name: 'git.status', entryId })).status.files).toEqual([]);
    expect(
      await h.cmdError({ name: 'git.status', entryId: 'en_0000000000000000000000000000ffff' }),
    ).toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
  });

  it('an entry from before WP-111 takes the current HEAD once; onlySessionFiles filters by files.session', async () => {
    const repo = await createTestRepo();
    const old = sampleEntry({ cwd: repo.root, baseSha: null, worktree: null });
    const sessionFiles: HostCommandHandler = {
      names: ['files.session'],
      handle: () =>
        Promise.resolve({
          files: [sampleSessionFile({ path: path.join(repo.root, 'a.txt') })],
          truncated: false,
        }),
    };
    const h = await setup({ seed: { entries: [old] }, hostCommands: [sessionFiles] });
    const head = await headCommit(repo.ctx, repo.root);
    await repo.write('a.txt', 'a\n');
    await repo.write('b.txt', 'b\n');
    const all = await h.cmd({ name: 'git.diff', entryId: old.id, scope: 'session' });
    expect(all.base).toBe(head);
    expect(h.stores.registry.get(old.id)?.baseSha).toBe(head);
    expect(all.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    const only = await h.cmd({ name: 'git.diff', entryId: old.id, scope: 'session', onlySessionFiles: true });
    expect(only.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('worktree.list of a folder; NOT_A_GIT_REPO for an entry outside a repository', async () => {
    const repo = await createTestRepo();
    const h = await setup();
    expect(await h.cmd({ name: 'worktree.list', cwd: repo.root })).toEqual({
      repoRoot: repo.root,
      worktrees: [expect.objectContaining({ path: repo.root, branch: 'main', main: true })],
    });
    const entryId = await h.create(null);
    expect((await h.cmdError({ name: 'git.diff', entryId, scope: 'session' })).code).toBe('NOT_A_GIT_REPO');
    expect((await h.cmd({ name: 'git.status', entryId })).status.isRepo).toBe(false);
  });
});

describe('review comments (WP-111, ADR-254)', () => {
  it('add, update, markSent, remove: ops, the loaded view, limits', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const anchor = { path: 'src/a.ts', side: 'new' as const, line: 3, endLine: 4, quote: 'x\ny' };
    const added = await h.cmd({ name: 'review.add', entryId, ...anchor, text: 'Rename this' });
    expect(added.comment).toMatchObject({ ...anchor, text: 'Rename this', state: 'open', sentAt: null });
    expect(added.comment.id).toMatch(/^rc_[0-9a-f]{32}$/);
    const updated = await h.cmd({
      name: 'review.update',
      entryId,
      commentId: added.comment.id,
      state: 'stale',
    });
    expect(updated.comment.state).toBe('stale');
    await h.cmd({ name: 'review.markSent', entryId, commentIds: [added.comment.id] });
    const view = await h.manager.loadView(entryId);
    expect(view?.detail.review).toEqual([
      { ...updated.comment, state: 'sent', sentAt: h.now().toISOString() },
    ]);

    expect(
      await h.cmdError({
        name: 'review.update',
        entryId,
        commentId: 'rc_0000000000000000000000000000ffff',
        text: 'x',
      }),
    ).toMatchObject({ code: 'VALIDATION_FAILED', params: { field: 'commentId' } });
    expect(
      await h.cmdError({ name: 'review.update', entryId, commentId: added.comment.id, endLine: 1 }),
    ).toMatchObject({ code: 'VALIDATION_FAILED', params: { field: 'endLine' } });

    await h.cmd({
      name: 'review.remove',
      entryId,
      commentIds: [added.comment.id, 'rc_0000000000000000000000000000ffff'],
    });
    const reviewOps = h.publisher
      .opsOf(entryId)
      .filter((op: SessionOp) => op.op === 'review.upsert' || op.op === 'review.remove')
      .map((op) => op.op);
    expect(reviewOps).toEqual(['review.upsert', 'review.upsert', 'review.upsert', 'review.remove']);
    expect((await h.manager.loadView(entryId))?.detail.review).toEqual([]);
    // Unknown ids only: nothing published.
    await h.cmd({ name: 'review.remove', entryId, commentIds: [added.comment.id] });
    expect(h.publisher.opsOf(entryId).filter((op) => op.op === 'review.remove')).toHaveLength(1);
  });
});

describe('session.create with a worktree (WP-111, ADR-250/251)', () => {
  it('creates the worktree, runs the setup with the port, then sends the held prompt', async () => {
    const repo = await createTestRepo();
    const { terminal, runs } = scriptTerminal();
    const h = await setup({ terminal });
    await useProject(h, repo, { setup: 'pnpm install', ports: true, shell: 'cmd' });
    const created = await h.cmd({
      name: 'session.create',
      cwd: repo.root,
      prompt: { text: 'Hello worktree' },
      worktree: { mode: 'new', branch: 'feature/login' },
    });
    expect(created.messageUuid).toBeNull();
    const entryId = created.entryId;
    const entry = h.stores.registry.get(entryId);
    const wt = path.join(repo.root, '.claude', 'worktrees', 'feature-login');
    expect(entry?.cwd).toBe(wt);
    expect(entry?.worktree).toMatchObject({
      repoRoot: repo.root,
      path: wt,
      branch: 'feature/login',
      baseRef: 'main',
      baseSha: await headCommit(repo.ctx, repo.root),
    });
    const portBase = entry?.worktree?.portBase ?? 0;
    expect(portBase).toBeGreaterThanOrEqual(WORKTREE_PORTS.first);
    expect((portBase - WORKTREE_PORTS.first) % WORKTREE_PORTS.size).toBe(0);

    await h.waitFor(() => runs.length === 1, 20_000);
    expect(await exists(path.join(wt, 'README.md'))).toBe(true);
    expect(runs[0]).toMatchObject({
      entryId,
      spec: {
        title: 'Setup',
        shell: 'cmd',
        command: 'pnpm install',
        env: { PARALLAX_WORKTREE_PORT: String(portBase) },
      },
      origin: 'local',
    });
    expect(h.summary(entryId).worktreeSetup).toMatchObject({ state: 'setup', exitCode: null });
    // Nothing starts meanwhile.
    expect(await h.cmdError({ name: 'session.resume', entryId })).toMatchObject({ code: 'SESSION_BUSY' });
    expect(h.sessions(entryId)).toHaveLength(0);

    runs[0]?.finish(0);
    await h.waitFor(
      () => h.summary(entryId).worktreeSetup === null && h.sessions(entryId).length === 1,
      20_000,
    );
    await h.settle();
    const prompts = (await h.manager.loadView(entryId))?.items.filter((i) => i.kind === 'user_message') ?? [];
    expect(prompts.map((i) => i.text.text)).toEqual(['Hello worktree']);
    expect((await h.cmd({ name: 'worktree.list', cwd: repo.root })).worktrees).toHaveLength(2);
    // The main worktree's status stays clean (info/exclude).
    expect(await repo.git(['status', '--porcelain'])).toBe('');
  });

  it('a failed setup waits for "Start anyway" (session.resume sends the held prompt)', async () => {
    const repo = await createTestRepo();
    const { terminal, runs } = scriptTerminal();
    const h = await setup({ terminal });
    await useProject(h, repo, { setup: 'exit 3', ports: false });
    const { entryId } = await h.cmd({
      name: 'session.create',
      cwd: repo.root,
      prompt: { text: 'After setup' },
      worktree: { mode: 'new', branch: 'fix-a' },
    });
    expect(h.stores.registry.get(entryId)?.worktree?.portBase).toBeNull();
    await h.waitFor(() => runs.length === 1, 20_000);
    expect(runs[0]?.spec.env).toEqual({});
    runs[0]?.finish(3);
    await h.waitFor(() => h.summary(entryId).worktreeSetup?.state === 'failed', 20_000);
    expect(h.summary(entryId).worktreeSetup).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(h.sessions(entryId)).toHaveLength(0);

    await h.cmd({ name: 'session.resume', entryId });
    await h.settle();
    expect(h.summary(entryId).worktreeSetup).toBeNull();
    const prompts = (await h.manager.loadView(entryId))?.items.filter((i) => i.kind === 'user_message') ?? [];
    expect(prompts).toHaveLength(1);
  });

  it('refusals create nothing: NOT_A_GIT_REPO, BRANCH_EXISTS, WORKTREE_EXISTS, unknown base', async () => {
    const repo = await createTestRepo();
    await repo.git(['branch', 'taken']);
    const h = await setup();
    const before = h.stores.registry.list().length;
    const create = (worktree: { mode: 'new'; branch: string; baseRef?: string }, cwd = repo.root) =>
      h.cmdError({ name: 'session.create', cwd, worktree });
    expect(await create({ mode: 'new', branch: 'x' }, path.dirname(repo.root))).toMatchObject({
      code: 'NOT_A_GIT_REPO',
    });
    expect(await create({ mode: 'new', branch: 'taken' })).toEqual(
      makeError('BRANCH_EXISTS', { branch: 'taken' }),
    );
    expect(await create({ mode: 'new', branch: 'y', baseRef: 'nope' })).toMatchObject({
      code: 'VALIDATION_FAILED',
      params: { field: 'worktree.baseRef' },
    });
    await writeFile(path.join(repo.root, 'placeholder'), '');
    await repo.write('.claude/worktrees/busy/keep.txt', 'k');
    expect(await create({ mode: 'new', branch: 'busy' })).toMatchObject({ code: 'WORKTREE_EXISTS' });
    expect(h.stores.registry.list()).toHaveLength(before);
  });

  it('an existing worktree: no creation, no setup; worktree.remove with busy, dirty, teardown, branch', async () => {
    const repo = await createTestRepo();
    const wt = path.join(repo.root, '.claude', 'worktrees', 'side');
    await repo.git(['worktree', 'add', '-q', '-b', 'side', wt]);
    const { terminal, runs, closed } = scriptTerminal();
    const h = await setup({ terminal });
    await useProject(h, repo, { setup: 'never runs', teardown: 'cleanup', ports: false });
    const { entryId } = await h.cmd({
      name: 'session.create',
      cwd: repo.root,
      prompt: { text: 'Go' },
      worktree: { mode: 'existing', path: wt },
    });
    await h.settle();
    expect(runs).toHaveLength(0);
    expect(h.stores.registry.get(entryId)?.worktree).toMatchObject({
      path: wt,
      branch: 'side',
      baseRef: 'main',
    });
    expect(h.sessions(entryId)).toHaveLength(1);

    // Running → SESSION_BUSY.
    const remove = { name: 'worktree.remove' as const, entryId, deleteBranch: true, force: false };
    expect(await h.cmdError(remove)).toMatchObject({ code: 'SESSION_BUSY' });
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();

    // Open work → WORKTREE_DIRTY (the inspection tells what).
    await writeFile(path.join(wt, 'work.txt'), 'w\n');
    expect(await h.cmd({ name: 'worktree.inspect', entryId })).toEqual({
      dirtyFiles: 1,
      unpushedCommits: 0,
      branchMerged: true,
    });
    expect(await h.cmdError(remove)).toEqual(
      makeError('WORKTREE_DIRTY', { dirtyFiles: 1, unpushedCommits: 0 }),
    );

    // A failing teardown stops it; "Delete anyway" skips it.
    const failing = h.cmdError({ ...remove, force: true });
    await h.waitFor(() => runs.length === 1, 20_000);
    expect(runs[0]?.spec).toMatchObject({ title: 'Teardown', command: 'cleanup' });
    runs[0]?.finish(2);
    expect(await failing).toEqual(makeError('GIT_FAILED', { op: 'teardown', exitCode: 2 }));
    expect(await exists(wt)).toBe(true);

    await h.cmd({ ...remove, force: true, skipTeardown: true });
    expect(runs).toHaveLength(1);
    expect(closed).toContain(entryId);
    expect(await exists(wt)).toBe(false);
    // CR5 (code review WP-117): the entry stays in its repository's group – the record is kept with
    // `removedAt`, the folder is gone; neither inspection nor removal applies any more.
    expect(h.stores.registry.get(entryId)?.worktree).toMatchObject({
      repoRoot: repo.root,
      path: wt,
      removedAt: h.now().toISOString(),
    });
    expect(h.summary(entryId).worktree?.removedAt).toBe(h.now().toISOString());
    expect((await h.cmd({ name: 'worktree.list', cwd: repo.root })).worktrees).toHaveLength(1);
    await expect(repo.git(['rev-parse', '--verify', '--quiet', 'refs/heads/side'])).rejects.toThrow();
    expect((await h.cmdError({ name: 'worktree.inspect', entryId })).code).toBe('VALIDATION_FAILED');
    expect((await h.cmdError(remove)).code).toBe('VALIDATION_FAILED');
    expect(runs).toHaveLength(1);
  });
});

describe('code review WP-117: worktree creation and the HEAD watch', () => {
  it('CR1: two concurrent session.create never share a port block', async () => {
    const repo = await createTestRepo();
    const h = await setup();
    await useProject(h, repo, { setup: '', ports: true });
    const create = (branch: string) =>
      h.cmd({ name: 'session.create', cwd: repo.root, worktree: { mode: 'new', branch } });
    const [a, b] = await Promise.all([create('one'), create('two')]);
    const ports = [a.entryId, b.entryId].map((id) => h.stores.registry.get(id)?.worktree?.portBase);
    expect(ports.every((port) => typeof port === 'number')).toBe(true);
    expect(new Set(ports).size).toBe(2);
    await h.waitFor(
      () => h.summary(a.entryId).worktreeSetup === null && h.summary(b.entryId).worktreeSetup === null,
      20_000,
    );
  });

  it('CR10: a failing `git worktree add` is the error of session.create – no entry, no folder, no branch', async () => {
    const repo = await createTestRepo();
    // `refs/heads/feature` is a file: git cannot create `feature/login` (the checks before cannot know).
    await repo.git(['branch', 'feature']);
    const h = await setup();
    const before = h.stores.registry.list().length;
    const error = await h.cmdError({
      name: 'session.create',
      cwd: repo.root,
      prompt: { text: 'Never lost silently' },
      worktree: { mode: 'new', branch: 'feature/login' },
    });
    expect(error).toMatchObject({ code: 'GIT_FAILED', params: { op: 'worktree_add' } });
    expect(h.stores.registry.list()).toHaveLength(before);
    expect(await exists(path.join(repo.root, '.claude', 'worktrees', 'feature-login'))).toBe(false);
    // The reservations are free again: the same branch name works once the conflict is gone.
    await repo.git(['branch', '-D', 'feature']);
    const { entryId } = await h.cmd({
      name: 'session.create',
      cwd: repo.root,
      worktree: { mode: 'new', branch: 'feature/login' },
    });
    expect(h.stores.registry.get(entryId)?.cwd).toBe(
      path.join(repo.root, '.claude', 'worktrees', 'feature-login'),
    );
    await h.waitFor(() => h.summary(entryId).worktreeSetup === null, 20_000);
  });

  it('CR10: a start prompt whose files cannot be copied fails session.create before the worktree', async () => {
    const repo = await createTestRepo();
    const h = await setup();
    const file = h.stores.blobs.put('trace', 'application/octet-stream', 'build.log');
    const materialize = vi
      .spyOn(h.stores.attachments, 'materialize')
      .mockRejectedValueOnce(new Error('disk full'));
    const before = h.stores.registry.list().length;
    const error = await h.cmdError({
      name: 'session.create',
      cwd: repo.root,
      prompt: { text: 'With a file', attachments: [{ blobId: file.blobId }] },
      worktree: { mode: 'new', branch: 'with-file' },
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(h.stores.registry.list()).toHaveLength(before);
    expect(await exists(path.join(repo.root, '.claude', 'worktrees', 'with-file'))).toBe(false);
    await expect(repo.git(['rev-parse', '--verify', '--quiet', 'refs/heads/with-file'])).rejects.toThrow();
  });

  it('SR2: a link at `.claude` refuses a new worktree (nothing is created through it)', async () => {
    const repo = await createTestRepo();
    const outside = await makeTempHome('outside-');
    await symlink(outside, path.join(repo.root, '.claude'), 'junction');
    const h = await setup();
    expect(
      await h.cmdError({
        name: 'session.create',
        cwd: repo.root,
        worktree: { mode: 'new', branch: 'linked' },
      }),
    ).toEqual(makeError('VALIDATION_FAILED', { field: 'worktree.path', reason: 'link' }));
    expect(await readdir(outside)).toEqual([]);
  });

  it('CR2: the HEAD watch ends when no window shows the entry any more, and when it is archived', async () => {
    const repo = await createTestRepo();
    const entry = sampleEntry({ cwd: repo.root, worktree: null, baseSha: null });
    const h = await setup({ seed: { entries: [entry] }, gitBranch: () => Promise.resolve('main') });
    const before = gitHeadWatchCount();
    const show = (presence: readonly ClientPresence[]) => {
      h.publisher.setPresence(presence);
      h.manager.onPresenceChanged(presence);
    };
    show([viewer(entry.id)]);
    await h.waitFor(() => gitHeadWatchCount() === before + 1, 20_000);
    show([]);
    expect(gitHeadWatchCount()).toBe(before);

    show([viewer(entry.id)]);
    await h.waitFor(() => gitHeadWatchCount() === before + 1, 20_000);
    await h.cmd({ name: 'session.setArchived', entryId: entry.id, archived: true });
    expect(gitHeadWatchCount()).toBe(before);
  });
});

function viewer(entryId: EntryId): ClientPresence {
  return {
    clientId: sampleId('cl', 1),
    presence: { focused: true, visible: true, viewingEntryId: entryId, typing: false },
    lastFocusAt: new Date(SAMPLE_TIME),
    connectedAt: new Date(SAMPLE_TIME),
  };
}
