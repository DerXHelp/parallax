import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import type { Profile } from '@shared/model';
import { sampleClaudeInstallStatus, sampleId, sampleProfile } from '@shared/samples';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createClaudeIntegration } from './integration';
import { POSIX_PATHS } from '@shared/paths';
import { createMemoryFs } from '../lib/windows';
import {
  CHROME_POLICY_KEYS,
  checkChrome,
  checkChromePolicies,
  checkHomeLocation,
  checkNode,
  checkPnpm,
  checkProfileIssues,
  checkProfileStatus,
  checkProfilesSource,
  checkRegistry,
  chromePolicyValues,
  coversParallaxOrigin,
  describeProfileIssue,
  findPnpm,
  formatPreflight,
  loadPreflightProfiles,
  pnpmVersionFromUserAgent,
  preflightExitCode,
  redactRegistry,
  runPreflight,
  type PreflightCheck,
} from './preflight';
import { profileIssues } from './profileIssues';
import { PROFILES_FILE, type ProfilesFileRead } from './profileStore';
import { STANDARD_PROFILE, createProfileStore } from './profiles';

const STANDARD = { id: STANDARD_PROFILE.id, name: STANDARD_PROFILE.name };
const LOGGED_OUT = { state: 'logged_out', method: null, apiProvider: null, subscriptionType: null } as const;

describe('rating', () => {
  it.each<[string, PreflightCheck['level']]>([
    ['v26.12.0', 'ok'],
    ['26.9.0', 'ok'],
    ['v27.1.0', 'warn'],
    ['v26.8.2', 'fail'],
    ['v26.4.0', 'fail'],
    ['v24.11.1', 'fail'],
    ['v24.5.0', 'fail'],
    ['v22.20.0', 'fail'],
    ['v21.9.0', 'fail'],
    ['v18.20.0', 'fail'],
    ['garbage', 'fail'],
  ])('node %s → %s', (version, level) => {
    expect(checkNode(version).level).toBe(level);
  });

  it.each<[string | null, PreflightCheck['level']]>([
    ['12.8.2', 'ok'],
    ['12.8.0', 'ok'],
    ['12.11.2', 'ok'],
    ['13.0.0', 'ok'],
    ['12.7.9', 'fail'],
    ['9.15.0', 'fail'],
    ['weird', 'warn'],
    [null, 'warn'],
  ])('pnpm %s → %s', (version, level) => {
    expect(checkPnpm(version).level).toBe(level);
  });

  it.each([
    ['https://registry.npmjs.org/', 'https://registry.npmjs.org/'],
    ['https://user:secret@nexus.corp/repository/npm/?token=abc#x', 'https://nexus.corp/repository/npm/'],
    ['not a url //user:pw@host', 'not a url //host'],
  ])('redactRegistry(%s)', (input, output) => {
    expect(redactRegistry(input)).toBe(output);
  });

  it('shows the registry as info and warns if unknown', () => {
    expect(checkRegistry('https://nexus.corp/npm/')).toMatchObject({
      level: 'info',
      detail: 'https://nexus.corp/npm/',
    });
    expect(checkRegistry(null).level).toBe('warn');
  });

  it('rates a working profile', () => {
    expect(checkProfileStatus(STANDARD, sampleClaudeInstallStatus(), '2.1.296')).toEqual([
      {
        id: 'claude:standard',
        title: 'claude',
        level: 'ok',
        detail: 'C:\\Users\\user\\.local\\bin\\claude.exe, 2.1.300 (profile "Standard")',
      },
      {
        id: 'login:standard',
        title: 'login',
        level: 'ok',
        detail: 'logged in (claude.ai, firstParty, subscription max)',
      },
    ]);
  });

  it('WP-62: shows the tested version; a newer claude is a warning with the cli-check hint', () => {
    const same = checkProfileStatus(
      STANDARD,
      sampleClaudeInstallStatus({ testedVersion: '2.1.300' }),
      '2.1.296',
    );
    expect(same[0]).toEqual({
      id: 'claude:standard',
      title: 'claude',
      level: 'ok',
      detail: 'C:\\Users\\user\\.local\\bin\\claude.exe, 2.1.300 (tested 2.1.300, profile "Standard")',
    });
    const newer = checkProfileStatus(
      STANDARD,
      sampleClaudeInstallStatus({ version: '2.1.330', testedVersion: '2.1.322' }),
      '2.1.296',
    );
    expect(newer[0]).toMatchObject({
      level: 'warn',
      detail:
        'C:\\Users\\user\\.local\\bin\\claude.exe, 2.1.330 (tested 2.1.322, profile "Standard") – newer than tested',
    });
    expect(newer[0]?.hint).toContain('pnpm cli-check');
    expect(newer[1]?.level).toBe('ok');
    // Older than tested (e.g. a second profile with its own claude) is fine; too old stays a failure.
    expect(
      checkProfileStatus(
        STANDARD,
        sampleClaudeInstallStatus({ version: '2.1.300', testedVersion: '2.1.322' }),
        '2.1.296',
      )[0]?.level,
    ).toBe('ok');
    expect(
      checkProfileStatus(
        STANDARD,
        sampleClaudeInstallStatus({ version: '2.1.330', testedVersion: '2.1.322', versionStatus: 'too_old' }),
        '2.1.296',
      )[0]?.level,
    ).toBe('fail');
  });

  it.each<[string, Parameters<typeof sampleClaudeInstallStatus>[0], PreflightCheck['level'][]]>([
    ['too old (C.7: red)', { versionStatus: 'too_old' }, ['fail', 'ok']],
    ['unknown version', { versionStatus: 'unknown', version: null }, ['warn', 'ok']],
    ['logged out', { auth: LOGGED_OUT }, ['ok', 'fail']],
    ['auth error', { auth: { ...LOGGED_OUT, state: 'error' } }, ['ok', 'fail']],
    [
      'not found',
      { state: 'not_found', path: null, error: { code: 'CLAUDE_NOT_FOUND', params: {} } },
      ['fail'],
    ],
    [
      'broken exe',
      { state: 'error', error: { code: 'CLAUDE_SPAWN_FAILED', params: { reason: 'exit' } } },
      ['fail'],
    ],
    [
      'env issue',
      { state: 'error', path: null, error: { code: 'PROFILE_ENV_REF_UNRESOLVED', params: {} } },
      ['fail'],
    ],
  ])('rates %s', (_name, partial, levels) => {
    expect(
      checkProfileStatus(STANDARD, sampleClaudeInstallStatus(partial), '2.1.296').map((c) => c.level),
    ).toEqual(levels);
  });

  it('rates Chrome (path and version) and computes the exit code', () => {
    expect(checkChrome(null).level).toBe('fail');
    expect(checkChrome({ path: 'C:\\c\\chrome.exe', version: '156.0.8078.76' })).toEqual({
      id: 'chrome',
      title: 'chrome',
      level: 'ok',
      detail: 'C:\\c\\chrome.exe, 156.0.8078.76',
    });
    expect(checkChrome({ path: 'C:\\c\\chrome.exe', version: null })).toMatchObject({
      level: 'ok',
      detail: 'C:\\c\\chrome.exe (version unknown)',
    });
    expect(preflightExitCode([checkNode('v27.1.0'), checkRegistry(null)])).toBe(0);
    expect(preflightExitCode([checkNode('v26.12.0'), checkChrome(null)])).toBe(1);
  });

  it('formats an English report', () => {
    const text = formatPreflight([checkNode('v27.1.0'), checkChrome(null), checkRegistry('https://r/')]);
    expect(text).toBe(
      [
        'Parallax preflight',
        '  WARN  node      v27.1.0',
        '                  -> Node 26 is the standard version of this project.',
        '  FAIL  chrome    not found',
        '                  -> Parallax opens its window with Google Chrome (App Paths, Program Files or %LOCALAPPDATA%) - install Chrome.',
        '  INFO  registry  https://r/',
        'Result: FAILED (1 failure, 1 warning)',
        '',
      ].join('\n'),
    );
  });
});

describe('pnpm', () => {
  const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const PNPM_EXE = `${NPM}\\node_modules\\pnpm\\pnpm.exe`;

  it('uses npm_execpath (native exe or JS through node)', async () => {
    const fs = createMemoryFs({ [PNPM_EXE]: '', 'C:\\pnpm\\pnpm.cjs': '' });
    expect(await findPnpm({ npm_execpath: PNPM_EXE }, fs, 'C:\\node\\node.exe', 'win32')).toEqual({
      file: PNPM_EXE,
      prefix: [],
    });
    expect(await findPnpm({ npm_execpath: 'C:\\pnpm\\pnpm.cjs' }, fs, 'C:\\node\\node.exe', 'win32')).toEqual(
      {
        file: 'C:\\node\\node.exe',
        prefix: ['C:\\pnpm\\pnpm.cjs'],
      },
    );
  });

  it('POSIX (WP-103): npm_execpath as a JS file through node, else pnpm on PATH (no shims)', async () => {
    const fs = createMemoryFs(
      { '/home/u/.local/share/pnpm/pnpm': '', '/opt/pnpm/bin/pnpm.cjs': '' },
      { rules: POSIX_PATHS },
    );
    expect(
      await findPnpm({ npm_execpath: '/opt/pnpm/bin/pnpm.cjs' }, fs, '/usr/local/bin/node', 'linux'),
    ).toEqual({ file: '/usr/local/bin/node', prefix: ['/opt/pnpm/bin/pnpm.cjs'] });
    expect(
      await findPnpm({ PATH: '/home/u/.local/share/pnpm:/usr/bin' }, fs, '/usr/local/bin/node', 'linux'),
    ).toEqual({ file: '/home/u/.local/share/pnpm/pnpm', prefix: [] });
    expect(await findPnpm({ Path: '/home/u/.local/share/pnpm' }, fs, 'node', 'linux')).toBeNull();
  });

  it('falls back to where pnpm and resolves the npm shim', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm`]: '#!/bin/sh',
      [`${NPM}\\pnpm.cmd`]: '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n',
      [PNPM_EXE]: '',
    });
    expect(await findPnpm({ PATH: NPM }, fs, 'node.exe', 'win32')).toEqual({ file: PNPM_EXE, prefix: [] });
    expect(await findPnpm({ PATH: 'C:\\empty' }, fs, 'node.exe', 'win32')).toBeNull();
  });

  it('reads the version from the user agent', () => {
    expect(pnpmVersionFromUserAgent('pnpm/12.8.2 npm/? node/? win32 x64')).toBe('12.8.2');
    expect(pnpmVersionFromUserAgent('npm/10.0.0 node/v22')).toBeNull();
    expect(pnpmVersionFromUserAgent(undefined)).toBeNull();
  });
});

describe('Chrome policies (ADR-136)', () => {
  const v = (name: string, data: string) => ({
    key: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
    name,
    data,
  });

  it('no relevant policy: an OK line "none" (WP22-11 – the output shows that it was checked)', () => {
    const none = { id: 'chrome-policies', title: 'chrome policies', level: 'ok', detail: 'none' };
    expect(checkChromePolicies([])).toEqual(none);
    expect(checkChromePolicies([v('HomepageLocation', 'https://intranet')])).toEqual(none);
  });

  it('policies that do not override Parallax are only info (sync stays off by --disable-sync)', () => {
    expect(
      checkChromePolicies([
        v('BrowserSignin', '0x0'),
        v('SyncDisabled', '0x0'),
        v('DefaultNotificationsSetting', '0x1'),
        v('AutoplayAllowed', '0x1'),
        v('URLBlocklist', 'https://ads.example.invalid'),
      ]),
    ).toEqual({
      id: 'chrome-policies',
      title: 'chrome policies',
      level: 'info',
      detail:
        'BrowserSignin=0x0, SyncDisabled=0x0, DefaultNotificationsSetting=0x1, AutoplayAllowed=0x1, ' +
        'URLBlocklist=https://ads.example.invalid',
    });
  });

  it.each([
    ['BrowserSignin', '0x2', 'forces a Google sign-in'],
    ['ForceBrowserSignin', '0x1', 'forces a Google sign-in'],
    ['UserDataDir', 'D:\\ChromeData', 'replaces the own profile folder'],
    ['BrowserGuestModeEnforced', '0x1', 'guest'],
    ['IncognitoModeAvailability', '0x2', 'incognito'],
    ['ProfilePickerOnStartupAvailability', '0x2', 'profile picker'],
    ['DefaultNotificationsSetting', '0x2', 'Windows notifications instead'],
    ['NotificationsBlockedForUrls', 'http://127.0.0.1:*', 'Windows notifications instead'],
    ['AutoplayAllowed', '0x0', 'mutes sounds'],
    ['URLBlocklist', '*', 'blocks the Parallax page'],
  ])('%s=%s overrides the app window → warn', (name, data, effect) => {
    const check = checkChromePolicies([v(name, data)]);
    expect(check).toMatchObject({ id: 'chrome-policies', level: 'warn', detail: `${name}=${data}` });
    expect(check.hint).toContain(`${name} `);
    expect(check.hint).toContain(effect);
    expect(check.hint).toContain('chrome://policy');
  });

  it('several risky entries of one list name it once in the hint', () => {
    const check = checkChromePolicies([v('URLBlocklist', '127.0.0.1'), v('URLBlocklist', 'http://*')]);
    expect(check.detail).toBe('URLBlocklist=127.0.0.1, URLBlocklist=http://*');
    expect(check.hint?.match(/URLBlocklist/g)).toHaveLength(1);
  });

  it.each<[string, boolean]>([
    ['*', true],
    ['127.0.0.1', true],
    ['http://127.0.0.1:4711', true],
    ['[*.]127.0.0.1', true],
    ['http://*', true],
    ['HTTP://*:*/', true],
    ['https://*', false],
    ['localhost', false],
    ['example.invalid', false],
  ])('coversParallaxOrigin(%s) = %s', (pattern, expected) => {
    expect(coversParallaxOrigin(pattern)).toBe(expected);
  });

  it('reads machine and user policies plus the list subkeys (64-bit view); missing keys have none', async () => {
    const asked: string[] = [];
    const HKLM = CHROME_POLICY_KEYS[0];
    const values = await chromePolicyValues((key, view) => {
      asked.push(`${key} ${String(view)}`);
      if (key === HKLM) return Promise.resolve(`\r\n${key}\r\n    BrowserSignin    REG_DWORD    0x2\r\n`);
      if (key === `${HKLM}\\URLBlocklist`) {
        return Promise.resolve(
          `\r\n${key}\r\n    1    REG_SZ    *\r\n    2    REG_SZ    example.invalid\r\n`,
        );
      }
      return Promise.resolve(null);
    });
    expect(asked).toEqual([
      'HKLM\\SOFTWARE\\Policies\\Google\\Chrome 64',
      'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\URLBlocklist 64',
      'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\NotificationsBlockedForUrls 64',
      'HKCU\\SOFTWARE\\Policies\\Google\\Chrome 64',
    ]);
    expect(values).toEqual([
      { key: HKLM, name: 'BrowserSignin', data: '0x2' },
      { key: `${HKLM}\\URLBlocklist`, name: 'URLBlocklist', data: '*' },
      { key: `${HKLM}\\URLBlocklist`, name: 'URLBlocklist', data: 'example.invalid' },
    ]);
  });
});

describe('runPreflight', () => {
  const LOCAL = 'C:\\Users\\u\\.local\\bin\\claude.exe';
  const PNPM_EXE = 'C:\\pnpm\\pnpm.exe';
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const versions: string[] = [];
  /** Never reads a real exe (a test path may exist on the machine). */
  const exeVersion = (file: string) => {
    versions.push(file);
    return Promise.resolve('156.0.8078.76');
  };
  const ok = (stdout: string): RunFileResult => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  });

  function stubs(files: Record<string, string>, profiles?: Profile[]) {
    const calls: string[] = [];
    const envs: (Record<string, string> | undefined)[] = [];
    const fs = createMemoryFs(files);
    const runFile = (
      file: string,
      args: readonly string[],
      options: RunFileOptions,
    ): Promise<RunFileResult> => {
      calls.push([file, ...args].join(' '));
      envs.push(options.env);
      if (file === PNPM_EXE && args[0] === '--version') return Promise.resolve(ok('12.8.2\n'));
      if (file === PNPM_EXE) return Promise.resolve(ok('https://registry.npmjs.org/\n'));
      if (args[0] === '--version') return Promise.resolve(ok('2.1.300 (Claude Code)\n'));
      return Promise.resolve(
        ok('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'),
      );
    };
    const integration = createClaudeIntegration({
      appVersion: '0.0.0',
      platform: 'win32',
      baseEnv: () => ({ PATH: 'C:\\Users\\u\\.local\\bin' }),
      persistentEnv: () => Promise.resolve(null),
      fs,
      runFile,
      sdkClaudeCodeVersion: '2.1.296',
      ...(profiles === undefined ? {} : { profiles: createProfileStore(profiles) }),
    });
    return { fs, runFile, integration, calls, envs };
  }

  const env = { npm_execpath: PNPM_EXE, ProgramFiles: 'C:\\Program Files' };
  const sdk = { sdkVersion: '0.3.296', claudeCodeVersion: '2.1.296' };

  it('checks everything and exits 0', async () => {
    const { fs, runFile, integration, calls } = stubs({ [LOCAL]: '', [PNPM_EXE]: '', [CHROME]: '' });
    const report = await runPreflight({
      platform: 'win32',
      integration,
      nodeVersion: 'v26.12.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'C:\\node\\node.exe',
      sdk,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      exeVersion,
    });
    expect(report.checks.map((check) => [check.id, check.level])).toEqual([
      ['node', 'ok'],
      ['pnpm', 'ok'],
      ['registry', 'info'],
      ['sdk', 'info'],
      [`claude:${STANDARD_PROFILE_ID}`, 'ok'],
      [`login:${STANDARD_PROFILE_ID}`, 'ok'],
      ['chrome', 'ok'],
      ['chrome-policies', 'ok'],
    ]);
    expect(report.exitCode).toBe(0);
    expect(report.checks.find((check) => check.id === 'chrome')?.detail).toBe(`${CHROME}, 156.0.8078.76`);
    expect(versions.at(-1)).toBe(CHROME);
    // Only version/status commands – never a model call (and never chrome.exe).
    expect(calls).toEqual([
      `${PNPM_EXE} --version`,
      `${PNPM_EXE} config get registry`,
      `${LOCAL} --version`,
      `${LOCAL} auth status --json`,
    ]);
  });

  it('checks every profile of the data folder, reading profiles.json without writing (WP-32)', async () => {
    const home = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp32-preflight-'));
    const work = sampleId('pf', 1);
    const broken = sampleId('pf', 2);
    const text = `${JSON.stringify({
      schemaVersion: 1,
      profiles: [
        sampleProfile({ isDefault: false }),
        sampleProfile({
          id: work,
          name: 'Work',
          builtin: false,
          isDefault: true,
          configDir: 'D:\\claude\\work',
        }),
        sampleProfile({
          id: broken,
          name: 'Broken',
          builtin: false,
          isDefault: false,
          args: ['--resume', 'x'],
          env: { K: '${env:NOPE_NOT_SET}' },
        }),
      ],
    })}\n`;
    await writeFile(path.join(home, PROFILES_FILE), text, 'utf8');

    const { profiles, source } = await loadPreflightProfiles(home);
    const { fs, runFile, integration, calls, envs } = stubs(
      { [LOCAL]: '', [PNPM_EXE]: '', [CHROME]: '' },
      profiles,
    );
    const report = await runPreflight({
      platform: 'win32',
      integration,
      nodeVersion: 'v26.12.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'node.exe',
      sdk,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      exeVersion,
      profilesSource: source,
      profileIssues: (profile) =>
        profileIssues(profile, { env: {}, persistentEnv: new Map(), exists: () => true, platform: 'win32' }),
    });
    expect(report.checks.map((check) => [check.id, check.level])).toEqual([
      ['node', 'ok'],
      ['pnpm', 'ok'],
      ['registry', 'info'],
      ['sdk', 'info'],
      ['profiles', 'ok'],
      [`claude:${STANDARD_PROFILE_ID}`, 'ok'],
      [`login:${STANDARD_PROFILE_ID}`, 'ok'],
      [`claude:${work}`, 'ok'],
      [`login:${work}`, 'ok'],
      [`config:${broken}`, 'fail'],
      [`claude:${broken}`, 'fail'],
      ['chrome', 'ok'],
      ['chrome-policies', 'ok'],
    ]);
    expect(report.checks.find((check) => check.id === 'profiles')?.detail).toBe('3 from profiles.json');
    expect(report.checks.find((check) => check.id === `config:${broken}`)?.detail).toBe(
      'PROFILE_ARG_BLOCKED (flag=--resume, index=0) (profile "Broken")',
    );
    expect(report.exitCode).toBe(1);
    // Each profile is checked with its own env (Work: its config dir); the broken env never runs claude.
    const workCalls = envs.filter((e) => e?.CLAUDE_CONFIG_DIR === 'D:\\claude\\work');
    expect(workCalls).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith(LOCAL))).toHaveLength(4);
    // Read-only: the file is untouched, nothing else was written.
    expect(await readFile(path.join(home, PROFILES_FILE), 'utf8')).toBe(text);
    expect(await readdir(home)).toEqual([PROFILES_FILE]);
  });

  it('fails without claude and Chrome', async () => {
    const { fs, runFile, integration } = stubs({ [PNPM_EXE]: '' });
    const report = await runPreflight({
      platform: 'win32',
      integration,
      nodeVersion: 'v26.12.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'node.exe',
      sdk: null,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      exeVersion,
    });
    expect(report.checks.filter((check) => check.level === 'fail').map((check) => check.id)).toEqual([
      'sdk',
      `claude:${STANDARD_PROFILE_ID}`,
      'chrome',
    ]);
    expect(report.exitCode).toBe(1);
  });

  it('names the data folder when a home is given (R2-13: a hint, never a failure, no query)', async () => {
    const { fs, runFile, integration } = stubs({ [LOCAL]: '', [PNPM_EXE]: '', [CHROME]: '' });
    const report = await runPreflight({
      platform: 'win32',
      integration,
      nodeVersion: 'v26.12.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'node.exe',
      sdk,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      exeVersion,
      home: 'D:\\px-data',
    });
    expect(report.checks.at(-1)).toMatchObject({ id: 'home', level: 'info' });
    expect(report.exitCode).toBe(0);
  });
});

describe('profiles (WP-32)', () => {
  it.each<[string, ProfilesFileRead | null, PreflightCheck['level'], string]>([
    ['no data folder', null, 'info', 'built-in "Standard" (data folder unknown)'],
    ['no file', { kind: 'missing' }, 'info', 'built-in "Standard" (no profiles.json yet)'],
    [
      'a consistent file',
      { kind: 'ok', profiles: [STANDARD_PROFILE], repairs: [] },
      'ok',
      '1 from profiles.json',
    ],
    [
      'a file the server repairs',
      { kind: 'ok', profiles: [STANDARD_PROFILE], repairs: ['standard_added'] },
      'warn',
      '1 from profiles.json (inconsistent: standard_added)',
    ],
    [
      'a newer file',
      { kind: 'newer', version: 2 },
      'warn',
      'profiles.json was written by a newer Parallax (schemaVersion 2) – only "Standard" checked',
    ],
    [
      'an unreadable file',
      { kind: 'invalid', reason: 'json' },
      'warn',
      'profiles.json is unreadable (json) – only "Standard" checked',
    ],
  ])('%s', (_name, read, level, detail) => {
    expect(checkProfilesSource(read)).toMatchObject({ id: 'profiles', level, detail });
  });

  it('loadPreflightProfiles without a data folder: only "Standard"', async () => {
    const { profiles, source } = await loadPreflightProfiles(null);
    expect(profiles).toEqual([STANDARD_PROFILE]);
    expect(source.level).toBe('info');
  });

  it('lists errors (fail) before warnings (warn); infos alone give no line', () => {
    const profile = { id: STANDARD_PROFILE_ID, name: 'Standard' } as const;
    const blocked = {
      level: 'error',
      issue: { code: 'PROFILE_ARG_BLOCKED', params: { index: 0, flag: '-p' } },
    } as const;
    const bypass = {
      level: 'warning',
      issue: { code: 'PROFILE_BYPASS_ENABLED', params: { index: 1, flag: '--dangerously-skip-permissions' } },
    } as const;
    const raw = {
      level: 'info',
      issue: { code: 'PROFILE_ARG_PASSED_RAW', params: { index: 2, flag: '--x' } },
    } as const;
    expect(checkProfileIssues(profile, [blocked, bypass, raw])).toMatchObject({
      id: `config:${STANDARD_PROFILE_ID}`,
      level: 'fail',
      detail: 'PROFILE_ARG_BLOCKED (flag=-p, index=0) (profile "Standard")',
    });
    expect(checkProfileIssues(profile, [bypass, raw])).toMatchObject({
      level: 'warn',
      detail: 'PROFILE_BYPASS_ENABLED (flag=--dangerously-skip-permissions, index=1) (profile "Standard")',
    });
    expect(checkProfileIssues(profile, [raw])).toBeNull();
    expect(checkProfileIssues(profile, [])).toBeNull();
    expect(
      describeProfileIssue({ code: 'PROFILE_INVALID', params: { field: 'executable', reason: 'not_found' } }),
    ).toBe('PROFILE_INVALID (field=executable, reason=not_found)');
  });
});

describe('checkHomeLocation (R2-13, ADR-229)', () => {
  it('trusts %LOCALAPPDATA% and only hints elsewhere – without querying any rights', () => {
    const local = 'C:\\Users\\<USER>\\AppData\\Local';
    expect(checkHomeLocation(`${local}\\Parallax`, local, 'win32').level).toBe('ok');
    expect(checkHomeLocation('c:\\users\\<user>\\appdata\\local\\parallax', local, 'win32').level).toBe('ok');
    expect(checkHomeLocation(`${local}X\\Parallax`, local, 'win32').level).toBe('info');
    const outside = checkHomeLocation('D:\\px-data', local, 'win32');
    expect(outside.level).toBe('info');
    expect(outside.hint).toContain('icacls "D:\\px-data" /inheritance:r');
    expect(checkHomeLocation('D:\\px-data', undefined, 'win32').level).toBe('info');
  });

  it('POSIX (WP-103): a hint with chmod 700, never a query', () => {
    const check = checkHomeLocation('/home/u/.local/share/parallax', undefined, 'linux');
    expect(check).toMatchObject({ id: 'home', level: 'info' });
    expect(check.hint).toContain("chmod 700 '/home/u/.local/share/parallax'");
  });
});
