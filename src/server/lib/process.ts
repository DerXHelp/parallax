/**
 * Process helpers of the server (WP-11 owns this file; WP-13 and WP-21 use it). Every spawn goes
 * through here: always an argument array, `shell: false`, `windowsHide: true` (C.8, C.10), only
 * ABSOLUTE `.exe` paths (C.7; a `.cmd`/`.bat` would need a shell; a bare name like `git` would be
 * searched in the child's cwd first by libuv – a planted `git.exe` in a cloned repo, R1-04 /
 * ADR-022). Resolve bare names with `resolveExecutable`/`searchPath` (lib/windows.ts) or
 * `systemTool()`. stderr of a piped child is always read (F.16: a full stderr pipe blocks the
 * child). Process trees end with `taskkill /PID <pid> /T /F`. Contract: docs/architecture.md §2.2.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { windowsPathIssue } from '@shared/paths';
import { toError } from './async';
import { logger } from './logger';
import { fsErrorCode } from './paths';

export interface RunFileOptions {
  cwd?: string;
  /** Full environment of the child (e.g. from buildEnv()); default: inherit process.env. */
  env?: Record<string, string>;
  /** Hard limit; on expiry the whole process tree is killed and `timedOut` is true. */
  timeoutMs: number;
  /** Per stream (stdout, stderr); more output is read and discarded. Default 1 MiB. */
  maxOutputBytes?: number;
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
 * - Other platforms (tests only): an absolute path.
 */
export function assertSpawnableFile(file: string, platform: NodeJS.Platform = process.platform): void {
  if (file === '' || file.includes('\0')) throw new TypeError('spawn: empty or invalid executable');
  if (platform !== 'win32') {
    if (!path.posix.isAbsolute(file))
      throw new TypeError(`spawn: only absolute paths are started, got "${file}"`);
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

/** Absolute path of a Windows system tool (System32), never resolved through PATH. */
export function systemTool(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/**
 * spawn() with `shell: false` and `windowsHide: true` (cannot be overridden). A piped stderr is
 * always consumed (F.16); see `onStderr`. The caller must handle the child's `error` event
 * (spawn failures such as ENOENT arrive there) and should end trees with killProcessTree().
 */
export function spawnHidden(
  file: string,
  args: readonly string[],
  options: SpawnHiddenOptions = {},
): ChildProcess {
  assertSpawnableFile(file);
  const { onStderr, ...spawnOptions } = options;
  const child = spawn(file, [...args], { ...spawnOptions, shell: false, windowsHide: true });
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
 * code; rejects only when the process cannot be started (ENOENT, EACCES, …). On timeout the whole
 * process tree is killed (`taskkill /T /F`), so no grandchild survives.
 */
export function runFile(
  file: string,
  args: readonly string[],
  options: RunFileOptions,
): Promise<RunFileResult> {
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<RunFileResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      assertSpawnableFile(file);
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
      resolve({ exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    };

    const timer = setTimeout(() => {
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
    }, options.timeoutMs);

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
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

/** True if a process with this PID exists (EPERM = exists, but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  if (pid === process.pid) throw new RangeError('refusing to kill the own process tree');
}

/** taskkill exit code for "process not found". */
const TASKKILL_NOT_FOUND = 128;

/**
 * Ends `pid` and all its descendants (`taskkill /PID <pid> /T /F`, C.8). A process that is already
 * gone is not an error. Rejects if the process still runs afterwards.
 */
export async function killProcessTree(pid: number): Promise<void> {
  assertPid(pid);
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (errnoCode(error) !== 'ESRCH') throw error;
    }
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

// =====================================================================================
// Process queries (orphan cleanup at server start, shutdown sweep) – R2-02
// =====================================================================================

/** Identity of a running process, for the orphan cleanup on the next start (B, C.8). */
export interface ProcessInfo {
  pid: number;
  /** Image name, e.g. `claude.exe`. */
  name: string;
  parentPid: number | null;
  /** Creation time (UTC). PID + name + start time identify a process; PIDs alone are reused. */
  startedAt: Date;
}

/**
 * Why a query gave no answer: PowerShell timed out (`timeout`), could not run or failed – policy
 * (AppLocker, Constrained Language Mode), CIM error, exit ≠ 0 (`failed`) – or printed something
 * unreadable (`output`); `unsupported` off Windows. NEVER the same as "the process is gone".
 */
export type ProcessQueryFailure = 'timeout' | 'failed' | 'output' | 'unsupported';

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
  /** Per PowerShell call; default `PROCESS_QUERY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test seam (default `runFile`). */
  run?: RunFileFn;
  /** Test seam (default `process.platform`). */
  platform?: NodeJS.Platform;
}

/**
 * PowerShell + CIM: 1–3 s idle, up to ≈ 23 s under load (docs/wp/FLAKES.md). The orphan cleanup
 * runs in the background, so the limit is generous (R2-02); a timeout is `unknown`, never "gone".
 */
export const PROCESS_QUERY_TIMEOUT_MS = 60_000;
/** WQL clauses per CIM query (the filter has a length limit); more PIDs → several sequential calls. */
export const PROCESS_QUERY_MAX_CLAUSES = 100;

function assertPids(pids: readonly number[]): void {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  }
}

/**
 * WQL filters for `Win32_Process` (`ProcessId = a OR … OR ParentProcessId = b …`), at most
 * `PROCESS_QUERY_MAX_CLAUSES` clauses each. Only validated integers go into the text (no injection).
 */
export function processQueryFilters(filter: ProcessFilter, maxClauses = PROCESS_QUERY_MAX_CLAUSES): string[] {
  const pids = [...new Set(filter.pids ?? [])];
  const parents = [...new Set(filter.parentPids ?? [])];
  assertPids(pids);
  assertPids(parents);
  const clauses = [
    ...pids.map((pid) => `ProcessId = ${String(pid)}`),
    ...parents.map((pid) => `ParentProcessId = ${String(pid)}`),
  ];
  const filters: string[] = [];
  for (let i = 0; i < clauses.length; i += maxClauses) {
    filters.push(clauses.slice(i, i + maxClauses).join(' OR '));
  }
  return filters;
}

/**
 * The PowerShell script of one query. `-ErrorAction Stop` + `try/catch → exit 3`: a CIM failure
 * must not print an empty list (that would read as "no such process"). The date format has no
 * culture-dependent specifier and everything works in Constrained Language Mode;
 * `-InputObject @(...)` keeps 0/1 results arrays (PS 5.1).
 */
function processQueryScript(wqlFilter: string | null): string {
  const selection =
    wqlFilter === null ? '-Property ProcessId,ParentProcessId,Name,CreationDate' : `-Filter '${wqlFilter}'`;
  return (
    `try { $c = @(Get-CimInstance -ClassName Win32_Process ${selection} -ErrorAction Stop | ` +
    // ProcessId 0 (System Idle Process) has a CreationDate too, but no positive PID.
    `Where-Object { $_.CreationDate -and $_.ProcessId -gt 0 } | ForEach-Object { @{ pid = [int]$_.ProcessId; name = [string]$_.Name; ` +
    `parentPid = [int]$_.ParentProcessId; ` +
    `startedAt = $_.CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH':'mm':'ss'.'fff'Z'") } }); ` +
    `ConvertTo-Json -InputObject $c -Compress } catch { Write-Output ('error: ' + $_.Exception.Message); exit 3 }`
  );
}

const processQueryOutputSchema = z.array(
  z.object({
    pid: z.number().int().positive(),
    name: z.string(),
    parentPid: z.number().int().nullable(),
    startedAt: z.iso.datetime({ offset: true }),
  }),
);

/** stdout of one query → processes, or null if it is not the expected JSON. */
export function parseProcessQueryOutput(stdout: string): ProcessInfo[] | null {
  const text = stdout.trim();
  if (text === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const parsed = processQueryOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.map((row) => ({
    pid: row.pid,
    name: row.name,
    parentPid: row.parentPid,
    startedAt: new Date(row.startedAt),
  }));
}

function unknownResult(reason: ProcessQueryFailure, detail: string): ProcessQueryResult {
  return { kind: 'unknown', reason, detail: detail.trim().slice(0, 500) };
}

async function runProcessQuery(
  wqlFilter: string | null,
  run: RunFileFn,
  timeoutMs: number,
): Promise<ProcessQueryResult> {
  let result: RunFileResult;
  try {
    result = await run(
      systemTool(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processQueryScript(wqlFilter)],
      { timeoutMs, maxOutputBytes: 1024 * 1024 },
    );
  } catch (error) {
    return unknownResult('failed', `powershell could not be started: ${toError(error).message}`);
  }
  if (result.timedOut) return unknownResult('timeout', `no answer within ${String(timeoutMs)} ms`);
  if (result.exitCode !== 0) {
    return unknownResult('failed', `exit ${String(result.exitCode)}: ${result.stdout} ${result.stderr}`);
  }
  const processes = parseProcessQueryOutput(result.stdout);
  if (processes === null) return unknownResult('output', `unreadable output: ${result.stdout.slice(0, 200)}`);
  return { kind: 'ok', processes };
}

/**
 * Name, parent and start time of every process matching `filter` (Win32_Process via
 * PowerShell/CIM, also processes of other sessions) – ONE PowerShell call for many PIDs and their
 * children (R2-02: ≈ 2.8 s instead of 2 × 2.4 s per PID). Three-valued: a failure or timeout is
 * `unknown`, never an empty list. Meant for the orphan cleanup and the shutdown sweep, not for hot
 * paths. An empty filter answers `ok []` without a call.
 */
export async function queryProcesses(
  filter: ProcessFilter,
  options: ProcessQueryOptions = {},
): Promise<ProcessQueryResult> {
  const filters = processQueryFilters(filter);
  if (filters.length === 0) return { kind: 'ok', processes: [] };
  if ((options.platform ?? process.platform) !== 'win32') return unknownResult('unsupported', 'not Windows');
  const run = options.run ?? runFile;
  const timeoutMs = options.timeoutMs ?? PROCESS_QUERY_TIMEOUT_MS;
  const found = new Map<number, ProcessInfo>();
  for (const wqlFilter of filters) {
    const result = await runProcessQuery(wqlFilter, run, timeoutMs);
    if (result.kind === 'unknown') return result;
    for (const info of result.processes) found.set(info.pid, info);
  }
  return { kind: 'ok', processes: [...found.values()] };
}

/**
 * EVERY process of the machine in one CIM query (name, parent, start time; ≈ 1–3 s, three-valued
 * like queryProcesses). For the periodic snapshot of the session process trees (WP22-06, R2-03):
 * Win32_Process has no recursive filter, the descendants are computed with `descendantsOf`.
 */
export async function listProcesses(options: ProcessQueryOptions = {}): Promise<ProcessQueryResult> {
  if ((options.platform ?? process.platform) !== 'win32') return unknownResult('unsupported', 'not Windows');
  return runProcessQuery(null, options.run ?? runFile, options.timeoutMs ?? PROCESS_QUERY_TIMEOUT_MS);
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
 * Direct children of `pid` (Win32_Process with ParentProcessId = pid), e.g. for the shutdown sweep
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
