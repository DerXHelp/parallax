/**
 * Connection log of the sharing computer (`<home>/remote/events.json`, docs/wp/WP-75.md §3.7,
 * ADR-225): ring buffer of at most LIMITS.remoteEventsMax rows, none older than
 * LIMITS.remoteEventsDays. Equal kinds from one address within a minute (from the row's first
 * occurrence) are merged into one row with a counter. New rows also go to the server log (merged
 * repeats do not, so a port scan cannot flood it). Written debounced through `JsonStore`.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import { LIMITS } from '@shared/common';
import {
  REJECTED_REMOTE_EVENT_KINDS,
  REMOTE_EVENTS_SCHEMA_VERSION,
  remoteEventsFileSchema,
  type RemoteEvent,
  type RemoteEventKind,
  type RemoteEventsFile,
} from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';
import { normalizeRemoteAddress, sanitizeClaimedName } from './addresses';
import type { RemoteEventInput, RemoteEventLog } from './ports';

export const REMOTE_DIR = 'remote';
export const EVENTS_FILE = 'events.json';
/** Equal kind + address within this time of a row's first occurrence → merged. */
export const EVENT_MERGE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const REJECTED: ReadonlySet<RemoteEventKind> = new Set(REJECTED_REMOTE_EVENT_KINDS);

export function isRejectedEventKind(kind: RemoteEventKind): boolean {
  return REJECTED.has(kind);
}

export interface RemoteEventLogOptions {
  home: string;
  now?: () => Date;
  warnings?: StoreWarningSink;
  logger?: Logger;
  fs?: StoreFs;
  debounceMs?: number;
  max?: number;
  days?: number;
}

export interface FileRemoteEventLog extends RemoteEventLog {
  /** Reads the file (once); records before that are kept and applied afterwards. */
  load(): Promise<void>;
  /** A row was added or the seen mark changed (not for merged repeats). */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

function emptyFile(): RemoteEventsFile {
  return { schemaVersion: REMOTE_EVENTS_SCHEMA_VERSION, events: [], seenAt: null };
}

export function createRemoteEventLog(options: RemoteEventLogOptions): FileRemoteEventLog {
  const now = options.now ?? (() => new Date());
  const max = options.max ?? LIMITS.remoteEventsMax;
  const maxAgeMs = (options.days ?? LIMITS.remoteEventsDays) * DAY_MS;
  const log = (options.logger ?? rootLogger).child({ module: 'remoteEvents' });
  const store = new JsonStore<RemoteEventsFile>({
    file: path.join(options.home, REMOTE_DIR, EVENTS_FILE),
    schema: remoteEventsFileSchema,
    version: REMOTE_EVENTS_SCHEMA_VERSION,
    defaults: emptyFile,
    debounceMs: options.debounceMs ?? 1_000,
    ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    logger: options.logger ?? rootLogger,
  });
  const listeners = new Set<() => void>();
  /** In memory until load() finished (a set() before the read would replace the file content). */
  let data: RemoteEventsFile | null = null;
  const pending: { event: RemoteEventInput; at: Date }[] = [];
  let loading: Promise<void> | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'event log listener failed');
      }
    }
  };

  const prune = (file: RemoteEventsFile, at: Date): RemoteEventsFile => {
    const limit = at.getTime() - maxAgeMs;
    let events = file.events.filter((event) => Date.parse(event.lastAt) >= limit);
    if (events.length > max) events = events.slice(events.length - max);
    return events.length === file.events.length ? file : { ...file, events };
  };

  /** Applies one observation; true when a new row was added. */
  const apply = (
    file: RemoteEventsFile,
    input: RemoteEventInput,
    at: Date,
  ): { file: RemoteEventsFile; added: boolean } => {
    const address = normalizeRemoteAddress(input.address);
    const claimedName = sanitizeClaimedName(input.claimedName);
    const atMs = at.getTime();
    const iso = at.toISOString();
    for (let index = file.events.length - 1; index >= 0; index -= 1) {
      const row = file.events[index];
      if (row === undefined) continue;
      if (atMs - Date.parse(row.at) >= EVENT_MERGE_MS) break;
      if (row.kind !== input.kind || row.address !== address) continue;
      const merged: RemoteEvent = {
        ...row,
        lastAt: atMs > Date.parse(row.lastAt) ? iso : row.lastAt,
        count: row.count + 1,
        port: input.port ?? row.port,
        claimedName: claimedName ?? row.claimedName,
      };
      const events = [...file.events];
      events[index] = merged;
      return { file: { ...file, events }, added: false };
    }
    const row: RemoteEvent = {
      id: `ev_${randomBytes(12).toString('hex')}`,
      kind: input.kind,
      at: iso,
      lastAt: iso,
      count: 1,
      address,
      port: input.port,
      claimedName,
      // WP-102: the detail of `manage_command`/`level_changed` comes with WP-107.
      detail: null,
      rejected: isRejectedEventKind(input.kind),
    };
    const fields = { kind: row.kind, address: row.address, port: row.port, claimedName: row.claimedName };
    if (row.rejected) log.warn(fields, 'remote access rejected');
    else log.info(fields, 'remote access event');
    return { file: prune({ ...file, events: [...file.events, row] }, at), added: true };
  };

  const commit = (next: RemoteEventsFile): void => {
    data = next;
    try {
      store.set(next);
    } catch (error) {
      log.error({ err: error }, 'event log not stored');
    }
  };

  return {
    load() {
      loading ??= store
        .load()
        .catch((error: unknown) => {
          // Unreadable or newer file: keep the log in memory only (the JsonStore stays blocked).
          log.error({ err: error }, 'event log could not be read');
          return emptyFile();
        })
        .then((file) => {
          let next = prune(file, now());
          let added = false;
          for (const entry of pending.splice(0)) {
            const result = apply(next, entry.event, entry.at);
            next = result.file;
            added ||= result.added;
          }
          if (next !== file) commit(next);
          else data = next;
          if (added) notify();
        });
      return loading;
    },
    record(event, at = now()) {
      if (data === null) {
        if (pending.length < max) pending.push({ event, at });
        return;
      }
      const result = apply(data, event, at);
      commit(result.file);
      if (result.added) notify();
    },
    list(onlyRejected) {
      const events = data?.events ?? [];
      const selected = onlyRejected ? events.filter((event) => event.rejected) : [...events];
      return selected.reverse();
    },
    unseenRejected() {
      if (data === null) return 0;
      const seenAt = data.seenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(data.seenAt);
      return data.events.filter((event) => event.rejected && Date.parse(event.lastAt) > seenAt).length;
    },
    markSeen(at = now()) {
      if (data === null) return;
      commit({ ...data, seenAt: at.toISOString() });
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async flush() {
      if (data !== null) await store.flush();
    },
    async close() {
      if (data !== null) await store.close();
    },
  };
}
