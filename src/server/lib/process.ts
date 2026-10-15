/**
 * Process helpers of the server (WP-11 owns this file; WP-13 and WP-21 use it). Every spawn goes
 * through here: always an argument array, `shell: false`, `windowsHide: true` (C.8, C.10), only
 * `.exe` files (C.7; a `.cmd`/`.bat` would need a shell). stderr of a piped child is always read
 * (F.16: a full stderr pipe blocks the child). Process trees end with `taskkill /PID <pid> /T /F`.
 * Contract of the exports: docs/architecture.md §2.2.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { logger } from './logger';

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

/** `code` of a Node system error (ENOENT, ESRCH, EPERM …). */
export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Throws for files that cannot run without a shell (`.cmd`, `.bat`, `.ps1` …). Allowed: `*.exe`
 * and bare names without an extension (libuv resolves those only to `.exe`/`.com` on the PATH).
 */
export function assertSpawnableFile(file: string): void {
  if (file === '' || file.includes('\0')) throw new TypeError('spawn: empty or invalid executable');
  const ext = path.win32.extname(file);
  if (ext !== '' && ext.toLowerCase() !== '.exe') {
    throw new TypeError(`spawn: only .exe files are started (no shell), got "${path.win32.basename(file)}"`);
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
    const child = spawn(systemTool('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
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
