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
  FOREIGN_SHORTCUT,
  LAUNCHER_MARKER,
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

  it('another data directory adds --home=<home> and --system-integration=on before the extra arguments (R4-12)', async () => {
    const command = await launcherCommand(REPO, ['--autostart'], {
      home: 'D:\\temp\\px home',
      realpath: () => Promise.resolve(NODE),
    });
    expect(command.args.slice(-3)).toEqual([
      '--home=D:\\temp\\px home',
      '--system-integration=on',
      '--autostart',
    ]);
    // The default data directory needs neither (auto integrates it).
    const plain = await launcherCommand(REPO, ['--autostart'], { realpath: () => Promise.resolve(NODE) });
    expect(plain.args.some((a) => a.startsWith('--home=') || a.startsWith('--system-integration'))).toBe(
      false,
    );
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
    // R4-04: no -ExecutionPolicy.
    expect(call.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
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
      [AUTOSTART_ENV.marker]: LAUNCHER_MARKER,
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
      [AUTOSTART_ENV.marker]: LAUNCHER_MARKER,
    });
    // R4-11: a shortcut that does not start the launcher stays – also a success.
    const foreign = fakeRun(FOREIGN_SHORTCUT);
    expect(await removeAutostartShortcut('C:\\x\\Parallax.lnk', { run: foreign.run, env: {} })).toEqual({
      ok: true,
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

  it('CR2-03: creating passes the marker and refuses a foreign shortcut (reason foreign, never replaced)', async () => {
    const appData = await makeTempHome('appdata-');
    const link = autostartLinkPath({ APPDATA: appData });
    if (link === null) throw new Error('no link path');
    const foreign = fakeRun(FOREIGN_SHORTCUT);
    expect(await createAutostartShortcut(link, COMMAND, { run: foreign.run, env: {} })).toEqual({
      ok: false,
      reason: FOREIGN_SHORTCUT,
    });
    expect(foreign.calls[0]?.options.env).toMatchObject({
      [AUTOSTART_ENV.action]: 'create',
      [AUTOSTART_ENV.marker]: LAUNCHER_MARKER,
    });
    // An own shortcut (marker in its arguments) is refreshed as before.
    expect(await createAutostartShortcut(link, COMMAND, { run: fakeRun('created').run, env: {} })).toEqual({
      ok: true,
    });
  });

  it('CR2-03: the script checks an existing shortcut before either action (create and remove, R4-11)', () => {
    const lines = AUTOSTART_SCRIPT.split('\n');
    const read = lines.findIndex((l) => l.includes('.CreateShortcut($path)'));
    const check = lines.findIndex((l) => l.includes('.Arguments') && l.includes('Contains($marker)'));
    const keep = lines.findIndex((l) => l.includes(`Write-Output '${FOREIGN_SHORTCUT}'`));
    const branch = lines.findIndex((l) => l.includes(`$env:${AUTOSTART_ENV.action} -eq 'remove'`));
    const save = lines.findIndex((l) => l.includes('$link.Save()'));
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(check);
    expect(check).toBeLessThan(keep);
    // The check runs before the action branch, so it guards the creation as well.
    expect(keep).toBeLessThan(branch);
    expect(branch).toBeLessThan(save);
    expect(lines.filter((l) => l.includes(`Write-Output '${FOREIGN_SHORTCUT}'`))).toHaveLength(1);
  });

  it('R4-11: the removal reads the shortcut first and keeps one without the launcher in its arguments', () => {
    const lines = AUTOSTART_SCRIPT.split('\n');
    const read = lines.findIndex((l) => l.includes('.CreateShortcut($path)'));
    const check = lines.findIndex((l) => l.includes('.Arguments') && l.includes('Contains($marker)'));
    const keep = lines.findIndex((l) => l.includes(`Write-Output '${FOREIGN_SHORTCUT}'`));
    const remove = lines.findIndex((l) => l.includes('Remove-Item -LiteralPath $path'));
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(check);
    expect(check).toBeLessThan(keep);
    expect(keep).toBeLessThan(remove);
    // Without a marker (never from Parallax) nothing is removed.
    expect(lines[check]).toContain('-not $marker');
    expect(LAUNCHER_MARKER).toBe('launcher\\main.ts');
  });
});
