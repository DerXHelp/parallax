import { describe, expect, it } from 'vitest';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import {
  classifyPushFailure,
  countPatchLines,
  hostPath,
  parseRawNumstat,
  parseStatusV2,
  parseWorktreeList,
  patchBody,
  rootInCwdSpelling,
  splitNul,
} from './parse';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('paths git reports (both flavors)', () => {
  it('hostPath: Windows separators, trailing separators dropped, roots kept', () => {
    expect(hostPath('C:/work/repo\n', WIN32_PATHS)).toBe('C:\\work\\repo');
    expect(hostPath('C:/work/repo/', WIN32_PATHS)).toBe('C:\\work\\repo');
    expect(hostPath('C:/', WIN32_PATHS)).toBe('C:\\');
    expect(hostPath('/home/user/repo/\n', POSIX_PATHS)).toBe('/home/user/repo');
    expect(hostPath('/', POSIX_PATHS)).toBe('/');
  });

  it("rootInCwdSpelling keeps the cwd's spelling on Windows only", () => {
    expect(rootInCwdSpelling('D:\\Work\\Repo', 'd:\\work\\repo\\src', WIN32_PATHS)).toBe('d:\\work\\repo');
    expect(rootInCwdSpelling('D:\\', 'd:\\x', WIN32_PATHS)).toBe('d:\\');
    expect(rootInCwdSpelling('D:\\Work\\Repo', 'E:\\other', WIN32_PATHS)).toBe('D:\\Work\\Repo');
    expect(rootInCwdSpelling('/srv/Repo', '/srv/Repo/src', POSIX_PATHS)).toBe('/srv/Repo');
  });

  it('splitNul drops only the trailing empty record', () => {
    expect(splitNul('a\0b\0')).toEqual(['a', 'b']);
    expect(splitNul('a\0\0b')).toEqual(['a', '', 'b']);
    expect(splitNul('')).toEqual([]);
  });
});

describe('parseStatusV2', () => {
  it('reads the branch headers and every entry type', () => {
    const text = [
      `# branch.oid ${SHA_A}`,
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      `1 M. N... 100644 100644 100644 ${SHA_A} ${SHA_B} src/a file.ts`,
      `1 .M N... 100644 100644 100644 ${SHA_A} ${SHA_B} b.ts`,
      `2 R. N... 100644 100644 100644 ${SHA_A} ${SHA_B} R100 new name.ts`,
      'old name.ts',
      `u UU N... 100644 100644 100644 100644 ${SHA_A} ${SHA_B} ${SHA_A} conflict.ts`,
      '? notes.txt',
      '? nested/',
      '! ignored.log',
      '',
    ].join('\0');
    const status = parseStatusV2(text);
    expect(status).toMatchObject({
      branch: 'feature/x',
      detached: false,
      head: SHA_A,
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
    });
    expect(status.files).toEqual([
      { path: 'src/a file.ts', origPath: null, kind: 'modified', staged: true, unstaged: false },
      { path: 'b.ts', origPath: null, kind: 'modified', staged: false, unstaged: true },
      { path: 'new name.ts', origPath: 'old name.ts', kind: 'renamed', staged: true, unstaged: false },
      { path: 'conflict.ts', origPath: null, kind: 'conflicted', staged: true, unstaged: true },
      { path: 'notes.txt', origPath: null, kind: 'untracked', staged: false, unstaged: true },
      { path: 'nested', origPath: null, kind: 'untracked', staged: false, unstaged: true },
    ]);
  });

  it('a detached HEAD, an unborn branch', () => {
    expect(parseStatusV2(`# branch.oid ${SHA_B}\0# branch.head (detached)\0`)).toMatchObject({
      branch: null,
      detached: true,
      head: SHA_B,
    });
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({
      branch: 'main',
      head: null,
      upstream: null,
      ahead: 0,
    });
  });
});

describe('parseRawNumstat', () => {
  it('merges raw and numstat records; renames, binaries, unmerged paths listed twice', () => {
    const text = [
      `:100644 100644 ${SHA_A} ${SHA_B} M`,
      'a.ts',
      `:000000 100644 ${'0'.repeat(40)} ${SHA_B} A`,
      'img.png',
      `:100644 100644 ${SHA_A} ${SHA_B} R087`,
      'old.ts',
      'new.ts',
      `:100644 100644 ${SHA_A} ${SHA_B} U`,
      'c.ts',
      `:100644 100644 ${SHA_A} ${SHA_B} M`,
      'c.ts',
      '3\t1\ta.ts',
      '-\t-\timg.png',
      '2\t2\t',
      'old.ts',
      'new.ts',
      '1\t0\tc.ts',
      '',
    ].join('\0');
    expect(parseRawNumstat(text)).toEqual([
      { path: 'a.ts', origPath: null, kind: 'modified', binary: false, additions: 3, deletions: 1 },
      { path: 'img.png', origPath: null, kind: 'added', binary: true, additions: 0, deletions: 0 },
      { path: 'new.ts', origPath: 'old.ts', kind: 'renamed', binary: false, additions: 2, deletions: 2 },
      { path: 'c.ts', origPath: null, kind: 'conflicted', binary: false, additions: 1, deletions: 0 },
    ]);
    expect(parseRawNumstat('')).toEqual([]);
  });
});

describe('patches', () => {
  it('patchBody drops the header; binary files have no body', () => {
    const text = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
    expect(patchBody(text)).toEqual({ patch: '@@ -1 +1 @@\n-a\n+b\n', binary: false });
    expect(patchBody('diff --git a/i b/i\nBinary files a/i and b/i differ\n')).toEqual({
      patch: '',
      binary: true,
    });
    expect(patchBody('')).toEqual({ patch: '', binary: false });
  });

  it('countPatchLines', () => {
    expect(countPatchLines('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n')).toEqual({ additions: 2, deletions: 1 });
  });
});

describe('parseWorktreeList', () => {
  it('the main worktree first, linked ones, detached; bare and rejected paths skipped (Windows)', () => {
    const text = [
      'worktree C:/work/repo',
      `HEAD ${SHA_A}`,
      'branch refs/heads/main',
      '',
      'worktree C:/work/repo/.claude/worktrees/feature-x',
      `HEAD ${SHA_B}`,
      'branch refs/heads/feature/x',
      '',
      'worktree C:/work/detached',
      `HEAD ${SHA_B}`,
      'detached',
      '',
      'worktree //server/share/wt',
      `HEAD ${SHA_B}`,
      'branch refs/heads/unc',
      '',
    ].join('\0');
    expect(parseWorktreeList(text, WIN32_PATHS)).toEqual([
      { path: 'C:\\work\\repo', branch: 'main', head: SHA_A, main: true },
      {
        path: 'C:\\work\\repo\\.claude\\worktrees\\feature-x',
        branch: 'feature/x',
        head: SHA_B,
        main: false,
      },
      { path: 'C:\\work\\detached', branch: null, head: SHA_B, main: false },
    ]);
  });

  it('a bare main repository is not listed, its linked worktree is not main (POSIX)', () => {
    const text = [
      'worktree /srv/repo.git',
      'bare',
      '',
      'worktree /srv/wt',
      `HEAD ${SHA_A}`,
      'branch refs/heads/x',
      '',
    ].join('\0');
    expect(parseWorktreeList(text, POSIX_PATHS)).toEqual([
      { path: '/srv/wt', branch: 'x', head: SHA_A, main: false },
    ]);
  });
});

describe('classifyPushFailure', () => {
  it.each([
    ['fatal: Authentication failed for https://example.invalid/r.git', 'auth'],
    ['fatal: could not read Username for https://example.invalid: terminal prompts disabled', 'auth'],
    ['git@example.invalid: Permission denied (publickey).', 'auth'],
    [' ! [rejected]        main -> main (fetch first)', 'rejected'],
    ['error: failed to push some refs\nhint: Updates were rejected because the tip is behind', 'rejected'],
    ['fatal: unable to access https://example.invalid/: Could not resolve host: example.invalid', 'network'],
    ['ssh: connect to host example.invalid port 22: Connection timed out', 'network'],
    ['error: src refspec main does not match any', 'other'],
  ] as const)('%s → %s', (stderr, reason) => {
    expect(classifyPushFailure(stderr)).toBe(reason);
  });
});
