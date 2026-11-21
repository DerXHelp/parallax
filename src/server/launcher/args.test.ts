import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { makeTempHome } from '../http/testServer';
import { LAUNCHER_USAGE, parseLauncherArgs, portRequested, serverArgsFor } from './args';

const WIN = process.platform === 'win32';
/** WP-107: an absolute data folder / installation root by the rules of this computer. */
const PX = WIN ? 'D:\\px' : '/srv/px';
const APPS = WIN ? 'C:\\Apps\\Parallax' : '/opt/Parallax';
const SPACED = WIN ? 'D:/px root' : '/srv/px root';

describe('launcher command line', () => {
  it('separates the launcher flags from the server flags', () => {
    expect(parseLauncherArgs(['--print-url', '--port=5000', '--no-build', '--backend=fake'])).toEqual({
      printUrl: true,
      server: false,
      command: null,
      build: false,
      help: false,
      open: null,
      autostart: false,
      installRoot: null,
      applyUpdate: null,
      problem: null,
      serverArgv: ['--port=5000', '--backend=fake'],
    });
    expect(parseLauncherArgs([])).toEqual({
      printUrl: false,
      server: false,
      command: null,
      build: true,
      help: false,
      open: null,
      autostart: false,
      installRoot: null,
      applyUpdate: null,
      problem: null,
      serverArgv: [],
    });
    expect(parseLauncherArgs(['-h']).help).toBe(true);
    expect(parseLauncherArgs(['--help']).help).toBe(true);
  });

  it('skips the literal "--" of `pnpm start -- --port=4800` (pnpm 12 passes it on)', () => {
    const args = parseLauncherArgs(['--', '--port=4800', '--print-url']);
    expect(args).toMatchObject({ printUrl: true, serverArgv: ['--port=4800'] });
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    expect(loadConfig({ argv: args.serverArgv, env, cwd: 'C:\\repo' }).port).toBe(4800);
    // Without the fix loadConfig rejected it.
    expect(() => loadConfig({ argv: ['--', '--port=4800'], env, cwd: 'C:\\repo' })).toThrow();
  });

  it('resolves home and port like the server (flag > PARALLAX_* > default) and passes the result on', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PARALLAX_PORT: '4800' };
    const fromEnv = loadConfig({ argv: [], env, cwd: 'C:\\repo' });
    expect(fromEnv.port).toBe(4800);
    const config = loadConfig({
      argv: ['--port=5000', `--home=${PX}`, '--backend=fake'],
      env,
      cwd: 'C:\\repo',
    });
    expect(serverArgsFor(config)).toEqual([
      `--home=${PX}`,
      '--port=5000',
      '--backend=fake',
      '--log-level=info',
      '--validate=log',
      `--toasts=${config.toasts}`,
      // Under Vitest always off (R6); the server accepts and keeps it.
      '--system-integration=off',
    ]);
    // The server accepts exactly these flags (parseArgs strict) and resolves the same values – also
    // the validation mode of the launcher's environment (NODE_ENV=test of the E2E → throw, R3-05).
    expect(loadConfig({ argv: serverArgsFor(config), env: {}, cwd: 'C:\\elsewhere' })).toMatchObject({
      home: PX,
      port: 5000,
      backend: 'fake',
      validation: 'log',
    });
    const e2e = loadConfig({ argv: ['--home=D:\\px'], env: { ...env, NODE_ENV: 'test' }, cwd: 'C:\\repo' });
    expect(serverArgsFor(e2e)).toContain('--validate=throw');
  });

  it('CR-11: --toasts of the launcher (flag or PARALLAX_TOASTS) reaches the server', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const flagged = loadConfig({ argv: ['--toasts=off', '--home=D:\\px'], env, cwd: 'C:\\repo' });
    expect(serverArgsFor(flagged)).toContain('--toasts=off');
    expect(loadConfig({ argv: serverArgsFor(flagged), env: {}, cwd: 'C:\\elsewhere' }).toasts).toBe('off');
    const fromEnv = loadConfig({ argv: [], env: { ...env, PARALLAX_TOASTS: 'off' }, cwd: 'C:\\repo' });
    expect(serverArgsFor(fromEnv)).toContain('--toasts=off');
    // A flag of the launcher wins over the server's own environment.
    const server = loadConfig({
      argv: serverArgsFor(flagged),
      env: { PARALLAX_TOASTS: 'native' },
      cwd: 'C:\\x',
    });
    expect(server.toasts).toBe('off');
  });

  it('a port hint only for an explicitly requested port (V2-13)', () => {
    expect(portRequested([], {})).toBe(false);
    expect(portRequested(['--home=D:\\px'], { PARALLAX_PORT: '' })).toBe(false);
    expect(portRequested(['--port=4800'], {})).toBe(true);
    expect(portRequested(['--port', '4800'], {})).toBe(true);
    expect(portRequested([], { PARALLAX_PORT: '4792' })).toBe(true);
  });

  it('passes PARALLAX_BACKEND=fake on as --backend=fake (smoke/E2E of the launcher path, WP-20)', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PARALLAX_BACKEND: 'fake',
      PARALLAX_HOME: 'D:\\px-try',
    };
    expect(serverArgsFor(loadConfig({ argv: [], env, cwd: 'C:\\repo' }))).toContain('--backend=fake');
    // Without the variable the launcher starts the real backend; a flag wins over the variable.
    expect(serverArgsFor(loadConfig({ argv: [], env: {}, cwd: 'C:\\repo' }))).toContain('--backend=sdk');
    expect(serverArgsFor(loadConfig({ argv: ['--backend=sdk'], env, cwd: 'C:\\repo' }))).toContain(
      '--backend=sdk',
    );
    expect(LAUNCHER_USAGE).toContain('PARALLAX_BACKEND');
    // R3-02: the FakeBackend on the real data directory is refused, the usage says so.
    expect(() => loadConfig({ argv: ['--backend=fake'], env: {}, cwd: 'C:\\repo' })).toThrow(/FakeBackend/);
    expect(LAUNCHER_USAGE).toContain('fake needs its own --home');
  });

  it('documents every flag in the usage text', () => {
    for (const flag of [
      '--port',
      '--home',
      '--backend',
      '--validate',
      '--toasts',
      '--system-integration',
      '--no-build',
      '--print-url',
      '--help',
      '--autostart',
      '--install-root',
      '--open',
      '--apply-update',
      '--wait-pid',
      '--restore',
      '--server',
      '--key-store=file',
      'service install|uninstall|status',
      'remote status|enable|disable|pair',
      '--level',
    ]) {
      expect(LAUNCHER_USAGE).toContain(flag);
    }
  });

  it('ADR-111: the port from settings.json – launcher and server resolve the same one', async () => {
    const home = await makeTempHome('args-port-');
    await writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, settings: { port: 4890 } }),
      'utf8',
    );
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const launcher = loadConfig({ argv: [`--home=${home}`], env, cwd: 'C:\\repo' });
    expect(launcher.port).toBe(4890);
    expect(serverArgsFor(launcher)).toContain('--port=4890');
    // The server gets the resolved port as a flag and ends up on the same one.
    expect(loadConfig({ argv: serverArgsFor(launcher), env: {}, cwd: 'C:\\x' }).port).toBe(4890);
    // A flag or PARALLAX_PORT still wins over the settings.
    expect(loadConfig({ argv: [`--home=${home}`, '--port=5000'], env, cwd: 'C:\\repo' }).port).toBe(5000);
    expect(
      loadConfig({ argv: [`--home=${home}`], env: { ...env, PARALLAX_PORT: '5001' }, cwd: 'C:\\repo' }).port,
    ).toBe(5001);
  });
});

describe('launcher --install-root (WP-85, package mode)', () => {
  it('takes an absolute local folder as --install-root <dir> or --install-root=<dir>', () => {
    expect(parseLauncherArgs(['--install-root', APPS, '--port=4800'])).toMatchObject({
      installRoot: APPS,
      problem: null,
      serverArgv: ['--port=4800'],
    });
    expect(parseLauncherArgs([`--install-root=${SPACED}`]).installRoot).toBe(SPACED);
  });

  // WP-107: the rules of this computer (Linux refuses a Windows path, Windows a POSIX one).
  it.each(
    WIN
      ? [
          ['--install-root'],
          ['--install-root='],
          ['--install-root=relative\\dir'],
          ['--install-root=\\\\host\\share'],
          ['--install-root=C:\\px\\..\\x'],
          ['--install-root=/opt/Parallax'],
        ]
      : [
          ['--install-root'],
          ['--install-root='],
          ['--install-root=relative/dir'],
          ['--install-root=/opt/../x'],
          ['--install-root=C:\\Apps\\Parallax'],
        ],
  )('refuses %s', (arg) => {
    expect(parseLauncherArgs([arg]).problem).toMatch(/--install-root needs an absolute local folder/);
  });
});

describe('launcher --open / --autostart (ADR-109, ADR-110)', () => {
  const URI = 'parallax://session/en_0123456789abcdef0123456789abcdef';

  it('takes the link from --open <uri> and --open=<uri>; --autostart is a launcher flag', () => {
    expect(parseLauncherArgs(['--home=D:\\px', '--open', URI])).toMatchObject({
      open: URI,
      problem: null,
      serverArgv: ['--home=D:\\px'],
    });
    expect(parseLauncherArgs([`--open=${URI}`])).toMatchObject({ open: URI, problem: null, serverArgv: [] });
    expect(parseLauncherArgs(['--autostart', '--port=4800'])).toMatchObject({
      autostart: true,
      open: null,
      serverArgv: ['--port=4800'],
    });
  });

  it('R5: nothing may follow the link (a crafted %1 cannot add options)', () => {
    // `parallax://session/x" --home=C:\evil "` substituted into `--open "%1"`:
    const smuggled = parseLauncherArgs(['--open', 'parallax://session/x', '--home=C:\\evil', '']);
    expect(smuggled.problem).toMatch(/--open must be the last option/);
    expect(smuggled.serverArgv).toEqual([]);
    expect(parseLauncherArgs(['--open']).problem).toMatch(/needs a parallax:\/\/session/);
    // WP-81: the message names both forms.
    expect(parseLauncherArgs(['--open=']).problem).toBe(
      '--open needs a parallax://session/<id> or parallax://session/<computer>/<id> link',
    );
    expect(parseLauncherArgs(['--autostart', '--open', URI]).problem).toMatch(/cannot be combined/);
  });
});

describe('launcher --apply-update (WP-87b, the orchestrator of a version switch)', () => {
  const ROOT = `--install-root=${APPS}`;

  it('takes the version, --wait-pid and --restore (both value forms); the rest goes to the server', () => {
    expect(
      parseLauncherArgs([ROOT, '--apply-update=1.0.1', '--restore', '--wait-pid=4242', `--home=${PX}`]),
    ).toMatchObject({
      installRoot: APPS,
      applyUpdate: { version: '1.0.1', restore: true, waitPid: 4242 },
      problem: null,
      serverArgv: [`--home=${PX}`],
    });
    expect(parseLauncherArgs([ROOT, '--apply-update', '1.0.0-rc.4', '--wait-pid', '7']).applyUpdate).toEqual({
      version: '1.0.0-rc.4',
      restore: false,
      waitPid: 7,
    });
    expect(parseLauncherArgs([ROOT]).applyUpdate).toBeNull();
  });

  it.each([
    [['--apply-update=1.0.1', '--wait-pid=1'], /needs --install-root/],
    [[ROOT, '--apply-update=1.0.1'], /needs --wait-pid/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=0'], /needs --wait-pid/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=1e3'], /needs --wait-pid/],
    [[ROOT, '--apply-update=1.0', '--wait-pid=1'], /needs a release version/],
    [[ROOT, '--apply-update', '--wait-pid=1'], /needs a release version/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=1', '--print-url'], /cannot be combined/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=1', '--autostart'], /cannot be combined/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=1', '--open', 'parallax://session/x'], /cannot be combined/],
    [[ROOT, '--apply-update=1.0.1', '--wait-pid=1', '--server'], /cannot be combined/],
    [[ROOT, '--restore'], /belong to --apply-update/],
    [[ROOT, '--wait-pid=5'], /belong to --apply-update/],
  ])('refuses %j', (argv, problem) => {
    const args = parseLauncherArgs(argv);
    expect(args.problem).toMatch(problem);
    expect(args.applyUpdate).toBeNull();
  });
});

describe('launcher --server and the subcommands (WP-107)', () => {
  it('--server is a launcher flag; it combines with --print-url, not with --open or --autostart', () => {
    expect(parseLauncherArgs(['--server', '--print-url', '--port=4800'])).toMatchObject({
      server: true,
      printUrl: true,
      problem: null,
      command: null,
      serverArgv: ['--port=4800'],
    });
    expect(parseLauncherArgs(['--server', '--autostart']).problem).toMatch(/--server cannot be combined/);
    expect(parseLauncherArgs(['--server', '--open', 'parallax://session/x']).problem).toMatch(
      /--server cannot be combined/,
    );
  });

  it('service install|uninstall|status with server flags after it', () => {
    expect(parseLauncherArgs(['service', 'install', `--home=${PX}`, '--key-store=file'])).toMatchObject({
      command: { kind: 'service', action: 'install' },
      problem: null,
      serverArgv: [`--home=${PX}`, '--key-store=file'],
    });
    expect(parseLauncherArgs(['--', 'service', 'status']).command).toEqual({
      kind: 'service',
      action: 'status',
    });
    expect(parseLauncherArgs(['service']).problem).toMatch(/service needs one of install, uninstall, status/);
    expect(parseLauncherArgs(['service', 'restart']).problem).toMatch(/service needs one of/);
    expect(parseLauncherArgs(['service', 'install', 'extra']).problem).toMatch(/unexpected argument "extra"/);
    expect(parseLauncherArgs(['service', 'status', '--help']).help).toBe(true);
  });

  it('a subcommand after the --install-root of start.mjs', () => {
    expect(parseLauncherArgs([`--install-root=${APPS}`, 'remote', 'status'])).toMatchObject({
      installRoot: APPS,
      command: { kind: 'remote', request: { action: 'status' } },
      problem: null,
      serverArgv: [],
    });
    expect(parseLauncherArgs(['--install-root', APPS, 'service', 'install']).command).toEqual({
      kind: 'service',
      action: 'install',
    });
    // Anywhere else it is no subcommand: the server would refuse the positional.
    expect(parseLauncherArgs(['--port=4800', 'remote', 'status']).command).toBeNull();
  });

  it('remote: every action, pair with --level (default control), level with its value', () => {
    for (const action of ['status', 'enable', 'disable', 'cancel', 'unpair'] as const) {
      expect(parseLauncherArgs(['remote', action]).command).toEqual({ kind: 'remote', request: { action } });
    }
    expect(parseLauncherArgs(['remote', 'pair']).command).toEqual({
      kind: 'remote',
      request: { action: 'pair', level: 'control' },
    });
    expect(parseLauncherArgs(['remote', 'pair', '--level', 'manage', `--home=${PX}`])).toMatchObject({
      command: { kind: 'remote', request: { action: 'pair', level: 'manage' } },
      serverArgv: [`--home=${PX}`],
    });
    expect(parseLauncherArgs(['remote', 'pair', '--level=control']).command).toEqual({
      kind: 'remote',
      request: { action: 'pair', level: 'control' },
    });
    expect(parseLauncherArgs(['remote', 'level', 'manage']).command).toEqual({
      kind: 'remote',
      request: { action: 'level', level: 'manage' },
    });
  });

  it.each([
    [['remote'], /remote needs one of status, enable, disable, pair, cancel, unpair, level/],
    [['remote', 'open'], /remote needs one of/],
    [['remote', 'level'], /remote level needs control or manage/],
    [['remote', 'level', 'admin'], /remote level needs control or manage/],
    [['remote', 'pair', '--level'], /--level needs control or manage/],
    [['remote', 'pair', '--level=root'], /--level needs control or manage/],
  ])('refuses %j', (argv, problem) => {
    const args = parseLauncherArgs(argv);
    expect(args.problem).toMatch(problem);
    expect(args.command).toBeNull();
  });

  it('--level belongs to pair only (elsewhere a server flag the server refuses)', () => {
    expect(parseLauncherArgs(['remote', 'status', '--level=manage']).serverArgv).toEqual(['--level=manage']);
  });

  it('serverArgsFor passes --key-store=file on, never the default', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const config = loadConfig({ argv: [`--home=${PX}`], env, cwd: 'C:\\repo' });
    expect(serverArgsFor(config).some((arg) => arg.startsWith('--key-store'))).toBe(false);
    expect(serverArgsFor({ ...config, keyStore: 'file' })).toContain('--key-store=file');
  });
});
