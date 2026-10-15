import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { LAUNCHER_USAGE, parseLauncherArgs, serverArgsFor } from './args';

describe('launcher command line', () => {
  it('separates the launcher flags from the server flags', () => {
    expect(parseLauncherArgs(['--print-url', '--port=5000', '--no-build', '--backend=fake'])).toEqual({
      printUrl: true,
      build: false,
      help: false,
      serverArgv: ['--port=5000', '--backend=fake'],
    });
    expect(parseLauncherArgs([])).toEqual({ printUrl: false, build: true, help: false, serverArgv: [] });
    expect(parseLauncherArgs(['-h']).help).toBe(true);
    expect(parseLauncherArgs(['--help']).help).toBe(true);
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
    ]);
    // The server accepts exactly these flags (parseArgs strict) and resolves the same values.
    expect(loadConfig({ argv: serverArgsFor(config), env: {}, cwd: 'C:\\elsewhere' })).toMatchObject({
      home: 'D:\\px',
      port: 5000,
      backend: 'fake',
    });
  });

  it('passes PARALLAX_BACKEND=fake on as --backend=fake (smoke/E2E of the launcher path, WP-20)', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PARALLAX_BACKEND: 'fake' };
    expect(serverArgsFor(loadConfig({ argv: [], env, cwd: 'C:\\repo' }))).toContain('--backend=fake');
    // Without the variable the launcher starts the real backend; a flag wins over the variable.
    expect(serverArgsFor(loadConfig({ argv: [], env: {}, cwd: 'C:\\repo' }))).toContain('--backend=sdk');
    expect(serverArgsFor(loadConfig({ argv: ['--backend=sdk'], env, cwd: 'C:\\repo' }))).toContain(
      '--backend=sdk',
    );
    expect(LAUNCHER_USAGE).toContain('PARALLAX_BACKEND');
  });

  it('documents every flag in the usage text', () => {
    for (const flag of ['--port', '--home', '--backend', '--no-build', '--print-url', '--help']) {
      expect(LAUNCHER_USAGE).toContain(flag);
    }
  });
});
