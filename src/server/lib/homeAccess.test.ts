import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempHome } from '../http/testServer';
import {
  checkHomeAccess,
  logHomeAccess,
  otherReaders,
  parseSddlDacl,
  parseWhoamiSid,
  type HomeAccess,
} from './homeAccess';
import { runFile, systemTool, type RunFileFn, type RunFileResult } from './process';

const windowsOnly = process.platform === 'win32' ? it : it.skip;
/** PowerShell + whoami (+ icacls) under parallel load. */
const TOOL_TEST_TIMEOUT_MS = 120_000;

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const PRIVATE_SDDL = `O:${USER}G:${USER}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`;

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('SDDL parsing (R2-13)', () => {
  it('reads type, flags, rights and SIDs; aliases become SIDs', () => {
    expect(parseSddlDacl(`O:BAG:SYD:AI(A;OICIID;0x1200a9;;;BU)(D;;FA;;;WD)(A;ID;CCDCLC;;;AU)`)).toEqual([
      { type: 'A', flags: ['OI', 'CI', 'ID'], mask: 0x1200a9, sid: 'S-1-5-32-545' },
      { type: 'D', flags: [], mask: 0x1f01ff, sid: 'S-1-1-0' },
      { type: 'A', flags: ['ID'], mask: 0x7, sid: 'S-1-5-11' },
    ]);
    expect(parseSddlDacl(PRIVATE_SDDL)).toHaveLength(3);
    // The SACL part is not part of the DACL; conditional ACEs keep their nested parentheses.
    expect(
      parseSddlDacl('D:(A;;FA;;;SY)(XA;;FR;;;WD;(@User.x == 1))S:(AU;SA;FA;;;WD)')?.map((a) => a.sid),
    ).toEqual(['S-1-5-18', 'S-1-1-0']);
    expect(parseSddlDacl('O:BAG:SY')).toBeNull();
    expect(parseSddlDacl('D:(A;;FA')).toBeNull();
  });

  it.each<[string, string, string[]]>([
    ['user-only folder (default under %LOCALAPPDATA%)', PRIVATE_SDDL, []],
    [
      'Authenticated Users: Modify (another drive)',
      `D:AI(A;OICIID;0x1301bf;;;AU)(A;OICIID;FA;;;${USER})`,
      ['Authenticated Users'],
    ],
    ['Users: read & execute', 'D:AI(A;OICIID;0x1200a9;;;BU)', ['Users']],
    ['Everyone generic read', 'D:(A;OICI;GR;;;WD)', ['Everyone']],
    [
      'another account',
      'D:(A;OICI;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1002)',
      ['S-1-5-21-1111111111-2222222222-3333333333-1002'],
    ],
    ['execute/traverse only is no read access', 'D:(A;;FX;;;WD)', []],
    [
      'deny entries and services do not count',
      'D:(D;OICI;FA;;;WD)(A;OICI;FA;;;S-1-5-80-1)(A;OICI;FA;;;LS)(A;OICIIO;FA;;;CO)',
      [],
    ],
    ['inherit-only entries count (they apply to the files inside)', 'D:(A;OICIIO;GR;;;BU)', ['Users']],
  ])('%s', (_name, sddl, readers) => {
    const aces = parseSddlDacl(sddl);
    expect(aces).not.toBeNull();
    expect(otherReaders(aces ?? [], USER)).toEqual(readers);
  });

  it('whoami csv → SID', () => {
    expect(parseWhoamiSid(`"pc-1\\jane","${USER}"\r\n`)).toBe(USER);
    expect(parseWhoamiSid('ERROR: access denied')).toBeNull();
  });
});

describe('checkHomeAccess / logHomeAccess', () => {
  const fakeRun =
    (answers: Partial<RunFileResult>[]): RunFileFn =>
    () =>
      Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...answers.shift(),
      });

  it('missing folder, failing tools and other platforms are never a warning', async () => {
    const home = await makeTempHome('r2-acl-');
    homes.push(home);
    expect(await checkHomeAccess(path.join(home, 'nope'), { platform: 'win32' })).toEqual({
      kind: 'missing',
    });
    expect(await checkHomeAccess(home, { platform: 'linux' })).toMatchObject({ kind: 'unknown' });
    expect(
      await checkHomeAccess(home, { platform: 'win32', run: fakeRun([{ exitCode: 1, stdout: '' }]) }),
    ).toMatchObject({ kind: 'unknown' });
    expect(
      await checkHomeAccess(home, {
        platform: 'win32',
        run: fakeRun([{ stdout: `"x\\u","${USER}"` }, { exitCode: 1, stdout: 'Get-Acl : denied' }]),
      }),
    ).toMatchObject({ kind: 'unknown' });
    expect(
      await checkHomeAccess(home, {
        platform: 'win32',
        run: () => Promise.reject(new Error('spawn EACCES')),
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'spawn EACCES' });
  });

  it('warns only for a shared folder', async () => {
    const home = await makeTempHome('r2-acl-');
    homes.push(home);
    const log = { warn: vi.fn(), debug: vi.fn() };
    const shared = await logHomeAccess(home, {
      platform: 'win32',
      log,
      run: fakeRun([{ stdout: `"x\\u","${USER}"` }, { stdout: 'D:(A;OICI;0x1301bf;;;AU)\r\n' }]),
    });
    expect(shared).toEqual({ kind: 'shared', principals: ['Authenticated Users'] });
    expect(log.warn).toHaveBeenCalledOnce();
    const own = await logHomeAccess(home, {
      platform: 'win32',
      log,
      run: fakeRun([{ stdout: `"x\\u","${USER}"` }, { stdout: PRIVATE_SDDL }]),
    });
    expect(own).toEqual({ kind: 'private' });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('V3-15 (b): an aborted check ends as unknown "aborted"; the signal reaches every tool call', async () => {
    const home = await makeTempHome('r2-acl-');
    homes.push(home);
    const before = new AbortController();
    before.abort();
    const calls: (AbortSignal | undefined)[] = [];
    const run: RunFileFn = (_file, _args, options) => {
      calls.push(options.signal);
      return Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: `"x\\u","${USER}"`,
        stderr: '',
        timedOut: false,
      });
    };
    expect(await checkHomeAccess(home, { platform: 'win32', run, signal: before.signal })).toEqual({
      kind: 'unknown',
      reason: 'aborted',
    });
    expect(calls).toEqual([]);
    // Aborted while whoami runs: Get-Acl is not started any more.
    const during = new AbortController();
    const aborting: RunFileFn = (file, args, options) => {
      during.abort();
      return run(file, args, options);
    };
    expect(await checkHomeAccess(home, { platform: 'win32', run: aborting, signal: during.signal })).toEqual({
      kind: 'unknown',
      reason: 'aborted',
    });
    expect(calls).toEqual([during.signal]);
  });

  windowsOnly(
    'real tools: a temp folder is readable as checked; granting Everyone read makes it shared',
    async () => {
      const base = await makeTempHome('r2-acl-');
      homes.push(base);
      const home = path.join(base, 'home');
      await mkdir(home);
      const before: HomeAccess = await checkHomeAccess(home, { timeoutMs: 60_000 });
      expect(['private', 'shared']).toContain(before.kind);
      // Test folder only (deleted afterwards): Everyone gets read access.
      const grant = await runFile(systemTool('icacls.exe'), [home, '/grant', '*S-1-1-0:(OI)(CI)R'], {
        timeoutMs: 60_000,
      });
      expect(grant.exitCode).toBe(0);
      const after = await checkHomeAccess(home, { timeoutMs: 60_000 });
      expect(after.kind).toBe('shared');
      expect(after.kind === 'shared' ? after.principals : []).toContain('Everyone');
    },
    TOOL_TEST_TIMEOUT_MS,
  );
});
