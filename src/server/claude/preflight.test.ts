import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { sampleClaudeInstallStatus } from '@shared/samples';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createClaudeIntegration } from './integration';
import {
  checkEdge,
  checkNode,
  checkPnpm,
  checkProfileStatus,
  checkRegistry,
  findEdge,
  findPnpm,
  formatPreflight,
  parseRegDefaultValue,
  pnpmVersionFromUserAgent,
  preflightExitCode,
  redactRegistry,
  runPreflight,
  type PreflightCheck,
  type RegQuery,
} from './preflight';
import { STANDARD_PROFILE } from './profiles';
import { createMemoryFs } from './resolveClaude';

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

describe('Edge (C.9)', () => {
  const EN = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    '    (Default)    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '    Path    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    '',
  ].join('\r\n');
  const DE = EN.replace('(Default)', '(Standard)');
  const EXPAND =
    '    (Standard)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe"\r\n';
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  it.each([
    ['English', EN, EDGE],
    ['German', DE, EDGE],
    ['expand + quotes', EXPAND, 'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['nothing', 'ERROR: not found', null],
  ])('parseRegDefaultValue: %s', (_name, output, value) => {
    expect(parseRegDefaultValue(output, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(value);
  });

  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };

  it('prefers App Paths', async () => {
    const queries: string[] = [];
    const regQuery: RegQuery = (key, view) => {
      queries.push(`${key}@${view}`);
      return Promise.resolve(key.startsWith('HKLM') && view === 64 ? EN : null);
    };
    expect(await findEdge({ regQuery, fs: createMemoryFs({ [EDGE]: '' }), env })).toBe(EDGE);
    expect(queries).toHaveLength(3);
  });

  it('falls back to Program Files and returns null if Edge is missing', async () => {
    const none: RegQuery = () => Promise.resolve(null);
    const programFiles = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(await findEdge({ regQuery: none, fs: createMemoryFs({ [programFiles]: '' }), env })).toBe(
      programFiles,
    );
    expect(await findEdge({ regQuery: none, fs: createMemoryFs({}), env })).toBeNull();
  });

  it('never touches an unsafe registry value', async () => {
    const fs = createMemoryFs({});
    const unc: RegQuery = () => Promise.resolve('    (Default)    REG_SZ    \\\\evil\\share\\msedge.exe\r\n');
    expect(await findEdge({ regQuery: unc, fs, env: {} })).toBeNull();
    expect(fs.touched).toEqual([]);
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
    });
    expect(report.checks.map((check) => [check.id, check.level])).toEqual([
      ['node', 'ok'],
      ['pnpm', 'ok'],
      ['registry', 'info'],
      ['sdk', 'info'],
      [`claude:${STANDARD_PROFILE_ID}`, 'ok'],
      [`login:${STANDARD_PROFILE_ID}`, 'ok'],
      ['edge', 'ok'],
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
    });
    expect(report.checks.filter((check) => check.level === 'fail').map((check) => check.id)).toEqual([
      'sdk',
      `claude:${STANDARD_PROFILE_ID}`,
      'edge',
    ]);
    expect(report.exitCode).toBe(1);
  });
});
