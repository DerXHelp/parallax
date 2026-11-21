/**
 * ConPTY through `node:ffi` (WP-98 spike, production in WP-99): a pseudo console of Windows
 * (`CreatePseudoConsole`) with a shell attached, driven from this process without node-pty and
 * without a started helper. kernel32 only; null without `node:ffi` or off Windows x64 (`lib/ffi.ts`).
 *
 * - Pipes: `CreatePipe` twice. The console ends (input read, output write) are closed right after
 *   `CreatePseudoConsole` – conhost holds its own copies.
 * - Start: `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`, the
 *   pseudo console as attribute `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, `STARTF_USESTDHANDLES` with
 *   empty handles (a server with redirected stdio must not hand its own handles to the shell), no
 *   handle inheritance, the environment as a block (`envBlock.ts`).
 * - Reading never blocks: `PeekNamedPipe` first, then `ReadFile` of at most the bytes that are there.
 * - Writing never blocks either: the input pipe is `PIPE_NOWAIT`, input waits in a bounded queue and
 *   goes out in small chunks; what does not fit is retried on an unref'd timer. A blocking
 *   `WriteFile` would freeze the event loop for good once conhost stops reading input – it does
 *   when its output pipe is full, and only this event loop drains that pipe (review WP-99).
 * - Ctrl+C: before the first start this process stops ignoring Ctrl+C (`SetConsoleCtrlHandler(NULL,
 *   FALSE)`), because a started shell inherits that flag – a detached server (new process group) has
 *   it set, and then `\x03` reaches no program in cmd or PowerShell (WP-98).
 * - Closing: the output pipe first, then `ClosePseudoConsole` (it can wait for a reader of the
 *   output on older builds), then the remaining handles. Ending the console ends the processes
 *   attached to it (`CTRL_CLOSE_EVENT`). The process handle stays open until `exitCode()` has seen
 *   the shell end: while it is open, Windows cannot give the pid to another process, so the
 *   service's tree-kill fallback by pid never hits a stranger.
 *
 * Layouts (x64): STARTUPINFOEXW 112 bytes (`cb` 0, `dwFlags` 60, std handles 80/88/96,
 * `lpAttributeList` 104); PROCESS_INFORMATION 24 bytes (`hProcess` 0, `hThread` 8, `dwProcessId` 16).
 * COORD travels by value as one uint32 (X = columns low word, Y = rows high word).
 */
import { quoteWindowsArg, windowsCommandLine } from '../lib/cmdline';
import { loadFfi, openLibrary, pointerValue, type FfiFunction } from '../lib/ffi';
import { environmentBlock } from './envBlock';
import type { PtyFactory, PtyProcess, PtySpawnOptions } from './ports';

/** Absolute path of the program (`.exe`), arguments, folder, environment and size. */
export type ConPtyOptions = PtySpawnOptions;

/** One shell in a pseudo console (a `PtyProcess` with a real pid). Every method returns quickly; none throws after `spawn`. */
export interface ConPty extends PtyProcess {
  readonly pid: number;
  /** What the console wrote, at most `max` bytes; null = nothing waiting (or closed). */
  read(max: number): Buffer | null;
  /**
   * Input as UTF-8 (keys as VT sequences, `\x03` = Ctrl+C), queued and sent without blocking;
   * false = the console is gone, or the queue is full (`CONPTY_INPUT_QUEUE_BYTES`) and the input dropped.
   */
  write(data: string | Buffer): boolean;
  resize(cols: number, rows: number): boolean;
  /** Exit code once the shell ended, null while it runs – also after `close()`. */
  exitCode(): number | null;
  /**
   * Ends the console (and with it the attached processes) and frees the pipes; the process handle
   * follows once `exitCode()` sees the shell gone. Idempotent.
   */
  close(): void;
}

export interface ConPtyApi {
  /** Starts the shell; throws `ConPtyError` (the failed step) on failure. */
  spawn(options: ConPtyOptions): ConPty;
}

export class ConPtyError extends Error {
  constructor(
    readonly step: string,
    readonly code: number,
  ) {
    super(`${step} failed (${code})`);
    this.name = 'ConPtyError';
  }
}

const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000;
const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x0002_0016n;
const STARTF_USESTDHANDLES = 0x0000_0100;
const STARTUPINFOEX_BYTES = 112;
const STARTUPINFO_FLAGS_OFFSET = 60;
const ATTRIBUTE_LIST_OFFSET = 104;
const PROCESS_INFORMATION_BYTES = 24;
const PI_PROCESS_OFFSET = 0;
const PI_THREAD_OFFSET = 8;
const PI_PID_OFFSET = 16;
const WAIT_OBJECT_0 = 0;
/** `SetNamedPipeHandleState` mode: byte read mode (0) | `PIPE_NOWAIT` (1). */
const PIPE_NOWAIT_MODE = 0x0000_0001;
/** Pipe buffer size asked for (a hint for the system). */
const PIPE_BYTES = 64 * 1024;
/** Largest single read. */
export const CONPTY_READ_MAX = 64 * 1024;
/** Largest single write: far below the pipe buffer, so a non-blocking write that is all-or-nothing still progresses. */
export const CONPTY_WRITE_CHUNK = 1024;
/** Input waiting for the console at most; more is dropped (the shell then reads nothing at all). */
export const CONPTY_INPUT_QUEUE_BYTES = 1024 * 1024;
/** Retry interval while input waits. */
export const CONPTY_WRITE_RETRY_MS = 20;

const COLS_MAX = 0x7fff;

function packSize(cols: number, rows: number): number {
  const x = Math.min(Math.max(Math.trunc(cols), 1), COLS_MAX);
  const y = Math.min(Math.max(Math.trunc(rows), 1), COLS_MAX);
  return ((y << 16) | x) >>> 0;
}

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf16le');
}

/** `"<exe>" <args>` – the program token is always quoted (its parsing knows no escapes). */
export function conPtyCommandLine(executablePath: string, args: readonly string[]): string {
  const program = executablePath.includes('"') ? quoteWindowsArg(executablePath) : `"${executablePath}"`;
  return args.length === 0 ? program : `${program} ${windowsCommandLine(args)}`;
}

let cached: ConPtyApi | null | undefined;

/** The ConPTY binding, or null without `node:ffi`/kernel32 symbols (cached for the process). */
export function loadConPty(): ConPtyApi | null {
  if (cached !== undefined) return cached;
  cached = null;
  const ffi = loadFfi();
  const k = openLibrary('kernel32.dll', {
    CreatePipe: { return: 'int32', arguments: ['buffer', 'buffer', 'pointer', 'uint32'] },
    CreatePseudoConsole: { return: 'int32', arguments: ['uint32', 'pointer', 'pointer', 'uint32', 'buffer'] },
    ResizePseudoConsole: { return: 'int32', arguments: ['pointer', 'uint32'] },
    ClosePseudoConsole: { return: 'void', arguments: ['pointer'] },
    InitializeProcThreadAttributeList: {
      return: 'int32',
      arguments: ['pointer', 'uint32', 'uint32', 'buffer'],
    },
    UpdateProcThreadAttribute: {
      return: 'int32',
      arguments: ['pointer', 'uint32', 'uint64', 'pointer', 'uint64', 'pointer', 'pointer'],
    },
    DeleteProcThreadAttributeList: { return: 'void', arguments: ['pointer'] },
    CreateProcessW: {
      return: 'int32',
      arguments: [
        'buffer',
        'buffer',
        'pointer',
        'pointer',
        'int32',
        'uint32',
        'buffer',
        'buffer',
        'buffer',
        'buffer',
      ],
    },
    PeekNamedPipe: {
      return: 'int32',
      arguments: ['pointer', 'pointer', 'uint32', 'pointer', 'buffer', 'pointer'],
    },
    ReadFile: { return: 'int32', arguments: ['pointer', 'buffer', 'uint32', 'buffer', 'pointer'] },
    WriteFile: { return: 'int32', arguments: ['pointer', 'buffer', 'uint32', 'buffer', 'pointer'] },
    SetNamedPipeHandleState: { return: 'int32', arguments: ['pointer', 'buffer', 'pointer', 'pointer'] },
    WaitForSingleObject: { return: 'uint32', arguments: ['pointer', 'uint32'] },
    GetExitCodeProcess: { return: 'int32', arguments: ['pointer', 'buffer'] },
    CloseHandle: { return: 'int32', arguments: ['pointer'] },
    GetLastError: { return: 'uint32', arguments: [] },
    SetConsoleCtrlHandler: { return: 'int32', arguments: ['pointer', 'int32'] },
  });
  if (ffi === null || k === null) return cached;
  const call = (fn: FfiFunction, ...args: unknown[]): unknown => fn(...args);
  const lastError = (): number => {
    const code = call(k.GetLastError);
    return typeof code === 'number' ? code : -1;
  };
  const closeHandle = (handle: bigint): void => {
    if (handle === 0n) return;
    try {
      call(k.CloseHandle, handle);
    } catch {
      // nothing left to do
    }
  };
  const createPipe = (): [read: bigint, write: bigint] => {
    const read = Buffer.alloc(8);
    const write = Buffer.alloc(8);
    if (call(k.CreatePipe, read, write, null, PIPE_BYTES) === 0)
      throw new ConPtyError('CreatePipe', lastError());
    return [read.readBigUInt64LE(0), write.readBigUInt64LE(0)];
  };

  let ctrlCInheritable = false;
  cached = {
    spawn(options) {
      if (!ctrlCInheritable) {
        // A shell inherits "ignore Ctrl+C" from the process that starts it (a server started detached
        // is in its own process group, which sets it). Without this, `\x03` stops nothing in cmd or
        // PowerShell. The hidden server has no console of its own, so it receives nothing either way.
        call(k.SetConsoleCtrlHandler, null, 0);
        ctrlCInheritable = true;
      }
      const pipes = { inRead: 0n, inWrite: 0n, outRead: 0n, outWrite: 0n };
      let pseudoConsole = 0n;
      /** Memory of the attribute list; declared outside the `try` so the error path can still delete the list. */
      let attributes: Buffer | null = null;
      try {
        [pipes.inRead, pipes.inWrite] = createPipe();
        [pipes.outRead, pipes.outWrite] = createPipe();
        // Writing must never block the event loop (see the module comment).
        const mode = Buffer.alloc(4);
        mode.writeUInt32LE(PIPE_NOWAIT_MODE, 0);
        if (call(k.SetNamedPipeHandleState, pipes.inWrite, mode, null, null) === 0) {
          throw new ConPtyError('SetNamedPipeHandleState', lastError());
        }

        const hpc = Buffer.alloc(8);
        const hr = call(
          k.CreatePseudoConsole,
          packSize(options.cols, options.rows),
          pipes.inRead,
          pipes.outWrite,
          0,
          hpc,
        );
        if (hr !== 0) throw new ConPtyError('CreatePseudoConsole', typeof hr === 'number' ? hr >>> 0 : -1);
        pseudoConsole = hpc.readBigUInt64LE(0);
        // conhost keeps its own copies of the console ends.
        closeHandle(pipes.inRead);
        closeHandle(pipes.outWrite);
        pipes.inRead = 0n;
        pipes.outWrite = 0n;

        const size = Buffer.alloc(8);
        call(k.InitializeProcThreadAttributeList, null, 1, 0, size);
        const listBytes = Number(size.readBigUInt64LE(0));
        if (listBytes <= 0) throw new ConPtyError('InitializeProcThreadAttributeList(size)', lastError());
        const list = Buffer.alloc(listBytes);
        if (call(k.InitializeProcThreadAttributeList, list, 1, 0, size) === 0) {
          throw new ConPtyError('InitializeProcThreadAttributeList', lastError());
        }
        attributes = list;
        const listPointer = ffi.getRawPointer(list);
        const updated = call(
          k.UpdateProcThreadAttribute,
          listPointer,
          0,
          PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
          pseudoConsole,
          8n,
          null,
          null,
        );
        if (updated === 0) throw new ConPtyError('UpdateProcThreadAttribute', lastError());

        const startup = Buffer.alloc(STARTUPINFOEX_BYTES);
        startup.writeUInt32LE(STARTUPINFOEX_BYTES, 0);
        startup.writeUInt32LE(STARTF_USESTDHANDLES, STARTUPINFO_FLAGS_OFFSET);
        startup.writeBigUInt64LE(listPointer, ATTRIBUTE_LIST_OFFSET);
        const info = Buffer.alloc(PROCESS_INFORMATION_BYTES);
        const created = call(
          k.CreateProcessW,
          wide(options.executablePath),
          wide(options.windowsCommandLine ?? conPtyCommandLine(options.executablePath, options.args)),
          null,
          null,
          0,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
          environmentBlock(options.env),
          wide(options.cwd),
          startup,
          info,
        );
        if (created === 0) throw new ConPtyError('CreateProcessW', lastError());
        // The buffer itself (not the address): keeps it reachable until the list is gone.
        call(k.DeleteProcThreadAttributeList, list);
        attributes = null;
        closeHandle(info.readBigUInt64LE(PI_THREAD_OFFSET));
        return createConPty(k, call, closeHandle, {
          pseudoConsole,
          processHandle: info.readBigUInt64LE(PI_PROCESS_OFFSET),
          inWrite: pipes.inWrite,
          outRead: pipes.outRead,
          pid: info.readUInt32LE(PI_PID_OFFSET),
        });
      } catch (error) {
        if (attributes !== null) call(k.DeleteProcThreadAttributeList, attributes);
        closeHandle(pipes.outRead);
        if (pseudoConsole !== 0n) call(k.ClosePseudoConsole, pseudoConsole);
        closeHandle(pipes.inRead);
        closeHandle(pipes.inWrite);
        closeHandle(pipes.outWrite);
        throw error;
      }
    },
  };
  return cached;
}

interface ConPtyHandles {
  pseudoConsole: bigint;
  processHandle: bigint;
  inWrite: bigint;
  outRead: bigint;
  pid: number;
}

function createConPty(
  k: Record<string, FfiFunction>,
  call: (fn: FfiFunction, ...args: unknown[]) => unknown,
  closeHandle: (handle: bigint) => void,
  h: ConPtyHandles,
): ConPty {
  const fn = (name: string): FfiFunction => {
    const found = k[name];
    if (found === undefined) throw new Error(`kernel32 ${name} missing`);
    return found;
  };
  const peek = fn('PeekNamedPipe');
  const readFile = fn('ReadFile');
  const writeFile = fn('WriteFile');
  const wait = fn('WaitForSingleObject');
  const getExitCode = fn('GetExitCodeProcess');
  const resize = fn('ResizePseudoConsole');
  const closeConsole = fn('ClosePseudoConsole');
  const available = Buffer.alloc(4);
  const transferred = Buffer.alloc(4);
  const scratch = Buffer.alloc(CONPTY_READ_MAX);
  let closed = false;
  let outputOpen = true;
  let exit: number | null = null;
  let processHandle = h.processHandle;
  /** Input not yet taken by the pipe, oldest first. */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  /** Reads the exit code once the process is gone (no handle → whatever was seen). */
  const probeExit = (): number | null => {
    if (exit !== null || processHandle === 0n) return exit;
    try {
      if (call(wait, processHandle, 0) !== WAIT_OBJECT_0) return null;
      const code = Buffer.alloc(4);
      if (call(getExitCode, processHandle, code) === 0) return null;
      exit = code.readUInt32LE(0);
      return exit;
    } catch {
      return null;
    }
  };
  const releaseProcess = (): void => {
    closeHandle(processHandle);
    processHandle = 0n;
  };

  const dropInput = (): void => {
    pending = [];
    pendingBytes = 0;
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };

  /** Sends queued input until the pipe is full; false = the console is gone. Never blocks (`PIPE_NOWAIT`). */
  const flush = (): boolean => {
    while (pending.length > 0) {
      const head = pending[0];
      if (head === undefined) break;
      // Chunks end on a UTF-8 character boundary.
      let end = Math.min(head.length, CONPTY_WRITE_CHUNK);
      while (end > 1 && end < head.length && ((head[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      const chunk = head.subarray(0, end);
      if (call(writeFile, h.inWrite, chunk, chunk.length, transferred, null) === 0) return false;
      const written = transferred.readUInt32LE(0);
      if (written === 0) break; // the pipe is full – later
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
      let alive: boolean;
      try {
        alive = flush();
      } catch {
        alive = false;
      }
      if (alive) scheduleFlush();
      else dropInput();
    }, CONPTY_WRITE_RETRY_MS);
    retry.unref();
  };

  return {
    pid: h.pid,
    read(max) {
      if (closed || !outputOpen) return null;
      try {
        if (call(peek, h.outRead, null, 0, null, available, null) === 0) {
          outputOpen = false;
          return null;
        }
        const waiting = available.readUInt32LE(0);
        if (waiting === 0) return null;
        const want = Math.min(waiting, Math.max(1, Math.trunc(max)), CONPTY_READ_MAX);
        if (call(readFile, h.outRead, scratch, want, transferred, null) === 0) {
          outputOpen = false;
          return null;
        }
        const got = transferred.readUInt32LE(0);
        return got === 0 ? null : Buffer.from(scratch.subarray(0, got));
      } catch {
        outputOpen = false;
        return null;
      }
    },
    write(data) {
      if (closed) return false;
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      if (bytes.length === 0) return true;
      if (pendingBytes + bytes.length > CONPTY_INPUT_QUEUE_BYTES) return false;
      pending.push(bytes);
      pendingBytes += bytes.length;
      try {
        if (!flush()) {
          dropInput();
          return false;
        }
      } catch {
        dropInput();
        return false;
      }
      scheduleFlush();
      return true;
    },
    resize(cols, rows) {
      if (closed) return false;
      try {
        return call(resize, h.pseudoConsole, packSize(cols, rows)) === 0;
      } catch {
        return false;
      }
    },
    exitCode() {
      const code = probeExit();
      if (code !== null && closed) releaseProcess();
      return code;
    },
    close() {
      if (closed) return;
      closed = true;
      dropInput();
      closeHandle(h.outRead);
      try {
        call(closeConsole, h.pseudoConsole);
      } catch {
        // the handles below are freed anyway
      }
      closeHandle(h.inWrite);
      // Still running: the handle stays until `exitCode()` sees the end (pid stays reserved).
      if (probeExit() !== null) releaseProcess();
    },
  };
}

/** The pseudo console as the terminal service's `PtyFactory`; null where `loadConPty` is null. */
export function createConPtyFactory(): PtyFactory | null {
  const api = loadConPty();
  if (api === null) return null;
  return { spawn: (options) => api.spawn(options) };
}

/** `TERMINAL_UNAVAILABLE.params.reason` when `createConPtyFactory` is null: `platform` off Windows x64, else `ffi`. */
export function conPtyUnavailableReason(): 'platform' | 'ffi' {
  return process.platform === 'win32' && process.arch === 'x64' ? 'ffi' : 'platform';
}

/** For tests: forget the cached binding. */
export function resetConPtyForTests(): void {
  cached = undefined;
}

/** Re-export for the spike script: the raw pointer of a buffer (offset check). */
export function rawPointer(buffer: Buffer): bigint {
  const ffi = loadFfi();
  return ffi === null ? 0n : pointerValue(ffi.getRawPointer(buffer));
}
