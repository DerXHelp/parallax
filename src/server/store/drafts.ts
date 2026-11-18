import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  DRAFT_SCHEMA_VERSION,
  draftFileSchema,
  draftSchema,
  type Draft,
  type DraftFile,
} from '@shared/model';
import { DEFAULT_RETRY_DELAYS_MS, nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import type { DraftStore } from '../sync/ports';
import { entryDir } from './decisions';
import { fileTimestamp, type StoreWarningSink } from './jsonStore';

/**
 * WP-77 (ADR-210): the synchronized composer draft per entry, `entries/<entryId>/draft.json`
 * (`draftFileSchema`, `schemaVersion` 1). Writes are debounced per entry (default 500 ms) and atomic
 * (`writeFileAtomic`, no `.bak` – an old draft must never come back); `save(id, null)` deletes the
 * file, `remove(id)` deletes it at once. A corrupt file goes to quarantine
 * (`draft.json.corrupt-<time>-<rand>`, host warning STORE_CORRUPT_QUARANTINED) and counts as "no
 * draft". A file of a newer schema version is left untouched (R1-06): no draft, nothing written or
 * deleted for that entry, host warning STORE_VERSION_TOO_NEW – the server still starts (a draft is
 * no reason to stop it). Nothing is written before the file was read.
 */
export const DRAFT_FILE = 'draft.json';
/** Max delay between `save()` and the write. */
export const DRAFT_DEBOUNCE_MS = 500;

/** `PARALLAX_HOME/entries/<entryId>/draft.json` (the id is validated by `entryDir`). */
export function draftPath(home: string, entryId: EntryId): string {
  return path.join(entryDir(home, entryId), DRAFT_FILE);
}

export interface DraftStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: FsOps;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  logger?: Logger;
}

export interface FileDraftStore extends DraftStore {
  /** Writes pending drafts, then ignores further saves. */
  close(): Promise<void>;
}

interface Slot {
  /** Last value of the entry in memory (saved or read); undefined = not known yet. */
  known: Draft | null | undefined;
  /** Value still to write (null = delete); undefined = nothing pending. */
  pending: Draft | null | undefined;
  timer: NodeJS.Timeout | null;
  writing: Promise<void> | null;
  reading: Promise<Draft | null> | null;
  /** The file was read once (a newer one blocks the slot). */
  read: boolean;
  /** The file has a newer schema version: never written or deleted. */
  blocked: boolean;
  /** The last write failed (one host warning until a write succeeds). */
  failed: boolean;
}

/** The value read from the file – unless a save during the read came first (it wins). */
function settle(slot: Slot, read: Draft | null): Draft | null {
  if (slot.known === undefined) slot.known = read;
  return slot.known;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDraftStore(options: DraftStoreOptions): FileDraftStore {
  const fs = options.fs ?? nodeFsOps;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const debounceMs = options.debounceMs ?? DRAFT_DEBOUNCE_MS;
  const now = options.now ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ module: 'drafts' });
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
        file: DRAFT_FILE,
        quarantine: path.basename(target),
        reason,
        ...params,
      }),
    );
    log.warn({ quarantine: path.basename(target), reason }, 'draft file quarantined');
    try {
      await withFsRetry(() => fs.rename(file, target), retryDelays);
    } catch (error) {
      log.error({ err: error }, 'draft quarantine rename failed');
    }
  };

  /** Reads and checks the file; every problem ends as "no draft" (never rejects). */
  const readFile = async (entryId: EntryId, slot: Slot): Promise<Draft | null> => {
    const file = draftPath(options.home, entryId);
    let text: string;
    try {
      text = await withFsRetry(() => fs.readFile(file), retryDelays);
    } catch (error) {
      slot.read = true;
      if (fsErrorCode(error) !== 'ENOENT') log.warn({ err: error, entryId }, 'draft file unreadable');
      return null;
    }
    slot.read = true;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await quarantine(file, 'json');
      return null;
    }
    if (!isRecord(raw) || typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
      await quarantine(file, 'schema_version');
      return null;
    }
    if (raw.schemaVersion > DRAFT_SCHEMA_VERSION) {
      // R1-06: written by a newer Parallax – left as it is, nothing is written for this entry.
      slot.blocked = true;
      slot.pending = undefined;
      log.error(
        { entryId, version: raw.schemaVersion, supported: DRAFT_SCHEMA_VERSION },
        'draft file was written by a newer Parallax – left unchanged',
      );
      options.warnings?.add(
        makeError('STORE_VERSION_TOO_NEW', {
          file: DRAFT_FILE,
          version: raw.schemaVersion,
          supported: DRAFT_SCHEMA_VERSION,
        }),
      );
      return null;
    }
    const parsed = draftFileSchema.safeParse(raw);
    if (!parsed.success) {
      await quarantine(file, 'schema', {
        path: parsed.error.issues[0]?.path.map(String).join('.') ?? '',
      });
      return null;
    }
    return parsed.data.draft;
  };

  const readOnce = (entryId: EntryId, slot: Slot): Promise<Draft | null> => {
    slot.reading ??= readFile(entryId, slot).finally(() => {
      slot.reading = null;
    });
    return slot.reading;
  };

  const persist = async (entryId: EntryId, value: Draft | null): Promise<void> => {
    const file = draftPath(options.home, entryId);
    if (value === null) {
      try {
        await withFsRetry(() => fs.unlink(file), retryDelays);
      } catch (error) {
        if (fsErrorCode(error) !== 'ENOENT') throw error;
      }
      return;
    }
    const data: DraftFile = { schemaVersion: DRAFT_SCHEMA_VERSION, draft: value };
    await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { fs, retryDelaysMs: retryDelays });
  };

  /** One writer per entry: writes the newest pending value until nothing is left (never rejects). */
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
        log.error({ err: error, entryId }, 'draft write failed');
        if (!slot.failed) {
          options.warnings?.add(
            makeError('STORE_WRITE_FAILED', { file: DRAFT_FILE, reason: fsErrorCode(error) ?? 'unknown' }),
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
      // A write in progress picks the pending value up when it is done.
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
      const known = slot.known === undefined ? settle(slot, await readOnce(entryId, slot)) : slot.known;
      return known === null ? null : structuredClone(known);
    },

    save(entryId, draft) {
      if (closed) {
        log.warn({ entryId }, 'draft saved after close – ignored');
        return;
      }
      const value = draft === null ? null : draftSchema.parse(draft);
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
      slot.known = null;
      // A write in progress could bring the file back after the delete.
      if (slot.writing !== null) await slot.writing;
      if (!slot.read) await readOnce(entryId, slot);
      if (slot.blocked) return;
      await persist(entryId, null);
    },

    flush,

    async close() {
      await flush();
      closed = true;
    },
  };
}
