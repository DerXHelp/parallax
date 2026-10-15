import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sampleProfile } from '@shared/samples';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createMemoryFs, nodeFsProbe, resolveCmdShim, searchPath } from '../lib/windows';
import {
  cliVersionStatus,
  compareVersions,
  findClaude,
  npmClaudeShimTarget,
  parseClaudeVersion,
  readClaudeVersion,
  readSdkManifest,
  resolveClaude,
  resolveClaudeShim,
  type FindClaudeDeps,
} from './resolveClaude';

// ---- shim fixtures: exactly what npm (cmd-shim) writes into %APPDATA%\npm ----

const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`;

/** npm i -g @anthropic-ai/claude-code (native binary in bin/claude.exe). */
const CLAUDE_CMD_NATIVE = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
]);

/** Older JS CLI (cli.js through node) – not usable, Parallax only starts .exe (C.7). */
const CLAUDE_CMD_JS = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
]);

const CLAUDE_PS1_NATIVE = crlf([
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '}',
  'if ($MyInvocation.ExpectingInput) {',
  '  $input | & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args',
  '} else {',
  '  & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args',
  '}',
  'exit $LASTEXITCODE',
]);

/** Same shim style for pnpm (as installed on the WP-11 machine). */
const PNPM_CMD = crlf([
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*',
]);

const SH_SHIM = '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"\n';

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const NPM_TARGET = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const LOCAL = 'C:\\Users\\u\\.local\\bin\\claude.exe';

function deps(
  files: Record<string, string>,
  hits: string[],
): FindClaudeDeps & { touched: string[]; whereCalls: number } {
  const fs = createMemoryFs(files);
  const result = {
    ...fs,
    whereCalls: 0,
    where: (name: string) => {
      result.whereCalls += 1;
      expect(name).toBe('claude');
      return Promise.resolve(hits);
    },
  };
  return result;
}

const AUTO = { executable: { kind: 'auto' } } as const;

describe('findClaude via where (B, C.7, F.17)', () => {
  it('uses the native claude.exe', async () => {
    expect(await findClaude(AUTO, deps({ [LOCAL]: '' }, [LOCAL]))).toEqual({
      ok: true,
      path: LOCAL,
      source: 'path',
      candidates: [{ path: LOCAL, executable: LOCAL, source: 'path', rejected: null }],
    });
  });

  it('resolves the npm .cmd shim to …\\bin\\claude.exe and skips the extensionless sh script', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [`${NPM}\\claude`]: SH_SHIM, [`${NPM}\\claude.cmd`]: CLAUDE_CMD_NATIVE, [NPM_TARGET]: '' }, [
        `${NPM}\\claude`,
        `${NPM}\\claude.cmd`,
      ]),
    );
    expect(found).toEqual({
      ok: true,
      path: NPM_TARGET,
      source: 'npm-shim',
      candidates: [
        { path: `${NPM}\\claude`, executable: null, source: 'path', rejected: 'no_extension' },
        { path: `${NPM}\\claude.cmd`, executable: NPM_TARGET, source: 'npm-shim', rejected: null },
      ],
    });
  });

  it('prefers a direct .exe over an earlier shim', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [`${NPM}\\claude.cmd`]: CLAUDE_CMD_NATIVE, [NPM_TARGET]: '', [LOCAL]: '' }, [
        `${NPM}\\claude.cmd`,
        LOCAL,
      ]),
    );
    expect(found.ok && found.path).toBe(LOCAL);
  });

  it('resolves a .ps1 shim', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [`${NPM}\\claude.ps1`]: CLAUDE_PS1_NATIVE, [NPM_TARGET]: '' }, [`${NPM}\\claude.ps1`]),
    );
    expect(found.ok && found.path).toBe(NPM_TARGET);
  });

  it('falls back to the conventional target if the shim text is unknown', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [`${NPM}\\claude.cmd`]: '@echo off\r\nrem custom\r\n', [NPM_TARGET]: '' }, [
        `${NPM}\\claude.cmd`,
      ]),
    );
    expect(found.ok && found.path).toBe(NPM_TARGET);
  });

  it('rejects a JS CLI shim (only .exe, C.7)', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [`${NPM}\\claude.cmd`]: CLAUDE_CMD_JS }, [`${NPM}\\claude.cmd`]),
    );
    expect(found).toEqual({
      ok: false,
      error: { code: 'CLAUDE_NOT_FOUND', params: { source: 'path', candidates: 1 } },
      candidates: [
        { path: `${NPM}\\claude.cmd`, executable: null, source: 'npm-shim', rejected: 'shim_unresolved' },
      ],
    });
  });

  it.each<[string, string]>([
    ['C:\\Users\\u\\.local\\bin\\claude.exe.old.1791966999163.6044', 'old_binary'],
    ['C:\\tools\\claude.bat', 'unsupported_extension'],
    ['C:\\tools\\claude.com', 'unsupported_extension'],
    ['C:\\tools\\claude', 'no_extension'],
    ['C:\\gone\\claude.exe', 'missing'],
    ['\\\\server\\share\\claude.exe', 'unsafe_path'],
  ])('skips %s (%s)', async (hit, rejected) => {
    const d = deps(hit.includes('gone') ? {} : { [hit]: '' }, [hit]);
    const found = await findClaude(AUTO, d);
    expect(found.ok).toBe(false);
    expect(found.candidates).toEqual([{ path: hit, executable: null, source: 'path', rejected }]);
    expect(d.touched.filter((p) => p.startsWith('\\\\'))).toEqual([]);
  });

  it('never touches an unsafe where hit', async () => {
    const d = deps({}, ['\\\\server\\share\\claude.cmd', '\\\\server\\share\\claude.exe']);
    await findClaude(AUTO, d);
    expect(d.touched).toEqual([]);
  });

  it('marks a shim that leads to an already found .exe as duplicate', async () => {
    const found = await findClaude(
      AUTO,
      deps({ [NPM_TARGET]: '', [`${NPM}\\claude.cmd`]: CLAUDE_CMD_NATIVE }, [
        NPM_TARGET,
        `${NPM}\\claude.cmd`,
      ]),
    );
    expect(found.ok && found.path).toBe(NPM_TARGET);
    expect(found.candidates[1]?.rejected).toBe('duplicate');
  });

  it('reports CLAUDE_NOT_FOUND without hits', async () => {
    expect(await findClaude(AUTO, deps({}, []))).toEqual({
      ok: false,
      error: { code: 'CLAUDE_NOT_FOUND', params: { source: 'path', candidates: 0 } },
      candidates: [],
    });
  });
});

describe('findClaude with a fixed profile path (no fallback)', () => {
  const fixed = (p: string) => ({ executable: { kind: 'path', path: p } }) as const;

  it('uses the configured .exe and does not ask where', async () => {
    const d = deps({ 'D:\\tools\\claude.exe': '', [LOCAL]: '' }, [LOCAL]);
    expect(await findClaude(fixed('D:\\tools\\claude.exe'), d)).toEqual({
      ok: true,
      path: 'D:\\tools\\claude.exe',
      source: 'profile',
      candidates: [
        {
          path: 'D:\\tools\\claude.exe',
          executable: 'D:\\tools\\claude.exe',
          source: 'profile',
          rejected: null,
        },
      ],
    });
    expect(d.whereCalls).toBe(0);
  });

  it('resolves a configured npm shim', async () => {
    const d = deps({ [`${NPM}\\claude.cmd`]: CLAUDE_CMD_NATIVE, [NPM_TARGET]: '' }, []);
    const found = await findClaude(fixed(`${NPM}\\claude.cmd`), d);
    expect(found.ok && found.path).toBe(NPM_TARGET);
    expect(found.ok && found.source).toBe('profile');
  });

  it.each<[string, string]>([
    ['D:\\tools\\missing.exe', 'missing'],
    ['\\\\server\\share\\claude.exe', 'unsafe_path'],
    ['relative\\claude.exe', 'unsafe_path'],
    ['D:\\tools\\claude', 'no_extension'],
    ['D:\\tools\\claude.js', 'unsupported_extension'],
    ['D:\\tools\\claude.exe.old.1', 'old_binary'],
  ])('rejects %s (%s) without falling back to where', async (configured, reason) => {
    const d = deps({ [LOCAL]: '' }, [LOCAL]);
    expect(await findClaude(fixed(configured), d)).toMatchObject({
      ok: false,
      error: { code: 'CLAUDE_NOT_FOUND', params: { source: 'profile', reason } },
    });
    expect(d.whereCalls).toBe(0);
    expect(d.touched.filter((p) => !/^[A-Za-z]:\\/.test(p))).toEqual([]);
  });

  it('accepts a sample profile', async () => {
    const found = await findClaude(sampleProfile(), deps({ [LOCAL]: '' }, [LOCAL]));
    expect(found.ok).toBe(true);
  });
});

describe('npm shims', () => {
  it('parses cmd-shim targets and skips node.exe', async () => {
    expect(await resolveCmdShim(`${NPM}\\pnpm.cmd`, createMemoryFs({}))).toBeNull();
    const withShim = createMemoryFs({
      [`${NPM}\\pnpm.cmd`]: PNPM_CMD,
      [`${NPM}\\claude.cmd`]: CLAUDE_CMD_JS,
      [`${NPM}\\node_modules\\pnpm\\pnpm.exe`]: '',
      [`${NPM}\\node.exe`]: '',
    });
    expect(await resolveCmdShim(`${NPM}\\pnpm.cmd`, withShim)).toBe(`${NPM}\\node_modules\\pnpm\\pnpm.exe`);
    expect(await resolveCmdShim(`${NPM}\\pnpm.cmd`, withShim, 'claude.exe')).toBeNull();
    expect(await resolveCmdShim(`${NPM}\\claude.cmd`, withShim)).toBeNull();
  });

  it('handles the %~dp0 form and forward slashes', async () => {
    const fs = createMemoryFs({
      'C:\\npm\\claude.cmd': '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
      'C:\\npm\\claude.ps1': '& "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args\r\n',
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe': '',
    });
    const target = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    expect(await resolveClaudeShim('C:\\npm\\claude.cmd', fs)).toBe(target);
    expect(await resolveClaudeShim('C:\\npm\\claude.ps1', fs)).toBe(target);
  });

  it('ignores targets that leave the safe path space', async () => {
    const fs = createMemoryFs({ 'C:\\npm\\evil.cmd': '"%dp0%\\..\\x:ads.exe" %*\r\n' });
    expect(await resolveCmdShim('C:\\npm\\evil.cmd', fs)).toBeNull();
  });

  it('knows the conventional target', () => {
    expect(npmClaudeShimTarget(`${NPM}\\claude.cmd`)).toBe(NPM_TARGET);
  });
});

describe('searchPath (in-process where)', () => {
  it('lists bare name, then PATHEXT hits per directory, in PATH order', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\claude`]: '',
      [`${NPM}\\claude.cmd`]: '',
      [`${NPM}\\claude.ps1`]: '',
      [LOCAL]: '',
    });
    const env = { Path: `${NPM};"C:\\Users\\u\\.local\\bin";${NPM}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(await searchPath('claude', env, fs)).toEqual([`${NPM}\\claude`, `${NPM}\\claude.cmd`, LOCAL]);
  });

  it('skips UNC, device and relative PATH entries without touching them (C.10)', async () => {
    const fs = createMemoryFs({ [LOCAL]: '' });
    const env = { PATH: '\\\\evil\\share;\\\\?\\C:\\x;relative\\bin;.;;C:\\Users\\u\\.local\\bin' };
    expect(await searchPath('claude', env, fs)).toEqual([LOCAL]);
    expect(fs.touched.every((p) => p.startsWith('C:\\Users\\u\\.local\\bin\\'))).toBe(true);
  });

  it('uses the default PATHEXT and finds nothing without PATH', async () => {
    const fs = createMemoryFs({ 'C:\\a\\claude.exe': '' });
    expect(await searchPath('claude', { PATH: 'C:\\a' }, fs)).toEqual(['C:\\a\\claude.exe']);
    expect(await searchPath('claude', {}, fs)).toEqual([]);
  });
});

describe('real file system (temp npm folder with the .cmd shim fixture)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parallax-wp11-shim-'));
  const npm = path.join(root, 'npm');
  const target = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(path.join(npm, 'claude'), SH_SHIM);
  writeFileSync(path.join(npm, 'claude.cmd'), CLAUDE_CMD_NATIVE);
  writeFileSync(target, '');
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds and resolves the shim with the guarded node fs', async () => {
    const env = { PATH: npm, PATHEXT: '.EXE;.CMD' };
    const hits = await searchPath('claude', env, nodeFsProbe);
    expect(hits).toEqual([path.join(npm, 'claude'), path.join(npm, 'claude.cmd')]);
    const found = await findClaude(AUTO, { ...nodeFsProbe, where: () => Promise.resolve(hits) });
    expect(found.ok && found.path).toBe(target);
  });

  it('never stats unsafe paths', async () => {
    expect(await nodeFsProbe.isFile('\\\\127.0.0.1\\c$\\x.exe')).toBe(false);
    expect(await nodeFsProbe.readText('\\\\127.0.0.1\\c$\\x.cmd')).toBeNull();
    expect(await nodeFsProbe.readText(npm)).toBeNull();
  });
});

describe('versions (C.7)', () => {
  it.each<[string, string | null]>([
    ['2.1.300 (Claude Code)', '2.1.300'],
    ['2.1.300 (Claude Code)\r\n', '2.1.300'],
    ['v2.1.0', '2.1.0'],
    ['2.2.0-beta.1 (Claude Code)', '2.2.0-beta.1'],
    ['Claude Code 2.1.300', null],
    ['2.1', null],
    ['', null],
  ])('parseClaudeVersion(%j) = %j', (output, version) => {
    expect(parseClaudeVersion(output)).toBe(version);
  });

  it.each<[string, string, number | null]>([
    ['2.1.300', '2.1.296', 1],
    ['2.1.296', '2.1.296', 0],
    ['2.1.295', '2.1.296', -1],
    ['2.1.10', '2.1.9', 1],
    ['3.0.0', '2.99.99', 1],
    ['2.1.296-beta.1', '2.1.296', -1],
    ['2.1.296-beta.2', '2.1.296-beta.10', -1],
    ['2.1.296-alpha', '2.1.296-beta', -1],
    ['2.1.296-1', '2.1.296-alpha', -1],
    ['2.1.296+build.5', '2.1.296', 0],
    ['x', '2.1.296', null],
  ])('compareVersions(%s, %s) = %s', (a, b, order) => {
    expect(compareVersions(a, b)).toBe(order);
  });

  it.each<[string | null, string | null, string]>([
    ['2.1.300', '2.1.296', 'ok'],
    ['2.1.296', '2.1.296', 'ok'],
    ['2.1.295', '2.1.296', 'too_old'],
    [null, '2.1.296', 'unknown'],
    ['2.1.300', null, 'unknown'],
    ['weird', '2.1.296', 'unknown'],
  ])('cliVersionStatus(%s, %s) = %s', (cli, required, status) => {
    expect(cliVersionStatus(cli, required)).toBe(status);
  });

  it('reads the installed SDK manifest (0.3.296, claudeCodeVersion 2.1.296)', async () => {
    expect(await readSdkManifest()).toEqual({ sdkVersion: '0.3.296', claudeCodeVersion: '2.1.296' });
  });
});

describe('readClaudeVersion / resolveClaude', () => {
  const ok = (stdout: string, exitCode: number | null = 0): RunFileResult => ({
    exitCode,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  });

  it('runs `--version` with the given env', async () => {
    const calls: [string, readonly string[], RunFileOptions][] = [];
    const run = (file: string, args: readonly string[], options: RunFileOptions) => {
      calls.push([file, args, options]);
      return Promise.resolve(ok('2.1.300 (Claude Code)\n'));
    };
    const env = { PARALLAX: '1' };
    const result = await resolveClaude(AUTO, { ...deps({ [LOCAL]: '' }, [LOCAL]), runFile: run, env });
    expect(result).toMatchObject({ ok: true, path: LOCAL, version: '2.1.300', versionError: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(LOCAL);
    expect(calls[0]?.[1]).toEqual(['--version']);
    expect(calls[0]?.[2].env).toBe(env);
  });

  it('does not run anything when claude is not found', async () => {
    let runs = 0;
    const result = await resolveClaude(AUTO, {
      ...deps({}, []),
      runFile: () => {
        runs += 1;
        return Promise.resolve(ok(''));
      },
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(runs).toBe(0);
  });

  it.each<[string, () => Promise<RunFileResult>, unknown]>([
    ['exit code', () => Promise.resolve(ok('', 1)), { reason: 'exit', exitCode: 1 }],
    ['timeout', () => Promise.resolve({ ...ok(''), timedOut: true, exitCode: null }), { reason: 'timeout' }],
    [
      'spawn error',
      () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
      { reason: 'ENOENT' },
    ],
  ])('maps a failing --version (%s) to CLAUDE_SPAWN_FAILED', async (_name, run, params) => {
    expect(await readClaudeVersion(LOCAL, {}, run)).toEqual({
      version: null,
      error: { code: 'CLAUDE_SPAWN_FAILED', params },
    });
  });

  it('accepts output without a version (version null, no error)', async () => {
    expect(await readClaudeVersion(LOCAL, {}, () => Promise.resolve(ok('hello')))).toEqual({
      version: null,
      error: null,
    });
  });
});
