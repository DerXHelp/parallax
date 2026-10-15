import { describe, expect, it } from 'vitest';
import type { RunFileFn, RunFileResult } from './process';
import {
  MACHINE_ENVIRONMENT_KEY,
  USER_ENVIRONMENT_KEY,
  expandRegValue,
  parseRegValues,
  readPersistentEnvironment,
  regKeyQuery,
  regQuery,
  type RegKeyQuery,
} from './registry';

/** `reg query HKCU\Environment` as printed by reg.exe (four-space separators, CRLF). */
const USER = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    NPM_CONFIG_REGISTRY    REG_SZ    https://nexus.corp/repository/npm/',
  '    IntelliJ IDEA    REG_SZ    C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin;',
  '    EMPTY_ONE    REG_SZ    ',
  '    BINARY_ONE    REG_BINARY    0102',
  '    NODE_ENV    REG_SZ    development',
  '',
].join('\r\n');

const MACHINE = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
  '    NODE_ENV    REG_SZ    production',
  '    PNPM_HOME    REG_SZ    C:\\pnpm',
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\\Subkey',
  '',
].join('\r\n');

const ENV = { USERPROFILE: 'C:\\Users\\u', SystemRoot: 'C:\\Windows' };

describe('parseRegValues', () => {
  it('reads names with spaces, empty data and every type (subkeys/headers skipped)', () => {
    expect(parseRegValues(USER)).toEqual([
      { name: 'Path', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;' },
      { name: 'TEMP', type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\AppData\\Local\\Temp' },
      { name: 'NPM_CONFIG_REGISTRY', type: 'REG_SZ', data: 'https://nexus.corp/repository/npm/' },
      { name: 'IntelliJ IDEA', type: 'REG_SZ', data: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin;' },
      { name: 'EMPTY_ONE', type: 'REG_SZ', data: '' },
      { name: 'BINARY_ONE', type: 'REG_BINARY', data: '0102' },
      { name: 'NODE_ENV', type: 'REG_SZ', data: 'development' },
    ]);
    expect(
      parseRegValues('ERROR: The system was unable to find the specified registry key or value.'),
    ).toEqual([]);
  });

  it('expands %NAME% like Windows (unknown names stay literal)', () => {
    expect(expandRegValue('%USERPROFILE%\\x;%NOPE%', ENV)).toBe('C:\\Users\\u\\x;%NOPE%');
  });
});

describe('readPersistentEnvironment (ADR-021)', () => {
  it('merges machine and user (user wins), expands REG_EXPAND_SZ, upper-cases names, skips non-strings', async () => {
    const queried: string[] = [];
    const query: RegKeyQuery = (key) => {
      queried.push(key);
      return Promise.resolve(
        key === USER_ENVIRONMENT_KEY ? USER : key === MACHINE_ENVIRONMENT_KEY ? MACHINE : null,
      );
    };
    const persistent = await readPersistentEnvironment({ query, env: ENV });
    expect(queried.sort()).toEqual([MACHINE_ENVIRONMENT_KEY, USER_ENVIRONMENT_KEY].sort());
    expect(persistent.get('NPM_CONFIG_REGISTRY')).toBe('https://nexus.corp/repository/npm/');
    expect(persistent.get('NODE_ENV')).toBe('development');
    expect(persistent.get('PNPM_HOME')).toBe('C:\\pnpm');
    expect(persistent.get('COMSPEC')).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(persistent.get('TEMP')).toBe('C:\\Users\\u\\AppData\\Local\\Temp');
    expect(persistent.get('INTELLIJ IDEA')).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin;');
    expect(persistent.has('BINARY_ONE')).toBe(false);
  });

  it('fails closed: unreadable keys give no entries', async () => {
    expect((await readPersistentEnvironment({ query: () => Promise.resolve(null), env: ENV })).size).toBe(0);
    expect((await readPersistentEnvironment({ env: ENV, platform: 'linux' })).size).toBe(0);
  });
});

describe('reg.exe calls (System32, argument array)', () => {
  const ok = (stdout: string): RunFileResult => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
  });

  it('queries the default value or the whole key and maps failures to null', async () => {
    const calls: string[][] = [];
    const run: RunFileFn = (file, args) => {
      calls.push([file, ...args]);
      if (args[1] === 'HKCU\\Missing') return Promise.resolve({ ...ok(''), exitCode: 1 });
      if (args[1] === 'HKCU\\Throws') return Promise.reject(new Error('spawn failed'));
      return Promise.resolve(ok('data'));
    };
    expect(await regQuery(run)('HKLM\\Key', 32)).toBe('data');
    expect(await regKeyQuery(run)('HKCU\\Environment', 64)).toBe('data');
    expect(await regKeyQuery(run)('HKCU\\Missing', 64)).toBeNull();
    expect(await regKeyQuery(run)('HKCU\\Throws', 64)).toBeNull();
    expect(calls[0]?.slice(1)).toEqual(['query', 'HKLM\\Key', '/ve', '/reg:32']);
    expect(calls[1]?.slice(1)).toEqual(['query', 'HKCU\\Environment', '/reg:64']);
    expect(calls[0]?.[0]?.toLowerCase()).toMatch(/^[a-z]:\\windows\\system32\\reg\.exe$/);
  });
});
