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
      PARALLAX_HOST: '127.0.0.2',
      PARALLAX_LOG_LEVEL: 'warn',
    });
    expect(loadConfig({ argv: [], env: vars, cwd: CWD })).toMatchObject({
      port: 0,
      home: 'D:\\data\\px',
      host: '127.0.0.2',
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

  it('rejects unsafe home paths and the real home under Vitest', () => {
    expect(() => loadConfig({ argv: ['--home=\\\\server\\share'], env: env(), cwd: CWD })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ argv: [], env: env({ VITEST: 'true' }), cwd: CWD })).toThrow(
      /real data directory/,
    );
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
