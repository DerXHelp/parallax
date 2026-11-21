import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { isValidGitRefName } from '@shared/model';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import { sampleGitWorktree, sampleProjectSettings, sampleTime } from '@shared/samples';
import {
  PROJECT_FOLDERS_MAX,
  distinctRoots,
  foldersToResolve,
  knownProjectRoots,
  sortProjectRoots,
} from './project-roots';
import { newWorktreeFolder } from './WorktreeFields';
import {
  anyWorktreeDefault,
  defaultWorktreeBranch,
  gitErrorDetail,
  mainWorktreeBranch,
  pickableWorktrees,
  projectKeyFor,
  projectSettingsFor,
  refIssue,
  worktreeRequest,
} from './worktree-lib';

/** WP-114: pure helpers of the worktree part of "New session" and of the section "Projects". */

describe('defaultWorktreeBranch', () => {
  it('suggests parallax/<6 chars> – a valid ref name, random by default', () => {
    expect(defaultWorktreeBranch(new Uint8Array([0, 1, 25, 26, 35, 36]))).toBe('parallax/abz09a');
    const random = defaultWorktreeBranch();
    expect(random).toMatch(/^parallax\/[a-z0-9]{6}$/);
    expect(isValidGitRefName(random)).toBe(true);
  });
});

describe('project settings lookup', () => {
  const projects = { 'D:\\work\\App': sampleProjectSettings({ worktreeDefault: true }) };

  it('finds the exact key, else the same folder by the host rules (case-insensitive on Windows only)', () => {
    expect(projectSettingsFor(projects, 'D:\\work\\App', WIN32_PATHS)?.worktreeDefault).toBe(true);
    expect(projectSettingsFor(projects, 'd:\\WORK\\app', WIN32_PATHS)?.worktreeDefault).toBe(true);
    expect(projectSettingsFor(projects, 'D:\\work\\other', WIN32_PATHS)).toBeNull();
    const posix = { '/home/me/app': sampleProjectSettings() };
    expect(projectSettingsFor(posix, '/home/me/App', POSIX_PATHS)).toBeNull();
    expect(projectSettingsFor(posix, '/home/me/app/', POSIX_PATHS)).not.toBeNull();
  });

  it('keeps an existing spelling of the key; a new project takes the root as given', () => {
    expect(projectKeyFor(projects, 'd:\\work\\app', WIN32_PATHS)).toBe('D:\\work\\App');
    expect(projectKeyFor(projects, 'D:\\work\\new', WIN32_PATHS)).toBe('D:\\work\\new');
  });

  it('knows whether any project starts in a worktree by default', () => {
    expect(anyWorktreeDefault({})).toBe(false);
    expect(anyWorktreeDefault({ 'D:\\a': sampleProjectSettings() })).toBe(false);
    expect(anyWorktreeDefault(projects)).toBe(true);
  });
});

describe('worktrees of a repository', () => {
  const list = [
    sampleGitWorktree(),
    sampleGitWorktree({ path: 'D:\\work\\sample\\.claude\\worktrees\\a', branch: 'feature/a', main: false }),
    sampleGitWorktree({ path: 'D:\\work\\sample\\.claude\\worktrees\\b', branch: null, main: false }),
  ];

  it('the main branch is the default base; only linked worktrees with a branch can be picked', () => {
    expect(mainWorktreeBranch(list)).toBe('main');
    expect(mainWorktreeBranch([])).toBeNull();
    expect(pickableWorktrees(list).map((worktree) => worktree.branch)).toEqual(['feature/a']);
  });

  it('builds the folder of a new worktree like the server (/ in the branch → -)', () => {
    expect(newWorktreeFolder('D:\\work\\sample', 'feature/login', WIN32_PATHS)).toBe(
      'D:\\work\\sample\\.claude\\worktrees\\feature-login',
    );
    expect(newWorktreeFolder('/home/me/app', 'fix', POSIX_PATHS)).toBe('/home/me/app/.claude/worktrees/fix');
  });
});

describe('worktree request', () => {
  it('checks branch and base like git (base may be empty = the server default)', () => {
    expect(refIssue('')).toBe('empty');
    expect(refIssue('', true)).toBeNull();
    expect(refIssue('has space')).toBe('invalid');
    expect(refIssue('a..b')).toBe('invalid');
    expect(refIssue(' feature/x ')).toBeNull();
  });

  it('new: trimmed branch, base only when given; existing: the chosen folder; invalid input → null', () => {
    expect(worktreeRequest({ mode: 'new', branch: ' feature/x ', base: '', path: null })).toEqual({
      mode: 'new',
      branch: 'feature/x',
    });
    expect(worktreeRequest({ mode: 'new', branch: 'feature/x', base: 'develop', path: null })).toEqual({
      mode: 'new',
      branch: 'feature/x',
      baseRef: 'develop',
    });
    expect(worktreeRequest({ mode: 'new', branch: 'bad name', base: '', path: null })).toBeNull();
    expect(worktreeRequest({ mode: 'new', branch: 'ok', base: '-x', path: null })).toBeNull();
    expect(worktreeRequest({ mode: 'existing', branch: '', base: '', path: 'D:\\w' })).toEqual({
      mode: 'existing',
      path: 'D:\\w',
    });
    expect(worktreeRequest({ mode: 'existing', branch: '', base: '', path: null })).toBeNull();
  });
});

describe('gitErrorDetail', () => {
  it('gives the detail the generic text leaves out, tolerant of missing params', () => {
    expect(
      gitErrorDetail(makeError('GIT_FAILED', { op: 'worktree_add', detail: 'fatal: invalid reference' })),
    ).toBe('fatal: invalid reference');
    expect(gitErrorDetail(makeError('GIT_FAILED', { op: 'worktree_add' }))).toBeNull();
    expect(gitErrorDetail(makeError('BRANCH_EXISTS', { branch: 'feature/x' }))).toBe('feature/x');
    expect(gitErrorDetail(makeError('WORKTREE_EXISTS', { path: 'D:\\w' }))).toBe('D:\\w');
    expect(gitErrorDetail(makeError('NOT_A_GIT_REPO', { path: 'D:\\x' }))).toBe('D:\\x');
    expect(gitErrorDetail(makeError('GIT_PUSH_FAILED', { reason: 'auth' }))).toBeNull();
    expect(gitErrorDetail(makeError('BRANCH_EXISTS'))).toBeNull();
    expect(gitErrorDetail(makeError('CWD_NOT_FOUND'))).toBeNull();
  });
});

describe('project roots of a computer', () => {
  const session = (cwd: string, minutes: number, repoRoot: string | null = null) => ({
    cwd,
    worktree: repoRoot === null ? null : { repoRoot },
    lastActivityAt: sampleTime(minutes * 60),
  });

  it('settings keys first, then worktree roots, one spelling per folder', () => {
    const sessions = [
      session('D:\\work\\app\\.claude\\worktrees\\x', 1, 'd:\\WORK\\app'),
      session('D:\\b', 2, 'D:\\b'),
    ];
    expect(knownProjectRoots(['D:\\work\\app'], sessions, WIN32_PATHS)).toEqual(['D:\\work\\app', 'D:\\b']);
    expect(distinctRoots(['/a', '/A', '/a'], POSIX_PATHS)).toEqual(['/a', '/A']);
  });

  it('asks git only for folders outside the known roots, newest first, each once, at most the limit', () => {
    const sessions = [
      session('D:\\work\\app\\src', 5),
      session('D:\\old', 1),
      session('D:\\new', 9),
      session('d:\\NEW', 3),
      session('D:\\work\\app\\.claude\\worktrees\\x', 10, 'D:\\work\\app'),
    ];
    // sampleTime(n) is n seconds after the sample start: later = newer.
    expect(foldersToResolve(sessions, ['D:\\work\\app'], WIN32_PATHS)).toEqual(['D:\\new', 'D:\\old']);
    const many = Array.from({ length: PROJECT_FOLDERS_MAX + 5 }, (_, n) => session(`D:\\p${String(n)}`, n));
    expect(foldersToResolve(many, [], WIN32_PATHS)).toHaveLength(PROJECT_FOLDERS_MAX);
  });

  it('sorts by folder name, then path', () => {
    expect(sortProjectRoots(['D:\\z\\beta', 'C:\\Alpha', 'D:\\alpha'], WIN32_PATHS)).toEqual([
      'C:\\Alpha',
      'D:\\alpha',
      'D:\\z\\beta',
    ]);
  });
});
