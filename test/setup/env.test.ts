import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SERVER_CONTROL_VARS, assertNotRealHome, ensureTestEnv, isOwnTestHome, isPathInside } from './home';

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
      assertNotRealHome('C:\\Users\\x\\AppData\\Local\\parallax', env);
    }).toThrow(/real data directory/);
  });

  it.each([
    'C:\\Users\\x\\AppData\\Local\\Parallax\\',
    'c:\\users\\X\\appdata\\local\\PARALLAX\\tmp-123',
    'C:/Users/x/AppData/Local/Parallax/logs/sub',
    'C:\\Users\\x\\AppData\\Local\\Temp\\..\\Parallax\\x',
  ])('refuses %s inside the real data directory (R0-23)', (home) => {
    expect(() => {
      assertNotRealHome(home, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    }).toThrow(/real data directory/);
  });

  it.each([
    'C:\\Users\\x\\AppData\\Local\\Parallax-dev',
    'C:\\Users\\x\\AppData\\Local\\Temp\\Parallax',
    'D:\\Parallax',
  ])('allows %s (not inside it)', (home) => {
    expect(() => {
      assertNotRealHome(home, { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    }).not.toThrow();
  });

  it('isPathInside compares case-insensitively with / and \\ alike', () => {
    expect(isPathInside('C:/A/b/c', 'c:\\a\\B')).toBe(true);
    expect(isPathInside('C:\\a\\bc', 'C:\\a\\b')).toBe(false);
    expect(isPathInside('C:\\a\\b\\', 'C:\\a\\b')).toBe(true);
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
      OTHER: 'kept',
    });
    expect(env.PARALLAX_PORT).toBe('0');
    for (const name of [
      'PARALLAX',
      'PARALLAX_ENTRY_ID',
      'parallax_backend',
      'PARALLAX_VALIDATE',
      'PARALLAX_DEV',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    // Guard flags of the live tools are no server configuration (e2e/live checks them itself).
    expect(env.PARALLAX_LIVE).toBe('1');
    expect(env.OTHER).toBe('kept');
  });
});
