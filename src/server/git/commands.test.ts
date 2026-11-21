import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS, sampleWorktreeRef } from '@shared/samples';
import { createGitCommands, sessionDiffBase } from './commands';
import { createTestRepo } from './testRepo';

describe('sessionDiffBase (ADR-253)', () => {
  it('a worktree session: the merge base with baseRef, even after baseRef moved on', async () => {
    const repo = await createTestRepo();
    const fork = (await repo.git(['rev-parse', 'HEAD'])).trim();
    const wt = path.join(repo.root, '.claude', 'worktrees', 'side');
    await repo.git(['worktree', 'add', '-q', '-b', 'side', wt]);
    await repo.write('later.txt', 'main moves on\n');
    await repo.commitAll('later on main');
    await repo.git(['commit', '-q', '--allow-empty', '-m', 'work on side'], wt);
    const worktree = sampleWorktreeRef({
      repoRoot: repo.root,
      path: wt,
      branch: 'side',
      baseRef: 'main',
      baseSha: fork,
    });
    const remember = vi.fn();
    expect(await sessionDiffBase(repo.ctx, { cwd: wt, worktree, baseSha: null }, remember)).toBe(fork);
    // baseRef gone: the stored baseSha.
    const gone = { ...worktree, baseRef: 'deleted-branch' };
    expect(await sessionDiffBase(repo.ctx, { cwd: wt, worktree: gone, baseSha: null }, remember)).toBe(fork);
    expect(remember).not.toHaveBeenCalled();
  });

  it('a stored base that no longer exists: the current HEAD, not stored; none yet: HEAD, stored', async () => {
    const repo = await createTestRepo();
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
    const remember = vi.fn();
    const unknown = 'c'.repeat(40);
    expect(
      await sessionDiffBase(repo.ctx, { cwd: repo.root, worktree: null, baseSha: unknown }, remember),
    ).toBe(head);
    expect(remember).not.toHaveBeenCalled();
    expect(await sessionDiffBase(repo.ctx, { cwd: repo.root, worktree: null, baseSha: null }, remember)).toBe(
      head,
    );
    expect(remember).toHaveBeenCalledWith(head);
  });

  it('an unborn repository: null (the empty tree), nothing stored', async () => {
    const repo = await createTestRepo({ empty: true });
    const remember = vi.fn();
    expect(
      await sessionDiffBase(repo.ctx, { cwd: repo.root, worktree: null, baseSha: null }, remember),
    ).toBeNull();
    expect(remember).not.toHaveBeenCalled();
  });
});

describe('createGitCommands', () => {
  it('without deps (the scaffolding): NOT_IMPLEMENTED for every name', async () => {
    const handler = createGitCommands();
    expect(handler.names).toContain('worktree.remove');
    await expect(
      handler.handle(
        { name: 'git.status', entryId: SAMPLE_IDS.entry },
        { clientId: SAMPLE_IDS.client, cmdId: 'c1' },
      ),
    ).rejects.toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
  });
});
