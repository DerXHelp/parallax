import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleStatusFacts, sampleWorktreeInspection } from '@shared/samples';
import {
  defaultCleanupOption,
  dirtyWork,
  isCleanupOption,
  losesWork,
  needsClose,
  teardownExit,
  workLost,
} from './cleanup';
import { portRange } from './ports';

/** WP-114: the pure rules of the worktree cleanup. */

const clean = sampleWorktreeInspection({ dirtyFiles: 0, unpushedCommits: 0, branchMerged: false });

describe('cleanup options', () => {
  it('keeps while work is open or unknown; a clean worktree goes – with its branch only when merged', () => {
    expect(defaultCleanupOption(null)).toBe('keep');
    expect(defaultCleanupOption(sampleWorktreeInspection())).toBe('keep');
    expect(defaultCleanupOption(sampleWorktreeInspection({ dirtyFiles: 0 }))).toBe('keep');
    expect(defaultCleanupOption(clean)).toBe('worktree');
    expect(defaultCleanupOption({ ...clean, branchMerged: true })).toBe('all');
    expect(isCleanupOption('all')).toBe(true);
    expect(isCleanupOption('everything')).toBe(false);
  });

  it('deleting the worktree loses its files; deleting the branch also its commits found nowhere else', () => {
    const open = sampleWorktreeInspection({ dirtyFiles: 2, unpushedCommits: 3 });
    expect(workLost('keep', open)).toEqual({ files: 0, commits: 0 });
    expect(workLost('worktree', open)).toEqual({ files: 2, commits: 0 });
    expect(workLost('all', open)).toEqual({ files: 2, commits: 3 });
    expect(workLost('all', null)).toEqual({ files: 0, commits: 0 });
    expect(losesWork({ files: 0, commits: 0 })).toBe(false);
    expect(losesWork({ files: 0, commits: 1 })).toBe(true);
  });
});

describe('refusals the dialog answers', () => {
  it('WORKTREE_DIRTY: the open work (tolerant of bad params)', () => {
    expect(dirtyWork(makeError('WORKTREE_DIRTY', { dirtyFiles: 1, unpushedCommits: 4 }))).toEqual({
      files: 1,
      commits: 4,
    });
    expect(dirtyWork(makeError('WORKTREE_DIRTY'))).toEqual({ files: 0, commits: 0 });
    expect(dirtyWork(makeError('GIT_FAILED', { op: 'teardown' }))).toBeNull();
  });

  it('GIT_FAILED {op: teardown}: its exit code, null when stopped; other ops and codes are no teardown', () => {
    expect(teardownExit(makeError('GIT_FAILED', { op: 'teardown', exitCode: 3 }))).toBe(3);
    expect(teardownExit(makeError('GIT_FAILED', { op: 'teardown' }))).toBeNull();
    expect(teardownExit(makeError('GIT_FAILED', { op: 'worktree_remove', exitCode: 1 }))).toBeUndefined();
    expect(teardownExit(makeError('SESSION_BUSY'))).toBeUndefined();
  });
});

describe('needsClose', () => {
  it('a running, not archived session is closed first; sleeping, external and archived ones are not', () => {
    expect(needsClose({ archived: false, status: sampleStatusFacts({ runState: 'idle' }) })).toBe(true);
    expect(needsClose({ archived: false, status: sampleStatusFacts({ runState: 'working' }) })).toBe(true);
    expect(needsClose({ archived: false, status: sampleStatusFacts({ runState: 'sleeping' }) })).toBe(false);
    expect(needsClose({ archived: false, status: sampleStatusFacts({ runState: 'external' }) })).toBe(false);
    expect(needsClose({ archived: true, status: sampleStatusFacts({ runState: 'idle' }) })).toBe(false);
    expect(needsClose(null)).toBe(false);
  });
});

describe('portRange', () => {
  it('a block of ten ports', () => {
    expect(portRange(41000)).toEqual({ from: 41000, to: 41009 });
  });
});
