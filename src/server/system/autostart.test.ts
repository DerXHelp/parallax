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
  DEFERRED_SHORTCUT,
  FOREIGN_SHORTCUT,
  LAUNCHER_MARKER,
  autostartLinkPath,
  createAutostartShortcut,
  createStartMenuShortcut,
  installedLauncherCommand,
  launcherCommand,
  removeAutostartShortcut,
  removeStartMenuShortcut,
  startMenuLinkPath,
  type StartCommand,
} from './autostart';
import {
  INSTALL_MARKER,
  entryMarkers,
  entryOwner,
  installIconPath,
  installationOnlyMarkers,
  type EntryOwner,
} from './markers';

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

const ROOT = 'C:\\Users\\u\\AppData\\Local\\Programs\\Parallax';
const OTHER_ROOT = 'D:\\Tools\\Parallax';
const COMMAND_OF_REPO: StartCommand = {
  node: NODE,
  args: [`${REPO}\\src\\server\\launcher\\main.ts`, '--autostart'],
  cwd: REPO,
};

describe('installedLauncherCommand (WP-86)', () => {
  it('realpath(process.execPath) + node flags, <root>\\start.mjs, extra; working directory = the root', async () => {
    const realpaths: string[] = [];
    const command = await installedLauncherCommand(ROOT, ['--autostart'], {
      execPath: 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\1_2\\node.exe',
      realpath: (file) => {
        realpaths.push(file);
        return Promise.resolve(NODE);
      },
    });
    expect(realpaths).toEqual(['C:\\Users\\u\\AppData\\Local\\fnm_multishells\\1_2\\node.exe']);
    expect(command).toEqual({
      node: NODE,
      args: ['--use-system-ca', '--use-env-proxy', `${ROOT}\\start.mjs`, '--autostart'],
      cwd: ROOT,
    });
  });

  it('another data directory adds --home and --system-integration=on before the extra arguments', async () => {
    const command = await installedLauncherCommand(ROOT, ['--open'], {
      home: 'D:\\temp\\px home',
      realpath: () => Promise.resolve(NODE),
    });
    expect(command.args).toEqual([
      '--use-system-ca',
      '--use-env-proxy',
      `${ROOT}\\start.mjs`,
      '--home=D:\\temp\\px home',
      '--system-integration=on',
      '--open',
    ]);
    // The script path is normalized (forward slashes, trailing separator).
    const slashes = await installedLauncherCommand('C:/Apps/Parallax/', [], {
      realpath: () => Promise.resolve(NODE),
    });
    expect(slashes.args[2]).toBe('C:\\Apps\\Parallax\\start.mjs');
  });
});

describe('entry markers (WP-86): clone / installation / uninstaller × old / new / other / foreign', () => {
  const OLD = `"${NODE}" "D:\\dev\\repo\\node_modules\\tsx\\dist\\cli.mjs" --tsconfig x "D:\\dev\\repo\\src\\server\\launcher\\main.ts" --autostart`;
  const NEW = `"${NODE}" --use-system-ca --use-env-proxy ${ROOT}\\start.mjs --open "%1"`;
  const OTHER = `"${NODE}" --use-system-ca --use-env-proxy "${OTHER_ROOT}\\start.mjs" --autostart`;
  const FOREIGN = '"C:\\Program Files\\Other\\other.exe" "%1"';
  const PHASE1 = 'D:\\dev\\repo\\parallax.cmd --autostart';

  it('the marker lists', () => {
    expect(INSTALL_MARKER).toBe('\\start.mjs');
    expect(entryMarkers(null)).toEqual({ own: [LAUNCHER_MARKER], defer: ['\\start.mjs'] });
    expect(entryMarkers(ROOT)).toEqual({ own: [LAUNCHER_MARKER, `${ROOT}\\start.mjs`], defer: [] });
    expect(installationOnlyMarkers(ROOT)).toEqual({ own: [`${ROOT}\\start.mjs`], defer: [] });
    expect(installIconPath(ROOT)).toBe(`${ROOT}\\parallax.ico`);
  });

  const rows: [string, string, EntryOwner, EntryOwner, EntryOwner][] = [
    // command, clone, installation, uninstaller
    ['old (launcher\\main.ts)', OLD, 'own', 'own', 'foreign'],
    ['new (<root>\\start.mjs)', NEW, 'deferred', 'own', 'own'],
    ['new, other case', NEW.toUpperCase(), 'deferred', 'own', 'own'],
    ['another installation', OTHER, 'deferred', 'foreign', 'foreign'],
    ['foreign program', FOREIGN, 'foreign', 'foreign', 'foreign'],
    ['phase-1 shortcut on parallax.cmd', PHASE1, 'foreign', 'foreign', 'foreign'],
  ];
  it.each(rows)('%s', (_name, command, clone, installation, uninstaller) => {
    expect(entryOwner(command, entryMarkers(null))).toBe(clone);
    expect(entryOwner(command, entryMarkers(ROOT))).toBe(installation);
    expect(entryOwner(command, installationOnlyMarkers(ROOT))).toBe(uninstaller);
  });

  it('a root with umlauts still matches what reg.exe prints in the OEM code page (U+FFFD, ?)', () => {
    // Like a user folder with umlauts (the default root lies below %LOCALAPPDATA%).
    const root = 'D:\\Bürotools\\Größe Ü\\Parallax';
    const markers = entryMarkers(root);
    expect(entryOwner(`"${NODE}" "${root}\\start.mjs" --open "%1"`, markers)).toBe('own');
    const garbled = `"${NODE}" "D:\\B\uFFFDrotools\\Gr\uFFFD\uFFFDe \uFFFD\\Parallax\\start.mjs" --open "%1"`;
    expect(entryOwner(garbled, markers)).toBe('own');
    const unmapped = `"${NODE}" "D:\\B?rotools\\Gr??e ?\\Parallax\\start.mjs"`;
    expect(entryOwner(unmapped, markers)).toBe('own');
    // Only non-ASCII folds: another ASCII letter is another path.
    const other = `"${NODE}" "D:\\Bxrotools\\Grxxe x\\Parallax\\start.mjs"`;
    expect(entryOwner(other, markers)).toBe('foreign');
  });
});

describe('shortcut script markers (WP-86)', () => {
  const INSTALLED: StartCommand = {
    node: NODE,
    args: ['--use-system-ca', '--use-env-proxy', `${ROOT}\\start.mjs`, '--autostart'],
    cwd: ROOT,
  };

  it('passes the own markers |-separated and the deferred ones only when there are any', async () => {
    const appData = await makeTempHome('appdata-');
    const link = autostartLinkPath({ APPDATA: appData });
    if (link === null) throw new Error('no link path');
    const clone = fakeRun('created');
    const inherited = { PARALLAX_LNK_DEFER: 'x', PARALLAX_LNK_ICON: 'y' };
    await createAutostartShortcut(link, COMMAND_OF_REPO, {
      run: clone.run,
      env: inherited,
      markers: entryMarkers(null),
    });
    expect(clone.calls[0]?.options.env).toMatchObject({
      [AUTOSTART_ENV.marker]: LAUNCHER_MARKER,
      [AUTOSTART_ENV.defer]: '\\start.mjs',
    });
    // The autostart shortcut never gets an icon, also not an inherited one.
    expect(clone.calls[0]?.options.env).not.toHaveProperty(AUTOSTART_ENV.icon);
    const installation = fakeRun('created');
    await createAutostartShortcut(link, INSTALLED, {
      run: installation.run,
      env: inherited,
      markers: entryMarkers(ROOT),
    });
    expect(installation.calls[0]?.options.env).toMatchObject({
      [AUTOSTART_ENV.marker]: `${LAUNCHER_MARKER}|${ROOT}\\start.mjs`,
      [AUTOSTART_ENV.args]: `--use-system-ca --use-env-proxy ${ROOT}\\start.mjs --autostart`,
      [AUTOSTART_ENV.cwd]: ROOT,
    });
    expect(installation.calls[0]?.options.env).not.toHaveProperty(AUTOSTART_ENV.defer);
    const remove = fakeRun('removed');
    await removeAutostartShortcut(link, {
      run: remove.run,
      env: {},
      markers: installationOnlyMarkers(ROOT),
    });
    expect(remove.calls[0]?.options.env).toEqual({
      [AUTOSTART_ENV.action]: 'remove',
      [AUTOSTART_ENV.path]: link,
      [AUTOSTART_ENV.marker]: `${ROOT}\\start.mjs`,
    });
  });

  it('output "deferred": left alone, a success for both actions (no failure, no warning)', async () => {
    const appData = await makeTempHome('appdata-');
    const link = `${appData}\\Startup\\Parallax.lnk`;
    const create = fakeRun(DEFERRED_SHORTCUT);
    expect(
      await createAutostartShortcut(link, COMMAND_OF_REPO, {
        run: create.run,
        env: {},
        markers: entryMarkers(null),
      }),
    ).toEqual({ ok: true, deferred: true });
    const remove = fakeRun(DEFERRED_SHORTCUT);
    expect(
      await removeAutostartShortcut(link, { run: remove.run, env: {}, markers: entryMarkers(null) }),
    ).toEqual({ ok: true, deferred: true });
    // A foreign shortcut stays what it was.
    expect(
      await createAutostartShortcut(link, COMMAND_OF_REPO, {
        run: fakeRun(FOREIGN_SHORTCUT).run,
        env: {},
        markers: entryMarkers(null),
      }),
    ).toEqual({ ok: false, reason: FOREIGN_SHORTCUT });
  });

  it('the script: own markers first, then the deferred ones, then foreign – all before the action', () => {
    const lines = AUTOSTART_SCRIPT.split('\n');
    const ownLoop = lines.findIndex((l) => l.includes(`$env:${AUTOSTART_ENV.marker}`));
    const deferLoop = lines.findIndex((l) => l.includes(`$env:${AUTOSTART_ENV.defer}`));
    const deferred = lines.findIndex((l) => l.includes(`Write-Output '${DEFERRED_SHORTCUT}'`));
    const foreign = lines.findIndex((l) => l.includes(`Write-Output '${FOREIGN_SHORTCUT}'`));
    const branch = lines.findIndex((l) => l.includes(`$env:${AUTOSTART_ENV.action} -eq 'remove'`));
    expect(ownLoop).toBeGreaterThan(0);
    expect(lines[ownLoop]).toContain(".Split('|')");
    expect(lines[deferLoop]).toContain(".Split('|')");
    expect(ownLoop).toBeLessThan(deferLoop);
    expect(deferLoop).toBeLessThan(deferred);
    expect(deferred).toBeLessThan(foreign);
    expect(foreign).toBeLessThan(branch);
    expect(lines.filter((l) => l.includes(`Write-Output '${DEFERRED_SHORTCUT}'`))).toHaveLength(1);
    // The icon only when given, before the save.
    const icon = lines.findIndex((l) => l.includes(`if ($env:${AUTOSTART_ENV.icon})`));
    const save = lines.findIndex((l) => l.includes('$link.Save()'));
    expect(lines[icon + 1]).toContain(`$link.IconLocation = $env:${AUTOSTART_ENV.icon} + ',0'`);
    expect(icon).toBeGreaterThan(branch);
    expect(icon).toBeLessThan(save);
  });
});

describe('start menu shortcut (WP-86)', () => {
  const INSTALLED: StartCommand = {
    node: NODE,
    args: ['--use-system-ca', '--use-env-proxy', `${ROOT}\\start.mjs`],
    cwd: ROOT,
  };

  it('path from APPDATA; none without a safe APPDATA', () => {
    expect(startMenuLinkPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Parallax.lnk',
    );
    expect(startMenuLinkPath({})).toBeNull();
    expect(startMenuLinkPath({ APPDATA: '\\\\server\\roaming' })).toBeNull();
  });

  it('creates it with the icon, the minimized window and the marker rules (folder created)', async () => {
    const appData = await makeTempHome('appdata-');
    const link = startMenuLinkPath({ APPDATA: appData });
    if (link === null) throw new Error('no link path');
    const { run, calls } = fakeRun('created');
    const icon = installIconPath(ROOT);
    const env = { SystemRoot: 'C:\\Windows', PARALLAX_LNK_ICON: 'inherited' };
    expect(
      await createStartMenuShortcut(link, INSTALLED, icon, { run, env, markers: entryMarkers(ROOT) }),
    ).toEqual({ ok: true });
    expect((await stat(path.dirname(link))).isDirectory()).toBe(true);
    expect(calls[0]?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShell(AUTOSTART_SCRIPT),
    ]);
    expect(calls[0]?.options.env).toEqual({
      SystemRoot: 'C:\\Windows',
      [AUTOSTART_ENV.action]: 'create',
      [AUTOSTART_ENV.path]: link,
      [AUTOSTART_ENV.target]: NODE,
      [AUTOSTART_ENV.args]: `--use-system-ca --use-env-proxy ${ROOT}\\start.mjs`,
      [AUTOSTART_ENV.cwd]: ROOT,
      [AUTOSTART_ENV.description]: 'Parallax',
      [AUTOSTART_ENV.icon]: `${ROOT}\\parallax.ico`,
      [AUTOSTART_ENV.marker]: `${LAUNCHER_MARKER}|${ROOT}\\start.mjs`,
    });
    expect(AUTOSTART_SCRIPT).toContain('$link.WindowStyle = 7');
    // A foreign start menu shortcut (e.g. one the user made) is never replaced.
    expect(
      await createStartMenuShortcut(link, INSTALLED, icon, {
        run: fakeRun(FOREIGN_SHORTCUT).run,
        env: {},
        markers: entryMarkers(ROOT),
      }),
    ).toEqual({ ok: false, reason: FOREIGN_SHORTCUT });
  });

  it('removes it with the given markers; no icon, no target', async () => {
    const removed = fakeRun('removed');
    const link = 'C:\\x\\Start Menu\\Programs\\Parallax.lnk';
    expect(
      await removeStartMenuShortcut(link, {
        run: removed.run,
        env: {},
        markers: installationOnlyMarkers(ROOT),
      }),
    ).toEqual({ ok: true });
    expect(removed.calls[0]?.options.env).toEqual({
      [AUTOSTART_ENV.action]: 'remove',
      [AUTOSTART_ENV.path]: link,
      [AUTOSTART_ENV.marker]: `${ROOT}\\start.mjs`,
    });
  });
});
