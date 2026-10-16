import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { windowsCommandLine } from '../lib/cmdline';
import { encodePowerShell } from '../lib/powershell';
import type { RunFileFn, RunFileOptions, RunFileResult } from '../lib/process';
import {
  AUTOSTART_ENV,
  AUTOSTART_SCRIPT,
  autostartLinkPath,
  createAutostartShortcut,
  launcherCommand,
  removeAutostartShortcut,
  type StartCommand,
} from './autostart';

const REPO = 'D:\\dev\\Parallax Repo';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

function fakeRun(stdout = 'created', extra: Partial<RunFileResult> | Error = {}) {
  const calls: { file: string; args: readonly string[]; options: RunFileOptions }[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    if (extra instanceof Error) return Promise.reject(extra);
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: `${stdout}\r\n`,
      stderr: '',
      timedOut: false,
      ...extra,
    });
  };
  return { run, calls };
}

describe('launcherCommand (ADR-110)', () => {
  it('realpath(process.execPath) + tsx CLI, tsconfig, launcher main.ts, extra', async () => {
    const realpaths: string[] = [];
    const command = await launcherCommand(REPO, ['--autostart'], {
      execPath: 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\123_456\\node.exe',
      realpath: (file) => {
        realpaths.push(file);
        return Promise.resolve(NODE);
      },
    });
    expect(realpaths).toEqual(['C:\\Users\\u\\AppData\\Local\\fnm_multishells\\123_456\\node.exe']);
    expect(command).toEqual({
      node: NODE,
      args: [
        `${REPO}\\node_modules\\tsx\\dist\\cli.mjs`,
        '--tsconfig',
        `${REPO}\\src\\server\\tsconfig.json`,
        `${REPO}\\src\\server\\launcher\\main.ts`,
        '--autostart',
      ],
      cwd: REPO,
    });
  });

  it('another data directory adds --home=<home> before the extra arguments', async () => {
    const command = await launcherCommand(REPO, ['--autostart'], {
      home: 'D:\\temp\\px home',
      realpath: () => Promise.resolve(NODE),
    });
    expect(command.args.slice(-2)).toEqual(['--home=D:\\temp\\px home', '--autostart']);
  });

  it('uses the real node.exe by default', async () => {
    const command = await launcherCommand(REPO, []);
    expect(path.isAbsolute(command.node)).toBe(true);
    expect(command.node.toLowerCase()).toMatch(/node\.exe$|node$/);
  });
});

describe('autostart shortcut (ADR-110)', () => {
  const COMMAND: StartCommand = {
    node: NODE,
    args: [
      `${REPO}\\node_modules\\tsx\\dist\\cli.mjs`,
      '--tsconfig',
      `${REPO}\\src\\server\\tsconfig.json`,
      '--autostart',
    ],
    cwd: REPO,
  };

  it('path from APPDATA; none without a safe APPDATA', () => {
    expect(autostartLinkPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Parallax.lnk',
    );
    expect(autostartLinkPath({ appdata: 'C:\\x' })).toBe(
      'C:\\x\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Parallax.lnk',
    );
    expect(autostartLinkPath({})).toBeNull();
    expect(autostartLinkPath({ APPDATA: '\\\\server\\roaming' })).toBeNull();
  });

  it('creates it with WScript.Shell: constant script, data in the environment, minimized window', async () => {
    const appData = await makeTempHome('appdata-');
    const link = autostartLinkPath({ APPDATA: appData });
    if (link === null) throw new Error('no link path');
    const { run, calls } = fakeRun('created');
    const env = { SystemRoot: 'C:\\Windows', PARALLAX_LNK_ARGS: 'inherited' };
    expect(await createAutostartShortcut(link, COMMAND, { run, env })).toEqual({ ok: true });
    // The Startup folder exists (created in the temp APPDATA).
    expect((await stat(path.dirname(link))).isDirectory()).toBe(true);
    const call = calls[0];
    if (call === undefined) throw new Error('no call');
    expect(call.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(AUTOSTART_SCRIPT),
    ]);
    expect(call.options.env).toEqual({
      SystemRoot: 'C:\\Windows',
      [AUTOSTART_ENV.action]: 'create',
      [AUTOSTART_ENV.path]: link,
      [AUTOSTART_ENV.target]: NODE,
      [AUTOSTART_ENV.args]: windowsCommandLine(COMMAND.args),
      [AUTOSTART_ENV.cwd]: REPO,
      [AUTOSTART_ENV.description]: 'Parallax',
    });
    expect(AUTOSTART_SCRIPT).toContain('New-Object -ComObject WScript.Shell');
    expect(AUTOSTART_SCRIPT).toContain('$link.WindowStyle = 7');
    expect(AUTOSTART_SCRIPT).not.toContain(REPO);
    expect(AUTOSTART_SCRIPT).not.toMatch(/HKCU|HKLM|cmd\.exe|Invoke-Expression/i);
  });

  it('removes it; failures are results, never thrown', async () => {
    const removed = fakeRun('removed');
    expect(await removeAutostartShortcut('C:\\x\\Parallax.lnk', { run: removed.run, env: {} })).toEqual({
      ok: true,
    });
    expect(removed.calls[0]?.options.env).toMatchObject({
      [AUTOSTART_ENV.action]: 'remove',
      [AUTOSTART_ENV.path]: 'C:\\x\\Parallax.lnk',
    });
    const failed = fakeRun('error: Zugriff verweigert', { exitCode: 3 });
    expect(await removeAutostartShortcut('C:\\x\\Parallax.lnk', { run: failed.run, env: {} })).toEqual({
      ok: false,
      reason: 'exit 3: error: Zugriff verweigert',
    });
    const slow = fakeRun('', { timedOut: true, exitCode: null });
    expect(await removeAutostartShortcut('C:\\x\\Parallax.lnk', { run: slow.run, env: {} })).toEqual({
      ok: false,
      reason: 'timeout',
    });
    const missing = fakeRun('', new Error('spawn EACCES'));
    const appData = await makeTempHome('appdata-');
    expect(
      await createAutostartShortcut(`${appData}\\Startup\\Parallax.lnk`, COMMAND, {
        run: missing.run,
        env: {},
      }),
    ).toEqual({
      ok: false,
      reason: 'powershell could not be started: spawn EACCES',
    });
  });
});
