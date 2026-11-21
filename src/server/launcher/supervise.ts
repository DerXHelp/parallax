/**
 * WP-109 (code review of the service mode): the launcher of `--server` stays the main process of
 * the systemd unit for as long as a server of its data folder runs. The unit stops with
 * `KillMode=mixed` (systemdService.ts): SIGTERM goes to the launcher only, which passes it on – the
 * server ends its sessions itself, systemd kills the rest only afterwards.
 * - Signals (SIGINT/SIGTERM/SIGHUP) are taken from the start: one that arrives before the server
 *   exists is passed on as soon as it does.
 * - POSIX: a server of the home that runs already is adopted (its PID watched, stop signals passed
 *   on) instead of failing – else `Restart=on-failure` would start the launcher again and again.
 * - POSIX: a server that ends by itself with 0 while the start lock of the home is held was handed
 *   over to the update orchestrator (it holds that lock from before the handshake until the new
 *   version is ready, applyUpdate.ts): the launcher waits and adopts the new server – otherwise the
 *   unit would stop and systemd would kill the orchestrator in the middle of the switch.
 * Windows has no service manager here: the own server only, as before.
 */
import { serverOrigin } from '@shared/http';
import type { RunningServerCheck } from './client';
import type { ServerExit } from './serverProcess';

export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** How often an adopted server is looked at (one small `/proc` file). */
export const ADOPTED_POLL_MS = 1_000;
/** How often the start lock is tried while an update switches. */
export const SUCCESSOR_POLL_MS = 500;
/**
 * Longest wait for the new server: the orchestrator's way (old server's end, check, backup, start
 * within at most 600 s, the way back with another start) with room to spare.
 */
export const SUCCESSOR_WAIT_MS = 30 * 60_000;

/** A server the launcher watches: its own child or an adopted one. */
export interface WatchedServer {
  pid: number;
  /** An adopted server's exit is unknown: `{ code: null, signal: null }`. */
  exited: Promise<ServerExit>;
  signal(name: NodeJS.Signals): void;
}

/** Passes the launcher's signals on to the watched server; keeps one that arrives in between. */
export interface SignalRelay {
  /** The server that gets signals from now on (a kept signal is passed on at once); null = none. */
  attach(server: WatchedServer | null): void;
  /** A signal arrived (the stop is wanted, whatever ends next is a regular end). */
  readonly stopRequested: boolean;
  dispose(): void;
}

/** Registers `handler` for FORWARDED_SIGNALS; returns the function that removes it again. */
export type ListenSignals = (handler: (signal: NodeJS.Signals) => void) => () => void;

export const listenProcessSignals: ListenSignals = (handler) => {
  for (const signal of FORWARDED_SIGNALS) process.on(signal, handler);
  return () => {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, handler);
  };
};

export function createSignalRelay(listen: ListenSignals): SignalRelay {
  let target: WatchedServer | null = null;
  let kept: NodeJS.Signals | null = null;
  let stopRequested = false;
  const remove = listen((signal) => {
    stopRequested = true;
    if (target === null) kept = signal;
    else target.signal(signal);
  });
  return {
    attach(server) {
      target = server;
      if (server === null || kept === null) return;
      const signal = kept;
      kept = null;
      server.signal(signal);
    },
    get stopRequested() {
      return stopRequested;
    },
    dispose: remove,
  };
}

export interface SuperviseDeps {
  platform: NodeJS.Platform;
  home: string;
  findRunning(): Promise<RunningServerCheck>;
  /** One try of the start lock of the home (released at once): true = nobody holds it. */
  launchLockFree(): Promise<boolean>;
  /** Identity of a running process (Linux: its start ticks); null = it no longer runs. */
  identity(pid: number): number | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(line: string): void;
}

/**
 * Watches `pid` (a server this launcher did not start): it counts as ended once its identity
 * changes; signals reach it only while it is still the same process (PIDs are reused). Null if it
 * is gone already.
 */
export function adoptServer(pid: number, deps: SuperviseDeps): WatchedServer | null {
  const identity = deps.identity(pid);
  if (identity === null) return null;
  const same = (): boolean => deps.identity(pid) === identity;
  const exited = (async (): Promise<ServerExit> => {
    while (same()) await deps.sleep(ADOPTED_POLL_MS);
    return { code: null, signal: null };
  })();
  return {
    pid,
    exited,
    signal: (name) => {
      if (!same()) return;
      try {
        deps.kill(pid, name);
      } catch {
        // ended just now
      }
    },
  };
}

/** POSIX: adopts the running server of the home (null on Windows or when it is gone already). */
export function adoptRunning(port: number, pid: number, deps: SuperviseDeps): WatchedServer | null {
  if (deps.platform === 'win32') return null;
  const server = adoptServer(pid, deps);
  if (server === null) return null;
  deps.out(
    `Parallax already runs on ${serverOrigin(port)} (PID ${String(pid)}, data: ${deps.home}) - this process ` +
      'watches it now and passes a stop on (its output is in the logs folder of the data).',
  );
  return server;
}

type Successor =
  { kind: 'none' } | { kind: 'adopted'; server: WatchedServer } | { kind: 'failed'; reason: string };

/** After a server ended by itself with 0: was it an update hand-over, and who runs now? */
async function awaitSuccessor(previous: number, deps: SuperviseDeps): Promise<Successor> {
  const deadline = deps.now() + SUCCESSOR_WAIT_MS;
  let waited = false;
  while (!(await deps.launchLockFree())) {
    if (!waited) deps.out('The server handed over to an update - waiting for the new version...');
    waited = true;
    if (deps.now() >= deadline) return { kind: 'failed', reason: 'the update did not finish in time' };
    await deps.sleep(SUCCESSOR_POLL_MS);
  }
  // Nobody held the start lock: "Shut down" in the app – a regular end.
  if (!waited) return { kind: 'none' };
  const running = await deps.findRunning();
  if (running.kind !== 'running' || running.lock.pid === previous) {
    return { kind: 'failed', reason: 'no Parallax server runs after the update' };
  }
  const server = adoptServer(running.lock.pid, deps);
  if (server === null) return { kind: 'failed', reason: 'the new server ended at once' };
  deps.out(
    `Parallax ${running.health.serverVersion} runs on ${serverOrigin(running.lock.port)} (PID ` +
      `${String(running.lock.pid)}) - this process watches it now (its output is in the logs folder of the data).`,
  );
  return { kind: 'adopted', server };
}

/** Watches `first` (and whoever follows an update) until the end; resolves with the exit code. */
export async function superviseServer(
  first: WatchedServer,
  relay: SignalRelay,
  deps: SuperviseDeps,
): Promise<number> {
  let current = first;
  for (;;) {
    relay.attach(current);
    const exit = await current.exited;
    relay.attach(null);
    const known = exit.code !== null || exit.signal !== null;
    // Ended by a signal we passed on: a regular stop.
    if (relay.stopRequested) return exit.code ?? 0;
    if (known && exit.code !== 0) return exit.code ?? 1;
    if (deps.platform === 'win32') return 0;
    const next = await awaitSuccessor(current.pid, deps);
    if (next.kind === 'failed') {
      deps.out(`Parallax server mode ends: ${next.reason}.`);
      return 1;
    }
    if (next.kind === 'none') {
      if (known) return 0;
      // An adopted server: a regular end removes its lock file, a crash leaves it behind.
      const after = await deps.findRunning();
      return after.kind === 'none' && after.reason === 'no_lock' ? 0 : 1;
    }
    current = next.server;
  }
}
