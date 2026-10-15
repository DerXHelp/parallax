/**
 * `PARALLAX_HOME/processes.json` (WP-13 §3.5.13, architecture §8, C.8): PID, image name and start
 * time of every running `claude.exe`, so the next server start can end orphans of a hard abort
 * (PID alone is reused – name + start time identify the process). WP-13-internal schema
 * `{schemaVersion: 1, records[]}` over `JsonStore` (WP-10: atomic, quarantine, a newer
 * schemaVersion aborts the start). `add` is durable (flushed: the record must survive a hard
 * abort), `remove` is debounced. `createMemoryProcessStore()` is the test double.
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { entryIdSchema, isoDateTimeSchema, type EntryId } from '@shared/common';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';

export const PROCESSES_FILE = 'processes.json';
export const PROCESSES_SCHEMA_VERSION = 1;

export const processRecordSchema = z.object({
  entryId: entryIdSchema,
  pid: z.number().int().positive(),
  /** Image name of the executable, e.g. `claude.exe` (compared case-insensitively). */
  image: z.string().min(1).max(260),
  /** Spawn time as seen by the backend (the orphan check allows a tolerance). */
  startedAt: isoDateTimeSchema,
});
export type ProcessRecord = z.infer<typeof processRecordSchema>;

export const processesFileSchema = z.object({
  schemaVersion: z.literal(PROCESSES_SCHEMA_VERSION),
  records: z.array(processRecordSchema),
});
export type ProcessesFile = z.infer<typeof processesFileSchema>;

export interface ProcessStore {
  load(): Promise<ProcessRecord[]>;
  /** Durable (flushed before it resolves). Replaces a record with the same entryId + pid. */
  add(record: ProcessRecord): Promise<void>;
  /** Debounced. */
  remove(entryId: EntryId, pid: number): void;
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
    load: async () => (await store.load()).records.map((r) => ({ ...r })),
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
}

export function createMemoryProcessStore(seed: readonly ProcessRecord[] = []): MemoryProcessStore {
  let records = seed.map((r) => processRecordSchema.parse(r));
  let adds = 0;
  let removes = 0;
  let flushes = 0;
  return {
    load: () => Promise.resolve(records.map((r) => ({ ...r }))),
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
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    records: () => records.map((r) => ({ ...r })),
    get adds() {
      return adds;
    },
    get removes() {
      return removes;
    },
    get flushes() {
      return flushes;
    },
  };
}
