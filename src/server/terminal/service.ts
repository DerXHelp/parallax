/**
 * Terminal service (WP-99, ADR-239): the shells of the embedded terminal, their scrollback and the
 * sockets watching them. Implements `TerminalService` of `ports.ts`; `socket.ts` bridges each
 * WebSocket to a `TerminalConnection`. Protocol and limits: `src/shared/terminal.ts`.
 *
 * - `connect` (after `hello`): `welcome` (available or `TERMINAL_UNAVAILABLE {reason}`, limits),
 *   then `terminals`. Unknown entry → ENTRY_NOT_FOUND (the socket closes 4404).
 * - `open`: checks in this order – available, entry known, not archived (SESSION_ARCHIVED),
 *   limits (`perEntry` counts running and exited terminals until closed, plus opens in flight;
 *   `total` → TERMINAL_LIMIT_REACHED {scope, max}), `checkCwd`, the launch (`resolveShellLaunch`
 *   in mode `embedded`; SHELL_NOT_FOUND passes through), `pty.spawn` (a throw → TERMINAL_START_FAILED
 *   {reason}: the failed ConPTY or Linux pty step and code or a generic word, never a path). Errors go to the
 *   requesting socket only (`error {requestId}`); success answers `opened` and pushes `terminals`
 *   to every socket of the entry. The client attaches explicitly afterwards.
 * - `attach`: lowest free channel 0–255 on that socket (a re-attach keeps its channel), `attached`,
 *   the ring replayed as binary frames (≤ `TERMINAL_FRAME_BYTES` each), then – if running – resize
 *   to the attach size plus a nudge (cols+1 and back) so conhost repaints the screen (WP-98 #7).
 * - `input` writes to a running shell (content never logged), `resize` updates pty and info,
 *   `detach` frees the channel, `close` ends the shell and removes the terminal (`exit
 *   {reason: 'closed'}` + `terminals`). `rename` sets the title (`terminalTitle`), `move` the
 *   position in the entry's list; both push `terminals` to every socket of the entry.
 * - Exit (seen by the poller): the remaining output drains for at least `EXIT_GRACE_MS` (conhost
 *   renders a moment after the process ends) and at most `EXIT_DRAIN_MAX_MS`, then `pty.close()`,
 *   state `exited` with the code, `exit {reason: 'exited'}` + `terminals`. The ring stays, so a
 *   later attach replays the end.
 * - `closeEntry`/`closeAll`: every console of the entry/computer ends with `exit {reason}`
 *   (`archived`, `removed`, `shutdown`); `closeEntry` pushes the empty list. Opens in flight for
 *   that entry fail. If a shell still runs `KILL_FALLBACK_MS` after `close()` (seen through the
 *   pty's `exitCode()`, never the bare pid) and `killTree` is given, it gets the pid
 *   (ClosePseudoConsole normally ends everything, WP-98 #3).
 * - Backpressure per socket (checked every tick): over `pauseBytes` queued → the terminals it has
 *   attached are not read any more (the pipe fills, conhost slows the shell down) until it is
 *   below `resumeBytes`; over `closeBytes`, or paused longer than `pauseMaxMs` → close 1013.
 * - `disconnect`: the socket's channels go away; the shells keep running.
 */
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ConsoleSettings, ShellKind } from '@shared/model';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_LIMITS,
  TERMINAL_PROTOCOL_VERSION,
  encodeTerminalFrame,
  type TerminalClientMessage,
  type TerminalCommand,
  type TerminalExitReason,
  type TerminalId,
  type TerminalInfo,
  type TerminalServerMessage,
} from '@shared/terminal';
import { newId } from '../lib/ids';
import { logger as rootLogger } from '../lib/logger';
import { checkCwd as defaultCheckCwd } from '../lib/paths';
import { regKeyQuery as defaultRegKeyQuery, type RegKeyQuery } from '../lib/registry';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import { realTimers, type Timers } from '../sessions/lib/timers';
import { CommandError } from '../sync/ports';
import { ConPtyError } from './conpty';
import { createPoller } from './poller';
import type {
  PtyProcess,
  TerminalClaudeOpenResult,
  TerminalConnection,
  TerminalEndReason,
  TerminalService,
  TerminalServiceDeps,
  TerminalOrigin,
  TerminalSink,
} from './ports';
import { createByteRing, type ByteRing } from './ring';
import {
  createGitFinder,
  resolveShellLaunch,
  type GitFinder,
  type GitLocatorDeps,
  type ShellLaunch,
} from './shells';
import { UnixPtyError } from './unixPty';

/** Size of a terminal started by `openClaude` until a panel attaches with its own size (`attach` resizes). */
export const CLAUDE_TERMINAL_SIZE = { cols: 120, rows: 30 } as const;

/** Payload bytes of one binary output frame (the frame adds the channel byte). */
export const TERMINAL_FRAME_BYTES = 64 * 1024 - 1;
/** After the exit is seen, output is read at least this long before the console closes. */
export const EXIT_GRACE_MS = 50;
/** … and at most this long (a paused socket or children that keep writing). */
export const EXIT_DRAIN_MAX_MS = 1000;
/** A shell still running this long after `close()` gets `killTree`. */
export const KILL_FALLBACK_MS = 2000;
/** Poll step of the liveness check after `close()`. */
const KILL_WATCH_STEP_MS = 100;

export const TERMINAL_BACKPRESSURE = {
  /** Above this many queued bytes a socket's terminals are not read any more. */
  pauseBytes: 1024 * 1024,
  /** Reading resumes below this. */
  resumeBytes: 256 * 1024,
  /** Above this the socket is closed (1013). */
  closeBytes: 8 * 1024 * 1024,
  /** Paused longer than this → the socket is closed (1013). */
  pauseMaxMs: 30_000,
} as const;

/** What starts for a shell in `cwd` (default: `resolveShellLaunch(…, 'embedded')`). */
export type TerminalLaunch = (
  kind: ShellKind,
  cwd: string,
  settings: ConsoleSettings,
) => Promise<ShellLaunch>;

export interface TerminalServiceOptions extends TerminalServiceDeps {
  /** Wall clock in ms (`createdAt`, poller, backpressure); default `Date.now`. */
  now?: () => number;
  logger?: Logger;
  /** Timer seam (default: unref'd real timers). */
  timers?: Timers;
  /** Fallback for a shell still running `KILL_FALLBACK_MS` after `close()` (e.g. `killProcessTree`); none if missing. */
  killTree?: (pid: number) => Promise<void>;
  /** Overrides the launch resolution (tests). */
  launch?: TerminalLaunch;
  /** Default `checkCwd` of `lib/paths.ts`. */
  checkCwd?: (cwd: string) => Promise<void>;
  /** For the default launch: base environment (default `process.env`), Git and POSIX lookup seams. */
  env?: NodeJS.ProcessEnv;
  fs?: FsProbe;
  /** WP-105: platform of the default launch (default `process.platform`). */
  platform?: NodeJS.Platform;
  regKeyQuery?: RegKeyQuery;
  /** Shared with `createShellCommands` to reuse one Git cache. */
  gitFinder?: GitFinder;
}

interface Terminal {
  info: TerminalInfo;
  /** WP-76 §B.13: started through remote access → ended by `closeRemote`. */
  readonly origin: TerminalOrigin;
  readonly pty: PtyProcess;
  readonly ring: ByteRing;
  /** Sockets receiving its output → their channel for it. */
  readonly attached: Map<Conn, number>;
  /** Exit code seen while the remaining output drains; null while running normally. */
  ending: { code: number; since: number } | null;
  /** The last read of the current tick found nothing waiting. */
  drained: boolean;
}

interface Conn {
  readonly entryId: EntryId;
  /** Terminals opened from this socket get it (WP-107: `remote` for the relay). */
  readonly origin: TerminalOrigin;
  readonly sink: TerminalSink;
  closed: boolean;
  /** Attached terminals → channel. */
  readonly channels: Map<TerminalId, number>;
  /** Since when its backlog is over `pauseBytes` (null = not paused). */
  pausedSince: number | null;
}

type ClientMessage = Exclude<TerminalClientMessage, { type: 'hello' }>;
type OpenMessage = Extract<ClientMessage, { type: 'open' }>;

/** A name from `rename`: control characters become spaces, trimmed; empty → null (the default name). */
export function terminalTitle(raw: string | null): string | null {
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
  const title = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return title === '' ? null : title.slice(0, TERMINAL_LIMITS.titleMaxChars);
}

/** The failed step of a ConPTY or Linux pty start (WP-105), or a generic word – never a path. */
export function startFailureReason(error: unknown): string {
  if (error instanceof ConPtyError || error instanceof UnixPtyError) {
    return `${error.step} (${String(error.code)})`;
  }
  return 'spawn';
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const log = (options.logger ?? rootLogger).child({ module: 'terminal' });
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const checkCwd = options.checkCwd ?? ((cwd: string) => defaultCheckCwd(cwd));
  const { pty: factory, killTree } = options;

  const finder = options.gitFinder ?? createGitFinder();
  let registry: RegKeyQuery | null = options.regKeyQuery ?? null;
  const locator = (): GitLocatorDeps => {
    registry ??= defaultRegKeyQuery();
    return { fs: options.fs ?? nodeFsProbe, env: options.env ?? process.env, regKeyQuery: registry };
  };
  const launchShell: TerminalLaunch =
    options.launch ??
    ((kind, cwd, settings) =>
      resolveShellLaunch(kind, cwd, settings, 'embedded', {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fs === undefined ? {} : { fs: options.fs }),
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        gitDir: () => finder.find(settings.gitDir, locator()),
      }));

  /** Every terminal of this computer; insertion order = oldest first. */
  const terminals = new Map<TerminalId, Terminal>();
  const conns = new Set<Conn>();
  /** Opens in flight (reserved against the limits). */
  const pendingOpens = new Map<EntryId, number>();
  let pendingTotal = 0;
  /** Security review WP-109: +1 per `closeRemote` (remote starts in flight compare it). */
  let remoteEpoch = 0;
  /** Bumped by `closeEntry`: an open in flight for an older epoch fails. */
  const epochs = new Map<EntryId, { epoch: number; reason: TerminalEndReason }>();
  /** Liveness watches after `close()` (awaited by `closeAll`). */
  const watches = new Set<Promise<void>>();
  let shuttingDown = false;

  const unavailable = (): ErrorPayload =>
    makeError('TERMINAL_UNAVAILABLE', {
      reason: factory === null ? (options.unavailableReason ?? 'platform') : 'disabled',
    });
  const canStart = (): boolean => factory !== null && !shuttingDown;

  // ---- sending ----

  const send = (conn: Conn, message: TerminalServerMessage): void => {
    if (conn.closed) return;
    try {
      conn.sink.send(message);
    } catch (error) {
      log.debug({ err: error }, 'terminal send failed');
    }
  };

  const sendFrames = (conn: Conn, channel: number, data: Uint8Array): void => {
    if (conn.closed) return;
    try {
      for (let offset = 0; offset < data.length; offset += TERMINAL_FRAME_BYTES) {
        conn.sink.sendFrame(
          encodeTerminalFrame(channel, data.subarray(offset, offset + TERMINAL_FRAME_BYTES)),
        );
      }
    } catch (error) {
      log.debug({ err: error }, 'terminal frame send failed');
    }
  };

  const entryConns = (entryId: EntryId): Conn[] =>
    [...conns].filter((conn) => conn.entryId === entryId && !conn.closed);

  const entryTerminals = (entryId: EntryId): Terminal[] =>
    [...terminals.values()].filter((t) => t.info.entryId === entryId);

  const list = (entryId: EntryId): TerminalInfo[] => entryTerminals(entryId).map((t) => ({ ...t.info }));

  const pushList = (entryId: EntryId): void => {
    const items = list(entryId);
    for (const conn of entryConns(entryId)) send(conn, { type: 'terminals', items });
  };

  const broadcastExit = (
    entryId: EntryId,
    terminalId: TerminalId,
    exitCode: number | null,
    reason: TerminalExitReason,
  ): void => {
    for (const conn of entryConns(entryId)) send(conn, { type: 'exit', terminalId, exitCode, reason });
  };

  const sendError = (
    conn: Conn,
    error: ErrorPayload,
    ids: { requestId?: string; terminalId?: TerminalId },
  ): void => {
    send(conn, { type: 'error', ...ids, error });
  };

  // ---- consoles ----

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timers.setTimeout(() => {
        resolve();
      }, ms);
    });

  const ended = (pty: PtyProcess): boolean => {
    try {
      return pty.exitCode() !== null;
    } catch {
      return true;
    }
  };

  /** Polls `exitCode()` until the shell is gone or `ms` passed; true = gone. */
  const waitEnded = async (pty: PtyProcess, ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    while (!ended(pty)) {
      if (now() >= deadline) return false;
      await sleep(KILL_WATCH_STEP_MS);
    }
    return true;
  };

  /**
   * Waits until the shell is gone; after KILL_FALLBACK_MS the tree gets `killTree`. Liveness comes
   * from the pty (`exitCode()` keeps answering after `close()`), never from the bare pid: ConPTY keeps
   * the process handle until it has seen the end, so the pid cannot belong to another process yet.
   */
  const watchExit = async (pty: PtyProcess, pid: number): Promise<void> => {
    if (await waitEnded(pty, KILL_FALLBACK_MS)) return;
    if (killTree === undefined) return;
    log.warn({ pid }, 'shell still running after the console closed – killing the tree');
    try {
      await killTree(pid);
    } catch (error) {
      log.warn({ err: error, pid }, 'killing the shell tree failed');
    }
    // Lets the pty see the end (and free its process handle).
    if (!(await waitEnded(pty, KILL_FALLBACK_MS))) log.warn({ pid }, 'shell survived the tree kill');
  };

  /** `close()` of a pty, then a watch until it is gone (kill fallback) when a pid is known. */
  const stopPty = (pty: PtyProcess): void => {
    const pid = pty.pid;
    try {
      pty.close();
    } catch (error) {
      log.warn({ err: error }, 'closing a pseudo console failed');
    }
    if (pid === null) return;
    const watch = watchExit(pty, pid).finally(() => {
      watches.delete(watch);
    });
    watches.add(watch);
  };

  const exitCodeOf = (t: Terminal): number | null => {
    if (t.ending !== null) return t.ending.code;
    try {
      return t.pty.exitCode();
    } catch {
      return null;
    }
  };

  /** Ends and forgets a terminal; every socket of the entry gets `exit {reason}`. */
  const endTerminal = (t: Terminal, reason: TerminalExitReason): void => {
    const { terminalId, entryId } = t.info;
    terminals.delete(terminalId);
    let exitCode = t.info.exitCode;
    if (t.info.state === 'running') {
      exitCode = exitCodeOf(t);
      stopPty(t.pty);
    }
    for (const conn of t.attached.keys()) conn.channels.delete(terminalId);
    t.attached.clear();
    t.ring.clear();
    broadcastExit(entryId, terminalId, exitCode, reason);
    log.info({ terminalId, entryId, reason }, 'terminal ended');
  };

  /** The shell exited and its output drained: close the console, keep the terminal listed. */
  const finishExit = (t: Terminal): void => {
    const exitCode = exitCodeOf(t);
    try {
      t.pty.close();
    } catch (error) {
      log.warn({ err: error }, 'closing a pseudo console failed');
    }
    t.ending = null;
    t.info = { ...t.info, state: 'exited', exitCode };
    broadcastExit(t.info.entryId, t.info.terminalId, exitCode, 'exited');
    pushList(t.info.entryId);
    log.info({ terminalId: t.info.terminalId, exitCode }, 'terminal exited');
  };

  const deliver = (t: Terminal, data: Uint8Array): void => {
    t.ring.push(data);
    for (const [conn, channel] of t.attached) sendFrames(conn, channel, data);
  };

  // ---- sockets ----

  const dropConn = (conn: Conn): void => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    for (const terminalId of conn.channels.keys()) terminals.get(terminalId)?.attached.delete(conn);
    conn.channels.clear();
  };

  const overload = (conn: Conn, why: 'backlog' | 'paused', buffered: number): void => {
    log.warn({ entryId: conn.entryId, why, buffered }, 'terminal socket overloaded – closing');
    dropConn(conn);
    try {
      conn.sink.close(TERMINAL_CLOSE_CODES.overloaded, 'overloaded');
    } catch (error) {
      log.debug({ err: error }, 'terminal socket close failed');
    }
  };

  const checkBackpressure = (conn: Conn, at: number): void => {
    const buffered = conn.sink.bufferedAmount();
    if (buffered > TERMINAL_BACKPRESSURE.closeBytes) {
      overload(conn, 'backlog', buffered);
      return;
    }
    if (conn.pausedSince === null) {
      if (buffered > TERMINAL_BACKPRESSURE.pauseBytes) conn.pausedSince = at;
      return;
    }
    if (buffered < TERMINAL_BACKPRESSURE.resumeBytes) {
      conn.pausedSince = null;
      return;
    }
    if (at - conn.pausedSince > TERMINAL_BACKPRESSURE.pauseMaxMs) overload(conn, 'paused', buffered);
  };

  const isPaused = (t: Terminal): boolean => {
    for (const conn of t.attached.keys()) if (conn.pausedSince !== null) return true;
    return false;
  };

  // ---- poller ----

  const poller = createPoller<Terminal>(
    {
      beforeTick(at) {
        for (const conn of [...conns]) checkBackpressure(conn, at);
        for (const t of terminals.values()) t.drained = false;
      },
      readable: () => [...terminals.values()].filter((t) => t.info.state === 'running' && !isPaused(t)),
      read(t, max) {
        const data = t.pty.read(max);
        if (data === null || data.length === 0) {
          t.drained = true;
          return null;
        }
        return data;
      },
      output: deliver,
      checkExits(at) {
        let ending = false;
        for (const t of [...terminals.values()]) {
          if (t.info.state !== 'running') continue;
          if (t.ending === null) {
            const code = t.pty.exitCode();
            if (code === null) continue;
            t.ending = { code, since: at };
            ending = true;
            continue;
          }
          const waited = at - t.ending.since;
          if ((waited >= EXIT_GRACE_MS && t.drained) || waited >= EXIT_DRAIN_MAX_MS) finishExit(t);
          else ending = true;
        }
        return ending;
      },
      active: () => !shuttingDown && [...terminals.values()].some((t) => t.info.state === 'running'),
    },
    {
      timers,
      now,
      onError: (error) => {
        log.error({ err: error }, 'terminal poll failed');
      },
    },
  );

  // ---- requests ----

  /** Checks 1–4 of `open` (available, entry, archived, limits); null = may start. */
  const admission = (entryId: EntryId): ErrorPayload | null => {
    if (!canStart()) return unavailable();
    const entry = options.entry(entryId);
    if (entry === null) return makeError('ENTRY_NOT_FOUND');
    if (entry.archived) return makeError('SESSION_ARCHIVED');
    const own = entryTerminals(entryId).length + (pendingOpens.get(entryId) ?? 0);
    if (own >= TERMINAL_LIMITS.perEntry) {
      return makeError('TERMINAL_LIMIT_REACHED', { scope: 'entry', max: TERMINAL_LIMITS.perEntry });
    }
    if (terminals.size + pendingTotal >= TERMINAL_LIMITS.total) {
      return makeError('TERMINAL_LIMIT_REACHED', { scope: 'total', max: TERMINAL_LIMITS.total });
    }
    return null;
  };

  /** The error of a failed check; CommandError payloads pass through (PATH_REJECTED, SHELL_NOT_FOUND …). */
  const checkFailure = (error: unknown, reason: string): ErrorPayload => {
    if (error instanceof CommandError) return error.error;
    log.warn({ err: error, reason }, 'terminal start check failed');
    return makeError('TERMINAL_START_FAILED', { reason });
  };

  const reserve = (entryId: EntryId, delta: 1 | -1): void => {
    const next = (pendingOpens.get(entryId) ?? 0) + delta;
    if (next <= 0) pendingOpens.delete(entryId);
    else pendingOpens.set(entryId, next);
    pendingTotal += delta;
  };

  /** Why an open in flight must not start any more (state changed during its awaits); null = go. */
  const stillAllowed = (entryId: EntryId, epoch: number): ErrorPayload | null => {
    if (!canStart()) return unavailable();
    const ended = epochs.get(entryId);
    if (ended !== undefined && ended.epoch !== epoch) {
      return makeError(ended.reason === 'removed' ? 'ENTRY_NOT_FOUND' : 'SESSION_ARCHIVED');
    }
    const entry = options.entry(entryId);
    if (entry === null) return makeError('ENTRY_NOT_FOUND');
    if (entry.archived) return makeError('SESSION_ARCHIVED');
    return null;
  };

  /** What a start needs besides the entry: how to resolve the program, and the terminal's facts. */
  interface StartPlan {
    readonly entryId: EntryId;
    readonly resolve: (cwd: string) => Promise<ShellLaunch>;
    readonly shell: ShellKind;
    readonly command: TerminalCommand;
    readonly origin: TerminalOrigin;
    readonly cols: number;
    readonly rows: number;
    /** False once nobody waits for the result any more (the socket closed): nothing starts, no error. */
    readonly wanted: () => boolean;
    /** Origin `remote`: `remoteEpoch` when the request arrived (default: at the start of this call). */
    readonly remoteSince?: number;
  }

  type StartOutcome =
    | { kind: 'opened'; info: TerminalInfo; pid: number | null }
    | { kind: 'failed'; error: ErrorPayload }
    | { kind: 'dropped' };

  /**
   * Checks 1–7 of `open` and the spawn: admission, `checkCwd`, the launch, the state again after the
   * awaits, `pty.spawn`; registers the terminal and pushes the list. Never throws.
   */
  const startTerminal = async (plan: StartPlan): Promise<StartOutcome> => {
    const { entryId } = plan;
    // Security review WP-109: a remote start from before the last `closeRemote` never starts.
    const remoteSince = plan.remoteSince ?? remoteEpoch;
    const revoked = (): boolean => plan.origin === 'remote' && remoteEpoch !== remoteSince;
    if (revoked()) return { kind: 'failed', error: makeError('HOST_REVOKED') };
    const refused = admission(entryId);
    if (refused !== null) return { kind: 'failed', error: refused };
    // admission() saw the entry; a null here would be a race with removal (checked again below).
    const cwd = options.entry(entryId)?.cwd ?? '';
    const epoch = epochs.get(entryId)?.epoch ?? 0;
    reserve(entryId, 1);
    try {
      try {
        await checkCwd(cwd);
      } catch (error) {
        return { kind: 'failed', error: checkFailure(error, 'cwd') };
      }
      let launch: ShellLaunch;
      try {
        launch = await plan.resolve(cwd);
      } catch (error) {
        return { kind: 'failed', error: checkFailure(error, 'launch') };
      }
      const late = stillAllowed(entryId, epoch);
      if (late !== null) return { kind: 'failed', error: late };
      if (revoked()) return { kind: 'failed', error: makeError('HOST_REVOKED') };
      if (!plan.wanted() || factory === null) return { kind: 'dropped' };
      let pty: PtyProcess;
      try {
        pty = factory.spawn({
          executablePath: launch.executablePath,
          args: launch.args,
          cwd,
          env: launch.env,
          cols: plan.cols,
          rows: plan.rows,
        });
      } catch (error) {
        const reason = startFailureReason(error);
        // A claude start carries the profile's env: its error text stays out of the log (only the step).
        const err = plan.command === 'shell' ? { err: error } : {};
        log.warn({ ...err, shell: plan.shell, command: plan.command, reason }, 'terminal start failed');
        return { kind: 'failed', error: makeError('TERMINAL_START_FAILED', { reason }) };
      }
      const info: TerminalInfo = {
        terminalId: newId('tm'),
        entryId,
        shell: plan.shell,
        cwd,
        createdAt: new Date(now()).toISOString(),
        cols: plan.cols,
        rows: plan.rows,
        state: 'running',
        exitCode: null,
        title: null,
        command: plan.command,
      };
      terminals.set(info.terminalId, {
        info,
        origin: plan.origin,
        pty,
        ring: createByteRing(),
        attached: new Map(),
        ending: null,
        drained: false,
      });
      log.info(
        {
          terminalId: info.terminalId,
          entryId,
          shell: info.shell,
          command: info.command,
          origin: plan.origin,
          pid: pty.pid,
        },
        'terminal opened',
      );
      return { kind: 'opened', info, pid: pty.pid };
    } finally {
      reserve(entryId, -1);
    }
  };

  /** `open` from a socket: starts the shell and answers `opened` (or `error` with the request id). */
  const openShell = async (conn: Conn, message: OpenMessage): Promise<void> => {
    const outcome = await startTerminal({
      entryId: conn.entryId,
      resolve: (cwd) => launchShell(message.shell, cwd, options.settings()),
      shell: message.shell,
      command: 'shell',
      origin: conn.origin,
      cols: message.cols,
      rows: message.rows,
      wanted: () => !conn.closed,
    });
    if (outcome.kind === 'dropped') return;
    if (outcome.kind === 'failed') {
      sendError(conn, outcome.error, { requestId: message.requestId });
      return;
    }
    send(conn, { type: 'opened', requestId: message.requestId, terminal: { ...outcome.info } });
    pushList(conn.entryId);
    poller.wake();
  };

  /** The terminal if it belongs to the socket's entry; otherwise answers TERMINAL_NOT_FOUND. */
  const own = (conn: Conn, terminalId: TerminalId): Terminal | null => {
    const t = terminals.get(terminalId);
    if (t?.info.entryId === conn.entryId) return t;
    sendError(conn, makeError('TERMINAL_NOT_FOUND', { terminalId }), { terminalId });
    return null;
  };

  const freeChannel = (conn: Conn): number | null => {
    const used = new Set(conn.channels.values());
    for (let channel = 0; channel <= TERMINAL_LIMITS.channelMax; channel += 1) {
      if (!used.has(channel)) return channel;
    }
    return null;
  };

  const attach = (conn: Conn, message: Extract<ClientMessage, { type: 'attach' }>): void => {
    const t = own(conn, message.terminalId);
    if (t === null) return;
    let channel = conn.channels.get(message.terminalId);
    if (channel === undefined) {
      const free = freeChannel(conn);
      if (free === null) {
        sendError(conn, makeError('INVALID_MESSAGE', { reason: 'channels' }), {
          terminalId: message.terminalId,
        });
        return;
      }
      channel = free;
      conn.channels.set(message.terminalId, channel);
      t.attached.set(conn, channel);
    }
    send(conn, { type: 'attached', terminalId: message.terminalId, channel });
    const replay = t.ring.snapshot();
    if (replay.length > 0) sendFrames(conn, channel, replay);
    if (t.info.state !== 'running') return;
    const { cols, rows } = message;
    // Resize, then nudge (one column more – or less at the maximum – and back): conhost repaints.
    const nudge = cols < TERMINAL_LIMITS.colsMax ? cols + 1 : cols - 1;
    t.pty.resize(cols, rows);
    t.pty.resize(nudge, rows);
    t.pty.resize(cols, rows);
    t.info = { ...t.info, cols, rows };
    poller.wake();
  };

  const handle = (conn: Conn, message: ClientMessage): void => {
    if (conn.closed) return;
    switch (message.type) {
      case 'open':
        openShell(conn, message).catch((error: unknown) => {
          log.error({ err: error }, 'terminal open failed');
          sendError(conn, makeError('TERMINAL_START_FAILED', { reason: 'internal' }), {
            requestId: message.requestId,
          });
        });
        return;
      case 'attach':
        attach(conn, message);
        return;
      case 'detach': {
        conn.channels.delete(message.terminalId);
        terminals.get(message.terminalId)?.attached.delete(conn);
        return;
      }
      case 'input': {
        const t = own(conn, message.terminalId);
        if (t?.info.state !== 'running' || t.ending !== null) return;
        // Content is never logged – only its size.
        if (!t.pty.write(message.data)) {
          log.debug({ terminalId: message.terminalId, chars: message.data.length }, 'terminal input dropped');
        }
        poller.wake();
        return;
      }
      case 'resize': {
        const t = own(conn, message.terminalId);
        if (t?.info.state !== 'running') return;
        t.pty.resize(message.cols, message.rows);
        t.info = { ...t.info, cols: message.cols, rows: message.rows };
        return;
      }
      case 'close': {
        const t = own(conn, message.terminalId);
        if (t === null) return;
        endTerminal(t, 'closed');
        pushList(conn.entryId);
        return;
      }
      case 'rename': {
        const t = own(conn, message.terminalId);
        if (t === null) return;
        const title = terminalTitle(message.title);
        if (title === t.info.title) return;
        t.info = { ...t.info, title };
        pushList(conn.entryId);
        return;
      }
      case 'move': {
        const t = own(conn, message.terminalId);
        if (t === null) return;
        const order = entryTerminals(conn.entryId);
        const from = order.indexOf(t);
        const to = Math.min(message.index, order.length - 1);
        if (from === to) return;
        order.splice(from, 1);
        order.splice(to, 0, t);
        // The map's insertion order is the list order: re-insert the entry's terminals in the new order.
        for (const item of order) terminals.delete(item.info.terminalId);
        for (const item of order) terminals.set(item.info.terminalId, item);
        pushList(conn.entryId);
        return;
      }
    }
  };

  return {
    get available() {
      return factory !== null;
    },
    connect(entryId, sink, origin = 'local'): TerminalConnection | ErrorPayload {
      if (options.entry(entryId) === null) return makeError('ENTRY_NOT_FOUND');
      const conn: Conn = { entryId, origin, sink, closed: false, channels: new Map(), pausedSince: null };
      conns.add(conn);
      const available = canStart();
      send(conn, {
        type: 'welcome',
        protocol: TERMINAL_PROTOCOL_VERSION,
        available,
        error: available ? null : unavailable(),
        limits: { perEntry: TERMINAL_LIMITS.perEntry, total: TERMINAL_LIMITS.total },
      });
      send(conn, { type: 'terminals', items: list(entryId) });
      return {
        handle: (message) => {
          handle(conn, message);
        },
        disconnect: () => {
          dropConn(conn);
        },
      };
    },
    list,
    async openClaude(entryId, launch, origin = 'local', since?: number): Promise<TerminalClaudeOpenResult> {
      try {
        const outcome = await startTerminal({
          entryId,
          // A copy: the spec's arrays and env stay the caller's.
          resolve: () =>
            Promise.resolve({
              executablePath: launch.executablePath,
              args: [...launch.args],
              env: { ...launch.env },
            }),
          shell: options.settings().defaultShell,
          command: 'claude',
          origin,
          ...CLAUDE_TERMINAL_SIZE,
          wanted: () => true,
          ...(since === undefined ? {} : { remoteSince: since }),
        });
        if (outcome.kind === 'failed') return outcome;
        if (outcome.kind === 'dropped') return { kind: 'failed', error: unavailable() };
        pushList(entryId);
        poller.wake();
        return { kind: 'opened', terminalId: outcome.info.terminalId, pid: outcome.pid };
      } catch (error) {
        // Never the launch in the log: its env holds the profile's secrets.
        log.error({ err: error, entryId }, 'claude terminal open failed');
        return { kind: 'failed', error: makeError('TERMINAL_START_FAILED', { reason: 'internal' }) };
      }
    },
    claudeState(terminalId) {
      const t = terminals.get(terminalId);
      return t?.info.state === 'running' && t.ending === null ? 'running' : 'ended';
    },
    remoteEpoch: () => remoteEpoch,
    closeRemote() {
      remoteEpoch += 1;
      const remote = [...terminals.values()].filter((t) => t.origin === 'remote');
      const entries = new Set(remote.map((t) => t.info.entryId));
      for (const t of remote) endTerminal(t, 'closed');
      for (const entryId of entries) pushList(entryId);
      if (remote.length > 0) log.info({ count: remote.length }, 'remote terminals closed');
    },
    closeEntry(entryId, reason) {
      epochs.set(entryId, { epoch: (epochs.get(entryId)?.epoch ?? 0) + 1, reason });
      const ended = entryTerminals(entryId);
      for (const t of ended) endTerminal(t, reason);
      if (ended.length > 0) pushList(entryId);
    },
    async closeAll() {
      shuttingDown = true;
      for (const t of [...terminals.values()]) endTerminal(t, 'shutdown');
      poller.stop();
      await Promise.all([...watches]);
    },
  };
}
