/**
 * Lock file `PARALLAX_HOME/server.lock.json` (C.8, ADR-015, architecture §5.1/§8): the server
 * writes it atomically after `listen` (WP-20 calls `writeServerLock`) and removes it on a regular
 * shutdown; the launcher reads it. Whether the server behind a lock file is alive is decided by
 * `GET /api/health` with the instance UUID (client.ts), never by the PID – PIDs are reused and a
 * crashed server leaves a stale file behind.
 *
 * Concurrency (R2-01): the launcher polls this file every 150 ms while the new server replaces it.
 * On Windows a rename over a file another process is reading fails with EPERM, a read during the
 * replace can fail the same way – both sides retry (`LOCK_RETRY_DELAYS_MS`, `withFsRetry`). Readers
 * never see a half-written file (temp file + rename); anything unreadable counts as `invalid`/
 * `missing`, never as an error.
 */
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  SERVER_LOCK_FILE,
  SERVER_LOCK_SCHEMA_VERSION,
  serverLockFileSchema,
  type LauncherToken,
  type ServerLockFile,
} from '@shared/http';
import { DEFAULT_RETRY_DELAYS_MS, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';

/**
 * Retry delays of the lock-file rename (≈ 4.6 s): longer than the stores' default, because a
 * launcher reads this file in a loop exactly while the server writes it, and a failed write means
 * the launcher waits for nothing.
 */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [...DEFAULT_RETRY_DELAYS_MS, 1_000, 1_000, 1_000];

/** `<home>\server.lock.json`. */
export function serverLockPath(home: string): string {
  return path.join(home, SERVER_LOCK_FILE);
}

export type LockReadResult =
  | { kind: 'missing' }
  /** Unreadable, no JSON or not `serverLockFileSchema` (e.g. another lock schema version): stale. */
  | { kind: 'invalid'; reason: 'unreadable' | 'json' | 'schema' }
  | { kind: 'ok'; lock: ServerLockFile };

/** Reads a whole text file; ENOENT must reject with an error whose `code` is `ENOENT`. */
export type ReadText = (file: string) => Promise<string>;

const readUtf8: ReadText = (file) => readFile(file, 'utf8');

/**
 * Reads and validates the lock file. Transient EPERM/EBUSY/EACCES (scanner, a replace in progress)
 * are retried; a missing file is `missing`, anything else unreadable `invalid` – never thrown.
 */
export async function readServerLock(home: string, read: ReadText = readUtf8): Promise<LockReadResult> {
  let text: string;
  try {
    text = await withFsRetry(() => read(serverLockPath(home)));
  } catch (error) {
    return fsErrorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid', reason: 'unreadable' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'json' };
  }
  const parsed = serverLockFileSchema.safeParse(json);
  return parsed.success ? { kind: 'ok', lock: parsed.data } : { kind: 'invalid', reason: 'schema' };
}

export interface WriteServerLockOptions {
  home: string;
  /** The port the server actually listens on (`app.server.address().port`, also with `--port=0`). */
  port: number;
  /** `createServerInstance()` (config.ts). */
  instance: { serverInstanceId: string; startedAt: string; buildId: string };
  /** `AuthService.launcherToken` (http/auth.ts). */
  launcherToken: LauncherToken;
  /** Default `process.pid`. */
  pid?: number;
  /** Test seam (default the real file system). */
  fs?: FsOps;
}

export interface ServerLockHandle {
  readonly file: string;
  readonly lock: ServerLockFile;
  /**
   * Removes the lock file if it still belongs to this server instance (another server may have
   * replaced it meanwhile). Idempotent; resolves true if this call removed the file. Never throws.
   */
  release(): Promise<boolean>;
}

/**
 * Writes `server.lock.json` atomically (temp file + rename, retried on EPERM/EBUSY/EACCES with
 * `LOCK_RETRY_DELAYS_MS`) – call it right after `listen` and before telling anybody the server is
 * ready. The file carries the launcher token (a secret; it lives in the user's profile like
 * `auth-secret.json` – see lib/homeAccess.ts for a home other users can read, R2-13).
 */
export async function writeServerLock(options: WriteServerLockOptions): Promise<ServerLockHandle> {
  const lock = serverLockFileSchema.parse({
    schemaVersion: SERVER_LOCK_SCHEMA_VERSION,
    pid: options.pid ?? process.pid,
    port: options.port,
    serverInstanceId: options.instance.serverInstanceId,
    launcherToken: options.launcherToken,
    startedAt: options.instance.startedAt,
    buildId: options.instance.buildId,
  });
  const file = serverLockPath(options.home);
  await writeFileAtomic(file, `${JSON.stringify(lock, null, 2)}\n`, {
    retryDelaysMs: LOCK_RETRY_DELAYS_MS,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
  });
  let released = false;
  return {
    file,
    lock,
    release: async () => {
      if (released) return false;
      released = true;
      const current = await readServerLock(options.home);
      if (current.kind !== 'ok' || current.lock.serverInstanceId !== lock.serverInstanceId) return false;
      try {
        await withFsRetry(() => unlink(file));
        return true;
      } catch {
        return false;
      }
    },
  };
}
