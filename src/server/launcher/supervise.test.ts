import { describe, expect, it } from 'vitest';
import { sampleHealthResponse, sampleServerLockFile } from '@shared/samples';
import type { RunningServerCheck } from './client';
import type { ServerExit } from './serverProcess';
import {
  ADOPTED_POLL_MS,
  SUCCESSOR_WAIT_MS,
  adoptRunning,
  adoptServer,
  createSignalRelay,
  superviseServer,
  type SuperviseDeps,
  type WatchedServer,
} from './supervise';

interface World {
  deps: SuperviseDeps;
  out: string[];
  kills: [number, NodeJS.Signals][];
  /** Running processes: pid → identity. */
  alive: Map<number, number>;
  /** Answers of `launchLockFree`, in order (then always true). */
  lockAnswers: boolean[];
  lockTries: number;
  running: RunningServerCheck;
  /** Sends a signal to the launcher. */
  signal(name: NodeJS.Signals): void;
  relay: ReturnType<typeof createSignalRelay>;
}

function world(p: { platform?: NodeJS.Platform; lockAnswers?: boolean[] } = {}): World {
  let now = 0;
  let handler: ((signal: NodeJS.Signals) => void) | null = null;
  const w: Omit<World, 'deps' | 'relay' | 'signal'> = {
    out: [],
    kills: [],
    alive: new Map(),
    lockAnswers: [...(p.lockAnswers ?? [])],
    lockTries: 0,
    running: { kind: 'none', reason: 'no_lock', staleLock: null },
  };
  const deps: SuperviseDeps = {
    platform: p.platform ?? 'linux',
    home: '/home/demo/.local/share/parallax',
    findRunning: () => Promise.resolve(w.running),
    launchLockFree: () => {
      w.lockTries += 1;
      return Promise.resolve(w.lockAnswers.shift() ?? true);
    },
    identity: (pid) => w.alive.get(pid) ?? null,
    kill: (pid, signal) => {
      w.kills.push([pid, signal]);
      // The adopted server ends on the signal.
      w.alive.delete(pid);
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        now += ms;
        setImmediate(resolve);
      }),
    now: () => now,
    out: (line) => w.out.push(line),
  };
  const relay = createSignalRelay((h) => {
    handler = h;
    return () => {
      handler = null;
    };
  });
  return Object.assign(w, {
    deps,
    relay,
    signal: (name: NodeJS.Signals) => {
      handler?.(name);
    },
  });
}

/** An own child: ends when told (`end`), records the signals it got. */
function child(pid = 4100): WatchedServer & { got: NodeJS.Signals[]; end(exit: ServerExit): void } {
  let end: (exit: ServerExit) => void = () => undefined;
  const exited = new Promise<ServerExit>((resolve) => {
    end = resolve;
  });
  const got: NodeJS.Signals[] = [];
  return {
    pid,
    exited,
    got,
    signal: (name) => got.push(name),
    end: (exit) => {
      end(exit);
    },
  };
}

function runningCheck(pid: number, port = 4712): RunningServerCheck {
  return {
    kind: 'running',
    lock: sampleServerLockFile({ pid, port }),
    health: sampleHealthResponse({ serverVersion: '1.4.0' }),
  };
}

describe('server mode supervision (review WP-109)', () => {
  it('a signal before the server exists is kept and passed on once it does', () => {
    const w = world();
    w.signal('SIGTERM');
    expect(w.relay.stopRequested).toBe(true);
    const server = child();
    w.relay.attach(server);
    expect(server.got).toEqual(['SIGTERM']);
    // Passed on once only.
    w.relay.attach(server);
    expect(server.got).toEqual(['SIGTERM']);
    w.signal('SIGINT');
    expect(server.got).toEqual(['SIGTERM', 'SIGINT']);
    w.relay.dispose();
    w.signal('SIGHUP');
    expect(server.got).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('a stop passed on ends with 0; a crash with its code; Windows ends with the own server', async () => {
    const stopped = world();
    const own = child();
    const done = superviseServer(own, stopped.relay, stopped.deps);
    stopped.signal('SIGTERM');
    expect(own.got).toEqual(['SIGTERM']);
    own.end({ code: null, signal: 'SIGTERM' });
    expect(await done).toBe(0);

    const crashed = world();
    const second = child();
    second.end({ code: 1, signal: null });
    expect(await superviseServer(second, crashed.relay, crashed.deps)).toBe(1);
    const killed = world();
    const third = child();
    third.end({ code: null, signal: 'SIGKILL' });
    expect(await superviseServer(third, killed.relay, killed.deps)).toBe(1);

    const win = world({ platform: 'win32', lockAnswers: [false] });
    const fourth = child();
    fourth.end({ code: 0, signal: null });
    expect(await superviseServer(fourth, win.relay, win.deps)).toBe(0);
    expect(win.lockTries).toBe(0);
  });

  it('"Shut down" in the app (exit 0, start lock free) ends with 0 and waits for nothing', async () => {
    const w = world();
    const own = child();
    own.end({ code: 0, signal: null });
    expect(await superviseServer(own, w.relay, w.deps)).toBe(0);
    expect(w.lockTries).toBe(1);
    expect(w.out).toEqual([]);
  });

  it('an update hand-over: waits while the orchestrator holds the start lock, then adopts the new server', async () => {
    const w = world({ lockAnswers: [false, false, false] });
    const own = child(4100);
    w.alive.set(5200, 77);
    w.running = runningCheck(5200);
    own.end({ code: 0, signal: null });
    const done = superviseServer(own, w.relay, w.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.out[0]).toMatch(/handed over to an update - waiting/);
    expect(w.out[1]).toMatch(/Parallax 1\.4\.0 runs on http:\/\/127\.0\.0\.1:4712 \(PID 5200\)/);
    // systemctl stop: the adopted server gets the signal, its end is a regular stop.
    w.signal('SIGTERM');
    expect(w.kills).toEqual([[5200, 'SIGTERM']]);
    expect(await done).toBe(0);
  });

  it('a stop while the update switches reaches the new server once it runs', async () => {
    const w = world({ lockAnswers: Array.from({ length: 10 }, () => false) });
    const own = child(4100);
    w.alive.set(5200, 77);
    w.running = runningCheck(5200);
    own.end({ code: 0, signal: null });
    const done = superviseServer(own, w.relay, w.deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.out[0]).toMatch(/waiting for the new version/);
    // Nobody to pass it on to yet: kept for the successor.
    w.signal('SIGTERM');
    expect(w.kills).toEqual([]);
    expect(await done).toBe(0);
    expect(w.kills).toEqual([[5200, 'SIGTERM']]);
  });

  it('after the switch no server runs, or the orchestrator hangs: exit 1 (systemd starts again)', async () => {
    const none = world({ lockAnswers: [false] });
    const own = child(4100);
    own.end({ code: 0, signal: null });
    expect(await superviseServer(own, none.relay, none.deps)).toBe(1);
    expect(none.out.at(-1)).toMatch(/no Parallax server runs after the update/);

    const same = world({ lockAnswers: [false] });
    same.running = runningCheck(4100);
    const second = child(4100);
    second.end({ code: 0, signal: null });
    expect(await superviseServer(second, same.relay, same.deps)).toBe(1);

    const hang = world({ lockAnswers: Array.from({ length: 4000 }, () => false) });
    const third = child(4100);
    third.end({ code: 0, signal: null });
    expect(await superviseServer(third, hang.relay, hang.deps)).toBe(1);
    expect(hang.out.at(-1)).toMatch(/did not finish in time/);
    expect(hang.lockTries).toBeLessThan(4000);
    expect(hang.lockTries).toBeGreaterThan(SUCCESSOR_WAIT_MS / 1000);
  });

  it('adopting a running server: POSIX only, never a PID that is gone or reused', async () => {
    const win = world({ platform: 'win32' });
    win.alive.set(5200, 77);
    expect(adoptRunning(4712, 5200, win.deps)).toBeNull();
    const gone = world();
    expect(adoptRunning(4712, 5200, gone.deps)).toBeNull();

    const w = world();
    w.alive.set(5200, 77);
    const adopted = adoptRunning(4712, 5200, w.deps);
    expect(adopted).not.toBeNull();
    expect(w.out[0]).toMatch(
      /already runs on http:\/\/127\.0\.0\.1:4712 \(PID 5200, data: .*\) - this process watches it/,
    );
    // The PID now belongs to another process: no signal.
    w.alive.set(5200, 78);
    adopted?.signal('SIGTERM');
    expect(w.kills).toEqual([]);
    expect(await adopted?.exited).toEqual({ code: null, signal: null });
  });

  it('an adopted server that ends by itself: 0 when it removed its lock file, 1 when it crashed', async () => {
    const regular = world();
    regular.alive.set(5200, 77);
    const first = adoptServer(5200, regular.deps);
    if (first === null) throw new Error('not adopted');
    const done = superviseServer(first, regular.relay, regular.deps);
    await regular.deps.sleep(ADOPTED_POLL_MS);
    regular.alive.delete(5200);
    expect(await done).toBe(0);

    const crashed = world();
    crashed.alive.set(5200, 77);
    crashed.running = { kind: 'none', reason: 'unreachable', staleLock: sampleServerLockFile({ pid: 5200 }) };
    const second = adoptServer(5200, crashed.deps);
    if (second === null) throw new Error('not adopted');
    crashed.alive.delete(5200);
    expect(await superviseServer(second, crashed.relay, crashed.deps)).toBe(1);
  });
});
