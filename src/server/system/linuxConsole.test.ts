import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { POSIX_PATHS } from '@shared/paths';
import { SAMPLE_IDS } from '@shared/samples';
import type { ConsoleLaunchSpec } from '../claude/ports';
import type { ProcStat, ProcfsReader } from '../lib/procfs';
import { createMemoryFs } from '../lib/windows';
import { consolePreflight } from './console';
import {
  LINUX_CONSOLE_START_SLACK_MS,
  NO_TERMINAL_EMULATOR,
  createLinuxConsoleLauncher,
  findConsoleProcess,
} from './linuxConsole';
import type { SpawnedProcess, SystemSpawnFn } from './run';

const CLAUDE = '/home/demo/.local/bin/claude';
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const ENTRY = SAMPLE_IDS.entry;

const SPEC: ConsoleLaunchSpec = {
  executablePath: CLAUDE,
  args: ['--resume', SAMPLE_IDS.sessionId],
  env: { PATH: '/usr/bin', PARALLAX: '1', PARALLAX_ENTRY_ID: ENTRY },
  explicitEnv: {},
  cwd: '/home/demo/work',
};

interface FakeProcess {
  pid: number;
  /** Start in ms after T0. */
  start: number;
  argv: string[];
  env: Record<string, string> | null;
  state?: string;
}

/** A `/proc` of the given processes (start times relative to T0, millisecond exact). */
function procfs(processes: FakeProcess[]): ProcfsReader & { list: FakeProcess[] } {
  const row = (p: FakeProcess): ProcStat => ({
    pid: p.pid,
    comm: (p.argv[0] ?? '').split('/').pop() ?? '',
    state: p.state ?? 'S',
    ppid: 1,
    pgid: p.pid,
    sid: p.pid,
    startTicks: p.start,
  });
  return {
    list: processes,
    table: () => processes.map(row),
    stat: (pid) => {
      const found = processes.find((p) => p.pid === pid);
      return found === undefined ? null : row(found);
    },
    startedAt: (stat) => new Date(T0 + stat.startTicks),
    commandLine: (pid) => processes.find((p) => p.pid === pid)?.argv ?? null,
    environment: (pid) => processes.find((p) => p.pid === pid)?.env ?? null,
  };
}

/** A started emulator: emits `spawn` at once; `exit(code)` later on demand. */
function fakeSpawn(options: { pid?: number; error?: Error; exitAtOnce?: number } = {}) {
  const calls: { file: string; args: readonly string[]; cwd: unknown; env: unknown; detached: unknown }[] =
    [];
  const children: (EventEmitter & SpawnedProcess)[] = [];
  const spawn: SystemSpawnFn = (file, args, spawnOptions) => {
    calls.push({ file, args, cwd: spawnOptions.cwd, env: spawnOptions.env, detached: spawnOptions.detached });
    const child = Object.assign(new EventEmitter(), { pid: options.pid ?? 4100, unref: () => undefined });
    children.push(child);
    queueMicrotask(() => {
      if (options.error !== undefined) {
        child.emit('error', options.error);
        return;
      }
      child.emit('spawn');
      if (options.exitAtOnce !== undefined) child.emit('exit', options.exitAtOnce, null);
    });
    return child;
  };
  return { spawn, calls, children };
}

/** Virtual time: every `sleep` advances the clock. */
function virtualClock(start = T0) {
  let now = start;
  return {
    clock: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

const terminalFs = (files: readonly string[] = ['/usr/bin/gnome-terminal']) =>
  createMemoryFs(Object.fromEntries(files.map((file) => [file, ''])), { rules: POSIX_PATHS });

describe('findConsoleProcess (WP-106: PID over /proc)', () => {
  it('the oldest process of the entry started from the program after the click', () => {
    const since = new Date(T0);
    const reader = procfs([
      // Started before the click (an older console of the same entry).
      { pid: 10, start: -60_000, argv: [CLAUDE], env: { PARALLAX_ENTRY_ID: ENTRY } },
      // Another entry, another program, no environment readable.
      { pid: 11, start: 500, argv: [CLAUDE], env: { PARALLAX_ENTRY_ID: 'en_other' } },
      { pid: 12, start: 600, argv: ['/usr/bin/bash'], env: { PARALLAX_ENTRY_ID: ENTRY } },
      { pid: 13, start: 700, argv: [CLAUDE], env: null },
      // A zombie does not count.
      { pid: 14, start: 800, argv: [CLAUDE], env: { PARALLAX_ENTRY_ID: ENTRY }, state: 'Z' },
      // The console and a child of it (same environment, later).
      { pid: 21, start: 900, argv: ['claude', '--resume', 'x'], env: { PARALLAX_ENTRY_ID: ENTRY } },
      { pid: 22, start: 1_900, argv: [CLAUDE], env: { PARALLAX_ENTRY_ID: ENTRY } },
    ]);
    expect(findConsoleProcess(reader, { entryId: ENTRY, executable: CLAUDE, since })).toEqual({
      pid: 21,
      startedAt: new Date(T0 + 900),
    });
    expect(findConsoleProcess(procfs([]), { entryId: ENTRY, executable: CLAUDE, since })).toBeNull();
    const broken: ProcfsReader = { ...reader, table: () => null };
    expect(findConsoleProcess(broken, { entryId: ENTRY, executable: CLAUDE, since })).toBeNull();
  });
});

describe('createLinuxConsoleLauncher (WP-106, WP-100 §5.5)', () => {
  it('starts the emulator without a shell in the folder with the spec env; finds the console over /proc', async () => {
    const time = virtualClock();
    const reader = procfs([]);
    const { spawn, calls } = fakeSpawn({ pid: 4100 });
    const launcher = createLinuxConsoleLauncher({
      env: { PATH: '/usr/bin' },
      fs: terminalFs(),
      spawn,
      procfs: reader,
      ...time,
      sleep: async (ms) => {
        await time.sleep(ms);
        // The console appears after the emulator handed it to its server (1 s later).
        if (time.clock() - T0 >= 1_000 && reader.list.length === 0) {
          reader.list.push({ pid: 4242, start: 1_000, argv: [CLAUDE, ...SPEC.args], env: SPEC.env });
        }
      },
    });
    expect(await launcher.open(SPEC)).toEqual({
      kind: 'opened',
      process: { pid: 4242, startedAt: new Date(T0 + 1_000) },
    });
    expect(calls).toEqual([
      {
        file: '/usr/bin/gnome-terminal',
        args: [
          '--window',
          '--working-directory=/home/demo/work',
          '--',
          CLAUDE,
          '--resume',
          SAMPLE_IDS.sessionId,
        ],
        cwd: '/home/demo/work',
        env: SPEC.env,
        detached: true,
      },
    ]);
  });

  it('a process started a little before the click still counts (btime has seconds only)', async () => {
    const reader = procfs([
      { pid: 50, start: -LINUX_CONSOLE_START_SLACK_MS + 100, argv: [CLAUDE], env: SPEC.env },
    ]);
    const launcher = createLinuxConsoleLauncher({
      env: { PATH: '/usr/bin' },
      fs: terminalFs(),
      spawn: fakeSpawn().spawn,
      procfs: reader,
      ...virtualClock(),
    });
    expect(await launcher.open(SPEC)).toMatchObject({ kind: 'opened', process: { pid: 50 } });
  });

  it('the configured emulator; a missing one or none at all fails before anything starts', async () => {
    const { spawn, calls } = fakeSpawn();
    const configured = { value: '/opt/kitty/bin/kitty' as string | null };
    const launcher = createLinuxConsoleLauncher({
      terminalEmulator: () => configured.value,
      env: { PATH: '/usr/bin' },
      fs: terminalFs(['/opt/kitty/bin/kitty']),
      spawn,
      procfs: procfs([{ pid: 60, start: 10, argv: [CLAUDE], env: SPEC.env }]),
      ...virtualClock(),
    });
    expect(await launcher.open(SPEC)).toMatchObject({ kind: 'opened', process: { pid: 60 } });
    expect(calls[0]?.file).toBe('/opt/kitty/bin/kitty');
    expect(calls[0]?.args).toEqual([
      '--directory',
      '/home/demo/work',
      CLAUDE,
      '--resume',
      SAMPLE_IDS.sessionId,
    ]);
    configured.value = '/opt/missing/term';
    expect(await launcher.open(SPEC)).toEqual({ kind: 'failed', reason: NO_TERMINAL_EMULATOR });
    // The preflight says the same – before the engine closes the SDK query.
    expect(await consolePreflight(launcher)?.(SPEC)).toBe(NO_TERMINAL_EMULATOR);
    configured.value = null;
    expect(await consolePreflight(launcher)?.(SPEC)).toBe(NO_TERMINAL_EMULATOR);
    expect(calls).toHaveLength(1);
    configured.value = '/opt/kitty/bin/kitty';
    expect(await consolePreflight(launcher)?.(SPEC)).toBeNull();
  });

  it('refuses unsafe program and folder paths without starting anything', async () => {
    const { spawn, calls } = fakeSpawn();
    const launcher = createLinuxConsoleLauncher({
      env: { PATH: '/usr/bin' },
      fs: terminalFs(),
      spawn,
      procfs: procfs([]),
    });
    expect(await launcher.open({ ...SPEC, executablePath: 'claude' })).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/^program rejected/) as unknown,
    });
    expect(await launcher.open({ ...SPEC, cwd: 'work' })).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/^working directory rejected/) as unknown,
    });
    expect(calls).toEqual([]);
  });

  it('emulator errors: not startable, non-zero exit, nothing found → failed; a hosting emulator counts', async () => {
    const base = { env: { PATH: '/usr/bin' }, fs: terminalFs(['/usr/bin/xterm']) };
    const notStartable = createLinuxConsoleLauncher({
      ...base,
      spawn: fakeSpawn({ error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) }).spawn,
      procfs: procfs([]),
      ...virtualClock(),
    });
    expect(await notStartable.open(SPEC)).toEqual({
      kind: 'failed',
      reason: 'terminal emulator could not be started: spawn EACCES',
    });
    const exited = createLinuxConsoleLauncher({
      ...base,
      spawn: fakeSpawn({ exitAtOnce: 1 }).spawn,
      procfs: procfs([]),
      ...virtualClock(),
    });
    expect(await exited.open(SPEC)).toEqual({ kind: 'failed', reason: 'terminal emulator exit 1' });
    // Exit 0 at once (a dispatcher) and no console within the search time.
    const gone = createLinuxConsoleLauncher({
      ...base,
      spawn: fakeSpawn({ exitAtOnce: 0 }).spawn,
      procfs: procfs([]),
      findTimeoutMs: 2_000,
      ...virtualClock(),
    });
    expect(await gone.open(SPEC)).toEqual({ kind: 'failed', reason: 'console process not found' });
    // xterm runs the command as its child and is still open: its PID is watched.
    const hosting = createLinuxConsoleLauncher({
      ...base,
      spawn: fakeSpawn({ pid: 4300 }).spawn,
      procfs: procfs([{ pid: 4300, start: 5, argv: ['/usr/bin/xterm'], env: null }]),
      findTimeoutMs: 2_000,
      ...virtualClock(),
    });
    expect(await hosting.open(SPEC)).toEqual({
      kind: 'opened',
      process: { pid: 4300, startedAt: new Date(T0 + 5) },
    });
  });

  it('a spec without PARALLAX_ENTRY_ID (the shell window) is opened at once with an unknown process', async () => {
    const { spawn, calls } = fakeSpawn();
    const launcher = createLinuxConsoleLauncher({
      env: { PATH: '/usr/bin' },
      fs: terminalFs(),
      spawn,
      procfs: procfs([]),
    });
    const shell = { ...SPEC, executablePath: '/usr/bin/bash', args: [], env: { PATH: '/usr/bin' } };
    expect(await launcher.open(shell)).toEqual({ kind: 'opened', process: { pid: null, startedAt: null } });
    expect(calls[0]?.args).toEqual([
      '--window',
      '--working-directory=/home/demo/work',
      '--',
      '/usr/bin/bash',
    ]);
  });

  it('state: alive and the same start time (± 5 s) → running; gone or PID reused → ended', async () => {
    const started = new Date(T0);
    const launcher = createLinuxConsoleLauncher({
      isAlive: (pid) => pid !== 2,
      startTime: (pid) => Promise.resolve(pid === 3 ? new Date(T0 + 60_000) : started),
    });
    expect(await launcher.state({ pid: 1, startedAt: started })).toBe('running');
    expect(await launcher.state({ pid: 2, startedAt: started })).toBe('ended');
    expect(await launcher.state({ pid: 3, startedAt: started })).toBe('ended');
    expect(await launcher.state({ pid: null, startedAt: null })).toBe('unknown');
  });
});
