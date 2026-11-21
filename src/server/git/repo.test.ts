import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { makeTempHome } from '../http/testServer';
import { HOST_PATH_RULES } from '../lib/paths';
import { CommandError } from '../sync/ports';
import type { GitCall, GitResult, GitRunner } from './runner';
import {
  addedFilePatch,
  addWorktree,
  absoluteIn,
  commit,
  copyWorktreeInclude,
  createBranch,
  currentBranch,
  deleteBranch,
  diffList,
  ensureExcluded,
  fileDiff,
  headCommit,
  inspectWorktree,
  inspectWorktreeLoss,
  listWorktrees,
  mergeBase,
  plainFolderChain,
  push,
  readStatus,
  removeWorktree,
  resolveCommit,
  switchBranch,
  WORKTREES_DIR,
  worktreeRoot,
} from './repo';
import { createTestRepo } from './testRepo';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';

async function errorOf(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

describe('git repo operations (WP-111, real repositories)', () => {
  it('status: no repository is not an error; branch, head, kinds of a repository', async () => {
    const repo = await createTestRepo();
    const outside = await makeTempHome('norepo-');
    expect(await readStatus(repo.ctx, outside)).toMatchObject({ isRepo: false, root: null, files: [] });
    expect(await worktreeRoot(repo.ctx, path.join(outside, 'missing'))).toBeNull();

    await repo.write('README.md', 'hello\nworld\n');
    await repo.write('new.txt', 'n\n');
    await repo.write('staged.txt', 's\n');
    await repo.git(['add', 'staged.txt']);
    await mkdir(path.join(repo.root, 'sub'), { recursive: true });
    const status = await readStatus(repo.ctx, path.join(repo.root, 'sub'));
    expect(status.isRepo).toBe(true);
    expect(status.root).toBe(repo.root);
    expect(status.branch).toBe('main');
    expect(status.head).toBe(await headCommit(repo.ctx, repo.root));
    expect(status.upstream).toBeNull();
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
    expect(byPath['README.md']).toMatchObject({ kind: 'modified', staged: false, unstaged: true });
    expect(byPath['new.txt']).toMatchObject({ kind: 'untracked', staged: false });
    expect(byPath['staged.txt']).toMatchObject({ kind: 'added', staged: true, unstaged: false });
  });

  it('an unborn repository: no head, the session diff starts at the empty tree', async () => {
    const repo = await createTestRepo({ empty: true });
    await repo.write('a.txt', 'one\ntwo\n');
    const status = await readStatus(repo.ctx, repo.root);
    expect(status).toMatchObject({ isRepo: true, head: null, branch: 'main' });
    const list = await diffList(repo.ctx, repo.root, { scope: 'session', base: null });
    expect(list.files).toEqual([
      expect.objectContaining({ path: 'a.txt', kind: 'added', additions: 2, deletions: 0, patch: null }),
    ]);
    await repo.git(['add', 'a.txt']);
    const staged = await diffList(repo.ctx, repo.root, { scope: 'staged', base: null });
    expect(staged.files.map((f) => [f.path, f.kind, f.additions])).toEqual([['a.txt', 'added', 2]]);
  });

  it('diff scopes: session (since the base, with untracked), uncommitted, staged', async () => {
    const repo = await createTestRepo();
    const base = (await headCommit(repo.ctx, repo.root)) ?? '';
    await repo.write('committed.txt', 'c1\nc2\nc3\n');
    await repo.commitAll('second');
    await repo.write('README.md', 'hello\nchanged\n');
    await repo.write('dir/untracked.txt', 'u\n');
    await repo.write('staged.txt', 's\n');
    await repo.git(['add', 'staged.txt']);

    const session = await diffList(repo.ctx, repo.root, { scope: 'session', base });
    expect(session.root).toBe(repo.root);
    expect(session.files.map((f) => [f.path, f.kind, f.additions, f.deletions]).sort()).toEqual([
      ['README.md', 'modified', 1, 0],
      ['committed.txt', 'added', 3, 0],
      ['dir/untracked.txt', 'added', 1, 0],
      ['staged.txt', 'added', 1, 0],
    ]);
    const uncommitted = await diffList(repo.ctx, repo.root, { scope: 'uncommitted', base: null });
    expect(uncommitted.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'dir/untracked.txt',
      'staged.txt',
    ]);
    const staged = await diffList(repo.ctx, repo.root, { scope: 'staged', base: null });
    expect(staged.files.map((f) => f.path)).toEqual(['staged.txt']);
    // Only the session's files.
    const only = await diffList(repo.ctx, repo.root, { scope: 'session', base }, (p) => p === 'README.md');
    expect(only.files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('renames are detected (origPath)', async () => {
    const repo = await createTestRepo();
    await repo.write('old.txt', 'a\nb\nc\nd\ne\n');
    const base = await repo.commitAll('add old');
    await repo.git(['mv', 'old.txt', 'new.txt']);
    const list = await diffList(repo.ctx, repo.root, { scope: 'session', base });
    expect(list.files).toEqual([
      expect.objectContaining({ path: 'new.txt', origPath: 'old.txt', kind: 'renamed' }),
    ]);
    const file = await fileDiff(repo.ctx, repo.root, { scope: 'session', base }, 'new.txt');
    expect(file.kind).toBe('renamed');
  });

  it('fileDiff: tracked patch from the first hunk, untracked built by hand, binary, not in the diff', async () => {
    const repo = await createTestRepo();
    const base = (await headCommit(repo.ctx, repo.root)) ?? '';
    await repo.write('README.md', 'hello\nmore\n');
    await repo.write('fresh.txt', 'x\ny');
    await repo.write('blob.bin', new Uint8Array([1, 0, 2, 3]));
    const spec = { scope: 'session' as const, base };

    const tracked = await fileDiff(repo.ctx, repo.root, spec, 'README.md');
    expect(tracked.patch?.startsWith('@@ -1 +1,2 @@')).toBe(true);
    expect(tracked).toMatchObject({ additions: 1, deletions: 0, binary: false, truncated: false });

    const fresh = await fileDiff(repo.ctx, repo.root, spec, 'fresh.txt');
    expect(fresh.patch).toBe('@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file\n');
    expect(fresh).toMatchObject({ kind: 'added', additions: 2 });

    const blob = await fileDiff(repo.ctx, repo.root, spec, 'blob.bin');
    expect(blob).toMatchObject({ binary: true, patch: null });

    const missing = await errorOf(fileDiff(repo.ctx, repo.root, spec, 'nothing.txt'));
    expect(missing.error).toMatchObject({ code: 'VALIDATION_FAILED', params: { field: 'path' } });
  });

  it('commit: everything or the given files; the new HEAD', async () => {
    const repo = await createTestRepo();
    await repo.write('a.txt', 'a\n');
    await repo.write('b.txt', 'b\n');
    const sha = await commit(repo.ctx, repo.root, 'only a', ['a.txt']);
    expect(sha).toBe(await headCommit(repo.ctx, repo.root));
    expect((await readStatus(repo.ctx, repo.root)).files.map((f) => f.path)).toEqual(['b.txt']);
    await commit(repo.ctx, repo.root, 'the rest', null);
    expect((await readStatus(repo.ctx, repo.root)).files).toEqual([]);
    const outside = await errorOf(commit(repo.ctx, repo.root, 'x', ['../escape.txt']));
    expect(outside.error.code).toBe('VALIDATION_FAILED');
    // Nothing to commit: git's own refusal.
    expect((await errorOf(commit(repo.ctx, repo.root, 'empty', null))).error).toMatchObject({
      code: 'GIT_FAILED',
      params: { op: 'commit', exitCode: 1 },
    });
  });

  it('branches: create (BRANCH_EXISTS), create and switch, switch back', async () => {
    const repo = await createTestRepo();
    await createBranch(repo.ctx, repo.root, 'feature/a', false);
    expect(await currentBranch(repo.ctx, repo.root)).toBe('main');
    expect((await errorOf(createBranch(repo.ctx, repo.root, 'feature/a', true))).error).toEqual({
      code: 'BRANCH_EXISTS',
      params: { branch: 'feature/a' },
    });
    await createBranch(repo.ctx, repo.root, 'feature/b', true);
    expect(await currentBranch(repo.ctx, repo.root)).toBe('feature/b');
    await switchBranch(repo.ctx, repo.root, 'main');
    expect(await currentBranch(repo.ctx, repo.root)).toBe('main');
    expect((await errorOf(switchBranch(repo.ctx, repo.root, 'nope'))).error).toMatchObject({
      code: 'GIT_FAILED',
      params: { op: 'branch_switch' },
    });
  });

  it('push: without a remote GIT_PUSH_FAILED other; first push sets the upstream; a rejected push', async () => {
    const repo = await createTestRepo();
    expect((await errorOf(push(repo.ctx, repo.root))).error).toMatchObject({
      code: 'GIT_PUSH_FAILED',
      params: { reason: 'other', detail: 'no remote' },
    });
    const remote = await createTestRepo({ bare: true });
    await repo.git(['remote', 'add', 'origin', remote.root]);
    await push(repo.ctx, repo.root);
    const status = await readStatus(repo.ctx, repo.root);
    expect(status.upstream).toBe('origin/main');

    // A second clone pushes first → ours is rejected.
    const other = await createTestRepo({ empty: true });
    await other.git(['remote', 'add', 'origin', remote.root]);
    await other.git(['fetch', '-q', 'origin']);
    await other.git(['checkout', '-q', '-B', 'main', 'origin/main']);
    await other.write('other.txt', 'o\n');
    await other.commitAll('other');
    await other.git(['push', '-q', 'origin', 'main']);
    await repo.write('mine.txt', 'm\n');
    await repo.commitAll('mine');
    expect((await errorOf(push(repo.ctx, repo.root))).error).toMatchObject({
      code: 'GIT_PUSH_FAILED',
      params: { reason: 'rejected' },
    });
  });

  it('worktrees: add, exclude, .worktreeinclude, list, inspect, remove, delete the branch', async () => {
    const repo = await createTestRepo();
    await repo.write('.gitignore', '.env\nnode_modules/\n');
    await repo.write('.env', 'SECRET=1\n');
    await repo.write('node_modules/x/index.js', 'x\n');
    await repo.write('.worktreeinclude', '.env\n');
    const base = await repo.commitAll('ignore');
    const wt = path.join(repo.root, '.claude', 'worktrees', 'feature-x');
    await addWorktree(repo.ctx, repo.root, wt, 'feature/x', base);
    expect(await ensureExcluded(repo.ctx, repo.root, '.claude/worktrees')).toBe(true);
    expect(await ensureExcluded(repo.ctx, repo.root, '.claude/worktrees')).toBe(false);
    expect((await readStatus(repo.ctx, repo.root)).files).toEqual([]);
    const exclude = await readFile(path.join(repo.root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain('/.claude/worktrees/');

    const included = await copyWorktreeInclude(repo.ctx, repo.root, wt);
    expect(included).toEqual({ copied: 1, skipped: 0, limited: false });
    expect(await readFile(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
    // Never over an existing file.
    expect((await copyWorktreeInclude(repo.ctx, repo.root, wt)).copied).toBe(0);

    const listed = await listWorktrees(repo.ctx, wt);
    expect(listed.repoRoot).toBe(repo.root);
    expect(listed.worktrees.map((w) => [w.path, w.branch, w.main])).toEqual([
      [repo.root, 'main', true],
      [wt, 'feature/x', false],
    ]);
    expect((await readStatus(repo.ctx, wt)).root).toBe(wt);

    // Clean and merged.
    expect(await inspectWorktree(repo.ctx, wt, repo.root, 'feature/x', { ref: 'main', sha: base })).toEqual({
      dirtyFiles: 0,
      unpushedCommits: 0,
      branchMerged: true,
    });
    await writeFile(path.join(wt, 'work.txt'), 'w\n');
    await repo.git(['add', 'work.txt'], wt);
    await repo.git(['commit', '-q', '-m', 'work'], wt);
    await writeFile(path.join(wt, 'dirty.txt'), 'd\n');
    expect(await inspectWorktree(repo.ctx, wt, repo.root, 'feature/x', { ref: 'main', sha: base })).toEqual({
      dirtyFiles: 1,
      unpushedCommits: 1,
      branchMerged: false,
    });
    expect(await mergeBase(repo.ctx, repo.root, 'main', 'feature/x')).toBe(
      await resolveCommit(repo.ctx, repo.root, 'main'),
    );

    // Dirty: git refuses without force.
    expect((await errorOf(removeWorktree(repo.ctx, repo.root, wt, false))).error).toMatchObject({
      code: 'GIT_FAILED',
      params: { op: 'worktree_remove' },
    });
    await removeWorktree(repo.ctx, repo.root, wt, true);
    expect((await errorOf(deleteBranch(repo.ctx, repo.root, 'feature/x', false))).error.code).toBe(
      'GIT_FAILED',
    );
    await deleteBranch(repo.ctx, repo.root, 'feature/x', true);
    expect(await resolveCommit(repo.ctx, repo.root, 'refs/heads/feature/x')).toBeNull();
    expect((await listWorktrees(repo.ctx, repo.root)).worktrees).toHaveLength(1);
  });
});

/** A runner that records the arguments of every call and lets `answer` replace a call's result. */
function recording(runner: GitRunner, answer: (args: readonly string[]) => GitResult | null = () => null) {
  const calls: (readonly string[])[] = [];
  const wrapped: GitRunner = {
    executable: (env) => runner.executable(env),
    run: (c: GitCall) => {
      calls.push(c.args);
      return Promise.resolve(answer(c.args) ?? runner.run(c));
    },
    ok: (c: GitCall) => {
      calls.push(c.args);
      return Promise.resolve(answer(c.args) ?? runner.ok(c));
    },
  };
  return { runner: wrapped, calls };
}

describe('code and security review WP-117 (real repositories)', () => {
  it('CR3: commit and fileDiff take file names literally (`[id].ts`, `[n]otes.md` are no globs)', async () => {
    const repo = await createTestRepo();
    await repo.write('[id].ts', 'one\n');
    await repo.write('i.ts', 'i\n');
    await repo.write('[n]otes.md', 'bracket\n');
    await repo.write('notes.md', 'notes\n');
    await commit(repo.ctx, repo.root, 'only the literal names', ['[id].ts', '[n]otes.md']);
    expect((await readStatus(repo.ctx, repo.root)).files.map((f) => f.path).sort()).toEqual([
      'i.ts',
      'notes.md',
    ]);
    const base = await commit(repo.ctx, repo.root, 'the rest', null);

    await repo.write('[id].ts', 'one\ntwo\n');
    await repo.write('i.ts', 'i\nother\n');
    const file = await fileDiff(repo.ctx, repo.root, { scope: 'session', base }, '[id].ts');
    expect(file).toMatchObject({ path: '[id].ts', kind: 'modified', additions: 1, deletions: 0 });
    expect(file.patch).toContain('+two');
    expect(file.patch).not.toContain('other');
  });

  it('CR9: fileDiff of a tracked file asks git for that file only (no untracked listing, no line counts)', async () => {
    const repo = await createTestRepo();
    const base = (await headCommit(repo.ctx, repo.root)) ?? '';
    await repo.write('README.md', 'hello\nmore\n');
    await repo.write('fresh.txt', 'x\n');
    const { runner, calls } = recording(repo.runner);
    const ctx = { ...repo.ctx, runner };
    const tracked = await fileDiff(ctx, repo.root, { scope: 'session', base }, 'README.md');
    expect(tracked).toMatchObject({ kind: 'modified', additions: 1 });
    expect(calls.some((args) => args.includes('ls-files'))).toBe(false);
    expect(calls.some((args) => args.includes('--numstat'))).toBe(false);
    const fresh = await fileDiff(ctx, repo.root, { scope: 'session', base }, 'fresh.txt');
    expect(fresh).toMatchObject({ kind: 'added', additions: 1 });
  });

  it('CR4: an unknown count of unpushed commits is never 0', async () => {
    const repo = await createTestRepo();
    const base = (await headCommit(repo.ctx, repo.root)) ?? '';
    await repo.git(['branch', 'side']);
    const failing = recording(repo.runner, (args) =>
      args.includes('rev-list')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: bad object', truncated: false }
        : null,
    );
    const ctx = { ...repo.ctx, runner: failing.runner };
    expect(await inspectWorktreeLoss(ctx, repo.root, repo.root, 'side', { ref: 'main', sha: base })).toEqual({
      dirtyFiles: 0,
      unpushedCommits: null,
      branchMerged: true,
    });
    expect(
      (await errorOf(inspectWorktree(ctx, repo.root, repo.root, 'side', { ref: 'main', sha: base }))).error,
    ).toEqual({ code: 'GIT_FAILED', params: { op: 'status', detail: 'unpushed commits unknown' } });
  });

  it('SR1: reading calls never start a filter of the repository (status, diffs, inspection)', async () => {
    const repo = await createTestRepo();
    await repo.write('.gitattributes', '*.txt filter=evil\n');
    await repo.write('a.txt', 'one\n');
    const base = await repo.commitAll('attributes');
    const marker = path.join(await makeTempHome('marker-'), 'ran');
    const shellPath = marker.split(path.sep).join('/');
    await repo.git(['config', 'filter.evil.clean', `echo ran > '${shellPath}' && cat`]);
    await repo.git(['config', 'filter.evil.smudge', `echo ran > '${shellPath}' && cat`]);
    // Same size, new content: git has to read the file again.
    await repo.write('a.txt', 'two\n');

    const status = await readStatus(repo.ctx, repo.root);
    expect(status.files.map((f) => [f.path, f.kind])).toEqual([['a.txt', 'modified']]);
    expect(
      (await diffList(repo.ctx, repo.root, { scope: 'uncommitted', base: null })).files.map((f) => f.path),
    ).toEqual(['a.txt']);
    expect(
      (await diffList(repo.ctx, repo.root, { scope: 'session', base })).files.map((f) => f.path),
    ).toEqual(['a.txt']);
    expect((await fileDiff(repo.ctx, repo.root, { scope: 'session', base }, 'a.txt')).patch).toContain(
      '+two',
    );
    expect(
      (await inspectWorktree(repo.ctx, repo.root, repo.root, 'main', { ref: 'main', sha: base })).dirtyFiles,
    ).toBe(1);
    expect(existsSync(marker)).toBe(false);
    // The repository really runs the filter (a plain `git status`): the test would see it.
    await repo.git(['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  });

  it('SR2: .worktreeinclude copies only what the NEW worktree ignores, never through a link', async () => {
    const repo = await createTestRepo();
    const before = (await headCommit(repo.ctx, repo.root)) ?? '';
    await repo.write('.gitignore', '*.env\n');
    await repo.write('.worktreeinclude', '*.env\nsub/\n');
    await repo.commitAll('ignore');
    await repo.write('.env', 'SECRET=1\n');
    await repo.write('sub/x.env', 'SUB=1\n');

    // A worktree at a commit without the .gitignore: `.env` would be a new file there – not copied.
    const old = path.join(repo.root, '.claude', 'worktrees', 'old');
    await addWorktree(repo.ctx, repo.root, old, 'old', before);
    expect(await copyWorktreeInclude(repo.ctx, repo.root, old)).toEqual({
      copied: 0,
      skipped: 2,
      limited: false,
    });
    expect(existsSync(path.join(old, '.env'))).toBe(false);

    // A link in the new worktree (a junction on Windows) never takes a file out of it.
    const wt = path.join(repo.root, '.claude', 'worktrees', 'linked');
    await addWorktree(repo.ctx, repo.root, wt, 'linked', (await headCommit(repo.ctx, repo.root)) ?? '');
    const outside = await makeTempHome('outside-');
    await symlink(outside, path.join(wt, 'sub'), 'junction');
    expect(await copyWorktreeInclude(repo.ctx, repo.root, wt)).toEqual({
      copied: 1,
      skipped: 1,
      limited: false,
    });
    expect(await readFile(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(await readdir(outside)).toEqual([]);
  });

  it('SR2: plainFolderChain refuses a link or a file on the way to the worktree folder', async () => {
    const repo = await createTestRepo();
    expect(await plainFolderChain(repo.root, WORKTREES_DIR, HOST_PATH_RULES)).toBe(true);
    const outside = await makeTempHome('outside-');
    await symlink(outside, path.join(repo.root, '.claude'), 'junction');
    expect(await plainFolderChain(repo.root, WORKTREES_DIR, HOST_PATH_RULES)).toBe(false);
    const other = await createTestRepo();
    await other.write('.claude', 'a file');
    expect(await plainFolderChain(other.root, WORKTREES_DIR, HOST_PATH_RULES)).toBe(false);
  });

  it('SR4: push refuses a remote whose name would be an option', async () => {
    const repo = await createTestRepo();
    const remote = await createTestRepo({ bare: true });
    await repo.git(['config', 'remote.--upload-pack=evil.url', remote.root]);
    const { runner, calls } = recording(repo.runner);
    expect((await errorOf(push({ ...repo.ctx, runner }, repo.root))).error).toEqual({
      code: 'GIT_PUSH_FAILED',
      params: { reason: 'other', detail: 'invalid name' },
    });
    expect(calls.some((args) => args[0] === 'push')).toBe(false);
  });
});

describe('pure helpers of repo.ts', () => {
  it('absoluteIn keeps paths inside the root (both flavors)', () => {
    expect(absoluteIn('C:\\work\\r', 'src/a.ts', WIN32_PATHS)).toBe('C:\\work\\r\\src\\a.ts');
    expect(absoluteIn('C:\\work\\r', '../x', WIN32_PATHS)).toBeNull();
    expect(absoluteIn('C:\\work\\r', 'a//b', WIN32_PATHS)).toBeNull();
    expect(absoluteIn('C:\\work\\r', 'file.txt:stream', WIN32_PATHS)).toBeNull();
    expect(absoluteIn('/srv/r', 'src/a.ts', POSIX_PATHS)).toBe('/srv/r/src/a.ts');
    expect(absoluteIn('/srv/r', 'a/../../x', POSIX_PATHS)).toBeNull();
  });

  it('addedFilePatch: line count, missing newline, limit', () => {
    expect(addedFilePatch('')).toEqual({ patch: '', truncated: false });
    expect(addedFilePatch('one\n')).toEqual({ patch: '@@ -0,0 +1 @@\n+one\n', truncated: false });
    expect(addedFilePatch('a\nb')).toEqual({
      patch: '@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n',
      truncated: false,
    });
    const big = addedFilePatch('x'.repeat(100).concat('\n').repeat(50), 400);
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.patch)).toBeLessThanOrEqual(400);
    expect(LIMITS.gitPatchBytes).toBeGreaterThan(400);
  });
});
