import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  createServerInstance,
  defaultHome,
  loadConfig,
  readServerVersion,
  readSettingsFile,
  resolveSystemIntegrationMode,
  systemIntegrationAvailable,
} from './config';

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
      toasts: process.platform === 'win32' ? 'native' : 'off',
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      home: path.join('C:\\Users\\u\\AppData\\Local', 'Parallax'),
      dataDirLabel: '%LOCALAPPDATA%\\Parallax',
      logLevel: 'info',
      // Production default 'auto'; this process runs under Vitest → always 'off' (R6).
      systemIntegration: 'off',
      notes: [],
    });
  });

  it('native toasts: flag > env > off under tests (Vitest, NODE_ENV=test) (WP22-03)', () => {
    const load = (argv: string[], vars: Record<string, string> = {}) =>
      loadConfig({ argv: ['--home=D:\\data\\px', ...argv], env: env(vars), cwd: CWD }).toasts;
    expect(load(['--toasts=off'])).toBe('off');
    expect(load([], { PARALLAX_TOASTS: 'off' })).toBe('off');
    expect(load(['--toasts=native'], { PARALLAX_TOASTS: 'off', VITEST: 'true' })).toBe('native');
    expect(load([], { VITEST: 'true' })).toBe('off');
    expect(load([], { NODE_ENV: 'test' })).toBe('off');
    expect(() => load(['--toasts=loud'])).toThrow(ConfigError);
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

describe('port from settings.json (ADR-111)', () => {
  const settingsFile = (port: unknown, schemaVersion = 1): string =>
    JSON.stringify({ schemaVersion, settings: { port } });
  const reader =
    (files: Record<string, string>) =>
    (file: string): string => {
      const text = files[file];
      if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return text;
    };
  const at = (argv: string[], vars: Record<string, string>, files: Record<string, string>) =>
    loadConfig({ argv: ['--home=D:\\px', ...argv], env: env(vars), cwd: CWD, readFile: reader(files) });
  const FILE = 'D:\\px\\settings.json';

  it('flag > PARALLAX_PORT > settings.port > 4711', () => {
    const files = { [FILE]: settingsFile(4890) };
    expect(at([], {}, files).port).toBe(4890);
    expect(at([], { PARALLAX_PORT: '4891' }, files).port).toBe(4891);
    expect(at(['--port=4892'], { PARALLAX_PORT: '4891' }, files).port).toBe(4892);
    expect(at([], {}, { [FILE]: settingsFile(null) }).port).toBe(DEFAULT_PORT);
    expect(at([], {}, {}).port).toBe(DEFAULT_PORT);
    expect(at([], {}, {}).notes).toEqual([]);
  });

  it('reads the file only when no flag/env names the port, and never writes it', () => {
    const read: string[] = [];
    const config = loadConfig({
      argv: ['--home=D:\\px', '--port=4800'],
      env: env(),
      cwd: CWD,
      readFile: (file) => {
        read.push(file);
        return settingsFile(4890);
      },
    });
    expect(config.port).toBe(4800);
    expect(read).toEqual([]);
  });

  it.each([
    ['newer schema version', settingsFile(4890, 2), /newer Parallax version, schemaVersion 2/],
    ['invalid JSON', '{nope', /not valid JSON/],
    ['an invalid port', settingsFile(80), /invalid settings file/],
  ])('ignores a settings file with %s (hint in notes, default port)', (_name, text, note) => {
    const config = at([], {}, { [FILE]: text });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.notes).toHaveLength(1);
    expect(config.notes[0]).toMatch(note);
    expect(config.notes[0]).toContain(FILE);
  });

  it('an unreadable file is a hint too; a missing one is none', () => {
    const peek = readSettingsFile('D:\\px', () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(peek).toEqual({ settings: null, note: expect.stringMatching(/not readable: EACCES/) as string });
    expect(readSettingsFile('D:\\px', reader({}))).toEqual({ settings: null, note: null });
  });

  it('never reads the real data directory under Vitest, even with a hand-made env', () => {
    const read: string[] = [];
    readSettingsFile(defaultHome(process.env), (file) => {
      read.push(file);
      return settingsFile(4890);
    });
    expect(read).toEqual([]);
  });
});

describe('system integration mode (ADR-110, R6)', () => {
  it('auto/on/off outside tests; always off in a test run, on there is an error', () => {
    for (const mode of ['auto', 'on', 'off'] as const) {
      expect(resolveSystemIntegrationMode(mode, false)).toBe(mode);
    }
    expect(resolveSystemIntegrationMode('auto', true)).toBe('off');
    expect(resolveSystemIntegrationMode('off', true)).toBe('off');
    expect(() => resolveSystemIntegrationMode('on', true)).toThrow(ConfigError);
  });

  it('flag > env; under Vitest (this process) and NODE_ENV=test always off', () => {
    const at = (argv: string[], vars: Record<string, string> = {}) =>
      loadConfig({ argv: ['--home=D:\\px', ...argv], env: env(vars), cwd: CWD }).systemIntegration;
    expect(at([])).toBe('off');
    expect(at(['--system-integration=auto'])).toBe('off');
    expect(at([], { PARALLAX_SYSTEM_INTEGRATION: 'off' })).toBe('off');
    expect(() => at(['--system-integration=on'])).toThrow(/not allowed in tests/);
    expect(() => at([], { PARALLAX_SYSTEM_INTEGRATION: 'on', NODE_ENV: 'test' })).toThrow(ConfigError);
    expect(() => at(['--system-integration=always'])).toThrow(ConfigError);
  });

  it('available: on/off as given; auto only for the productive server', () => {
    const vars = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const real = 'C:\\Users\\u\\AppData\\Local\\Parallax';
    const base = { systemIntegration: 'auto' as const, home: real, backend: 'sdk' as const, dev: false };
    expect(systemIntegrationAvailable(base, vars, 'win32')).toBe(true);
    expect(
      systemIntegrationAvailable(
        { ...base, home: 'c:\\USERS\\u\\appdata\\local\\parallax\\' },
        vars,
        'win32',
      ),
    ).toBe(true);
    expect(systemIntegrationAvailable({ ...base, home: 'D:\\px' }, vars, 'win32')).toBe(false);
    expect(systemIntegrationAvailable({ ...base, backend: 'fake' }, vars, 'win32')).toBe(false);
    expect(systemIntegrationAvailable({ ...base, dev: true }, vars, 'win32')).toBe(false);
    expect(systemIntegrationAvailable(base, vars, 'linux')).toBe(false);
    expect(
      systemIntegrationAvailable({ ...base, systemIntegration: 'on', home: 'D:\\px' }, vars, 'win32'),
    ).toBe(true);
    expect(systemIntegrationAvailable({ ...base, systemIntegration: 'off' }, vars, 'win32')).toBe(false);
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
