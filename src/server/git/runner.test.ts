import { describe, expect, it, vi } from 'vitest';
import type { RunFileFn, RunFileResult } from '../lib/process';
import { CommandError } from '../sync/ports';
import {
  GIT_DETAIL_CHARS,
  GIT_LONG_TIMEOUT_MS,
  GIT_READ_TIMEOUT_MS,
  createGitRunner,
  gitArguments,
  gitEnvironment,
  gitFailure,
  scrubGitMessage,
  type GitCall,
} from './runner';

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

const result = (p: Partial<RunFileResult> = {}): RunFileResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...p,
});

const call = (p: Partial<GitCall> = {}): GitCall => ({
  cwd: 'D:\\repo',
  env: { PATH: 'C:\\Program Files\\Git\\cmd' },
  args: ['status'],
  op: 'status',
  mode: 'read',
  ...p,
});

async function errorOf(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

describe('git runner (WP-111, ADR-252)', () => {
  it('runs the absolute git with hardened reads; writes without the read hardening', async () => {
    const runFile = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'ok' })));
    const resolve = vi.fn(() => Promise.resolve(GIT));
    const runner = createGitRunner({ resolve, runFile, platform: 'win32' });
    expect(await runner.run(call({ env: { PATH: 'C:\\bin', GIT_DIR: 'D:\\other\\.git' } }))).toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      truncated: false,
    });
    const [file, args, options] = runFile.mock.calls[0] ?? [];
    expect(file).toBe(GIT);
    expect(args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'status']);
    expect(options).toMatchObject({ cwd: 'D:\\repo', timeoutMs: GIT_READ_TIMEOUT_MS });
    expect(options?.env).toEqual({
      PATH: 'C:\\bin',
      GIT_TERMINAL_PROMPT: '0',
      LANGUAGE: 'en',
      GIT_OPTIONAL_LOCKS: '0',
    });

    await runner.run(call({ mode: 'write', args: ['commit', '-m', 'x'], op: 'commit' }));
    const [, writeArgs, writeOptions] = runFile.mock.calls[1] ?? [];
    expect(writeArgs).toEqual(['--no-pager', 'commit', '-m', 'x']);
    expect(writeOptions).toMatchObject({ timeoutMs: GIT_LONG_TIMEOUT_MS });
    expect(writeOptions?.env).not.toHaveProperty('GIT_OPTIONAL_LOCKS');
    // The resolved git is reused for the same PATH.
    expect(resolve).toHaveBeenCalledTimes(2);
    await runner.run(call({ env: { PATH: 'C:\\bin' } }));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('GIT_NOT_FOUND without git or when the executable vanished; timeout; spawn failure', async () => {
    const none = createGitRunner({ resolve: () => Promise.resolve(null), runFile: vi.fn<RunFileFn>() });
    expect((await errorOf(none.run(call()))).error).toEqual({ code: 'GIT_NOT_FOUND', params: {} });

    const gone = createGitRunner({
      resolve: () => Promise.resolve(GIT),
      runFile: () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
    });
    expect((await errorOf(gone.run(call()))).error.code).toBe('GIT_NOT_FOUND');

    const busy = createGitRunner({
      resolve: () => Promise.resolve(GIT),
      runFile: () => Promise.reject(Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY' })),
    });
    expect((await errorOf(busy.run(call({ op: 'diff' })))).error).toEqual({
      code: 'GIT_FAILED',
      params: { op: 'diff', detail: 'spawn' },
    });

    const slow = createGitRunner({
      resolve: () => Promise.resolve(GIT),
      runFile: () => Promise.resolve(result({ timedOut: true, exitCode: null })),
    });
    expect((await errorOf(slow.run(call({ op: 'push' })))).error).toEqual({
      code: 'GIT_FAILED',
      params: { op: 'push', detail: 'timeout' },
    });
  });

  it('output beyond the cap is cut and reported', async () => {
    const runFile = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'x'.repeat(11) })));
    const runner = createGitRunner({ resolve: () => Promise.resolve(GIT), runFile });
    const out = await runner.run(call({ maxOutputBytes: 10 }));
    expect(out).toMatchObject({ stdout: 'x'.repeat(10), truncated: true });
    expect(runFile.mock.calls[0]?.[2]).toMatchObject({ maxOutputBytes: 11 });
  });

  it('ok(): NOT_A_GIT_REPO, GIT_FAILED with exit code and a scrubbed detail', async () => {
    const answers = [
      result({
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      }),
      result({
        exitCode: 1,
        stderr: '\nfatal: unable to access https://user:secret@example.invalid/r.git\n',
      }),
      result({ exitCode: 1, stdout: 'nothing to commit\n' }),
    ];
    const runner = createGitRunner({
      resolve: () => Promise.resolve(GIT),
      runFile: () => Promise.resolve(answers.shift() ?? result()),
    });
    expect((await errorOf(runner.ok(call()))).error).toEqual({
      code: 'NOT_A_GIT_REPO',
      params: { path: 'D:\\repo' },
    });
    expect((await errorOf(runner.ok(call({ op: 'push' })))).error).toEqual({
      code: 'GIT_FAILED',
      params: {
        op: 'push',
        exitCode: 1,
        detail: 'fatal: unable to access https://***@example.invalid/r.git',
      },
    });
    expect((await errorOf(runner.ok(call({ op: 'commit' })))).error).toEqual({
      code: 'GIT_FAILED',
      params: { op: 'commit', exitCode: 1, detail: 'nothing to commit' },
    });
  });
});

describe('pure parts of the runner', () => {
  it('gitEnvironment: redirect variables dropped by the platform rules of names', () => {
    const base = { Path: 'C:\\bin', git_dir: 'D:\\x', GIT_WORK_TREE: 'D:\\y', git_terminal_prompt: '1' };
    // Windows: one variable per name in any case (setEnvVar replaces the old spelling).
    expect(gitEnvironment(base, 'write', 'win32')).toEqual({
      Path: 'C:\\bin',
      GIT_TERMINAL_PROMPT: '0',
      LANGUAGE: 'en',
    });
    // Linux: names are exact – `git_dir` is not GIT_DIR.
    expect(gitEnvironment({ PATH: '/usr/bin', git_dir: '/x', GIT_DIR: '/y' }, 'read', 'linux')).toEqual({
      PATH: '/usr/bin',
      git_dir: '/x',
      GIT_TERMINAL_PROMPT: '0',
      LANGUAGE: 'en',
      GIT_OPTIONAL_LOCKS: '0',
    });
  });

  it('gitArguments, scrubGitMessage, gitFailure', () => {
    expect(gitArguments(['diff'], 'write')).toEqual(['--no-pager', 'diff']);
    expect(scrubGitMessage('\n  remote: ssh://me@host.example/x \u0007bell\nsecond')).toBe(
      'remote: ssh://***@host.example/x  bell',
    );
    expect(scrubGitMessage('y'.repeat(500))).toHaveLength(GIT_DETAIL_CHARS);
    expect(
      gitFailure({ op: 'status', cwd: 'D:\\r' }, { exitCode: null, stdout: '', stderr: '', truncated: false })
        .error,
    ).toEqual({
      code: 'GIT_FAILED',
      params: { op: 'status' },
    });
  });
});
