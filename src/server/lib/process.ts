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
      reject(error instanceof Error ? error : new Error(String(error)));
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

/** Identity of a running process, for the orphan cleanup on the next start (B, C.8). */
export interface ProcessInfo {
  pid: number;
  /** Image name, e.g. `claude.exe`. */
  name: string;
  parentPid: number | null;
  /** Creation time (UTC). PID + name + start time identify a process; PIDs alone are reused. */
  startedAt: Date;
}

const processInfoOutputSchema = z.object({
  name: z.string(),
  parentPid: z.number().int().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
});

/**
 * Name, parent and start time of `pid` (Win32_Process via PowerShell/CIM, also for processes of
 * other sessions), or null if it does not exist. Takes 1–3 s (PowerShell + CIM start) – meant for
 * the one-time orphan cleanup at server start, not for hot paths.
 */
export async function processInfo(
  pid: number,
  options: { timeoutMs?: number } = {},
): Promise<ProcessInfo | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  if (process.platform !== 'win32') return null;
  // `pid` is a validated integer, so the script text cannot be injected into. The date format has
  // no culture-dependent specifier (':' and '.' are quoted) and works in Constrained Language Mode.
  const script =
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'; ` +
    `if ($p) { @{ name = [string]$p.Name; parentPid = [int]$p.ParentProcessId; ` +
    `startedAt = $p.CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH':'mm':'ss'.'fff'Z'") } ` +
    `| ConvertTo-Json -Compress }`;
  const result = await runFile(
    systemTool(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: options.timeoutMs ?? 20_000, maxOutputBytes: 64 * 1024 },
  );
  const text = result.stdout.trim();
  if (result.exitCode !== 0 || text === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const parsed = processInfoOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    pid,
    name: parsed.data.name,
    parentPid: parsed.data.parentPid,
    startedAt: new Date(parsed.data.startedAt),
  };
}

/** Start time of `pid` or null (see processInfo). */
export async function processStartTime(pid: number): Promise<Date | null> {
  return (await processInfo(pid))?.startedAt ?? null;
}

const childProcessesOutputSchema = z.array(
  z.object({
    pid: z.number().int().positive(),
    name: z.string(),
    parentPid: z.number().int().nullable(),
    startedAt: z.iso.datetime({ offset: true }),
  }),
);

/**
 * Direct children of `pid` (Win32_Process with ParentProcessId = pid, like processInfo 1–3 s):
 * for the orphan cleanup after a hard abort, when only children of a dead `claude.exe` survive
 * (WP-13 §6 Nr. 7, §7). PIDs are reused – a caller must also compare the start time (a child is
 * never older than its parent). Non-Windows or failure: empty list.
 */
export async function childProcesses(
  pid: number,
  options: { timeoutMs?: number } = {},
): Promise<ProcessInfo[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${String(pid)}`);
  if (process.platform !== 'win32') return [];
  // Validated integer in the script (no injection); -InputObject @(...) keeps 0/1 results arrays (PS 5.1).
  const script =
    `$c = @(Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId = ${pid}' | ` +
    `Where-Object { $_.CreationDate } | ForEach-Object { @{ pid = [int]$_.ProcessId; name = [string]$_.Name; ` +
    `parentPid = [int]$_.ParentProcessId; ` +
    `startedAt = $_.CreationDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH':'mm':'ss'.'fff'Z'") } }); ` +
    `ConvertTo-Json -InputObject $c -Compress`;
  const result = await runFile(
    systemTool(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeoutMs: options.timeoutMs ?? 20_000, maxOutputBytes: 1024 * 1024 },
  );
  const text = result.stdout.trim();
  if (result.exitCode !== 0 || text === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  const parsed = childProcessesOutputSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.map((row) => ({
    pid: row.pid,
    name: row.name,
    parentPid: row.parentPid,
    startedAt: new Date(row.startedAt),
  }));
}
