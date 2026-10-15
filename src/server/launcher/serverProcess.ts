/**
 * Starting the server invisibly in the background (Plan "Server-Betrieb", C.2, C.8):
 * `node.exe` (process.execPath, absolute) with the absolute path of `dist/server.js` – never via
 * `pnpm run` or a shell; `detached`, `windowsHide` (lib/process.ts), stdout/stderr appended to
 * `PARALLAX_HOME/logs/server.out.log` (crashes before the logger is up land there), `unref()` so the
 * launcher can exit. Plus the port probe for a clear "port in use" message before the start.
 */
import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { LOOPBACK_HOST } from '@shared/http';
import { spawnHidden } from '../lib/process';
import { withFsRetry } from '../lib/fs';

/** stdout/stderr of the detached server (the pino log itself rotates in `logs/parallax.*.log`). */
export const SERVER_OUT_LOG = 'server.out.log';
/** Rotated to `server.out.1.log` at the next start once larger than this. */
export const SERVER_OUT_LOG_MAX_BYTES = 1024 * 1024;

export function logsDir(home: string): string {
  return path.join(home, 'logs');
}

export function serverOutLogPath(home: string): string {
  return path.join(logsDir(home), SERVER_OUT_LOG);
}

export interface ServerExit {
  code: number | null;
  signal: string | null;
}

export interface StartedServer {
  pid: number;
  /** Resolves when the server process ends (only observed while the launcher still runs). */
  exited: Promise<ServerExit>;
  /** Size of server.out.log before this start: its output begins here (readServerOutput). */
  outLogOffset: number;
}

export interface StartServerOptions {
  /** Absolute node.exe (process.execPath). */
  nodePath: string;
  /** Absolute path of `dist/server.js` (tests: a fake server script). */
  serverScript: string;
  args: readonly string[];
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

async function rotateIfLarge(file: string): Promise<void> {
  try {
    if ((await stat(file)).size <= SERVER_OUT_LOG_MAX_BYTES) return;
    await rename(file, file.replace(/\.log$/, '.1.log'));
  } catch {
    // missing or locked: keep appending
  }
}

/** Spawns the server detached and hidden; resolves once the process exists (rejects on ENOENT …). */
export async function startServerProcess(options: StartServerOptions): Promise<StartedServer> {
  const outLog = serverOutLogPath(options.home);
  await mkdir(path.dirname(outLog), { recursive: true });
  await rotateIfLarge(outLog);
  const fd = openSync(outLog, 'a');
  const outLogOffset = fstatSync(fd).size;
  try {
    const child = spawnHidden(options.nodePath, [options.serverScript, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    const exited = new Promise<ServerExit>((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        if (child.pid === undefined) reject(new Error('server process has no pid'));
        else resolve(child.pid);
      });
    });
    child.unref();
    return { pid, exited, outLogOffset };
  } finally {
    // The child has its own handle; the launcher's copy must not stay open.
    closeSync(fd);
  }
}

/** Output of the server since `offset` (at most the last `maxBytes`), '' if none. Never throws. */
export async function readServerOutput(home: string, offset: number, maxBytes = 16 * 1024): Promise<string> {
  try {
    // A virus scanner may hold the just-closed file for a moment (EBUSY/EPERM): retried.
    const handle = await withFsRetry(() => open(serverOutLogPath(home), 'r'));
    try {
      const { size } = await handle.stat();
      const start = Math.max(offset, size - maxBytes, 0);
      if (start >= size) return '';
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export type PortProbe = 'free' | 'in_use' | 'denied';

/** Can a server bind 127.0.0.1:<port> right now? (`denied` = EACCES, e.g. a Windows-reserved range.) */
export function probePort(port: number): Promise<PortProbe> {
  return new Promise<PortProbe>((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE' ? 'in_use' : 'denied');
    });
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.close(() => {
        resolve('free');
      });
    });
  });
}
