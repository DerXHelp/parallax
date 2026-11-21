/**
 * JSON files of "Several computers" whose writes must be KNOWN to have happened (docs/wp/WP-76.md
 * §B.7 step 7.3, §B.8): key files, `remote/peer.json`, `multi-host.json`. Unlike `JsonStore`
 * (debounced, failures only as host warnings, `.bak` fallback) every write is awaited and throws, and
 * there is never a `.bak`: a backup could bring back a revoked coupling or an old key after a
 * quarantine. Unusable files are moved aside (`<file>.corrupt-<time>-<rand>`, host warning
 * STORE_CORRUPT_QUARANTINED) and count as missing; a file of a newer schema version is left alone
 * (`StoreVersionTooNewError`, R1-06).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { makeError } from '@shared/errors';
import { nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { StoreVersionTooNewError, fileTimestamp, type StoreWarningSink } from '../store/jsonStore';
import { secureFsOps } from './privateFiles';

export interface StrictFileOptions {
  fs?: FsOps;
  warnings?: StoreWarningSink;
  now?: () => Date;
  logger?: Logger;
  retryDelaysMs?: readonly number[];
}

export type StrictReadResult<T> =
  { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'quarantined'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Moves an unusable file aside and raises the host warning (a failed rename is logged). */
export async function quarantineStrictFile(
  file: string,
  reason: string,
  options: StrictFileOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFsOps;
  const log = (options.logger ?? rootLogger).child({ module: 'strictFile' });
  const now = (options.now ?? (() => new Date()))();
  const target = `${file}.corrupt-${fileTimestamp(now)}-${randomBytes(3).toString('hex')}`;
  options.warnings?.add(
    makeError('STORE_CORRUPT_QUARANTINED', {
      file: path.basename(file),
      quarantine: path.basename(target),
      reason,
    }),
  );
  log.warn({ file: path.basename(file), quarantine: path.basename(target), reason }, 'file quarantined');
  try {
    await withFsRetry(() => fs.rename(file, target), options.retryDelaysMs);
  } catch (error) {
    log.error({ err: error, file: path.basename(file) }, 'quarantine rename failed');
  }
}

/**
 * Reads and validates `file`. Missing → `missing`; unusable → quarantined; newer `schemaVersion` →
 * throws StoreVersionTooNewError (file untouched); other read errors (EPERM after retries …) throw.
 */
export async function readStrictJson<T>(
  file: string,
  schema: z.ZodType<T>,
  supportedVersion: number,
  options: StrictFileOptions = {},
): Promise<StrictReadResult<T>> {
  const fs = options.fs ?? nodeFsOps;
  let text: string;
  try {
    text = await withFsRetry(() => fs.readFile(file), options.retryDelaysMs);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    await quarantineStrictFile(file, 'json', options);
    return { kind: 'quarantined', reason: 'json' };
  }
  if (!isRecord(raw) || typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
    await quarantineStrictFile(file, 'schema_version', options);
    return { kind: 'quarantined', reason: 'schema_version' };
  }
  if (raw.schemaVersion > supportedVersion) {
    throw new StoreVersionTooNewError(file, raw.schemaVersion, supportedVersion);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    await quarantineStrictFile(file, 'schema', options);
    return { kind: 'quarantined', reason: 'schema' };
  }
  return { kind: 'ok', value: parsed.data };
}

/** Atomic write without `.bak`; throws on failure (nothing half-written is ever visible). */
export async function writeStrictJson(
  file: string,
  value: unknown,
  options: StrictFileOptions = {},
): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, {
    // POSIX (WP-107): these files hold keys or kAuth – 0600 in 0700 folders.
    fs: options.fs ?? secureFsOps(),
    backup: false,
    retryDelaysMs: options.retryDelaysMs,
  });
}

/** Deletes `file`; a missing file is fine, other errors throw. */
export async function removeStrictFile(file: string, options: StrictFileOptions = {}): Promise<void> {
  const fs = options.fs ?? nodeFsOps;
  try {
    await withFsRetry(() => fs.unlink(file), options.retryDelaysMs);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') throw error;
  }
}
