import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT } from '@shared/model';
import { makeTempHome } from './http/testServer';
import {
  ConfigError,
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
    expect(loadConfig({ platform: 'win32', argv: [], env: env(), cwd: CWD })).toEqual({
      dev: false,
      backend: 'sdk',
      validation: 'log',
      toasts: 'native',
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      home: path.win32.join('C:\\Users\\u\\AppData\\Local', 'Parallax'),
      dataDirLabel: '%LOCALAPPDATA%\\Parallax',
      logLevel: 'info',
      // Production default 'auto'; this process runs under Vitest → always 'off' (R6).
      systemIntegration: 'off',
      keyStore: 'auto',
      installRoot: null,
      notes: [],
    });
  });

  it('key store opt-in (WP-76 §B.14): flag over env, file only on Linux', () => {
    const linux = (argv: string[], vars: NodeJS.ProcessEnv = {}) =>
      loadConfig({
        platform: 'linux',
        argv: ['--home=/tmp/px', ...argv],
        env: { HOME: '/home/u', ...vars },
        cwd: '/home/u',
      }).keyStore;
    expect(linux([])).toBe('auto');
    expect(linux(['--key-store=file'])).toBe('file');
    expect(linux([], { PARALLAX_KEY_STORE: 'file' })).toBe('file');
    expect(linux(['--key-store=auto'], { PARALLAX_KEY_STORE: 'file' })).toBe('auto');
    expect(() => linux(['--key-store=plain'])).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        platform: 'win32',
        argv: ['--home=D:\\data\\px', '--key-store=file'],
        env: env(),
        cwd: CWD,
      }),
    ).toThrow(/only on Linux/);
  });

  it('takes the install root of a package start (WP-86) and refuses an unsafe one', () => {
    const load = (argv: string[]) =>
      loadConfig({ platform: 'win32', argv: ['--home=D:\\data\\px', ...argv], env: env(), cwd: CWD })
        .installRoot;
    expect(load([])).toBeNull();
    expect(load(['--install-root=D:\\apps\\Parallax'])).toBe('D:\\apps\\Parallax');
    expect(() => load(['--install-root=\\\\server\\share\\Parallax'])).toThrow(ConfigError);
  });

  it('native toasts: flag > env > off under tests (Vitest, NODE_ENV=test) (WP22-03)', () => {
    const load = (argv: string[], vars: Record<string, string> = {}) =>
      loadConfig({ platform: 'win32', argv: ['--home=D:\\data\\px', ...argv], env: env(vars), cwd: CWD })
        .toasts;
    expect(load(['--toasts=off'])).toBe('off');
    expect(load([], { PARALLAX_TOASTS: 'off' })).toBe('off');
    expect(load(['--toasts=native'], { PARALLAX_TOASTS: 'off', VITEST: 'true' })).toBe('native');
    expect(load([], { VITEST: 'true' })).toBe('off');
    expect(load([], { NODE_ENV: 'test' })).toBe('off');
    expect(() => load(['--toasts=loud'])).toThrow(ConfigError);
  });

  it('parses the pnpm dev flags (ADR-006)', () => {
    const config = loadConfig({
      platform: 'win32',
      argv: ['--dev', '--backend=fake', '--port=4712', '--home=.parallax-dev'],
      env: env(),
      cwd: CWD,
    });
    expect(config).toMatchObject({
      dev: true,
      backend: 'fake',
      port: 4712,
      home: path.win32.resolve(CWD, '.parallax-dev'),
      dataDirLabel: 'dev',
      logLevel: 'debug',
    });
  });

  it('never defaults to %LOCALAPPDATA% in dev mode', () => {
    expect(loadConfig({ platform: 'win32', argv: ['--dev'], env: env(), cwd: CWD })).toMatchObject({
      home: path.win32.resolve(CWD, '.parallax-dev'),
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
    expect(loadConfig({ platform: 'win32', argv: [], env: vars, cwd: CWD })).toMatchObject({
      port: 0,
      home: 'D:\\data\\px',
      host: '127.0.0.1',
      logLevel: 'warn',
    });
    expect(
      loadConfig({ platform: 'win32', argv: ['--port=5000', '--home=D:\\other'], env: vars, cwd: CWD }),
    ).toMatchObject({
      port: 5000,
      home: 'D:\\other',
    });
    expect(loadConfig({ platform: 'win32', argv: [], env: env({ PARALLAX_DEV: '1' }), cwd: CWD }).dev).toBe(
      true,
    );
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
    expect(() => loadConfig({ platform: 'win32', argv, env: env(), cwd: CWD })).toThrow(ConfigError);
  });

  it.each(['0.0.0.0', '127.0.0.2', '::1', '::', '192.168.1.10', 'localhost'])(
    'binds only to 127.0.0.1: --host=%s and PARALLAX_HOST are rejected (R1-05)',
    (host) => {
      expect(() => loadConfig({ platform: 'win32', argv: [`--host=${host}`], env: env(), cwd: CWD })).toThrow(
        /only 127\.0\.0\.1/,
      );
      expect(() =>
        loadConfig({ platform: 'win32', argv: [], env: env({ PARALLAX_HOST: host }), cwd: CWD }),
      ).toThrow(ConfigError);
    },
  );

  it('accepts --host=127.0.0.1 explicitly', () => {
    expect(loadConfig({ platform: 'win32', argv: ['--host=127.0.0.1'], env: env(), cwd: CWD }).host).toBe(
      '127.0.0.1',
    );
  });

  it('rejects unsafe home paths and the real home under Vitest', () => {
    expect(() =>
      loadConfig({ platform: 'win32', argv: ['--home=\\\\server\\share'], env: env(), cwd: CWD }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ platform: 'win32', argv: [], env: env({ VITEST: 'true' }), cwd: CWD })).toThrow(
      /real data directory/,
    );
    // R0-23: also a folder inside it, any spelling
    expect(() =>
      loadConfig({
        platform: 'win32',
        argv: ['--home=c:\\users\\U\\appdata\\local\\PARALLAX\\sub'],
        env: env({ VITEST: 'true' }),
        cwd: CWD,
      }),
    ).toThrow(/real data directory/);
    expect(
      loadConfig({
        platform: 'win32',
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
      expect(() => loadConfig({ platform: 'win32', argv, env: env(), cwd: CWD })).toThrow(
        /FakeBackend never uses the real data/,
      );
    }
    expect(() =>
      loadConfig({ platform: 'win32', argv: [], env: env({ PARALLAX_BACKEND: 'fake' }), cwd: CWD }),
    ).toThrow(ConfigError);
    // Another home, dev mode (.parallax-dev) and the SdkBackend on the real home stay allowed.
    expect(
      loadConfig({ platform: 'win32', argv: ['--backend=fake', '--home=D:\\tmp\\px'], env: env(), cwd: CWD })
        .backend,
    ).toBe('fake');
    expect(loadConfig({ platform: 'win32', argv: ['--dev'], env: env(), cwd: CWD }).backend).toBe('fake');
    expect(
      loadConfig({ platform: 'win32', argv: ['--backend=sdk'], env: env(), cwd: CWD }).dataDirLabel,
    ).toBe('%LOCALAPPDATA%\\Parallax');
  });

  it('outgoing validation: flag > PARALLAX_VALIDATE > test runs throw > log (R3-05)', () => {
    const at = (argv: string[], vars: Record<string, string> = {}) =>
      loadConfig({ platform: 'win32', argv, env: env(vars), cwd: CWD }).validation;
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
    loadConfig({
      platform: 'win32',
      argv: ['--home=D:\\px', ...argv],
      env: env(vars),
      cwd: CWD,
      readFile: reader(files),
    });
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
      platform: 'win32',
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
    const peek = readSettingsFile(
      'D:\\px',
      () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      'win32',
    );
    expect(peek).toEqual({ settings: null, note: expect.stringMatching(/not readable: EACCES/) as string });
    expect(readSettingsFile('D:\\px', reader({}), 'win32')).toEqual({ settings: null, note: null });
  });

  it('R4-15: the real reader checks the size first – a file over 1 MiB is not read', async () => {
    const home = await makeTempHome('r4-settings-');
    try {
      await writeFile(path.join(home, 'settings.json'), ' '.repeat(1024 * 1024 + 1));
      expect(readSettingsFile(home)).toEqual({
        settings: null,
        note: expect.stringMatching(/not readable: file too large/) as string,
      });
      await writeFile(path.join(home, 'settings.json'), settingsFile(4890));
      expect(readSettingsFile(home).settings?.port).toBe(4890);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
      loadConfig({ platform: 'win32', argv: ['--home=D:\\px', ...argv], env: env(vars), cwd: CWD })
        .systemIntegration;
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

describe('loadConfig on Linux (WP-103)', () => {
  const HOME = '/home/u';
  const noSettings = (): string => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const linux = (argv: string[], vars: Record<string, string> = {}, cwd = '/home/u/repo') =>
    loadConfig({ platform: 'linux', argv, env: { HOME, ...vars }, cwd, readFile: noSettings });

  it('production defaults: ~/.local/share/parallax, no native toasts', () => {
    expect(linux([])).toMatchObject({
      home: '/home/u/.local/share/parallax',
      dataDirLabel: '~/.local/share/parallax',
      toasts: 'off',
      backend: 'sdk',
    });
    expect(defaultHome({ HOME }, 'linux')).toBe('/home/u/.local/share/parallax');
  });

  it('XDG_DATA_HOME moves the data directory (only an absolute one counts)', () => {
    expect(linux([], { XDG_DATA_HOME: '/data/xdg' })).toMatchObject({
      home: '/data/xdg/parallax',
      dataDirLabel: '$XDG_DATA_HOME/parallax',
    });
    expect(linux([], { XDG_DATA_HOME: 'relative/xdg' }).home).toBe('/home/u/.local/share/parallax');
    expect(linux([], { XDG_DATA_HOME: '' }).home).toBe('/home/u/.local/share/parallax');
  });

  it('dev mode and relative homes resolve against the working directory', () => {
    expect(linux(['--dev']).home).toBe('/home/u/repo/.parallax-dev');
    expect(linux(['--home=data/px']).home).toBe('/home/u/repo/data/px');
    expect(linux(['--home=/tmp/px']).dataDirLabel).toBe('/tmp/px');
  });

  it('refuses homes and install roots the POSIX rules refuse', () => {
    expect(() => linux(['--home=/proc/1/cwd'])).toThrow(/invalid home \(pseudo_fs\)/);
    expect(() => linux(['--home=/sys/x'])).toThrow(/invalid home \(pseudo_fs\)/);
    expect(() => linux(['--home=/tmp/px', '--install-root=/dev/shm/px'])).toThrow(/invalid install root/);
    expect(linux(['--home=/tmp/px', '--install-root=/opt/parallax']).installRoot).toBe('/opt/parallax');
  });

  it('the FakeBackend and test runs never use the real data directory – compared case-sensitively', () => {
    expect(() => linux(['--backend=fake'])).toThrow(/FakeBackend never uses the real data.*\/tmp/);
    expect(() => linux(['--backend=fake', '--home=/home/u/.local/share//parallax/sub'])).toThrow(
      /FakeBackend never uses/,
    );
    expect(() => linux([], { VITEST: 'true' })).toThrow(/real data directory/);
    expect(linux(['--backend=fake', '--home=/home/u/.local/share/Parallax']).backend).toBe('fake');
  });

  it('native toasts exist only on Windows: an explicit request is turned off with a note', () => {
    const config = linux(['--home=/tmp/px', '--toasts=native']);
    expect(config.toasts).toBe('off');
    expect(config.notes).toEqual([expect.stringMatching(/only on Windows/)]);
    expect(linux(['--home=/tmp/px', '--toasts=off']).notes).toEqual([]);
  });

  it('the settings file is read from the POSIX home', () => {
    const read: string[] = [];
    loadConfig({
      platform: 'linux',
      argv: ['--home=/tmp/px'],
      env: { HOME },
      cwd: '/',
      readFile: (file) => {
        read.push(file);
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    });
    expect(read).toEqual(['/tmp/px/settings.json']);
  });
});
