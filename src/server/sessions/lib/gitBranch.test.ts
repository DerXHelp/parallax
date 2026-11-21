import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTestRepo } from '../../git/testRepo';
import type { RunFileFn, RunFileResult } from '../../lib/process';
import {
  GIT_BRANCH_TIMEOUT_MS,
  GIT_HEAD_WATCH_MAX,
  gitHeadWatchCount,
  readGitBranch,
  watchGitHead,
  type GitHeadWatch,
  type GitHeadWatchDeps,
} from './gitBranch';

const result = (p: Partial<RunFileResult>): RunFileResult => ({
  exitCode: 0,
  signal: null,
  stdout: 'main\n',
  stderr: '',
  timedOut: false,
  ...p,
});

/** What the git runner puts before every reading call (CR8). */
const READ_PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false'];

/** A watch that is never triggered (CR8 test). */
function fakeWatchOnce(): { watch: NonNullable<GitHeadWatchDeps['watch']> } {
  return {
    watch: () => ({
      close: () => undefined,
      on: () => undefined as never,
    }),
  };
}

describe('readGitBranch (R1-04: never a bare `git`)', () => {
  it('resolves git on the session PATH and runs rev-parse in the cwd with the session env', async () => {
    const runFile = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'feature/x\r\n' })));
    const resolve = vi.fn(() => Promise.resolve('C:\\Program Files\\Git\\cmd\\git.exe'));
    const env = { PATH: 'C:\\Program Files\\Git\\cmd' };
    expect(await readGitBranch('D:\\repo', env, { resolve, runFile })).toBe('feature/x');
    expect(resolve).toHaveBeenCalledWith('git', env);
    expect(runFile).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      [...READ_PREFIX, 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: 'D:\\repo', timeoutMs: GIT_BRANCH_TIMEOUT_MS }),
    );
  });

  it('CR8: through the git runner – no GIT_DIR/GIT_WORK_TREE of the session, no prompt, no locks', async () => {
    const runFile = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'main\n' })));
    const resolve = () => Promise.resolve('C:\\git\\git.exe');
    const env = { PATH: 'C:\\git', GIT_DIR: 'D:\\other\\.git', GIT_WORK_TREE: 'D:\\other' };
    expect(await readGitBranch('D:\\repo', env, { resolve, runFile })).toBe('main');
    const options = runFile.mock.calls[0]?.[2];
    expect(options?.env).not.toHaveProperty('GIT_DIR');
    expect(options?.env).not.toHaveProperty('GIT_WORK_TREE');
    expect(options?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    const { watch } = fakeWatchOnce();
    const watchRun = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'D:/repo/.git\n' })));
    const handle = await watchGitHead('D:\\repo', env, vi.fn(), { resolve, runFile: watchRun, watch });
    expect(handle).not.toBeNull();
    expect(watchRun.mock.calls[0]?.[2].env).not.toHaveProperty('GIT_DIR');
    handle?.close();
  });

  it('V3-11: a fresh repository without a commit – the branch from `git branch --show-current`', async () => {
    const runFile = vi.fn<RunFileFn>((_file, args) =>
      Promise.resolve(
        args.includes('rev-parse')
          ? result({ exitCode: 128, stdout: 'HEAD\n', stderr: "fatal: ambiguous argument 'HEAD'" })
          : result({ stdout: 'main\n' }),
      ),
    );
    const resolve = () => Promise.resolve('C:\\git\\git.exe');
    expect(await readGitBranch('D:\\fresh', {}, { resolve, runFile })).toBe('main');
    expect(runFile.mock.calls.map((call) => call[1].slice(READ_PREFIX.length))).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['branch', '--show-current'],
    ]);
    // Detached HEAD in the fallback (empty output) and a second failure → null.
    runFile.mockImplementation((_file, args) =>
      Promise.resolve(args.includes('rev-parse') ? result({ exitCode: 128 }) : result({ stdout: '\n' })),
    );
    expect(await readGitBranch('D:\\fresh', {}, { resolve, runFile })).toBeNull();
    // A repository with commits needs only one call.
    runFile.mockClear();
    runFile.mockImplementation(() => Promise.resolve(result({ stdout: 'dev\n' })));
    expect(await readGitBranch('D:\\repo', {}, { resolve, runFile })).toBe('dev');
    expect(runFile).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<RunFileResult> | 'nogit' | 'throws']>([
    ['no git on the PATH', 'nogit'],
    ['not a repository', { exitCode: 128, stdout: '' }],
    ['detached HEAD', { stdout: 'HEAD\n' }],
    ['timeout', { timedOut: true }],
    ['spawn error', 'throws'],
  ])('%s → null', async (_name, answer) => {
    const runFile = vi.fn<RunFileFn>(() =>
      answer === 'throws'
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(result(answer === 'nogit' ? {} : answer)),
    );
    const resolve = () => Promise.resolve(answer === 'nogit' ? null : 'C:\\git\\git.exe');
    expect(await readGitBranch('D:\\repo', {}, { resolve, runFile })).toBeNull();
    if (answer === 'nogit') expect(runFile).not.toHaveBeenCalled();
  });

  it('the real resolver with an empty PATH starts nothing', async () => {
    const runFile = vi.fn<RunFileFn>();
    expect(await readGitBranch('D:\\repo', {}, { runFile })).toBeNull();
    expect(runFile).not.toHaveBeenCalled();
  });
});

describe('watchGitHead (WP-111)', () => {
  type Listener = (event: string, filename: string | null) => void;

  function fakeWatch() {
    const watchers: { folder: string; listener: Listener; emitter: EventEmitter; closed: boolean }[] = [];
    const watch: NonNullable<GitHeadWatchDeps['watch']> = (folder, listener) => {
      const emitter = new EventEmitter();
      const entry = { folder, listener, emitter, closed: false };
      watchers.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
          return undefined as never;
        },
      };
    };
    return { watchers, watch };
  }

  const gitDirOf = (dir: string) => ({
    resolve: () => Promise.resolve('C:\\git.exe'),
    runFile: vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: `${dir}\n` }))),
  });

  it('watches the git folder; HEAD and HEAD.lock report once after the pause, other files never', async () => {
    vi.useFakeTimers();
    try {
      const { watchers, watch } = fakeWatch();
      const deps = gitDirOf('D:/repo/.git/worktrees/x');
      const onChange = vi.fn();
      const handle = await watchGitHead('D:\\repo\\wt', { PATH: 'C:\\bin' }, onChange, {
        ...deps,
        watch,
        debounceMs: 50,
      });
      expect(handle?.gitDir).toBe('D:/repo/.git/worktrees/x');
      expect(deps.runFile.mock.calls[0]?.[1]).toEqual([...READ_PREFIX, 'rev-parse', '--absolute-git-dir']);
      expect(watchers[0]?.folder).toBe('D:/repo/.git/worktrees/x');
      const before = gitHeadWatchCount();
      watchers[0]?.listener('rename', 'index');
      watchers[0]?.listener('rename', 'HEAD.lock');
      watchers[0]?.listener('change', 'HEAD');
      vi.advanceTimersByTime(49);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      handle?.close();
      handle?.close();
      expect(gitHeadWatchCount()).toBe(before - 1);
      expect(watchers[0]?.closed).toBe(true);
      watchers[0]?.listener('change', 'HEAD');
      vi.advanceTimersByTime(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('null without git, outside a repository; an error of the folder ends the watch', async () => {
    const { watchers, watch } = fakeWatch();
    expect(
      await watchGitHead('D:\\x', {}, vi.fn(), { resolve: () => Promise.resolve(null), watch }),
    ).toBeNull();
    const outside = {
      resolve: () => Promise.resolve('C:\\git.exe'),
      runFile: vi.fn<RunFileFn>(() => Promise.resolve(result({ exitCode: 128, stdout: '' }))),
    };
    expect(await watchGitHead('D:\\x', {}, vi.fn(), { ...outside, watch })).toBeNull();
    expect(watchers).toHaveLength(0);

    const before = gitHeadWatchCount();
    const handle = await watchGitHead('D:\\r', {}, vi.fn(), { ...gitDirOf('D:/r/.git'), watch });
    expect(gitHeadWatchCount()).toBe(before + 1);
    watchers[0]?.emitter.emit('error', new Error('EPERM'));
    expect(gitHeadWatchCount()).toBe(before);
    expect(watchers[0]?.closed).toBe(true);
    handle?.close();
    expect(gitHeadWatchCount()).toBe(before);
  });

  it(`at most ${GIT_HEAD_WATCH_MAX.toString()} watches at a time`, async () => {
    const { watch } = fakeWatch();
    const handles: GitHeadWatch[] = [];
    try {
      while (gitHeadWatchCount() < GIT_HEAD_WATCH_MAX) {
        const handle = await watchGitHead('D:\\r', {}, vi.fn(), { ...gitDirOf('D:/r/.git'), watch });
        if (handle === null) throw new Error('unexpected null below the limit');
        handles.push(handle);
      }
      expect(await watchGitHead('D:\\r', {}, vi.fn(), { ...gitDirOf('D:/r/.git'), watch })).toBeNull();
    } finally {
      for (const handle of handles) handle.close();
    }
  });

  it(
    'a real repository: `git switch -c` in the worktree reports the change',
    { timeout: 30_000 },
    async () => {
      const repo = await createTestRepo();
      const onChange = vi.fn();
      const handle = await watchGitHead(repo.root, repo.env, onChange, { debounceMs: 20 });
      expect(handle).not.toBeNull();
      try {
        await repo.git(['switch', '-q', '-c', 'feature/watch']);
        await vi.waitFor(
          () => {
            expect(onChange).toHaveBeenCalled();
          },
          { timeout: 10_000, interval: 50 },
        );
      } finally {
        handle?.close();
      }
    },
  );
});
