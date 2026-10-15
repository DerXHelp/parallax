import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PORT, createServerInstance, loadConfig, readServerVersion } from './config';

const CWD = 'D:\\work\\repo';
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  ...vars,
});

describe('loadConfig', () => {
  it('uses production defaults', () => {
    expect(loadConfig({ argv: [], env: env(), cwd: CWD })).toEqual({
      dev: false,
      backend: 'sdk',
      validation: 'log',
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      home: path.join('C:\\Users\\u\\AppData\\Local', 'Parallax'),
      dataDirLabel: '%LOCALAPPDATA%\\Parallax',
      logLevel: 'info',
    });
  });

  it('parses the pnpm dev flags (ADR-006)', () => {
    const config = loadConfig({
      argv: ['--dev', '--backend=fake', '--port=4712', '--home=.parallax-dev'],
      env: env(),
      cwd: CWD,
    });
    expect(config).toMatchObject({
      dev: true,
      backend: 'fake',
      port: 4712,
      home: path.resolve(CWD, '.parallax-dev'),
      dataDirLabel: 'dev',
      logLevel: 'debug',
    });
  });

  it('never defaults to %LOCALAPPDATA% in dev mode', () => {
    expect(loadConfig({ argv: ['--dev'], env: env(), cwd: CWD })).toMatchObject({
      home: path.resolve(CWD, '.parallax-dev'),
      backend: 'fake',
    });
  });

  it('prefers flags over env over defaults; PARALLAX_PORT=0 is allowed', () => {
    const vars = env({
      PARALLAX_PORT: '0',
      PARALLAX_HOME: 'D:\\data\\px',
      PARALLAX_HOST: '127.0.0.1',
      PARALLAX_LOG_LEVEL: 'warn',
    });
    expect(loadConfig({ argv: [], env: vars, cwd: CWD })).toMatchObject({
      port: 0,
      home: 'D:\\data\\px',
      host: '127.0.0.1',
      logLevel: 'warn',
    });
    expect(loadConfig({ argv: ['--port=5000', '--home=D:\\other'], env: vars, cwd: CWD })).toMatchObject({
      port: 5000,
      home: 'D:\\other',
    });
    expect(loadConfig({ argv: [], env: env({ PARALLAX_DEV: '1' }), cwd: CWD }).dev).toBe(true);
  });

  it.each([
    [['--port=70000']],
    [['--port=']],
    [['--port=12ab']],
    [['--backend=live']],
    [['--host=localhost']],
    [['--unknown']],
    [['positional']],
    [['--log-level=loud']],
  ])('rejects %j', (argv) => {
    expect(() => loadConfig({ argv, env: env(), cwd: CWD })).toThrow(ConfigError);
  });

  it.each(['0.0.0.0', '127.0.0.2', '::1', '::', '192.168.1.10', 'localhost'])(
    'binds only to 127.0.0.1: --host=%s and PARALLAX_HOST are rejected (R1-05)',
    (host) => {
      expect(() => loadConfig({ argv: [`--host=${host}`], env: env(), cwd: CWD })).toThrow(
        /only 127\.0\.0\.1/,
      );
      expect(() => loadConfig({ argv: [], env: env({ PARALLAX_HOST: host }), cwd: CWD })).toThrow(
        ConfigError,
      );
    },
  );

  it('accepts --host=127.0.0.1 explicitly', () => {
    expect(loadConfig({ argv: ['--host=127.0.0.1'], env: env(), cwd: CWD }).host).toBe('127.0.0.1');
  });

  it('rejects unsafe home paths and the real home under Vitest', () => {
    expect(() => loadConfig({ argv: ['--home=\\\\server\\share'], env: env(), cwd: CWD })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ argv: [], env: env({ VITEST: 'true' }), cwd: CWD })).toThrow(
      /real data directory/,
    );
    // R0-23: also a folder inside it, any spelling
    expect(() =>
      loadConfig({
        argv: ['--home=c:\\users\\U\\appdata\\local\\PARALLAX\\sub'],
        env: env({ VITEST: 'true' }),
        cwd: CWD,
      }),
    ).toThrow(/real data directory/);
    expect(
      loadConfig({
        argv: ['--home=C:\\Users\\u\\AppData\\Local\\Parallax-test'],
        env: env({ VITEST: 'true' }),
        cwd: CWD,
      }).home,
    ).toBe('C:\\Users\\u\\AppData\\Local\\Parallax-test');
  });

  it('never runs the FakeBackend on the real data directory or inside it (R3-02)', () => {
    for (const argv of [
      ['--backend=fake'],
      ['--backend=fake', '--home=c:\\users\\U\\appdata\\local\\PARALLAX'],
      ['--backend=fake', '--home=C:\\Users\\u\\AppData\\Local\\Parallax\\sub'],
    ]) {
      expect(() => loadConfig({ argv, env: env(), cwd: CWD })).toThrow(
        /FakeBackend never uses the real data/,
      );
    }
    expect(() => loadConfig({ argv: [], env: env({ PARALLAX_BACKEND: 'fake' }), cwd: CWD })).toThrow(
      ConfigError,
    );
    // Another home, dev mode (.parallax-dev) and the SdkBackend on the real home stay allowed.
    expect(loadConfig({ argv: ['--backend=fake', '--home=D:\\tmp\\px'], env: env(), cwd: CWD }).backend).toBe(
      'fake',
    );
    expect(loadConfig({ argv: ['--dev'], env: env(), cwd: CWD }).backend).toBe('fake');
    expect(loadConfig({ argv: ['--backend=sdk'], env: env(), cwd: CWD }).dataDirLabel).toBe(
      '%LOCALAPPDATA%\\Parallax',
    );
  });

  it('outgoing validation: flag > PARALLAX_VALIDATE > test runs throw > log (R3-05)', () => {
    const at = (argv: string[], vars: Record<string, string> = {}) =>
      loadConfig({ argv, env: env(vars), cwd: CWD }).validation;
    expect(at([])).toBe('log');
    expect(at(['--dev'])).toBe('log');
    expect(at([], { VITEST: 'true', PARALLAX_HOME: 'D:\\tmp\\px' })).toBe('throw');
    expect(at([], { NODE_ENV: 'test' })).toBe('throw');
    expect(at([], { PARALLAX_VALIDATE: 'off' })).toBe('off');
    expect(at(['--validate=throw'], { PARALLAX_VALIDATE: 'off' })).toBe('throw');
    expect(at(['--validate=log'], { NODE_ENV: 'test' })).toBe('log');
    expect(() => at(['--validate=loud'])).toThrow(ConfigError);
  });
});

describe('server instance', () => {
  it('has a fresh UUID, the package version and the build id', () => {
    const a = createServerInstance({ now: new Date('2026-10-15T08:00:00.000Z') });
    const b = createServerInstance();
    expect(a.serverInstanceId).not.toBe(b.serverInstanceId);
    expect(a).toMatchObject({ buildId: 'dev', startedAt: '2026-10-15T08:00:00.000Z' });
    expect(a.serverVersion).toBe(readServerVersion());
    expect(readServerVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
