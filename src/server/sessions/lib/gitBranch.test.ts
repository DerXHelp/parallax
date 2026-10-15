import { describe, expect, it, vi } from 'vitest';
import type { RunFileFn, RunFileResult } from '../../lib/process';
import { GIT_BRANCH_TIMEOUT_MS, readGitBranch } from './gitBranch';

const result = (p: Partial<RunFileResult>): RunFileResult => ({
  exitCode: 0,
  signal: null,
  stdout: 'main\n',
  stderr: '',
  timedOut: false,
  ...p,
});

describe('readGitBranch (R1-04: never a bare `git`)', () => {
  it('resolves git on the session PATH and runs rev-parse in the cwd with the session env', async () => {
    const runFile = vi.fn<RunFileFn>(() => Promise.resolve(result({ stdout: 'feature/x\r\n' })));
    const resolve = vi.fn(() => Promise.resolve('C:\\Program Files\\Git\\cmd\\git.exe'));
    const env = { PATH: 'C:\\Program Files\\Git\\cmd' };
    expect(await readGitBranch('D:\\repo', env, { resolve, runFile })).toBe('feature/x');
    expect(resolve).toHaveBeenCalledWith('git', env);
    expect(runFile).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd: 'D:\\repo',
        env,
        timeoutMs: GIT_BRANCH_TIMEOUT_MS,
        maxOutputBytes: 4096,
      },
    );
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
