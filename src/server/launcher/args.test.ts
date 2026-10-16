import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { makeTempHome } from '../http/testServer';
import { LAUNCHER_USAGE, parseLauncherArgs, portRequested, serverArgsFor } from './args';

describe('launcher command line', () => {
  it('separates the launcher flags from the server flags', () => {
    expect(parseLauncherArgs(['--print-url', '--port=5000', '--no-build', '--backend=fake'])).toEqual({
      printUrl: true,
      build: false,
      help: false,
      open: null,
      autostart: false,
      problem: null,
      serverArgv: ['--port=5000', '--backend=fake'],
    });
    expect(parseLauncherArgs([])).toEqual({
      printUrl: false,
      build: true,
      help: false,
      open: null,
      autostart: false,
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
      argv: ['--port=5000', '--home=D:\\px', '--backend=fake'],
      env,
      cwd: 'C:\\repo',
    });
    expect(serverArgsFor(config)).toEqual([
      '--home=D:\\px',
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
      home: 'D:\\px',
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
      '--open',
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
    expect(parseLauncherArgs(['--open=']).problem).toMatch(/needs a parallax:\/\/session/);
    expect(parseLauncherArgs(['--autostart', '--open', URI]).problem).toMatch(/cannot be combined/);
  });
});
