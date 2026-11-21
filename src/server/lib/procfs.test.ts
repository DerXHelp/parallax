import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createProcfsReader,
  isEndedState,
  parseBootTime,
  parseEnviron,
  parseProcStat,
  processImageName,
} from './procfs';
import { killProcessTree, spawnHidden, systemTool } from './process';
import { procfsProcessApi } from './processNative';

/** A `/proc/<pid>/stat` line: fields 3…22 with the given values, the rest zero. */
function statLine(
  pid: number,
  comm: string,
  state: string,
  ppid: number,
  pgid: number,
  sid: number,
  ticks: number,
) {
  const rest = Array.from({ length: 30 }, () => '0');
  // fields[n - 3]: 4 ppid, 5 pgrp, 6 session, 22 starttime
  rest[0] = state;
  rest[1] = String(ppid);
  rest[2] = String(pgid);
  rest[3] = String(sid);
  rest[19] = String(ticks);
  return `${String(pid)} (${comm}) ${rest.join(' ')}\n`;
}

describe('procfs parsing (WP-103)', () => {
  it('reads pid, comm, state, parent, group, session and start ticks', () => {
    expect(parseProcStat(statLine(4242, 'claude', 'S', 1000, 4242, 900, 123456))).toEqual({
      pid: 4242,
      comm: 'claude',
      state: 'S',
      ppid: 1000,
      pgid: 4242,
      sid: 900,
      startTicks: 123456,
    });
  });

  it('comm ends at the LAST parenthesis (spaces and parentheses inside the name)', () => {
    expect(parseProcStat(statLine(7, 'a) (b c)', 'R', 1, 7, 7, 5))).toMatchObject({
      comm: 'a) (b c)',
      ppid: 1,
    });
    expect(parseProcStat(statLine(8, '', 'Z', 2, 8, 8, 6))).toMatchObject({ comm: '', state: 'Z' });
  });

  const good = statLine(12, 'x', 'S', 1, 1, 1, 5);

  it('parses the line the malformed cases are made of', () => {
    expect(parseProcStat(good)).toMatchObject({ pid: 12, startTicks: 5 });
  });

  it.each([
    '',
    'garbage',
    '12 claude S 1 2 3',
    '(x) S 1 1 1',
    '12 (x) S 1 1',
    good.replace(/^12/, '0'),
    good.replace(') S ', ') SS '),
    good.replace(') S 1 ', ') S -1 '),
    good.replace(' 5 ', ' 1e3 '),
  ])('rejects malformed %j', (text) => {
    expect(parseProcStat(text)).toBeNull();
  });

  it('btime from /proc/stat', () => {
    expect(parseBootTime('cpu  1 2 3\nintr 5\nbtime 1763700000\nprocesses 9\n')).toBe(1763700000);
    expect(parseBootTime('cpu 1\nbtime\n')).toBeNull();
    expect(parseBootTime('')).toBeNull();
  });

  it('environ: NUL-separated, first = separates, entries without = are skipped', () => {
    expect(parseEnviron('A=1\0PARALLAX_ENTRY_ID=en_x\0B=x=y\0broken\0=nokey\0')).toEqual({
      A: '1',
      PARALLAX_ENTRY_ID: 'en_x',
      B: 'x=y',
    });
    expect(parseEnviron('')).toEqual({});
  });

  it('zombies and dead processes have ended', () => {
    expect(['Z', 'X', 'x'].map(isEndedState)).toEqual([true, true, true]);
    expect(['R', 'S', 'D', 'T', 'I'].map(isEndedState)).toEqual([false, false, false, false, false]);
  });

  it('processImageName: base name cut to 15 bytes (TASK_COMM_LEN)', () => {
    expect(processImageName('/home/u/.local/bin/claude')).toBe('claude');
    expect(processImageName('/opt/a-very-long-program-name')).toBe('a-very-long-pro');
    // Never a cut multi-byte character: 7 × "ä" (14 bytes) + "ö" would be 16 bytes.
    expect(processImageName('/x/äääääääö')).toBe('äääääää');
  });
});

describe('createProcfsReader over a folder laid out like /proc', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'px-procfs-'));
  const put = (relative: string, text: string): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put('stat', 'cpu 1 2\nbtime 1763700000\n');
  put('100/stat', statLine(100, 'claude', 'S', 1, 100, 100, 250));
  put('100/cmdline', '/home/u/.local/bin/claude\0--print\0\0');
  put('100/environ', 'PARALLAX=1\0PARALLAX_ENTRY_ID=en_a\0');
  put('101/stat', statLine(101, 'node', 'Z', 100, 100, 100, 300));
  put('101/cmdline', '');
  put('102/stat', 'not a stat line');
  // A stat file whose pid differs from its folder (never trusted).
  put('103/stat', statLine(999, 'liar', 'S', 1, 999, 999, 1));
  put('self/stat', statLine(100, 'claude', 'S', 1, 100, 100, 250));
  put('sys/kernel', 'x');
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const reader = createProcfsReader({ root });

  it('lists numeric folders with a valid stat whose pid matches', () => {
    expect(
      reader
        .table()
        ?.map((row) => row.pid)
        .sort((a, b) => a - b),
    ).toEqual([100, 101]);
    expect(reader.stat(100)).toMatchObject({ comm: 'claude', pgid: 100 });
    expect(reader.stat(102)).toBeNull();
    expect(reader.stat(103)).toBeNull();
    expect(reader.stat(104)).toBeNull();
    expect(reader.stat(0)).toBeNull();
    expect(reader.stat(-1)).toBeNull();
  });

  it('start time = btime + ticks / USER_HZ, the same in every reader', () => {
    const row = reader.stat(100);
    if (row === null) throw new Error('no row');
    expect(reader.startedAt(row)?.toISOString()).toBe(new Date((1763700000 + 2.5) * 1000).toISOString());
    expect(createProcfsReader({ root }).startedAt(row)?.getTime()).toBe(reader.startedAt(row)?.getTime());
    expect(createProcfsReader({ root, clockTicks: 1000 }).startedAt(row)?.getTime()).toBe(
      (1763700000 + 0.25) * 1000,
    );
  });

  it('command line and environment', () => {
    expect(reader.commandLine(100)).toEqual(['/home/u/.local/bin/claude', '--print', '']);
    expect(reader.commandLine(101)).toBeNull();
    expect(reader.commandLine(104)).toBeNull();
    expect(reader.environment(100)).toEqual({ PARALLAX: '1', PARALLAX_ENTRY_ID: 'en_a' });
    expect(reader.environment(104)).toBeNull();
  });

  it('never throws: a missing /proc gives null', () => {
    const none = createProcfsReader({ root: path.join(root, 'missing') });
    expect(none.table()).toBeNull();
    expect(none.stat(1)).toBeNull();
    expect(
      none.startedAt({ pid: 1, comm: 'x', state: 'S', ppid: 0, pgid: 1, sid: 1, startTicks: 0 }),
    ).toBeNull();
  });

  it('the process API leaves zombies out (they have ended) and carries the start time', () => {
    const api = procfsProcessApi(createProcfsReader({ root }));
    expect(api.entries()).toEqual([
      { pid: 100, parentPid: 1, name: 'claude', startedAt: new Date((1763700000 + 2.5) * 1000) },
    ]);
    expect(api.startedAt(100)?.getTime()).toBe((1763700000 + 2.5) * 1000);
    expect(api.startedAt(101)).toBeNull();
    expect(procfsProcessApi(createProcfsReader({ root: path.join(root, 'missing') })).entries()).toBeNull();
  });
});

describe.runIf(process.platform === 'linux')('procfs on Linux (WP-103)', () => {
  const reader = createProcfsReader();

  it('this process: parent and comm; it is listed', () => {
    const me = reader.stat(process.pid);
    expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(me?.comm).toBe(readFileSync('/proc/self/comm', 'utf8').trim());
    expect(reader.table()?.some((row) => row.pid === process.pid)).toBe(true);
  });

  it('a started child: its own group (detached), command line and start environment', async () => {
    // `sleep`, not node: node renames its main thread (comm `node-MainThread`) once it runs.
    const sleep = systemTool('sleep');
    const child = spawnHidden(sleep, ['30'], {
      stdio: 'ignore',
      env: { ...process.env, PX_PROCFS_MARK: 'en_procfs' },
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('no pid');
    try {
      const row = reader.stat(pid);
      expect(row).toMatchObject({ pid, ppid: process.pid, pgid: pid, sid: pid });
      expect(row?.comm).toBe(processImageName(sleep));
      expect(reader.commandLine(pid)).toEqual([sleep, '30']);
      expect(reader.environment(pid)?.PX_PROCFS_MARK).toBe('en_procfs');
    } finally {
      await killProcessTree(pid);
    }
  }, 30_000);

  it('start time: deterministic and within seconds of the real start', () => {
    const me = reader.stat(process.pid);
    if (me === null) throw new Error('no stat');
    const started = reader.startedAt(me)?.getTime() ?? 0;
    expect(createProcfsReader().startedAt(me)?.getTime()).toBe(started);
    expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
  });
});
