/**
 * `PARALLAX_HOME/processes.json` (WP-13 §3.5.13, architecture §8, C.8): PID, image name and start
 * time of every running `claude.exe`, so the next server start can end orphans of a hard abort
 * (PID alone is reused – name + start time identify the process). WP-13-internal schema
 * `{schemaVersion: 1, records[]}` over `JsonStore` (WP-10: atomic, quarantine, a newer
 * schemaVersion aborts the start). `add` is durable (flushed: the record must survive a hard
 * abort), `remove` is debounced. `createMemoryProcessStore()` is the test double.
 *
 * WP22-06 (R2-03 follow-up): the heartbeat of the running server writes, per record, a snapshot of
 * the process tree below the claude.exe (`children`: PID, image, exact start time of every
 * descendant – Bash/PowerShell tools, MCP servers, their children) and the time of that snapshot
 * (`aliveAt`). Both fields have defaults (no version bump). After a hard abort the next start ends
 * only processes that still match a snapshot entry exactly (recovery.ts `cleanupOrphans`).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { entryIdSchema, isoDateTimeSchema, type EntryId } from '@shared/common';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';

export const PROCESSES_FILE = 'processes.json';
export const PROCESSES_SCHEMA_VERSION = 1;
/** Upper bound of the descendants kept per record (a runaway tool must not bloat the file). */
export const MAX_RECORDED_CHILDREN = 200;

/** One descendant of the claude.exe as the last snapshot saw it. */
export const processChildSchema = z.object({
  pid: z.number().int().positive(),
  image: z.string().min(1).max(260),
  /** Exact CIM creation time (the orphan check compares it exactly). */
  startedAt: isoDateTimeSchema,
});
export type ProcessChild = z.infer<typeof processChildSchema>;

export const processRecordSchema = z.object({
  entryId: entryIdSchema,
  pid: z.number().int().positive(),
  /** Image name of the executable, e.g. `claude.exe` (compared case-insensitively). */
  image: z.string().min(1).max(260),
  /** Spawn time as seen by the backend (the orphan check allows a tolerance). */
  startedAt: isoDateTimeSchema,
  /** Heartbeat: when the server last saw this process alive and took the `children` snapshot. */
  aliveAt: isoDateTimeSchema.nullable().default(null),
  /** Snapshot of the process tree below it at `aliveAt` (WP22-06). */
  children: z.array(processChildSchema).max(MAX_RECORDED_CHILDREN).default([]),
});
export type ProcessRecord = z.infer<typeof processRecordSchema>;
/** What callers pass in (`aliveAt`/`children` default to null/[]). */
export type ProcessRecordInput = z.input<typeof processRecordSchema>;

export const processesFileSchema = z.object({
  schemaVersion: z.literal(PROCESSES_SCHEMA_VERSION),
  records: z.array(processRecordSchema),
});
export type ProcessesFile = z.infer<typeof processesFileSchema>;

export interface ProcessSnapshot {
  aliveAt: string;
  children: readonly ProcessChild[];
}

export interface ProcessStore {
  load(): Promise<ProcessRecord[]>;
  /** Durable (flushed before it resolves). Replaces a record with the same entryId + pid. */
  add(record: ProcessRecordInput): Promise<void>;
  /** Debounced. */
  remove(entryId: EntryId, pid: number): void;
  /** Heartbeat (debounced): `aliveAt` + `children` of an existing record; unknown records are ignored. */
  heartbeat(entryId: EntryId, pid: number, snapshot: ProcessSnapshot): void;
  flush(): Promise<void>;
}

export interface OpenProcessStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  logger?: Logger;
}

function without(records: readonly ProcessRecord[], entryId: EntryId, pid: number): ProcessRecord[] {
  return records.filter((r) => !(r.entryId === entryId && r.pid === pid));
}

/** The records with the snapshot applied to entryId + pid, or null when there is no such record. */
function withSnapshot(
  records: readonly ProcessRecord[],
  entryId: EntryId,
  pid: number,
  snapshot: ProcessSnapshot,
): ProcessRecord[] | null {
  if (!records.some((r) => r.entryId === entryId && r.pid === pid)) return null;
  const children = snapshot.children.slice(0, MAX_RECORDED_CHILDREN).map((c) => processChildSchema.parse(c));
  const aliveAt = isoDateTimeSchema.parse(snapshot.aliveAt);
  return records.map((r) => (r.entryId === entryId && r.pid === pid ? { ...r, aliveAt, children } : r));
}

/** Loads processes.json (JsonStore rules: quarantine, `.bak`, newer version → StoreVersionTooNewError). */
export async function openProcessStore(
  options: OpenProcessStoreOptions,
): Promise<ProcessStore & { close(): Promise<void> }> {
  const store = new JsonStore<ProcessesFile>({
    file: path.join(options.home, PROCESSES_FILE),
    schema: processesFileSchema,
    version: PROCESSES_SCHEMA_VERSION,
    defaults: () => ({ schemaVersion: PROCESSES_SCHEMA_VERSION, records: [] }),
    debounceMs: options.debounceMs,
    warnings: options.warnings,
    fs: options.fs,
    logger: options.logger,
  });
  await store.load();
  const set = (records: ProcessRecord[]): void => {
    store.set({ schemaVersion: PROCESSES_SCHEMA_VERSION, records });
  };
  return {
    load: async () => (await store.load()).records.map((r) => ({ ...r, children: [...r.children] })),
    add: async (record) => {
      const parsed = processRecordSchema.parse(record);
      set([...without(store.get().records, parsed.entryId, parsed.pid), parsed]);
      await store.flush();
    },
    remove: (entryId, pid) => {
      const current = store.get().records;
      const next = without(current, entryId, pid);
      if (next.length !== current.length) set(next);
    },
    heartbeat: (entryId, pid, snapshot) => {
      const next = withSnapshot(store.get().records, entryId, pid, snapshot);
      if (next !== null) set(next);
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}

export interface MemoryProcessStore extends ProcessStore {
  /** Current records (copies). */
  records(): ProcessRecord[];
  readonly adds: number;
  readonly removes: number;
  readonly flushes: number;
  readonly heartbeats: number;
}

export function createMemoryProcessStore(seed: readonly ProcessRecordInput[] = []): MemoryProcessStore {
  let records = seed.map((r) => processRecordSchema.parse(r));
  let adds = 0;
  let removes = 0;
  let flushes = 0;
  let heartbeats = 0;
  return {
    load: () => Promise.resolve(records.map((r) => ({ ...r, children: [...r.children] }))),
    add: (record) => {
      const parsed = processRecordSchema.parse(record);
      records = [...without(records, parsed.entryId, parsed.pid), parsed];
      adds += 1;
      return Promise.resolve();
    },
    remove: (entryId, pid) => {
      const next = without(records, entryId, pid);
      if (next.length !== records.length) removes += 1;
      records = next;
    },
    heartbeat: (entryId, pid, snapshot) => {
      const next = withSnapshot(records, entryId, pid, snapshot);
      if (next === null) return;
      heartbeats += 1;
      records = next;
    },
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    records: () => records.map((r) => ({ ...r, children: [...r.children] })),
    get adds() {
      return adds;
    },
    get removes() {
      return removes;
    },
    get flushes() {
      return flushes;
    },
    get heartbeats() {
      return heartbeats;
    },
  };
}
