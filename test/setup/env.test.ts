import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotRealHome } from './home';

describe('test environment', () => {
  it('uses a temp PARALLAX_HOME and port 0', () => {
    const home = process.env.PARALLAX_HOME ?? '';
    expect(home).not.toBe('');
    expect(path.resolve(home).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())).toBe(true);
    expect(process.env.PARALLAX_PORT).toBe('0');
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
});
