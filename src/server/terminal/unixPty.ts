/**
 * Linux pseudo terminal through `node:ffi` (WP-105, spike WP-101 §1.3, WP-100 E5): the second
 * `PtyFactory` next to `conpty.ts` – no node-pty, no native build, no helper process of our own.
 * libc only (`lib/ffi.ts` `openLibc`); null off Linux x64 or without `node:ffi`.
 *
 * - Open: `/dev/ptmx` with `O_RDWR | O_NOCTTY | O_NONBLOCK`, `unlockpt`, `ptsname_r` (neither is
 *   variadic), the window size through `ioctl(TIOCSWINSZ)` (variadic, works through `node:ffi` on
 *   x86_64 – WP-101), then the slave with `O_RDWR | O_NOCTTY`. Node opens every file with
 *   `O_CLOEXEC`, so no other terminal's master leaks into a child.
 * - Start: `setsid -c <program> <args…>` (`systemTool('setsid')`) with the slave as stdin, stdout and
 *   stderr, the session's cwd and the given environment – never through a shell. Started without
 *   `detached` (the child is no group leader), so `setsid` does not fork: the pid of the spawn is the
 *   program itself, leader of a new session whose controlling terminal is the slave (Ctrl+C, job
 *   control). The slave is closed in the server right after the spawn.
 * - Reading never blocks: `readSync` on the non-blocking master, `EAGAIN` → nothing waiting, `EIO`
 *   (every slave closed) or EOF → the output ended. Bytes, never text (a read may split a UTF-8
 *   character; the web decodes as a stream).
 * - Writing never blocks either: the master is non-blocking; input waits in a bounded queue and goes
 *   out as far as the line discipline takes it (WP-101: `EAGAIN` after about 18 KiB while the shell
 *   reads nothing); the rest is retried on an unref'd timer – like ConPTY.
 * - Exit code from the child's `exit` (a signal → 128 + its number, the shells' convention).
 * - Close: the master first – the kernel hangs the terminal up (SIGHUP to the session leader and the
 *   foreground job). Jobs started with `nohup` survive that (WP-101) and so would any other member of
 *   the session, so the session goes as a whole through `killProcessTree` (WP-103: `SIGTERM` to the
 *   groups of the session, `SIGKILL` after the grace): at once while the program is not reaped yet
 *   (its pid is still ours), afterwards only while a process of the session lives – its id then
 *   still names that session and Linux hands it to no other process.
 * - Environment: what the caller built (`shellEnvironment` for shells, the console spec for
 *   `claude`), plus `unixPtyEnvironment`: `TERM=xterm-256color` and `COLORTERM=truecolor` always (the
 *   other end is xterm.js, an inherited value describes the terminal the server was started from),
 *   without the identity of that outer terminal (`TERM_PROGRAM`, `TMUX`, `KITTY_*` …), and
 *   `LANG=C.UTF-8` only when no locale is set at all (WP-101: `LANG` otherwise stays as it is).
 */
import type { ChildProcess } from 'node:child_process';
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { Logger } from 'pino';
import { isExecutableFileSync } from '../lib/executables';
import { loadFfi, openLibc, pointerValue, type FfiFunction } from '../lib/ffi';
import { logger as rootLogger } from '../lib/logger';
import { assertSpawnableFile, errnoCode, killProcessTree, spawnHidden, systemTool } from '../lib/process';
import { createProcfsReader, isEndedState } from '../lib/procfs';
import type { PtyFactory, PtyProcess, PtySpawnOptions } from './ports';

/** One program in a pseudo terminal (a `PtyProcess` with a real pid). Every method returns quickly; none throws after `spawn`. */
export interface UnixPty extends PtyProcess {
  readonly pid: number;
  read(max: number): Buffer | null;
  /** Input as UTF-8, queued and sent without blocking; false = closed, or the queue is full and the input dropped. */
  write(data: string | Buffer): boolean;
}

export interface UnixPtyApi {
  /** Starts the program; throws `UnixPtyError` (the failed step) on failure. */
  spawn(options: PtySpawnOptions): UnixPty;
}

/** A failed start: the step and the errno (name or number) – never a path. */
export class UnixPtyError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | number,
  ) {
    super(`${step} failed (${String(code)})`);
    this.name = 'UnixPtyError';
  }
}

/** `ioctl` request of `<asm-generic/ioctls.h>` (x86_64 and aarch64 alike). */
const TIOCSWINSZ = 0x5414n;
/** `struct winsize`: rows, cols, x pixels, y pixels – four unsigned shorts. */
const WINSIZE_BYTES = 8;
/** Room for `/dev/pts/<n>`. */
const PTS_NAME_BYTES = 64;
const PTS_NAME = /^\/dev\/pts\/\d+$/;
const SIZE_MAX = 0xffff;

/** Largest single read. */
export const UNIX_PTY_READ_MAX = 64 * 1024;
/** Largest single write (the line discipline takes what fits; a partial write is fine). */
export const UNIX_PTY_WRITE_CHUNK = 4 * 1024;
/** Input waiting for the terminal at most; more is dropped (the program then reads nothing at all). */
export const UNIX_PTY_INPUT_QUEUE_BYTES = 1024 * 1024;
/** Retry interval while input waits. */
export const UNIX_PTY_WRITE_RETRY_MS = 20;

/** Variables naming the terminal the server was started from – the embedded one is xterm.js. */
const OUTER_TERMINAL_VARS = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'VTE_VERSION',
  'COLORFGBG',
  'WINDOWID',
  'TMUX',
  'TMUX_PANE',
  'STY',
]);
const OUTER_TERMINAL_PREFIXES = ['KITTY_', 'WEZTERM_', 'ALACRITTY_', 'KONSOLE_', 'ITERM_', 'GHOSTTY_'];

function isOuterTerminalVar(name: string): boolean {
  return OUTER_TERMINAL_VARS.has(name) || OUTER_TERMINAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/** The environment of a program in the pseudo terminal (see the file comment); names are exact (POSIX). */
export function unixPtyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isOuterTerminalVar(name)) continue;
    out[name] = value;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  if (!isSet(out.LC_ALL) && !isSet(out.LC_CTYPE) && !isSet(out.LANG)) out.LANG = 'C.UTF-8';
  return out;
}

/** `struct winsize` for `cols` × `rows` (clamped to 1…65535). */
export function winsize(cols: number, rows: number): Buffer {
  const clamp = (value: number) => Math.min(Math.max(Math.trunc(value), 1), SIZE_MAX);
  const buffer = Buffer.alloc(WINSIZE_BYTES);
  buffer.writeUInt16LE(clamp(rows), 0);
  buffer.writeUInt16LE(clamp(cols), 2);
  return buffer;
}

/** Exit code of an ended child: its code, or 128 + the number of the signal that ended it. */
export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : osConstants.signals[signal];
  return 128 + (number ?? 0);
}

/** What the factory needs besides libc (seams for tests). */
export interface UnixPtyDeps {
  /** Ends the session of a closed terminal (default `killProcessTree`, WP-103). */
  killTree?: (pid: number) => Promise<void>;
  /** True while a process of the session `sid` lives (default `/proc`; unknown → false). */
  sessionAlive?: (sid: number) => boolean;
  /** `setsid` (default `systemTool('setsid')`). */
  setsidPath?: string;
  logger?: Logger;
}

function procSessionAlive(sid: number): boolean {
  const table = createProcfsReader().table();
  if (table === null) return false;
  return table.some((row) => row.sid === sid && !isEndedState(row.state));
}

interface Libc {
  unlockpt: FfiFunction;
  ptsname_r: FfiFunction;
  ioctl: FfiFunction;
  errnoLocation: FfiFunction;
}

let cachedLibc: Libc | null | undefined;

function loadLibc(): Libc | null {
  if (cachedLibc !== undefined) return cachedLibc;
  cachedLibc = null;
  const functions = openLibc({
    unlockpt: { return: 'int32', arguments: ['int32'] },
    ptsname_r: { return: 'int32', arguments: ['int32', 'buffer', 'uint64'] },
    ioctl: { return: 'int32', arguments: ['int32', 'uint64', 'buffer'] },
    __errno_location: { return: 'pointer', arguments: [] },
  });
  if (functions === null) return cachedLibc;
  cachedLibc = {
    unlockpt: functions.unlockpt,
    ptsname_r: functions.ptsname_r,
    ioctl: functions.ioctl,
    errnoLocation: functions.__errno_location,
  };
  return cachedLibc;
}

/** The pseudo terminal binding, or null off Linux x64 or without `node:ffi`/libc symbols (libc cached for the process). */
export function loadUnixPty(deps: UnixPtyDeps = {}): UnixPtyApi | null {
  if (process.platform !== 'linux') return null;
  const ffi = loadFfi();
  const libc = loadLibc();
  if (ffi === null || libc === null) return null;
  const log = (deps.logger ?? rootLogger).child({ module: 'terminal.pty' });
  const killTree = deps.killTree ?? ((pid: number) => killProcessTree(pid));
  const sessionAlive = deps.sessionAlive ?? procSessionAlive;
  const call = (fn: FfiFunction, ...args: unknown[]): unknown => fn(...args);
  const errno = (): number => {
    try {
      const pointer = pointerValue(call(libc.errnoLocation));
      return pointer === 0n ? -1 : ffi.toBuffer(pointer, 4).readInt32LE(0);
    } catch {
      return -1;
    }
  };
  const setSize = (fd: number, cols: number, rows: number): boolean =>
    call(libc.ioctl, fd, TIOCSWINSZ, winsize(cols, rows)) === 0;

  return {
    spawn(options) {
      // The program itself: absolute, executable – `setsid` must never fail to exec it (its message
      // would be the terminal's only output) and never search PATH.
      assertSpawnableFile(options.executablePath);
      if (!isExecutableFileSync(options.executablePath)) throw new UnixPtyError('exec', 'ENOENT');
      const setsid = deps.setsidPath ?? systemTool('setsid');
      const flags = fsConstants.O_RDWR | fsConstants.O_NOCTTY;
      let master: number;
      try {
        master = openSync('/dev/ptmx', flags | fsConstants.O_NONBLOCK);
      } catch (error) {
        throw new UnixPtyError('open', errnoCode(error) ?? -1);
      }
      try {
        if (call(libc.unlockpt, master) !== 0) throw new UnixPtyError('unlockpt', errno());
        const name = Buffer.alloc(PTS_NAME_BYTES);
        const named = call(libc.ptsname_r, master, name, BigInt(name.length));
        if (named !== 0) throw new UnixPtyError('ptsname_r', typeof named === 'number' ? named : -1);
        const end = name.indexOf(0);
        const slavePath = name.toString('utf8', 0, end < 0 ? name.length : end);
        if (!PTS_NAME.test(slavePath)) throw new UnixPtyError('ptsname_r', 'EINVAL');
        if (!setSize(master, options.cols, options.rows)) throw new UnixPtyError('ioctl', errno());
        let slave: number;
        try {
          slave = openSync(slavePath, flags);
        } catch (error) {
          throw new UnixPtyError('open', errnoCode(error) ?? -1);
        }
        let child: ChildProcess;
        try {
          child = spawnHidden(setsid, ['-c', options.executablePath, ...options.args], {
            stdio: [slave, slave, slave],
            cwd: options.cwd,
            env: unixPtyEnvironment(options.env),
            // No group of our own: `setsid` must not fork (the pid stays the program's).
            detached: false,
          });
        } finally {
          // The child holds its copies; the server keeps only the master.
          closeSync(slave);
        }
        const pid = child.pid;
        if (pid === undefined) {
          // Node reports the reason asynchronously (ENOENT of `setsid` …).
          child.once('error', () => undefined);
          throw new UnixPtyError('spawn', 'ENOENT');
        }
        return createUnixPty({ master, pid, child, setSize, killTree, sessionAlive, log });
      } catch (error) {
        try {
          closeSync(master);
        } catch {
          // nothing left to do
        }
        throw error;
      }
    },
  };
}

interface UnixPtyParts {
  master: number;
  pid: number;
  child: ChildProcess;
  setSize: (fd: number, cols: number, rows: number) => boolean;
  killTree: (pid: number) => Promise<void>;
  sessionAlive: (sid: number) => boolean;
  log: Logger;
}

function createUnixPty(parts: UnixPtyParts): UnixPty {
  const { master, pid, child, log } = parts;
  const scratch = Buffer.alloc(UNIX_PTY_READ_MAX);
  let closed = false;
  let outputOpen = true;
  let exit: number | null = null;
  /** Input not yet taken by the terminal, oldest first. */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  child.once('exit', (code, signal) => {
    exit = childExitCode(code, signal);
  });
  child.on('error', (error) => {
    log.debug({ err: error, pid }, 'pty child error');
  });
  // Like ConPTY: a running terminal does not keep the server's event loop alive.
  child.unref();

  const dropInput = (): void => {
    pending = [];
    pendingBytes = 0;
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };

  /** Sends queued input until the terminal takes no more; false = it is gone. Never blocks. */
  const flush = (): boolean => {
    while (pending.length > 0) {
      const head = pending[0];
      if (head === undefined) break;
      let written: number;
      try {
        written = writeSync(master, head, 0, Math.min(head.length, UNIX_PTY_WRITE_CHUNK));
      } catch (error) {
        const code = errnoCode(error);
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') break;
        return false;
      }
      if (written <= 0) break;
      pendingBytes -= written;
      if (written >= head.length) pending.shift();
      else pending[0] = head.subarray(written);
    }
    return true;
  };

  const scheduleFlush = (): void => {
    if (retry !== null || pending.length === 0 || closed) return;
    retry = setTimeout(() => {
      retry = null;
      if (closed) return;
      if (flush()) scheduleFlush();
      else dropInput();
    }, UNIX_PTY_WRITE_RETRY_MS);
    retry.unref();
  };

  /** The session of the closed terminal (see the file comment); errors only logged. */
  const endSession = (): void => {
    let alive: boolean;
    try {
      alive = exit === null || parts.sessionAlive(pid);
    } catch {
      alive = false;
    }
    if (!alive) return;
    parts.killTree(pid).catch((error: unknown) => {
      log.warn({ err: error, pid }, 'ending the terminal session failed');
    });
  };

  return {
    pid,
    read(max) {
      if (closed || !outputOpen) return null;
      const want = Math.min(Math.max(1, Math.trunc(max)), UNIX_PTY_READ_MAX);
      try {
        const got = readSync(master, scratch, 0, want, null);
        if (got <= 0) {
          outputOpen = false;
          return null;
        }
        return Buffer.from(scratch.subarray(0, got));
      } catch (error) {
        const code = errnoCode(error);
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') return null;
        // EIO: every slave is closed – the output ended.
        outputOpen = false;
        return null;
      }
    },
    write(data) {
      if (closed) return false;
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      if (bytes.length === 0) return true;
      if (pendingBytes + bytes.length > UNIX_PTY_INPUT_QUEUE_BYTES) return false;
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (!flush()) {
        dropInput();
        return false;
      }
      scheduleFlush();
      return true;
    },
    resize(cols, rows) {
      if (closed) return false;
      try {
        return parts.setSize(master, cols, rows);
      } catch {
        return false;
      }
    },
    exitCode() {
      return exit;
    },
    close() {
      if (closed) return;
      closed = true;
      dropInput();
      try {
        closeSync(master);
      } catch {
        // already gone
      }
      endSession();
    },
  };
}

/** The pseudo terminal as the terminal service's `PtyFactory`; null where `loadUnixPty` is null. */
export function createUnixPtyFactory(deps: UnixPtyDeps = {}): PtyFactory | null {
  const api = loadUnixPty(deps);
  if (api === null) return null;
  return { spawn: (options) => api.spawn(options) };
}

/** `TERMINAL_UNAVAILABLE.params.reason` when `createUnixPtyFactory` is null: `platform` off Linux x64, else `ffi`. */
export function unixPtyUnavailableReason(): 'platform' | 'ffi' {
  return process.platform === 'linux' && process.arch === 'x64' ? 'ffi' : 'platform';
}

/** For tests: forget the cached libc binding. */
export function resetUnixPtyForTests(): void {
  cachedLibc = undefined;
}
