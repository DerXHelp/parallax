/**
 * Process helpers of the server (WP-11 owns this file; WP-13 and WP-21 use it). Every spawn goes
 * through here: always an argument array, `shell: false`, `windowsHide: true` (C.8, C.10), only
 * ABSOLUTE `.exe` paths (C.7; a `.cmd`/`.bat` would need a shell; a bare name like `git` would be
 * searched in the child's cwd first by libuv – a planted `git.exe` in a cloned repo, R1-04 /
 * ADR-022). Resolve bare names with `resolveExecutable`/`searchPath` (lib/windows.ts) or
 * `systemTool()`. stderr of a piped child is always read (F.16: a full stderr pipe blocks the
 * child). Process trees end with `taskkill /PID <pid> /T /F`. Contract: docs/architecture.md §2.2.
 *
 * The ONE exception from `windowsHide: true` (CLAUDE.md "Windows", ADR-144, proposal WP-50 §6):
 * `spawnGui`/`spawnExplorer` below start visible GUI programs after a user click (editor, Explorer,
 * default program) – absolute `.exe` only, block list, PE subsystem GUI, no shell, detached.
 *
 * POSIX (WP-103, WP-100 §5.2): absolute paths after the POSIX path rules, executable; every hidden
 * child starts `detached` – its own process group and session – so `killProcessTree` ends it with
 * its group: `SIGTERM` to the groups of the tree, after a grace `SIGKILL`; descendants that opened a
 * group or session of their own (`setsid`) are found in `/proc` first (WP-101 §1.4). The process
 * list comes from `/proc` (lib/procfs.ts). `spawnGui` has no PE check there (Linux has no GUI flag);
 * it uses the POSIX block list.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { makeError } from '@shared/errors';
import { EDITOR_BLOCKED_EXECUTABLES, editorExecutableIssue } from '@shared/model';
import { POSIX_PATHS, windowsPathIssue } from '@shared/paths';
import { TERMINAL_TOOL_SHELL_VARS, envRemovalReason } from '../claude/env';
import { CommandError } from '../sync/ports';
import { sleep, toError } from './async';
import { isSpawnableIfPresent, posixSystemTool } from './executables';
import { readFileHead } from './fileRead';
import { logger } from './logger';
import { fsErrorCode } from './paths';
import { PE_HEADER_BYTES, PE_SUBSYSTEM_WINDOWS_GUI, peSubsystem } from './pe';
import { createProcfsReader, isEndedState, type ProcStat } from './procfs';
import { loadNativeProcessApi, type NativeProcessApi } from './processNative';

export interface RunFileOptions {
  cwd?: string;
  /** Full environment of the child (e.g. from buildEnv()); default: inherit process.env. */
  env?: Record<string, string>;
  /** Hard limit; on expiry the whole process tree is killed and `timedOut` is true. */
  timeoutMs: number;
  /** Per stream (stdout, stderr); more output is read and discarded. Default 1 MiB. */
  maxOutputBytes?: number;
  /**
   * Ends the process tree like the timeout (`timedOut: true`), e.g. at the server shutdown (V3-15);
   * already aborted → nothing is started.
   */
  signal?: AbortSignal;
}

export interface RunFileResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Signature of `runFile` (seam for tests and for the lookups in lib/registry.ts, claude/). */
export type RunFileFn = (
  file: string,
  args: readonly string[],
  options: RunFileOptions,
) => Promise<RunFileResult>;

export interface SpawnHiddenOptions extends Omit<SpawnOptions, 'shell' | 'windowsHide'> {
  /**
   * Receives stderr text when stderr is piped (the default). Without it the text goes to the
   * debug log. The stream is consumed in any case, also when the caller adds own listeners.
   */
  onStderr?: (text: string) => void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** After a kill, wait at most this long for the `close` event before giving up on it. */
const CLOSE_GRACE_MS = 5_000;
const STDERR_LOG_CHARS = 2_000;

/** `code` of a Node system error (ENOENT, ESRCH, EPERM …); same rule as `fsErrorCode` (lib/paths.ts). */
export function errnoCode(error: unknown): string | undefined {
  return fsErrorCode(error) ?? undefined;
}

/**
 * Throws a TypeError unless `file` can be started safely without a shell (R1-04):
 * - Windows: an absolute, safe path (`@shared/paths`: no relative/drive-relative, UNC, device or
 *   ADS path) ending in `.exe`. Bare names (`git`, `explorer.exe`) are refused – libuv would look
 *   in the child's cwd before the PATH unless `NoDefaultCurrentDirectoryInExePath` is set.
 *   `.cmd`/`.bat`/`.ps1`/`.com` are refused (they need a shell or are not what we resolved).
 * - POSIX (WP-103): a path the POSIX rules accept (absolute, no `.`/`..`, no control character, not
 *   below `/proc`, `/sys`, `/dev`); on this machine also no existing non-executable file (a folder,
 *   a FIFO, a file without `x` bit). A missing file passes – the spawn reports ENOENT as on Windows.
 *   Scripts with a shebang are fine: the kernel starts them without a shell.
 */
export function assertSpawnableFile(file: string, platform: NodeJS.Platform = process.platform): void {
  if (file === '' || file.includes('\0')) throw new TypeError('spawn: empty or invalid executable');
  if (platform !== 'win32') {
    const issue = POSIX_PATHS.issue(file);
    if (issue !== null)
      throw new TypeError(`spawn: only absolute paths are started (${issue}), got "${file}"`);
    // The file system is only asked on its own platform (tests check the POSIX rules on Windows too).
    if (platform === process.platform && !isSpawnableIfPresent(file)) {
      throw new TypeError(`spawn: not an executable file, got "${file}"`);
    }
    return;
  }
  if (path.win32.extname(file).toLowerCase() !== '.exe') {
    throw new TypeError(`spawn: only .exe files are started (no shell), got "${path.win32.basename(file)}"`);
  }
  const issue = windowsPathIssue(file);
  if (issue !== null) {
    throw new TypeError(
      `spawn: only absolute .exe paths are started (${issue}), got "${path.win32.basename(file)}" – ` +
        'resolve bare names with resolveExecutable()/systemTool()',
    );
  }
}

/** A Windows tool name (`tar.exe`, `WindowsPowerShell\v1.0\powershell.exe`) – never a POSIX tool. */
function isWindowsToolName(name: string): boolean {
  return /\.exe$/i.test(name) || name.includes('\\');
}

/**
 * Absolute path of a system tool, never resolved through PATH: Windows `%SystemRoot%\System32\<name>`;
 * POSIX (WP-103) `/usr/bin/<name>` or `/bin/<name>`, whichever is executable (lib/executables.ts) –
 * callers pass the POSIX name there (`tar`, not `tar.exe`). A Windows tool name keeps its System32
 * path on every platform (as before WP-103): only Windows code paths ask for one (registry, toasts,
 * taskkill), and off Windows `assertSpawnableFile` refuses it – an error, never a surprise program.
 */
export function systemTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' && !isWindowsToolName(name)) return posixSystemTool(name);
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** `%SystemRoot%\explorer.exe` (Explorer lives in the Windows folder, not in System32). */
export function explorerPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'explorer.exe');
}

/**
 * POSIX (WP-103): a hidden child leads its own process group (and session), so `killProcessTree`
 * reaches everything it starts; an explicit `detached` of the caller wins. Windows: unchanged.
 */
function withProcessGroup(options: SpawnOptions): SpawnOptions {
  if (process.platform === 'win32') return options;
  return { ...options, detached: options.detached ?? true };
}

/**
 * spawn() with `shell: false` and `windowsHide: true` (cannot be overridden). A piped stderr is
 * always consumed (F.16); see `onStderr`. The caller must handle the child's `error` event
 * (spawn failures such as ENOENT arrive there) and should end trees with killProcessTree().
 * POSIX: `detached` (own process group) unless the caller says otherwise.
 */
export function spawnHidden(
  file: string,
  args: readonly string[],
  options: SpawnHiddenOptions = {},
): ChildProcess {
  assertSpawnableFile(file);
  const { onStderr, ...spawnOptions } = options;
  const child = spawn(file, [...args], {
    ...withProcessGroup(spawnOptions),
    shell: false,
    windowsHide: true,
  });
  const stderr = child.stderr;
  if (stderr !== null) {
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      if (onStderr !== undefined) {
        onStderr(chunk);
      } else {
        logger.debug({ pid: child.pid, stderr: chunk.slice(0, STDERR_LOG_CHARS) }, 'child stderr');
      }
    });
  }
  return child;
}

/** Collects up to `max` bytes of a stream; the rest is read and dropped (the pipe never fills up). */
function collector(max: number): { push(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= max) return;
      const part = size + chunk.length > max ? chunk.subarray(0, max - size) : chunk;
      chunks.push(part);
      size += part.length;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/**
 * Runs `file args` to completion (like execFile, but never through a shell). Resolves for any exit
 * code; rejects only when the process cannot be started (ENOENT, EACCES, …). On timeout (or an
 * aborted `signal`) the whole process tree is killed (`killProcessTree`: Windows `taskkill /T /F`,
 * POSIX the process groups of the tree), so no grandchild survives.
 */
export function runFile(
  file: string,
  args: readonly string[],
  options: RunFileOptions,
): Promise<RunFileResult> {
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<RunFileResult>((resolve, reject) => {
    const abortSignal = options.signal;
    if (abortSignal?.aborted === true) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: true });
      return;
    }
    let child: ChildProcess;
    try {
      assertSpawnableFile(file);
      child = spawn(
        file,
        [...args],
        withProcessGroup({
          cwd: options.cwd,
          env: options.env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (error) {
      reject(toError(error));
      return;
    }
    const stdout = collector(max);
    const stderr = collector(max);
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      abortSignal?.removeEventListener('abort', stop);
      resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    };

    /** Timeout or abort: the whole tree is ended, then `close` is awaited (bounded). */
    const stop = (): void => {
      if (settled || timedOut) return;
      clearTimeout(timer);
      timedOut = true;
      const pid = child.pid;
      const kill = pid === undefined ? Promise.resolve() : killProcessTree(pid);
      void kill
        .catch((error: unknown) => {
          logger.warn({ pid, err: error }, 'runFile: killing the timed-out process tree failed');
          child.kill('SIGKILL');
        })
        .finally(() => {
          graceTimer = setTimeout(() => {
            finish(null, 'SIGKILL');
          }, CLOSE_GRACE_MS);
        });
    };
    const timer = setTimeout(stop, options.timeoutMs);
    abortSignal?.addEventListener('abort', stop, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      abortSignal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

/**
 * True if a process with this PID exists (EPERM = exists, but belongs to someone else). Linux: a
 * zombie (ended, not yet reaped – `kill(pid, 0)` still succeeds) counts as gone.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errnoCode(error) !== 'EPERM') return false;
  }
  if (process.platform !== 'linux') return true;
  // Unreadable (no /proc, or ended just now): `kill` said it exists.
  const row = createProcfsReader().stat(pid);
  return row === null || !isEndedState(row.state);
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  if (pid === process.pid) throw new RangeError('refusing to kill the own process tree');
}

/** taskkill exit code for "process not found". */
const TASKKILL_NOT_FOUND = 128;

/** POSIX: how long the tree has for `SIGTERM` before `SIGKILL` (claude flushes its transcript). */
export const KILL_TREE_GRACE_MS = 2_000;
/** POSIX: how long a `SIGKILL`ed process may take to disappear (a zombie counts as gone). */
const KILL_TREE_REAP_MS = 2_000;
const KILL_TREE_POLL_MS = 50;

/** What the POSIX `killProcessTree` needs (seam: tests fake the table and record the signals). */
export interface PosixKillDeps {
  /** The process table (default `/proc`); null = unknown → only the process and the group it leads. */
  table(): ProcStat[] | null;
  /** One process now, for the liveness checks while waiting. */
  stat(pid: number): ProcStat | null;
  /** `process.kill`; a negative target is a process group. `0` only probes. May throw (ESRCH, EPERM). */
  kill(target: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The server's own PID (never signalled, nor its group or session). */
  ownPid: number;
}

export interface KillTreeOptions {
  /** Test seam (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** POSIX: `SIGTERM` → at most this long → `SIGKILL` (default KILL_TREE_GRACE_MS). */
  graceMs?: number;
  /** POSIX test seam (default: `/proc` and `process.kill`). */
  posix?: PosixKillDeps;
}

/**
 * Ends `pid` and all its descendants. A process that is already gone is not an error. Rejects if
 * the process still runs afterwards.
 * - Windows: `taskkill /PID <pid> /T /F` (C.8).
 * - POSIX (WP-103): the tree from `/proc` (`posixKillTargets`), `SIGTERM` to its process groups and
 *   to members outside them, at most `graceMs` for them to end, then `SIGKILL` to whatever is left.
 *   Never the server itself, its group or its session.
 */
export async function killProcessTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
  assertPid(pid);
  if ((options.platform ?? process.platform) !== 'win32') {
    await killPosixTree(pid, options.graceMs ?? KILL_TREE_GRACE_MS, options.posix ?? defaultPosixKillDeps());
    return;
  }
  const result = await runTaskkill(pid);
  if (result.exitCode === 0 || result.exitCode === TASKKILL_NOT_FOUND) return;
  if (!isProcessAlive(pid)) return;
  throw new Error(
    `taskkill /PID ${pid} /T /F failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(0, 500)}`,
  );
}

/** taskkill itself is run without the timeout-kill path of runFile (no recursion). */
function runTaskkill(pid: number): Promise<RunFileResult> {
  return new Promise<RunFileResult>((resolve, reject) => {
    const taskkill = systemTool('taskkill.exe');
    assertSpawnableFile(taskkill);
    const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = collector(64 * 1024);
    const stderr = collector(64 * 1024);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut: false });
    });
  });
}

// ---- POSIX process trees (WP-103) ----

function defaultPosixKillDeps(): PosixKillDeps {
  const reader = createProcfsReader();
  return {
    table: () => reader.table(),
    stat: (pid) => reader.stat(pid),
    kill: (target, signal) => {
      process.kill(target, signal);
    },
    sleep,
    now: Date.now,
    ownPid: process.pid,
  };
}

/** Process groups signalled as a whole, and every process of the tree. */
export interface PosixKillTargets {
  /** `kill(-pgid)`: groups the tree created (led by a member or by `root`), never the server's own. */
  groups: number[];
  /** Every process of the tree (liveness; signalled one by one unless its group is in `groups`). */
  processes: ProcStat[];
}

/**
 * The tree of `root` in a `/proc` table (pure): `root`, its descendants (by parent PID; a "child"
 * that started before its parent is a reused PID) and every process in a group or session the tree
 * created – also descendants that left with `setsid` and orphans whose parent already ended (WP-101
 * §1.4). A group/session id is the PID of its leader and Linux hands out no PID that still names
 * one, so the group and session `root` led are its own even after `root` ended. The server itself
 * (`ownPid`), init and the server's own group and session never belong to a tree.
 */
export function posixKillTargets(table: readonly ProcStat[], root: number, ownPid: number): PosixKillTargets {
  const self = table.find((row) => row.pid === ownPid);
  const foreignGroup = (id: number): boolean => id <= 1 || id === ownPid || id === self?.pgid;
  const foreignSession = (id: number): boolean => id <= 1 || id === ownPid || id === self?.sid;
  const members = new Map<number, ProcStat>();
  const groups = new Set<number>();
  const sessions = new Set<number>();
  if (!foreignGroup(root)) groups.add(root);
  if (!foreignSession(root)) sessions.add(root);
  const add = (row: ProcStat): boolean => {
    if (row.pid <= 1 || row.pid === ownPid || members.has(row.pid)) return false;
    members.set(row.pid, row);
    if (row.pgid === row.pid && !foreignGroup(row.pid)) groups.add(row.pid);
    if (row.sid === row.pid && !foreignSession(row.pid)) sessions.add(row.pid);
    return true;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) {
      if (members.has(row.pid)) continue;
      const parent = members.get(row.ppid);
      const belongs =
        row.pid === root ||
        groups.has(row.pgid) ||
        sessions.has(row.sid) ||
        (parent !== undefined && row.startTicks >= parent.startTicks);
      if (belongs && add(row)) changed = true;
    }
  }
  const processes = [...members.values()];
  return {
    groups: [...groups].filter((group) => processes.some((p) => p.pgid === group)),
    processes,
  };
}

function trySignal(deps: PosixKillDeps, target: number, signal: NodeJS.Signals): void {
  try {
    deps.kill(target, signal);
  } catch (error) {
    // ESRCH: gone meanwhile; EPERM: not ours (the liveness check after SIGKILL decides).
    logger.debug({ target, signal, code: errnoCode(error) }, 'killProcessTree: signal not delivered');
  }
}

/** The processes of `watched` that still run after at most `ms` (same start time, not a zombie). */
async function survivors(deps: PosixKillDeps, watched: readonly ProcStat[], ms: number): Promise<ProcStat[]> {
  const deadline = deps.now() + ms;
  for (;;) {
    const alive = watched.filter((p) => {
      const now = deps.stat(p.pid);
      return now !== null && now.startTicks === p.startTicks && !isEndedState(now.state);
    });
    if (alive.length === 0 || deps.now() >= deadline) return alive;
    await deps.sleep(KILL_TREE_POLL_MS);
  }
}

async function killPosixTree(pid: number, graceMs: number, deps: PosixKillDeps): Promise<void> {
  const table = deps.table();
  if (table === null) {
    await killPosixWithoutTable(pid, graceMs, deps);
    return;
  }
  const { groups, processes } = posixKillTargets(table, pid, deps.ownPid);
  if (processes.length === 0) return;
  const grouped = new Set(groups);
  // Each group of the targets as a whole, the others one by one.
  const send = (signal: NodeJS.Signals, targets: readonly ProcStat[]): void => {
    const hit = new Set(targets.map((p) => p.pgid));
    for (const group of groups) if (hit.has(group)) trySignal(deps, -group, signal);
    for (const p of targets) if (!grouped.has(p.pgid)) trySignal(deps, p.pid, signal);
  };
  send('SIGTERM', processes);
  const left = await survivors(deps, processes, graceMs);
  if (left.length === 0) return;
  send('SIGKILL', left);
  const stuck = await survivors(deps, left, KILL_TREE_REAP_MS);
  if (stuck.some((p) => p.pid === pid)) {
    throw new Error(`kill ${String(pid)} failed: the process still runs after SIGKILL`);
  }
}

/**
 * Without a process table (no `/proc`): the process and the group it leads (`spawnHidden` starts
 * children detached). Not the group of our parent (it may be ours).
 */
async function killPosixWithoutTable(pid: number, graceMs: number, deps: PosixKillDeps): Promise<void> {
  const alive = (): boolean => {
    try {
      deps.kill(pid, 0);
      return true;
    } catch (error) {
      return errnoCode(error) === 'EPERM';
    }
  };
  const send = (signal: NodeJS.Signals): void => {
    if (pid !== process.ppid) trySignal(deps, -pid, signal);
    trySignal(deps, pid, signal);
  };
  const waitEnd = async (ms: number): Promise<boolean> => {
    const deadline = deps.now() + ms;
    while (alive()) {
      if (deps.now() >= deadline) return false;
      await deps.sleep(KILL_TREE_POLL_MS);
    }
    return true;
  };
  if (!alive()) return;
  send('SIGTERM');
  if (await waitEnd(graceMs)) return;
  send('SIGKILL');
  if (!(await waitEnd(KILL_TREE_REAP_MS))) {
    throw new Error(`kill ${String(pid)} failed: the process still runs after SIGKILL`);
  }
}

// =====================================================================================
// Process queries (orphan cleanup at server start, shutdown sweep) – R2-02
// ADR-229, ADR-231: in this process through `node:ffi` (lib/processNative.ts) – never PowerShell.
// Without `node:ffi` (switched off, the permission model, not Windows x64) every query is unknown.
// Linux (WP-103): `/proc` (lib/procfs.ts), no `node:ffi` needed.
// =====================================================================================

/** Identity of a running process, for the orphan cleanup on the next start (B, C.8). */
export interface ProcessInfo {
  pid: number;
  /** Image name, e.g. `claude.exe` (Linux: `comm`, the started file's base name cut to 15 bytes). */
  name: string;
  parentPid: number | null;
  /**
   * Creation time (UTC). PID + name + start time identify a process; PIDs alone are reused.
   * Linux: the same value in every process, up to 1 s earlier than the real start (lib/procfs.ts).
   */
  startedAt: Date;
}

/**
 * Why a query gave no answer: the native snapshot failed (`failed`), or there is no native process
 * list – neither Windows nor Linux, or no `node:ffi` on Windows (`unsupported`). NEVER the same as
 * "the process is gone".
 */
export type ProcessQueryFailure = 'failed' | 'unsupported';

/** Result of `queryProcesses` (R2-02: an unknown answer is not an empty one). */
export type ProcessQueryResult =
  { kind: 'ok'; processes: ProcessInfo[] } | { kind: 'unknown'; reason: ProcessQueryFailure; detail: string };

/** Three-valued lookup of one PID (`processInfo`). */
export type ProcessLookup =
  | { kind: 'found'; info: ProcessInfo }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: ProcessQueryFailure; detail: string };

/** Processes with one of these PIDs and/or one of these parent PIDs. */
export interface ProcessFilter {
  pids?: readonly number[];
  parentPids?: readonly number[];
}

export interface ProcessQueryOptions {
  /** Test seam (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Test seam: the native process list (default `loadNativeProcessApi()`); null = none. */
  native?: NativeProcessApi | null;
}

let defaultNative: NativeProcessApi | null | undefined;

function unknownResult(reason: ProcessQueryFailure, detail: string): ProcessQueryResult {
  return { kind: 'unknown', reason, detail: detail.trim().slice(0, 500) };
}

/**
 * Processes of the native snapshot that `wanted` accepts (null = all), with their start times.
 * A process whose start time cannot be read (another user's, a protected one) is left out – it is
 * never one of this user's session processes. Unknown off Windows and Linux and without `node:ffi`
 * on Windows.
 */
function nativeQuery(
  options: ProcessQueryOptions,
  wanted: ((entry: { pid: number; parentPid: number }) => boolean) | null,
): ProcessQueryResult {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'linux') {
    return unknownResult('unsupported', 'no native process list on this platform');
  }
  if (options.native === undefined && defaultNative === undefined) defaultNative = loadNativeProcessApi();
  const api = options.native === undefined ? defaultNative : options.native;
  if (api === null || api === undefined) {
    return unknownResult('unsupported', 'no native process list (node:ffi is not available)');
  }
  const entries = api.entries();
  if (entries === null) return unknownResult('failed', 'process snapshot failed');
  const processes: ProcessInfo[] = [];
  for (const entry of entries) {
    if (entry.pid <= 0 || (wanted !== null && !wanted(entry))) continue;
    const startedAt = entry.startedAt !== undefined ? entry.startedAt : api.startedAt(entry.pid);
    if (startedAt === null) continue;
    processes.push({ pid: entry.pid, name: entry.name, parentPid: entry.parentPid, startedAt });
  }
  return { kind: 'ok', processes };
}

/** A synchronous query as a promise (a thrown RangeError of an invalid PID rejects it). */
function settled(query: () => ProcessQueryResult): Promise<ProcessQueryResult> {
  return new Promise((resolve) => {
    resolve(query());
  });
}

function assertPids(pids: readonly number[]): void {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  }
}

/**
 * Name, parent and start time of every process matching `filter` (natively, ADR-229; one snapshot
 * for many PIDs and their children). Three-valued: a failure is `unknown`, never an empty list.
 * Meant for the orphan cleanup and the shutdown sweep, not for hot paths. An empty filter answers
 * `ok []` without a snapshot; an invalid PID rejects with a RangeError.
 */
export function queryProcesses(
  filter: ProcessFilter,
  options: ProcessQueryOptions = {},
): Promise<ProcessQueryResult> {
  return settled(() => {
    const pids = new Set(filter.pids ?? []);
    const parents = new Set(filter.parentPids ?? []);
    assertPids([...pids, ...parents]);
    if (pids.size === 0 && parents.size === 0) return { kind: 'ok', processes: [] };
    return nativeQuery(options, (entry) => pids.has(entry.pid) || parents.has(entry.parentPid));
  });
}

/**
 * EVERY process of the machine (name, parent, start time; natively ≈ 10–30 ms; three-valued like
 * queryProcesses). For the periodic snapshot of the session process trees (WP22-06, R2-03); the
 * descendants are computed with `descendantsOf`.
 */
export function listProcesses(options: ProcessQueryOptions = {}): Promise<ProcessQueryResult> {
  return settled(() => nativeQuery(options, null));
}

/**
 * All descendants of `root` in `processes` (children, grandchildren …; by ParentProcessId). PIDs
 * are reused and a ParentProcessId may name a dead parent whose PID went to a newer process: a
 * child is only counted when it started at or after its parent (a child is never older than its
 * parent). Pure; `root` itself is not part of the result.
 */
export function descendantsOf(processes: readonly ProcessInfo[], root: ProcessInfo): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of processes) {
    if (p.parentPid === null || p.pid === p.parentPid) continue;
    byParent.set(p.parentPid, [...(byParent.get(p.parentPid) ?? []), p]);
  }
  const out: ProcessInfo[] = [];
  const seen = new Set<number>([root.pid]);
  const queue: ProcessInfo[] = [root];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of byParent.get(parent.pid) ?? []) {
      if (seen.has(child.pid) || child.startedAt.getTime() < parent.startedAt.getTime()) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Three-valued identity of `pid` (see queryProcesses): found / missing / unknown. */
export async function processInfo(pid: number, options: ProcessQueryOptions = {}): Promise<ProcessLookup> {
  assertPids([pid]);
  const result = await queryProcesses({ pids: [pid] }, options);
  if (result.kind === 'unknown') return result;
  const info = result.processes.find((p) => p.pid === pid);
  return info === undefined ? { kind: 'missing' } : { kind: 'found', info };
}

/** Start time of `pid`; null if it is missing OR the lookup failed (use processInfo to tell them apart). */
export async function processStartTime(pid: number, options: ProcessQueryOptions = {}): Promise<Date | null> {
  const lookup = await processInfo(pid, options);
  return lookup.kind === 'found' ? lookup.info.startedAt : null;
}

/**
 * Direct children of `pid` (by their parent PID), e.g. for the shutdown sweep
 * (launcher/shutdown.ts). PIDs are reused – a caller must also compare the start time (a child is
 * never older than its parent). Three-valued like queryProcesses.
 */
export async function childProcesses(
  pid: number,
  options: ProcessQueryOptions = {},
): Promise<ProcessQueryResult> {
  assertPids([pid]);
  const result = await queryProcesses({ parentPids: [pid] }, options);
  if (result.kind === 'unknown') return result;
  return { kind: 'ok', processes: result.processes.filter((p) => p.parentPid === pid) };
}

// =====================================================================================
// Visible GUI programs (Phase 3, ADR-144) – the one exception from `windowsHide: true`
// =====================================================================================

/**
 * Environment of a started GUI program: the server's env without the variables of a calling
 * Claude session and every `PARALLAX*` (filter `session` of claude/env.ts – an editor's terminal
 * must not believe it runs inside Claude Code or reach the server's home) and without the
 * `pnpm run` state (`run_state`: the launcher starts the server through pnpm). When the server
 * itself runs inside a Claude session (`CLAUDECODE` set, dev only), the tool-shell settings of that
 * session go too, like for an interactive terminal (TERMINAL_TOOL_SHELL_VARS: an editor's terminal
 * would inherit `GIT_TERMINAL_PROMPT=0`, `NO_COLOR` …). Machine variables (`NPM_CONFIG_REGISTRY`,
 * `NODE_OPTIONS` …) stay: the program sees the user's normal environment.
 * POSIX (WP-103): `CLAUDECODE` and the tool-shell names count only in their exact spelling (names
 * are case-sensitive there); the removal rules of claude/env.ts match any spelling, which only
 * removes more.
 */
export function guiEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const spelling = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const fromClaudeSession = Object.keys(base).some((name) => spelling(name) === 'CLAUDECODE');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const reason = envRemovalReason(name);
    if (reason === 'session' || reason === 'run_state') continue;
    if (fromClaudeSession && TERMINAL_TOOL_SHELL_VARS.includes(spelling(name))) continue;
    env[name] = value;
  }
  return env;
}

/** What `spawnGui`/`spawnExplorer` need of a started child (ChildProcess; fakes in tests). */
export interface GuiChild {
  readonly pid?: number | undefined;
  once(event: 'spawn' | 'error' | 'exit', listener: (error?: Error) => void): unknown;
  unref(): void;
}

/**
 * Security review WP-109: direct children of the server the user sees and works in – GUI programs of
 * `spawnGui`, the terminal emulator of the Linux console and shell window. The shutdown sweep
 * (`launcher/shutdown.ts`) never ends them: on Linux they stay children of the server (Windows starts
 * its console through `powershell.exe`, which the sweep skips by name).
 */
const keptUserPrograms = new Set<number>();

/** Registers a started user program until its exit (no pid: nothing to keep). */
export function keepUserProgram(child: {
  readonly pid?: number | undefined;
  once(event: 'exit', listener: () => void): unknown;
}): void {
  const pid = child.pid;
  if (pid === undefined) return;
  keptUserPrograms.add(pid);
  child.once('exit', () => {
    keptUserPrograms.delete(pid);
  });
}

/** PIDs of the user programs still running (see `keepUserProgram`). */
export function userProgramPids(): number[] {
  return [...keptUserPrograms];
}

/** Spawn seam of the GUI start (default: `child_process.spawn`). */
export type GuiSpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => GuiChild;

const defaultGuiSpawn: GuiSpawnFn = (file, args, options) => spawn(file, [...args], options);

export interface GuiStartOptions {
  /** Base environment (default `process.env`), filtered by `guiEnvironment`. */
  env?: NodeJS.ProcessEnv;
  spawn?: GuiSpawnFn;
  platform?: NodeJS.Platform;
}

export interface SpawnGuiOptions extends GuiStartOptions {
  /** Working folder of the program (the folder of the opened file). */
  cwd: string;
  /** Reads the PE header (default `readFileHead`). */
  readHead?: (file: string, length: number) => Promise<Uint8Array>;
  /** POSIX: the target of a link (default `fs.realpath`). */
  realpath?: (file: string) => Promise<string>;
}

function openFailed(reason: string): CommandError {
  return new CommandError(makeError('OPEN_FAILED', { reason }));
}

/**
 * Starts a prepared child and waits for `spawn` (success, then `unref`) or `error` (ENOENT, an
 * AppLocker EACCES/EPERM …) → OPEN_FAILED {reason: <errno code>}. Exit codes are never awaited.
 */
function startDetached(start: () => GuiChild): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: GuiChild;
    try {
      child = start();
    } catch (error) {
      reject(openFailed(errnoCode(error) ?? 'spawn'));
      return;
    }
    child.once('spawn', () => {
      child.unref();
      keepUserProgram(child);
      resolve();
    });
    child.once('error', (error) => {
      reject(openFailed(errnoCode(error) ?? 'spawn'));
    });
  });
}

/**
 * Starts a VISIBLE GUI program after a user click (editor; ADR-144) – the one exception from
 * `windowsHide: true` (CLAUDE.md "Windows"): `windowsHide: true` sets SW_HIDE in STARTUPINFO, and a
 * GUI program that takes its first ShowWindow from there would stay invisible. Rules:
 * - only an absolute `.exe` (`assertSpawnableFile`), base name not in EDITOR_BLOCKED_EXECUTABLES
 *   (shells, script hosts, LOLBins, explorer.exe – Explorer has `spawnExplorer`);
 * - PE subsystem "Windows GUI" (2), otherwise OPEN_FAILED {reason: 'not_gui'} (a console program
 *   would open a console window);
 * - `shell: false`, argument array, `windowsHide: false`, `detached: true`, `stdio: 'ignore'`,
 *   `unref()`; working folder `cwd`; environment `guiEnvironment()`.
 * POSIX (WP-103, WP-100 §5.2): an absolute program after the POSIX rules, base name not on
 * EDITOR_BLOCKED_POSIX_EXECUTABLES (`editorExecutableIssue`: shells, interpreters, wrappers, terminal
 * emulators, openers like `xdg-open`), no PE check; `detached` (own session, `setsid`), stdio
 * `ignore`. The callers (editor, file manager) come with WP-106.
 * Errors: OPEN_FAILED {reason: 'path' | 'blocked' | 'not_gui' | <errno code>}.
 */
export async function spawnGui(
  file: string,
  args: readonly string[],
  options: SpawnGuiOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  try {
    assertSpawnableFile(file, platform);
  } catch {
    throw openFailed('path');
  }
  const spawnFn = options.spawn ?? defaultGuiSpawn;
  if (platform !== 'win32') {
    const issue = editorExecutableIssue(file, POSIX_PATHS);
    if (issue === 'blocked') throw openFailed('blocked');
    if (issue !== null) throw openFailed('path');
    // Security review WP-109: a harmless name may link to a blocked program (`~/bin/notes` →
    // python3). `snap` is the exception as a link target: it starts the installed snap named like the
    // link (`/snap/bin/code`), never a program from the arguments.
    let target: string;
    try {
      target = await (options.realpath ?? realpath)(file);
    } catch (error) {
      throw openFailed(errnoCode(error) ?? 'path');
    }
    if (POSIX_PATHS.baseName(target) !== 'snap' && editorExecutableIssue(target, POSIX_PATHS) === 'blocked') {
      throw openFailed('blocked');
    }
    const posixOptions: SpawnOptions = {
      cwd: options.cwd,
      env: guiEnvironment(options.env, platform),
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    };
    await startDetached(() => spawnFn(file, args, posixOptions));
    return;
  }
  const base = path.win32.basename(file).toLowerCase();
  if ((EDITOR_BLOCKED_EXECUTABLES as readonly string[]).includes(base)) throw openFailed('blocked');
  let head: Uint8Array;
  try {
    head = await (options.readHead ?? readFileHead)(file, PE_HEADER_BYTES);
  } catch (error) {
    throw openFailed(errnoCode(error) ?? 'read');
  }
  if (peSubsystem(head) !== PE_SUBSYSTEM_WINDOWS_GUI) throw openFailed('not_gui');
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: guiEnvironment(options.env, platform),
    shell: false,
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
  };
  await startDetached(() => spawnFn(file, args, spawnOptions));
}

/** How Explorer shows a path: `select` marks a file in its folder, `open` opens a folder or a file. */
export type ExplorerMode = 'select' | 'open';

/** Explorer's one argument: `/select,"<path>"` or `"<path>"` (a checked path never contains `"`). */
export function explorerArgument(target: string, mode: ExplorerMode): string {
  return mode === 'select' ? `/select,"${target}"` : `"${target}"`;
}

/**
 * `%SystemRoot%\explorer.exe` with ONE verbatim argument (ADR-144): `/select,"<path>"` marks a
 * file, `"<path>"` opens a folder – or a file with its default program (callers check the
 * extension list first). Explorer parses its command line itself, so the argument is passed with
 * `windowsVerbatimArguments` (libuv's quoting would turn `/select,"…"` into `"/select,\"…\""`).
 * Visible and detached like `spawnGui`; Explorer's exit code (1 also on success) is never awaited.
 * Errors: OPEN_FAILED {reason: 'path' | <errno code>}.
 */
export async function spawnExplorer(
  target: string,
  mode: ExplorerMode,
  options: GuiStartOptions = {},
): Promise<void> {
  // Never a UNC/device path, a quote or a control character in the verbatim command line.
  if (windowsPathIssue(target) !== null) throw openFailed('path');
  const explorer = explorerPath(options.env);
  try {
    assertSpawnableFile(explorer, options.platform);
  } catch {
    throw openFailed('path');
  }
  const spawnOptions: SpawnOptions = {
    cwd: path.win32.dirname(explorer),
    env: guiEnvironment(options.env),
    shell: false,
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    // Verbatim means unquoted: quote the program name of the command line ourselves.
    argv0: `"${explorer}"`,
  };
  const spawnFn = options.spawn ?? defaultGuiSpawn;
  await startDetached(() => spawnFn(explorer, [explorerArgument(target, mode)], spawnOptions));
}
