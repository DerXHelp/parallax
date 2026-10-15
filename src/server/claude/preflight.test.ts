import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { sampleClaudeInstallStatus } from '@shared/samples';
import type { HomeAccess } from '../lib/homeAccess';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createClaudeIntegration } from './integration';
import { createMemoryFs } from '../lib/windows';
import {
  EDGE_POLICY_KEYS,
  antivirusProducts,
  checkAntivirus,
  checkEdge,
  checkEdgePolicies,
  checkHomeAccessResult,
  checkNode,
  checkPnpm,
  checkProfileStatus,
  checkRegistry,
  edgePolicyValues,
  findPnpm,
  formatPreflight,
  pnpmVersionFromUserAgent,
  preflightExitCode,
  redactRegistry,
  runPreflight,
  type PreflightCheck,
} from './preflight';
import { STANDARD_PROFILE } from './profiles';

const STANDARD = { id: STANDARD_PROFILE.id, name: STANDARD_PROFILE.name };
const LOGGED_OUT = { state: 'logged_out', method: null, apiProvider: null, subscriptionType: null } as const;

describe('rating', () => {
  it.each<[string, PreflightCheck['level']]>([
    ['v26.4.0', 'ok'],
    ['26.0.0', 'ok'],
    ['v24.11.1', 'warn'],
    ['v22.0.0', 'warn'],
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

  it('rates Edge and computes the exit code', () => {
    expect(checkEdge(null).level).toBe('fail');
    expect(checkEdge('C:\\edge\\msedge.exe').level).toBe('ok');
    expect(preflightExitCode([checkNode('v24.0.0'), checkRegistry(null)])).toBe(0);
    expect(preflightExitCode([checkNode('v26.0.0'), checkEdge(null)])).toBe(1);
  });

  it('formats an English report', () => {
    const text = formatPreflight([checkNode('v24.0.0'), checkEdge(null), checkRegistry('https://r/')]);
    expect(text).toBe(
      [
        'Parallax preflight',
        '  WARN  node      v24.0.0',
        '                  -> Node 26 is the standard version of this project.',
        '  FAIL  edge      not found',
        '                  -> Parallax opens its window with Microsoft Edge (App Paths or Program Files).',
        '  INFO  registry  https://r/',
        'Result: FAILED (1 failure, 1 warning)',
        '',
      ].join('\n'),
    );
  });
});

describe('antivirus hint (V1-08)', () => {
  it.each<[string[] | null, PreflightCheck['level'] | null, string]>([
    [['Kaspersky Premium'], 'warn', 'Kaspersky'],
    [['Windows Defender', 'ESET Security'], 'warn', 'ESET'],
    [['Bitdefender Antivirus Free'], 'warn', 'Bitdefender'],
    [['Windows Defender'], 'info', 'Windows Defender'],
    [['Kaspersky', 'Kaspersky', 'Windows Defender'], 'warn', 'Kaspersky (scans web traffic)'],
    [[], 'info', 'none registered'],
    [null, null, ''],
  ])('%j → %s', (products, level, detail) => {
    const check = checkAntivirus(products);
    if (level === null) {
      expect(check).toBeNull();
      return;
    }
    expect(check?.level).toBe(level);
    expect(check?.detail).toContain(detail);
    expect(checkAntivirus(['A', 'A'])?.detail).toBe('A');
    if (level === 'warn') expect(check?.hint).toMatch(/127\.0\.0\.1.*one-time login code/);
  });

  it('reads Windows Security Center without a shell and fails soft', async () => {
    const run = (file: string, args: readonly string[]) => {
      expect(file.toLowerCase()).toMatch(/system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
      expect(args.join(' ')).toContain('root/SecurityCenter2');
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: '["Kaspersky","Windows Defender"]',
        stderr: '',
        timedOut: false,
      });
    };
    if (process.platform === 'win32') {
      expect(await antivirusProducts(run)).toEqual(['Kaspersky', 'Windows Defender']);
      expect(
        await antivirusProducts(() =>
          Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'Invalid namespace',
            timedOut: false,
          }),
        ),
      ).toBeNull();
      expect(await antivirusProducts(() => Promise.reject(new Error('blocked')))).toBeNull();
    } else {
      expect(await antivirusProducts(run)).toBeNull();
    }
  });
});

describe('pnpm', () => {
  const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const PNPM_EXE = `${NPM}\\node_modules\\pnpm\\pnpm.exe`;

  it('uses npm_execpath (native exe or JS through node)', async () => {
    const fs = createMemoryFs({ [PNPM_EXE]: '', 'C:\\pnpm\\pnpm.cjs': '' });
    expect(await findPnpm({ npm_execpath: PNPM_EXE }, fs, 'C:\\node\\node.exe')).toEqual({
      file: PNPM_EXE,
      prefix: [],
    });
    expect(await findPnpm({ npm_execpath: 'C:\\pnpm\\pnpm.cjs' }, fs, 'C:\\node\\node.exe')).toEqual({
      file: 'C:\\node\\node.exe',
      prefix: ['C:\\pnpm\\pnpm.cjs'],
    });
  });

  it('falls back to where pnpm and resolves the npm shim', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm`]: '#!/bin/sh',
      [`${NPM}\\pnpm.cmd`]: '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n',
      [PNPM_EXE]: '',
    });
    expect(await findPnpm({ PATH: NPM }, fs, 'node.exe')).toEqual({ file: PNPM_EXE, prefix: [] });
    expect(await findPnpm({ PATH: 'C:\\empty' }, fs, 'node.exe')).toBeNull();
  });

  it('reads the version from the user agent', () => {
    expect(pnpmVersionFromUserAgent('pnpm/12.8.2 npm/? node/? win32 x64')).toBe('12.8.2');
    expect(pnpmVersionFromUserAgent('npm/10.0.0 node/v22')).toBeNull();
    expect(pnpmVersionFromUserAgent(undefined)).toBeNull();
  });
});

describe('Edge policies (V2-01)', () => {
  const v = (name: string, data: string) => ({
    key: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
    name,
    data,
  });

  it('no relevant policy: no line', () => {
    expect(checkEdgePolicies([])).toBeNull();
    expect(checkEdgePolicies([v('HomepageLocation', 'https://intranet')])).toBeNull();
  });

  it('policies that help (sign-in off, sync off) are only info', () => {
    expect(checkEdgePolicies([v('BrowserSignin', '0x0'), v('SyncDisabled', '0x1')])).toMatchObject({
      id: 'edge-policies',
      level: 'info',
      detail: 'BrowserSignin=0x0, SyncDisabled=0x1',
    });
  });

  it.each([
    ['BrowserSignin', '0x2'],
    ['ForceSync', '0x1'],
    ['ImplicitSignInEnabled', '0x1'],
    ['FeatureFlagOverridesControl', '0x0'],
    ['UserDataDir', 'D:\\EdgeData'],
    ['ConfigureOnPremisesAccountAutoSignIn', '0x1'],
  ])('%s=%s can override the switches → warn', (name, data) => {
    const check = checkEdgePolicies([v(name, data)]);
    expect(check).toMatchObject({ level: 'warn' });
    expect(check?.hint).toContain(name);
  });

  it('reads machine and user policies with reg query (64-bit view); missing keys have none', async () => {
    const asked: string[] = [];
    const values = await edgePolicyValues((key, view) => {
      asked.push(`${key} ${String(view)}`);
      return Promise.resolve(
        key.startsWith('HKCU') ? null : `\r\n${key}\r\n    BrowserSignin    REG_DWORD    0x2\r\n`,
      );
    });
    expect(asked).toEqual([
      'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge 64',
      'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge 64',
    ]);
    expect(values).toEqual([{ key: EDGE_POLICY_KEYS[0], name: 'BrowserSignin', data: '0x2' }]);
  });
});

describe('runPreflight', () => {
  const LOCAL = 'C:\\Users\\u\\.local\\bin\\claude.exe';
  const PNPM_EXE = 'C:\\pnpm\\pnpm.exe';
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const ok = (stdout: string): RunFileResult => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  });

  function stubs(files: Record<string, string>) {
    const calls: string[] = [];
    const fs = createMemoryFs(files);
    const runFile = (
      file: string,
      args: readonly string[],
      _options: RunFileOptions,
    ): Promise<RunFileResult> => {
      calls.push([file, ...args].join(' '));
      if (file === PNPM_EXE && args[0] === '--version') return Promise.resolve(ok('12.8.2\n'));
      if (file === PNPM_EXE) return Promise.resolve(ok('https://registry.npmjs.org/\n'));
      if (args[0] === '--version') return Promise.resolve(ok('2.1.300 (Claude Code)\n'));
      return Promise.resolve(
        ok('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'),
      );
    };
    const integration = createClaudeIntegration({
      appVersion: '0.0.0',
      baseEnv: () => ({ PATH: 'C:\\Users\\u\\.local\\bin' }),
      persistentEnv: () => Promise.resolve(null),
      fs,
      runFile,
      sdkClaudeCodeVersion: '2.1.296',
    });
    return { fs, runFile, integration, calls };
  }

  const env = { npm_execpath: PNPM_EXE, 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const sdk = { sdkVersion: '0.3.296', claudeCodeVersion: '2.1.296' };

  it('checks everything and exits 0', async () => {
    const { fs, runFile, integration, calls } = stubs({ [LOCAL]: '', [PNPM_EXE]: '', [EDGE]: '' });
    const report = await runPreflight({
      integration,
      nodeVersion: 'v26.4.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'C:\\node\\node.exe',
      sdk,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      antivirus: () => Promise.resolve(['Windows Defender']),
    });
    expect(report.checks.map((check) => [check.id, check.level])).toEqual([
      ['node', 'ok'],
      ['pnpm', 'ok'],
      ['registry', 'info'],
      ['sdk', 'info'],
      [`claude:${STANDARD_PROFILE_ID}`, 'ok'],
      [`login:${STANDARD_PROFILE_ID}`, 'ok'],
      ['edge', 'ok'],
      ['antivirus', 'info'],
    ]);
    expect(report.exitCode).toBe(0);
    // Only version/status commands – never a model call.
    expect(calls).toEqual([
      `${PNPM_EXE} --version`,
      `${PNPM_EXE} config get registry`,
      `${LOCAL} --version`,
      `${LOCAL} auth status --json`,
    ]);
  });

  it('fails without claude and Edge', async () => {
    const { fs, runFile, integration } = stubs({ [PNPM_EXE]: '' });
    const report = await runPreflight({
      integration,
      nodeVersion: 'v26.4.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'node.exe',
      sdk: null,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      antivirus: () => Promise.resolve(['Windows Defender']),
    });
    expect(report.checks.filter((check) => check.level === 'fail').map((check) => check.id)).toEqual([
      'sdk',
      `claude:${STANDARD_PROFILE_ID}`,
      'edge',
    ]);
    expect(report.exitCode).toBe(1);
  });

  it('checks the data folder when a home is given (R2-13: a warning, never a failure)', async () => {
    const { fs, runFile, integration } = stubs({ [LOCAL]: '', [PNPM_EXE]: '', [EDGE]: '' });
    const homes: string[] = [];
    const report = await runPreflight({
      integration,
      nodeVersion: 'v26.4.0',
      env,
      cwd: 'D:\\repo',
      nodeExecutable: 'node.exe',
      sdk,
      fs,
      runFile,
      regQuery: () => Promise.resolve(null),
      regKeyQuery: () => Promise.resolve(null),
      antivirus: () => Promise.resolve(null),
      home: 'D:\\px-data',
      homeAccess: (home) => {
        homes.push(home);
        return Promise.resolve({ kind: 'shared', principals: ['Authenticated Users'] });
      },
    });
    expect(homes).toEqual(['D:\\px-data']);
    expect(report.checks.at(-1)).toMatchObject({ id: 'home', level: 'warn' });
    expect(report.exitCode).toBe(0);
  });
});

describe('checkHomeAccessResult (R2-13)', () => {
  it.each<[HomeAccess, PreflightCheck['level'], string]>([
    [{ kind: 'private' }, 'ok', 'only you'],
    [{ kind: 'missing' }, 'info', 'not created yet'],
    [{ kind: 'unknown', reason: 'Get-Acl failed (exit 1)' }, 'info', 'Get-Acl failed'],
    [
      { kind: 'shared', principals: ['Authenticated Users', 'Users'] },
      'warn',
      'readable by Authenticated Users, Users',
    ],
  ])('%j → %s', (access, level, detail) => {
    const check = checkHomeAccessResult('D:\\px-data', access);
    expect(check.level).toBe(level);
    expect(check.detail).toContain(detail);
    if (level === 'warn') expect(check.hint).toContain('icacls "D:\\px-data" /inheritance:r');
  });
});
