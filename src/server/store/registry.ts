import path from 'node:path';
import type { Logger } from 'pino';
import { entryIdSchema, type EntryId } from '@shared/common';
import {
  REGISTRY_SCHEMA_VERSION,
  entrySchema,
  registryFileSchema,
  type Entry,
  type RegistryFile,
} from '@shared/model';
import type { RegistryStore } from '../sync/ports';
import { JsonStore, type Migrations, type StoreFs, type StoreWarningSink } from './jsonStore';

/** `PARALLAX_HOME/sessions.json` (registryFileSchema). */
export const REGISTRY_FILE = 'sessions.json';

/** Migrations of sessions.json (none yet: schema version 1). */
export const REGISTRY_MIGRATIONS: Migrations = {};

export interface RegistryStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

export interface OpenRegistryStore extends RegistryStore {
  close(): Promise<void>;
}

/** Loads sessions.json (quarantine/backup/migration via JsonStore) and serves it from memory. */
export async function openRegistryStore(options: RegistryStoreOptions): Promise<OpenRegistryStore> {
  const store = new JsonStore<RegistryFile>({
    file: path.join(options.home, REGISTRY_FILE),
    schema: registryFileSchema,
    version: REGISTRY_SCHEMA_VERSION,
    defaults: () => ({ schemaVersion: REGISTRY_SCHEMA_VERSION, entries: [] }),
    migrations: REGISTRY_MIGRATIONS,
    debounceMs: options.debounceMs,
    warnings: options.warnings,
    fs: options.fs,
    retryDelaysMs: options.retryDelaysMs,
    logger: options.logger,
  });
  const file = await store.load();
  const entries = new Map<EntryId, Entry>(file.entries.map((entry) => [entry.id, entry]));

  const persist = () => {
    store.set({ schemaVersion: REGISTRY_SCHEMA_VERSION, entries: [...entries.values()] });
  };

  return {
    list: () => [...entries.values()],
    get: (id) => entries.get(id),
    upsert: (entry) => {
      // Validated at the boundary; the parsed entry (defaults applied) is what gets stored.
      const parsed = entrySchema.parse(entry);
      entries.set(parsed.id, parsed);
      persist();
    },
    remove: (id) => {
      entryIdSchema.parse(id);
      if (entries.delete(id)) persist();
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}
