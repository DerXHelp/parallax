import { describe, expect, it } from 'vitest';
import type { ProfileIssue } from '@shared/model';
import { profileIssueSchema } from '@shared/model';
import { sampleProfile, sampleProfileInput } from '@shared/samples';
import { errorCount, executableIssue, profileIssues, type ProfileIssueContext } from './profileIssues';

const EXE = 'C:\\Tools\\claude\\claude.exe';

function ctx(p: Partial<ProfileIssueContext> = {}): ProfileIssueContext {
  return {
    env: { USERPROFILE: 'C:\\Users\\u', Path: 'C:\\Windows' },
    persistentEnv: new Map(),
    exists: (file) => file.toLowerCase() === EXE.toLowerCase(),
    platform: 'win32',
    ...p,
  };
}

const error = (code: string, params: Record<string, unknown>): ProfileIssue =>
  profileIssueSchema.parse({ level: 'error', issue: { code, params } });
const warning = (code: string, params: Record<string, unknown>): ProfileIssue =>
  profileIssueSchema.parse({ level: 'warning', issue: { code, params } });
const info = (code: string, params: Record<string, unknown>): ProfileIssue =>
  profileIssueSchema.parse({ level: 'info', issue: { code, params } });

describe('profileIssues', () => {
  it.each<[string, Parameters<typeof sampleProfileInput>[0], ProfileIssue[]]>([
    ['a clean input', { env: {}, configDir: null }, []],
    ['a missing configDir folder is no finding', { configDir: 'D:\\does\\not\\exist' }, []],
    [
      'blocked, not allowed and invalid args (errors with ProfileArgIssueParams)',
      { args: ['--resume', 'x', 'stray', '--verbose', '--model'] },
      [
        error('PROFILE_ARG_BLOCKED', { index: 0, flag: '--resume' }),
        error('PROFILE_ARG_INVALID', { index: 2, flag: 'stray', reason: 'not_a_flag' }),
        error('PROFILE_ARG_NOT_ALLOWED', { index: 3, flag: '--verbose' }),
        error('PROFILE_ARG_INVALID', { index: 4, flag: '--model', reason: 'missing_value' }),
      ],
    ],
    [
      'warnings of severity warning and the info of passRaw',
      {
        args: [
          '--allowedTools',
          'Bash',
          '--dangerously-skip-permissions',
          '--append-system-prompt',
          'x',
          '--verbose',
        ],
        passRawArgs: true,
      },
      [
        warning('PROFILE_ARG_BROAD_ALLOWED_TOOLS', { index: 0, flag: '--allowedTools', value: 'Bash' }),
        warning('PROFILE_BYPASS_ENABLED', { index: 2, flag: '--dangerously-skip-permissions' }),
        warning('PROFILE_ARG_RESUME_NO_EFFECT', { index: 3, flag: '--append-system-prompt' }),
        info('PROFILE_ARG_PASSED_RAW', { index: 5, flag: '--verbose' }),
      ],
    ],
    [
      'an unresolved ${env:NAME} is a warning; a resolved one is fine',
      { env: { HOME_COPY: '${env:USERPROFILE}', TOKEN_REF: '${env:NOT_SET_ANYWHERE}' } },
      [warning('PROFILE_ENV_REF_UNRESOLVED', { name: 'NOT_SET_ANYWHERE', key: 'TOKEN_REF' })],
    ],
    [
      'an env value buildEnv cannot set is an error',
      { env: { BAD: 'a\0b' } },
      [error('VALIDATION_FAILED', { path: 'profile.env', key: 'BAD' })],
    ],
    [
      'an unsafe configDir',
      { configDir: '\\\\server\\share\\claude' },
      [error('PROFILE_INVALID', { field: 'configDir', reason: 'unsafe' })],
    ],
    [
      'a relative configDir is unsafe too',
      { configDir: 'claude-work' },
      [error('PROFILE_INVALID', { field: 'configDir', reason: 'unsafe' })],
    ],
    ['an existing absolute .exe', { executable: { kind: 'path', path: EXE } }, []],
    [
      'errors first, then warnings, then infos',
      {
        args: ['--verbose', '--dangerously-skip-permissions', '-p'],
        passRawArgs: true,
        executable: { kind: 'path', path: 'claude.exe' },
        env: { K: '${env:NOPE}' },
      },
      [
        error('PROFILE_ARG_BLOCKED', { index: 2, flag: '-p' }),
        error('PROFILE_INVALID', { field: 'executable', reason: 'not_absolute' }),
        warning('PROFILE_BYPASS_ENABLED', { index: 1, flag: '--dangerously-skip-permissions' }),
        warning('PROFILE_ENV_REF_UNRESOLVED', { name: 'NOPE', key: 'K' }),
        info('PROFILE_ARG_PASSED_RAW', { index: 0, flag: '--verbose' }),
      ],
    ],
  ])('%s', (_name, partial, expected) => {
    const issues = profileIssues(sampleProfileInput(partial), ctx());
    expect(issues).toEqual(expected);
  });

  it('accepts a stored profile as well as an input', () => {
    expect(profileIssues(sampleProfile({ args: ['--continue'] }), ctx())).toEqual([
      error('PROFILE_ARG_BLOCKED', { index: 0, flag: '--continue' }),
    ]);
  });

  it('resolves ${env:NAME} case-insensitively against the machine env', () => {
    const issues = profileIssues(
      sampleProfileInput({ env: { A: '${env:userprofile}' } }),
      ctx({ env: { USERPROFILE: 'C:\\Users\\u' } }),
    );
    expect(issues).toEqual([]);
  });

  it('counts errors', () => {
    const issues = profileIssues(
      sampleProfileInput({ args: ['-p', '--verbose'], configDir: '\\\\x\\y' }),
      ctx(),
    );
    expect(errorCount(issues)).toBe(3);
  });
});

describe('executableIssue', () => {
  const touched: string[] = [];
  const exists = (file: string): boolean => {
    touched.push(file);
    return file === EXE;
  };

  it.each<[string, string | null]>([
    [EXE, null],
    ['C:\\Tools\\claude\\other.exe', 'not_found'],
    ['C:\\Tools\\claude\\claude.cmd', 'not_exe'],
    ['C:\\Tools\\claude\\claude', 'not_exe'],
    ['claude.exe', 'not_absolute'],
    ['.\\claude.exe', 'not_absolute'],
    ['C:claude.exe', 'not_absolute'],
    ['\\\\server\\share\\claude.exe', 'unsafe'],
    ['//server/share/claude.exe', 'unsafe'],
    ['\\\\?\\C:\\claude.exe', 'unsafe'],
    ['C:\\Tools\\claude.exe:stream', 'unsafe'],
    ['C:\\Tools\\..\\claude.exe', 'unsafe'],
    ['C:\\Tools\\NUL.exe', 'unsafe'],
  ])('%s → %s', (file, reason) => {
    expect(executableIssue({ kind: 'path', path: file }, exists, 'win32')).toBe(reason);
  });

  it('never touches unsafe or relative paths, and auto needs no check', () => {
    touched.length = 0;
    executableIssue({ kind: 'path', path: '\\\\server\\share\\claude.exe' }, exists, 'win32');
    executableIssue({ kind: 'path', path: 'claude.exe' }, exists, 'win32');
    executableIssue({ kind: 'path', path: 'C:\\x\\claude.cmd' }, exists, 'win32');
    expect(executableIssue({ kind: 'auto' }, exists, 'win32')).toBeNull();
    expect(touched).toEqual([]);
  });

  it.each<[string, string | null]>([
    ['/home/u/.local/bin/claude', null],
    ['/opt/claude/claude', 'not_found'],
    ['claude', 'not_absolute'],
    ['./claude', 'not_absolute'],
    ['C:\\Tools\\claude\\claude.exe', 'not_absolute'],
    ['/home/u/../claude', 'unsafe'],
    ['/proc/self/exe', 'unsafe'],
  ])('POSIX (WP-103, B4): %s → %s – no extension required', (file, reason) => {
    const posixExists = (path: string): boolean => path === '/home/u/.local/bin/claude';
    expect(executableIssue({ kind: 'path', path: file }, posixExists, 'linux')).toBe(reason);
  });
});

describe('profileIssues on POSIX (WP-103, B4)', () => {
  const posixCtx = (): ProfileIssueContext => ({
    env: { HOME: '/home/u', home: 'other' },
    persistentEnv: new Map(),
    exists: (file) => file === '/home/u/.local/bin/claude',
    platform: 'linux',
  });

  it('accepts POSIX paths for the executable, configDir and --add-dir; refuses Windows paths', () => {
    expect(
      profileIssues(
        sampleProfileInput({
          executable: { kind: 'path', path: '/home/u/.local/bin/claude' },
          configDir: '/home/u/.claude-work',
          args: ['--add-dir', '/srv/shared'],
          env: { A: '${env:HOME}' },
        }),
        posixCtx(),
      ),
    ).toEqual([]);
    expect(
      profileIssues(
        sampleProfileInput({
          configDir: 'D:\\claude',
          args: ['--add-dir', 'D:\\a'],
          env: { A: '${env:Home}' },
        }),
        posixCtx(),
      ),
    ).toEqual([
      error('PROFILE_ARG_INVALID', { index: 0, flag: '--add-dir', reason: 'invalid_value' }),
      error('PROFILE_INVALID', { field: 'configDir', reason: 'unsafe' }),
      warning('PROFILE_ENV_REF_UNRESOLVED', { name: 'Home', key: 'A' }),
    ]);
  });
});
