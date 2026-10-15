/**
 * File helpers of the server (R2-10; moved unchanged from store/jsonStore.ts, which re-exports them):
 * retry of transient Windows file errors and the atomic replace (temp file + rename). Used by the
 * stores (WP-10), the lock file and the launcher (WP-21).
 *
 * Windows: a virus scanner/indexer holding a file – or ANOTHER PROCESS READING the target while it
 * is replaced (MoveFileEx refuses to replace an open file) – makes rename/read/unlink fail briefly
 * with EPERM/EBUSY/EACCES (R2-01 probe: 483 of 608 renames against a reader in a tight loop).
 */
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './async';
import { fsErrorCode } from './paths';

/** File system seam (tests inject failures, e.g. EPERM on rename). */
export interface FsOps {
  readFile(file: string): Promise<string>;
  /** Writes and fsyncs a new file (truncates); strings as UTF-8. */
  writeFile(file: string, data: string | Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export const nodeFsOps: FsOps = {
  readFile: (file) => readFile(file, 'utf8'),
  writeFile: async (file, data) => {
    const handle = await open(file, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  copyFile: (from, to) => copyFile(from, to),
  unlink: (file) => unlink(file),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

/** Windows: a scanner/indexer/reader briefly holding the file makes rename/read fail with these codes. */
const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** True for EPERM/EBUSY/EACCES – worth a retry. */
export function isTransientFsError(error: unknown): boolean {
  const code = fsErrorCode(error);
  return code !== null && TRANSIENT_FS_CODES.has(code);
}

/** Delays between retries of a transient failure (≈ 1.6 s in total). */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100, 200, 400, 800];

/** Runs `op`, retrying transient EPERM/EBUSY/EACCES failures with the given delays. */
export async function withFsRetry<T>(
  op: () => Promise<T>,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (!isTransientFsError(error) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

let tmpCounter = 0;

/**
 * Atomic replace: write `<file>.<pid>.<n>.tmp` (fsync), optionally copy the current file to
 * `<file>.bak`, then rename over the target (retried on EPERM/EBUSY). The temp file is removed on
 * failure. Readers never see a half-written target. Used by JsonStore, the plan/blob files and the
 * lock file.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { fs?: FsOps; backup?: boolean; retryDelaysMs?: readonly number[] } = {},
): Promise<void> {
  const fs = options.fs ?? nodeFsOps;
  await fs.mkdir(path.dirname(file));
  tmpCounter += 1;
  const tmp = `${file}.${String(process.pid)}.${String(tmpCounter)}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    if (options.backup === true) {
      try {
        await withFsRetry(() => fs.copyFile(file, `${file}.bak`), options.retryDelaysMs);
      } catch (error) {
        if (fsErrorCode(error) !== 'ENOENT') throw error;
      }
    }
    await withFsRetry(() => fs.rename(tmp, file), options.retryDelaysMs);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
