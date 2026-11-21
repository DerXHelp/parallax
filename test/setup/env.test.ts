import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../../src/server/config';
import {
  SERVER_CONTROL_VARS,
  assertNotRealHome,
  ensureTestEnv,
  isOwnTestHome,
  isPathInside,
  useLongTempDir,
} from './home';

describe('test environment', () => {
  it('uses a temp PARALLAX_HOME and port 0', () => {
    const home = process.env.PARALLAX_HOME ?? '';
    expect(home).not.toBe('');
    expect(path.resolve(home).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())).toBe(true);
    expect(isOwnTestHome(home)).toBe(true);
    expect(process.env.PARALLAX_PORT).toBe('0');
    for (const name of SERVER_CONTROL_VARS) expect(process.env[name], name).toBeUndefined();
  });

  it('refuses the real data directory', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
    expect(() => {
      assertNotRealHome('C:\\Users\\x\\AppData\\Local\\parallax', env, 'win32');
    }).toThrow(/real data directory/);
  });

  it.each([
    'C:\\Users\\x\\AppData\\Local\\Parallax\\',
    'c:\\users\\X\\appdata\\local\\PARALLAX\\tmp-123',
    'C:/Users/x/AppData/Local/Parallax/logs/sub',
    'C:\\Users\\x\\AppData\\Local\\Temp\\..\\Parallax\\x',
  ])('refuses %s inside the real data directory (R0-23)', (home) => {
    expect(() => {
      assertNotRealHome(home, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32');
    }).toThrow(/real data directory/);
  });

  it.each([
    'C:\\Users\\x\\AppData\\Local\\Parallax-dev',
    'C:\\Users\\x\\AppData\\Local\\Temp\\Parallax',
    'D:\\Parallax',
  ])('allows %s (not inside it)', (home) => {
    expect(() => {
      assertNotRealHome(home, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32');
    }).not.toThrow();
  });

  it('isPathInside compares case-insensitively with / and \\ alike', () => {
    expect(isPathInside('C:/A/b/c', 'c:\\a\\B', 'win32')).toBe(true);
    expect(isPathInside('C:\\a\\bc', 'C:\\a\\b', 'win32')).toBe(false);
    expect(isPathInside('C:\\a\\b\\', 'C:\\a\\b', 'win32')).toBe(true);
    // Drive root and doubled separators (CR-09).
    expect(isPathInside('D:\\x', 'D:\\', 'win32')).toBe(true);
    expect(isPathInside('d:/', 'D:\\', 'win32')).toBe(true);
    expect(isPathInside('D:\\', 'D:\\x', 'win32')).toBe(false);
    expect(isPathInside('C:\\a\\\\b\\c', 'C:\\a\\b', 'win32')).toBe(true);
  });

  it('isPathInside on POSIX compares exactly (WP-103)', () => {
    expect(isPathInside('/home/u/a/b', '/home/u/a', 'linux')).toBe(true);
    expect(isPathInside('/home/u/a/', '/home/u/a', 'linux')).toBe(true);
    expect(isPathInside('/home/u//a/b', '/home/u/a', 'linux')).toBe(true);
    expect(isPathInside('/home/u/A/b', '/home/u/a', 'linux')).toBe(false);
    expect(isPathInside('/home/u/ab', '/home/u/a', 'linux')).toBe(false);
    expect(isPathInside('/x', '/', 'linux')).toBe(true);
  });

  it.each([
    ['/home/u/.local/share/parallax', { HOME: '/home/u' }],
    ['/home/u/.local/share/parallax/sub', { HOME: '/home/u' }],
    ['/home/u/.local/share/tmp/../parallax/', { HOME: '/home/u' }],
    ['/data/xdg/parallax', { HOME: '/home/u', XDG_DATA_HOME: '/data/xdg' }],
    ['/data/xdg/parallax/logs', { HOME: '/home/u', XDG_DATA_HOME: '/data/xdg' }],
  ])('POSIX: refuses %s inside the real data directory (WP-103)', (home, env) => {
    expect(() => {
      assertNotRealHome(home, env, 'linux');
    }).toThrow(/real data directory/);
  });

  it.each([
    ['/home/u/.local/share/Parallax', { HOME: '/home/u' }],
    ['/home/u/.local/share/parallax-dev', { HOME: '/home/u' }],
    ['/tmp/parallax-test-abc', { HOME: '/home/u' }],
    // A set XDG_DATA_HOME moves the data directory: ~/.local/share/parallax is then a normal folder.
    ['/home/u/.local/share/parallax', { HOME: '/home/u', XDG_DATA_HOME: '/data/xdg' }],
  ])('POSIX: allows %s (not inside it)', (home, env) => {
    expect(() => {
      assertNotRealHome(home, env, 'linux');
    }).not.toThrow();
  });

  /**
   * CR-09: the guard and config.ts (which refuses the FakeBackend on/inside the real data directory)
   * use the one rule set of @shared/paths – both verdicts agree, and both are the expected one.
   */
  function expectVerdict(
    home: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    cwd: string,
    refused: boolean,
  ): void {
    let refusedByConfig = false;
    try {
      loadConfig({ argv: ['--backend=fake', `--home=${home}`, '--port=0'], env, cwd, platform });
    } catch (error) {
      refusedByConfig = error instanceof ConfigError && error.message.includes('real data directory');
    }
    let refusedByGuard = false;
    try {
      assertNotRealHome(home, env, platform);
    } catch {
      refusedByGuard = true;
    }
    expect({ guard: refusedByGuard, config: refusedByConfig }).toEqual({ guard: refused, config: refused });
  }

  it.each([
    ['C:\\Users\\x\\AppData\\Local\\Parallax', true],
    ['c:/users/X/appdata/local/parallax/', true],
    ['C:\\Users\\x\\AppData\\Local\\\\Parallax\\sub', true],
    ['C:\\Users\\x\\AppData\\Local\\Parallax-other', false],
    ['C:\\Users\\x\\AppData\\Local\\Temp\\parallax', false],
    ['D:\\Parallax', false],
  ])('CR-09: the test guard judges %s like config.ts (one rule, @shared/paths)', (home, refused) => {
    expectVerdict(home, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\repo', refused);
  });

  it.each([
    ['/home/u/.local/share/parallax', true],
    ['/home/u/.local/share/parallax/sub', true],
    ['/home/u/.local/share//parallax/', true],
    ['/home/u/.local/share/Parallax', false],
    ['/home/u/.local/share/parallax-other', false],
    ['/tmp/parallax', false],
  ])('CR-09 POSIX: the test guard judges %s like config.ts (WP-103)', (home, refused) => {
    expectVerdict(home, { HOME: '/home/u' }, 'linux', '/repo', refused);
  });
});

describe('ensureTestEnv – inherited homes (WP22-07)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'px-setup-test-'));
  const LOCAL = 'C:\\Users\\x\\AppData\\Local';
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function run(env: NodeJS.ProcessEnv, fresh = false) {
    const notes: string[] = [];
    const created = ensureTestEnv(env, { fresh, tmpdir: tmp, note: (m) => notes.push(m) });
    return { env, created, notes };
  }

  it.each([
    ['the real data directory', `${LOCAL}\\Parallax`],
    ['a folder inside the real data directory', `${LOCAL}\\Parallax\\sub`],
    ['a non-temporary folder', 'D:\\data\\parallax-home'],
    ['the temp home of a running (live) server', path.join(tmp, 'parallax-live-123', 'home')],
    ['another temp folder', path.join(tmp, 'something')],
  ])('never uses %s – a fresh temp home instead', (_label, inherited) => {
    const { env, created, notes } = run({ LOCALAPPDATA: LOCAL, PARALLAX_HOME: inherited });
    expect(created).toBeDefined();
    expect(env.PARALLAX_HOME).toBe(created);
    expect(isOwnTestHome(created ?? '', env, tmp)).toBe(true);
    expect(notes.join('\n')).toContain(inherited);
  });

  it('keeps its own test home in a worker, but replaces it in the globalSetup (fresh)', () => {
    const own = path.join(tmp, 'parallax-test-abc');
    mkdirSync(own);
    const worker = run({ LOCALAPPDATA: LOCAL, PARALLAX_HOME: own });
    expect(worker.created).toBeUndefined();
    expect(worker.env.PARALLAX_HOME).toBe(own);
    expect(worker.notes).toEqual([]);
    const globalSetup = run({ LOCALAPPDATA: LOCAL, PARALLAX_HOME: own }, true);
    expect(globalSetup.created).toBeDefined();
    expect(globalSetup.env.PARALLAX_HOME).not.toBe(own);
  });

  it('does not keep an own test home that does not exist', () => {
    const { created } = run({ LOCALAPPDATA: LOCAL, PARALLAX_HOME: path.join(tmp, 'parallax-test-gone') });
    expect(created).toBeDefined();
  });

  it('forces port 0 and drops inherited server control variables', () => {
    const { env } = run({
      LOCALAPPDATA: LOCAL,
      PARALLAX_PORT: '4711',
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: 'en_x',
      parallax_backend: 'sdk',
      PARALLAX_VALIDATE: 'off',
      PARALLAX_DEV: '1',
      PARALLAX_LIVE: '1',
      PARALLAX_UPDATE_READY_TIMEOUT_S: '600',
      PARALLAX_TEST_UPDATE_BASE: 'http://127.0.0.1:1/releases',
      parallax_test_release_keys: 'key',
      PARALLAX_TEST_REGISTRY: 'http://127.0.0.1:1/',
      OTHER: 'kept',
    });
    expect(env.PARALLAX_PORT).toBe('0');
    for (const name of [
      'PARALLAX',
      'PARALLAX_ENTRY_ID',
      'parallax_backend',
      'PARALLAX_VALIDATE',
      'PARALLAX_DEV',
      'PARALLAX_UPDATE_READY_TIMEOUT_S',
      'PARALLAX_TEST_UPDATE_BASE',
      'parallax_test_release_keys',
      'PARALLAX_TEST_REGISTRY',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    // Guard flags of the live tools are no server configuration (e2e/live checks them itself).
    expect(env.PARALLAX_LIVE).toBe('1');
    expect(env.OTHER).toBe('kept');
  });
});

describe('useLongTempDir', () => {
  it('points TEMP/TMP to the long form of an 8.3 short name (GitHub runner: RUNNER~1)', () => {
    const short = path.win32.join(process.env.SystemDrive ?? 'C:', path.win32.sep, 'PROGRA~1');
    // Only where Windows creates 8.3 names on the system drive (default; the CI runner has them).
    if (process.platform !== 'win32' || !existsSync(short)) return;
    vi.stubEnv('TEMP', short);
    vi.stubEnv('TMP', short);
    try {
      const long = useLongTempDir();
      expect(long).not.toContain('~');
      expect(process.env.TEMP).toBe(long);
      expect(process.env.TMP).toBe(long);
      expect(os.tmpdir()).toBe(long);
      expect(useLongTempDir()).toBe(long);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the test run itself uses the long form', () => {
    if (process.platform !== 'win32') return;
    expect(os.tmpdir()).not.toContain('~');
  });
});
