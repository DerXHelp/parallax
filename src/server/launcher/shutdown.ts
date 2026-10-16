/**
 * "Server beenden" – the server-side frame (Plan "Server-Betrieb", A.10, C.8, R0-19; WP-02 §7.5):
 *
 * The window lists the working/waiting sessions from the summaries and asks; on confirmation it
 * sends `server.shutdown`. The engine (WP-13b, `SessionSource.handleCommand`) answers first
 * (`sessionsStopped`, counted before closing) and then calls `onShutdownRequested`, which WP-20 wires
 * to `shutdown.stop('command')`. SIGINT/SIGTERM/SIGBREAK/SIGHUP take the same path.
 *
 * `stop()`: `stopSessions()` (engine: `close()` of every query, flush stores, `backend.dispose()`)
 * – if it is still running after `graceMs` (5 s, C.8), the remaining child process trees of the
 * server are ended with `taskkill /T /F` – then the close steps in order (compose.ts: `http` → WS
 * close 4503, `stores`, `homeAccess`, `lock`, `homeLock`), each bounded by a timeout, then
 * `exit(code)` (the log file is closed by the exit wrapper of compose.ts).
 * The engine logic itself belongs to WP-13b; this module only orders and bounds the steps.
 * Reason `error` (exit code 1): the global crash handler of main.ts (app/crash.ts, R3-06).
 */
import type { Logger } from 'pino';
import { settleWithin } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { childProcesses, killProcessTree, type ProcessQueryResult } from '../lib/process';

export type ShutdownReason = 'command' | 'signal' | 'error';

export interface ShutdownStep {
  /** For the log, e.g. `http`, `stores`, `backend`, `lock`, `logging`. */
  name: string;
  /** May return a promise (awaited, bounded by the timeout). */
  run: () => unknown;
  /** Default `stepTimeoutMs`. */
  timeoutMs?: number;
}

export interface ServerShutdownOptions {
  /** Engine hook (WP-13b `manager.shutdown()`): close all queries, flush registry/transcripts/processes. */
  stopSessions?: () => Promise<void>;
  /** Called once if `stopSessions` is still running after `graceMs` (default killChildProcessTrees). */
  forceKill?: () => Promise<unknown>;
  /** Close steps after the sessions, in order. */
  steps?: readonly ShutdownStep[];
  /** C.8: wait this long for `close()` before `taskkill /T /F` (default 5 s). */
  graceMs?: number;
  /** Upper bound for `stopSessions` in total (default 20 s; the engine bounds its close() at 15 s). */
  sessionsTimeoutMs?: number;
  /** Default timeout per close step (default 5 s). */
  stepTimeoutMs?: number;
  /** Upper bound for `forceKill` (default 15 s: one CIM query of 1-3 s plus a taskkill per tree). */
  forceKillTimeoutMs?: number;
  /** Default `process.exit`. */
  exit?: (code: number) => void;
  logger?: Logger;
}

/** Something that emits process signals (`process`). */
export interface SignalTarget {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface ServerShutdown {
  /** True once `stop()` was called (new work should be refused, e.g. `SERVER_SHUTTING_DOWN`). */
  readonly stopping: boolean;
  /** Runs the shutdown once; later calls return the same promise. Resolves after `exit(code)`. */
  stop(reason: ShutdownReason, exitCode?: number): Promise<void>;
  /** SIGINT/SIGTERM/SIGBREAK/SIGHUP → stop('signal'); a second signal exits at once. Returns uninstall. */
  installSignalHandlers(target?: SignalTarget): () => void;
}

export const SHUTDOWN_GRACE_MS = 5_000;
export const SHUTDOWN_SESSIONS_TIMEOUT_MS = 20_000;
export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
export const SHUTDOWN_FORCE_KILL_TIMEOUT_MS = 15_000;
/** Exit code after a second signal during the shutdown (like a hard Ctrl+C). */
export const FORCED_EXIT_CODE = 130;
const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

type Outcome = 'done' | 'failed' | 'timeout';

/** Settles `work` within `ms`; never rejects (lib/async `settleWithin`). */
async function bounded(work: () => unknown, ms: number): Promise<Outcome> {
  return (await settleWithin(work, ms)).outcome;
}

export function createServerShutdown(options: ServerShutdownOptions = {}): ServerShutdown {
  const log = options.logger ?? rootLogger;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const sessionsTimeoutMs = Math.max(graceMs, options.sessionsTimeoutMs ?? SHUTDOWN_SESSIONS_TIMEOUT_MS);
  const stepTimeoutMs = options.stepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS;
  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? SHUTDOWN_FORCE_KILL_TIMEOUT_MS;
  const forceKill = options.forceKill ?? (() => killChildProcessTrees({ logger: log }));
  let running: Promise<void> | null = null;

  async function stopSessions(): Promise<void> {
    const hook = options.stopSessions;
    if (hook === undefined) return;
    const sessions = bounded(hook, sessionsTimeoutMs);
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace'>((resolve) => {
      graceTimer = setTimeout(() => {
        resolve('grace');
      }, graceMs);
    });
    const early = await Promise.race([sessions, grace]);
    clearTimeout(graceTimer);
    if (early === 'grace') {
      log.warn({ graceMs }, 'shutdown: sessions still closing - ending the remaining process trees');
      const killed = await bounded(forceKill, forceKillTimeoutMs);
      if (killed !== 'done') log.warn({ outcome: killed }, 'shutdown: force kill did not complete');
    }
    const outcome = await sessions;
    if (outcome !== 'done') log.warn({ outcome }, 'shutdown: stopping the sessions did not complete');
  }

  async function run(reason: ShutdownReason, exitCode: number): Promise<void> {
    log.info({ reason }, 'shutdown: stopping the server');
    const started = Date.now();
    // WP22-05: duration per step in the final log line (target < 5 s for "Server beenden").
    const durations: Record<string, number> = {};
    try {
      let mark = Date.now();
      await stopSessions();
      durations.sessions = Date.now() - mark;
      for (const step of options.steps ?? []) {
        mark = Date.now();
        const outcome = await bounded(step.run, step.timeoutMs ?? stepTimeoutMs);
        durations[step.name] = Date.now() - mark;
        if (outcome !== 'done') log.warn({ step: step.name, outcome }, 'shutdown: step did not complete');
      }
      log.info({ reason, exitCode, totalMs: Date.now() - started, stepsMs: durations }, 'shutdown: done');
    } finally {
      exit(exitCode);
    }
  }

  const shutdown: ServerShutdown = {
    get stopping() {
      return running !== null;
    },
    stop(reason, exitCode = 0) {
      running ??= run(reason, exitCode);
      return running;
    },
    installSignalHandlers(target = process) {
      const onSignal = (): void => {
        if (running !== null) {
          log.warn('shutdown: second signal - exiting now');
          exit(FORCED_EXIT_CODE);
          return;
        }
        void shutdown.stop('signal');
      };
      for (const signal of SIGNALS) target.on(signal, onSignal);
      return () => {
        for (const signal of SIGNALS) target.off(signal, onSignal);
      };
    },
  };
  return shutdown;
}

/** Image names never killed by the sweep: the CIM query of `childProcesses` runs as our own child. */
const SWEEP_EXCLUDED = new Set(['powershell.exe']);

/**
 * Ends every direct child process tree of the server (`taskkill /PID <pid> /T /F`, C.8) – the
 * `claude.exe` sessions that did not exit after `close()`, with their Bash/MCP children. Children
 * started before `since` are skipped (PID reuse: a child is never older than its parent). Returns
 * the number of trees ended; failures – also a query that gave no answer (R2-02) – are logged,
 * never thrown.
 */
export async function killChildProcessTrees(
  options: {
    parentPid?: number;
    since?: Date;
    list?: (pid: number) => Promise<ProcessQueryResult>;
    kill?: (pid: number) => Promise<void>;
    logger?: Logger;
  } = {},
): Promise<number> {
  const log = options.logger ?? rootLogger;
  const parentPid = options.parentPid ?? process.pid;
  const since = options.since ?? new Date(Date.now() - process.uptime() * 1000 - 1000);
  const list =
    options.list ?? ((pid: number) => childProcesses(pid, { timeoutMs: SHUTDOWN_FORCE_KILL_TIMEOUT_MS }));
  const kill = options.kill ?? killProcessTree;
  const listed = await list(parentPid);
  if (listed.kind === 'unknown') {
    log.warn(
      { reason: listed.reason, detail: listed.detail },
      'shutdown: the child processes could not be listed - none ended',
    );
    return 0;
  }
  let killed = 0;
  for (const child of listed.processes) {
    if (SWEEP_EXCLUDED.has(child.name.toLowerCase())) continue;
    if (child.startedAt.getTime() < since.getTime()) continue;
    try {
      await kill(child.pid);
      killed += 1;
      log.info({ pid: child.pid, name: child.name }, 'shutdown: ended child process tree');
    } catch (error) {
      log.warn(
        { pid: child.pid, name: child.name, err: error },
        'shutdown: could not end child process tree',
      );
    }
  }
  return killed;
}
