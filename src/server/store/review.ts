import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  REVIEW_SCHEMA_VERSION,
  reviewCommentsSchema,
  reviewFileSchema,
  type ReviewComment,
  type ReviewFile,
} from '@shared/model';
import { DEFAULT_RETRY_DELAYS_MS, nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import type { ReviewStore } from '../sync/ports';
import { entryDir } from './decisions';
import { fileTimestamp, type StoreWarningSink } from './jsonStore';

/**
 * WP-111 (ADR-254): the review comments of an entry, `entries/<entryId>/review.json`
 * (`reviewFileSchema`, `schemaVersion` 1) – built like the draft store (store/drafts.ts, WP-77):
 * writes are debounced per entry (default 500 ms) and atomic (`writeFileAtomic`, no `.bak`); `save(id,
 * [])` deletes the file, `remove(id)` deletes it at once. A corrupt file goes to quarantine
 * (`review.json.corrupt-<time>-<rand>`, host warning STORE_CORRUPT_QUARANTINED) and counts as "no
 * comments". A file of a newer schema version is left untouched (R1-06): no comments, nothing written
 * or deleted for that entry, host warning STORE_VERSION_TOO_NEW – the server still starts. Nothing is
 * written before the file was read. Lists are copies (the caller never shares an array with the store).
 *
 * Composition (WP-117): `createReviewStore({home, warnings})`, opened with the other stores, passed
 * to the engine as `stores.review`; `close()` (flush, then ignore saves) with the store shutdown.
 */
export const REVIEW_FILE = 'review.json';
/** Max delay between `save()` and the write. */
export const REVIEW_DEBOUNCE_MS = 500;

/** `PARALLAX_HOME/entries/<entryId>/review.json` (the id is validated by `entryDir`). */
export function reviewPath(home: string, entryId: EntryId): string {
  return path.join(entryDir(home, entryId), REVIEW_FILE);
}

export interface ReviewStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: FsOps;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  logger?: Logger;
}

export interface FileReviewStore extends ReviewStore {
  /** Writes pending lists, then ignores further saves. */
  close(): Promise<void>;
}

type Comments = readonly ReviewComment[];

interface Slot {
  /** Last list of the entry in memory (saved or read); undefined = not known yet. */
  known: Comments | undefined;
  /** List still to write ([] = delete); undefined = nothing pending. */
  pending: Comments | undefined;
  timer: NodeJS.Timeout | null;
  writing: Promise<void> | null;
  reading: Promise<Comments> | null;
  /** The file was read once (a newer one blocks the slot). */
  read: boolean;
  /** The file has a newer schema version: never written or deleted. */
  blocked: boolean;
  /** The last write failed (one host warning until a write succeeds). */
  failed: boolean;
}

const NONE: Comments = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createReviewStore(options: ReviewStoreOptions): FileReviewStore {
  const fs = options.fs ?? nodeFsOps;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const debounceMs = options.debounceMs ?? REVIEW_DEBOUNCE_MS;
  const now = options.now ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ module: 'review' });
  const slots = new Map<EntryId, Slot>();
  let closed = false;

  const slotFor = (entryId: EntryId): Slot => {
    let slot = slots.get(entryId);
    if (slot === undefined) {
      slot = {
        known: undefined,
        pending: undefined,
        timer: null,
        writing: null,
        reading: null,
        read: false,
        blocked: false,
        failed: false,
      };
      slots.set(entryId, slot);
    }
    return slot;
  };

  const quarantine = async (file: string, reason: string, params: Record<string, string> = {}) => {
    const target = `${file}.corrupt-${fileTimestamp(now())}-${randomBytes(3).toString('hex')}`;
    options.warnings?.add(
      makeError('STORE_CORRUPT_QUARANTINED', {
        file: REVIEW_FILE,
        quarantine: path.basename(target),
        reason,
        ...params,
      }),
    );
    log.warn({ quarantine: path.basename(target), reason }, 'review file quarantined');
    try {
      await withFsRetry(() => fs.rename(file, target), retryDelays);
    } catch (error) {
      log.error({ err: error }, 'review quarantine rename failed');
    }
  };

  /** Reads and checks the file; every problem ends as "no comments" (never rejects). */
  const readFile = async (entryId: EntryId, slot: Slot): Promise<Comments> => {
    const file = reviewPath(options.home, entryId);
    let text: string;
    try {
      text = await withFsRetry(() => fs.readFile(file), retryDelays);
    } catch (error) {
      slot.read = true;
      if (fsErrorCode(error) !== 'ENOENT') log.warn({ err: error, entryId }, 'review file unreadable');
      return NONE;
    }
    slot.read = true;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await quarantine(file, 'json');
      return NONE;
    }
    if (!isRecord(raw) || typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
      await quarantine(file, 'schema_version');
      return NONE;
    }
    if (raw.schemaVersion > REVIEW_SCHEMA_VERSION) {
      // R1-06: written by a newer Parallax – left as it is, nothing is written for this entry.
      slot.blocked = true;
      slot.pending = undefined;
      log.error(
        { entryId, version: raw.schemaVersion, supported: REVIEW_SCHEMA_VERSION },
        'review file was written by a newer Parallax – left unchanged',
      );
      options.warnings?.add(
        makeError('STORE_VERSION_TOO_NEW', {
          file: REVIEW_FILE,
          version: raw.schemaVersion,
          supported: REVIEW_SCHEMA_VERSION,
        }),
      );
      return NONE;
    }
    const parsed = reviewFileSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(file, 'schema', {
        path: parsed.error.issues[0]?.path.map(String).join('.') ?? '',
      });
      return NONE;
    }
    return parsed.data.comments;
  };

  const readOnce = (entryId: EntryId, slot: Slot): Promise<Comments> => {
    slot.reading ??= readFile(entryId, slot).finally(() => {
      slot.reading = null;
    });
    return slot.reading;
  };

  const persist = async (entryId: EntryId, value: Comments): Promise<void> => {
    const file = reviewPath(options.home, entryId);
    if (value.length === 0) {
      try {
        await withFsRetry(() => fs.unlink(file), retryDelays);
      } catch (error) {
        if (fsErrorCode(error) !== 'ENOENT') throw error;
      }
      return;
    }
    const data: ReviewFile = { schemaVersion: REVIEW_SCHEMA_VERSION, comments: [...value] };
    await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { fs, retryDelaysMs: retryDelays });
  };

  /** One writer per entry: writes the newest pending list until nothing is left (never rejects). */
  const drain = async (entryId: EntryId, slot: Slot): Promise<void> => {
    // Never write before the file was read: it may be newer (R1-06).
    if (!slot.read) await readOnce(entryId, slot);
    while (slot.pending !== undefined && !slot.blocked) {
      const next = slot.pending;
      slot.pending = undefined;
      try {
        await persist(entryId, next);
        slot.failed = false;
      } catch (error) {
        // Kept for the next save/flush; no retry loop.
        slot.pending ??= next;
        log.error({ err: error, entryId }, 'review write failed');
        if (!slot.failed) {
          options.warnings?.add(
            makeError('STORE_WRITE_FAILED', { file: REVIEW_FILE, reason: fsErrorCode(error) ?? 'unknown' }),
          );
        }
        slot.failed = true;
        return;
      }
    }
  };

  const startWrite = (entryId: EntryId, slot: Slot): Promise<void> => {
    if (slot.writing === null) {
      const run = drain(entryId, slot);
      slot.writing = run;
      void run.finally(() => {
        if (slot.writing === run) slot.writing = null;
      });
    }
    return slot.writing;
  };

  const clearTimer = (slot: Slot): void => {
    if (slot.timer === null) return;
    clearTimeout(slot.timer);
    slot.timer = null;
  };

  const schedule = (entryId: EntryId, slot: Slot): void => {
    if (slot.timer !== null) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      // A write in progress picks the pending list up when it is done.
      void startWrite(entryId, slot);
    }, debounceMs);
    slot.timer.unref();
  };

  const flush = async (): Promise<void> => {
    const writes: Promise<void>[] = [];
    for (const [entryId, slot] of slots) {
      clearTimer(slot);
      if (slot.pending !== undefined) writes.push(startWrite(entryId, slot));
      else if (slot.writing !== null) writes.push(slot.writing);
    }
    await Promise.all(writes);
  };

  return {
    async load(entryId) {
      const slot = slotFor(entryId);
      if (slot.known === undefined) {
        const read = await readOnce(entryId, slot);
        // A save during the read came first (it wins).
        slot.known ??= read;
      }
      return structuredClone([...slot.known]);
    },

    save(entryId, comments) {
      if (closed) {
        log.warn({ entryId }, 'review saved after close – ignored');
        return;
      }
      const value = reviewCommentsSchema.parse(structuredClone([...comments]));
      const slot = slotFor(entryId);
      slot.known = value;
      if (slot.blocked) return;
      slot.pending = value;
      schedule(entryId, slot);
    },

    async remove(entryId) {
      const slot = slotFor(entryId);
      clearTimer(slot);
      slot.pending = undefined;
      slot.known = NONE;
      // A write in progress could bring the file back after the delete.
      if (slot.writing !== null) await slot.writing;
      if (!slot.read) await readOnce(entryId, slot);
      if (slot.blocked) return;
      await persist(entryId, NONE);
    },

    flush,

    async close() {
      await flush();
      closed = true;
    },
  };
}
