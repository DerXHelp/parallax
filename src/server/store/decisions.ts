import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { entryIdSchema, type EntryId } from '@shared/common';
import {
  DECISIONS_SCHEMA_VERSION,
  decisionRecordsFileSchema,
  type DecisionRecord,
  type DecisionRecordsFile,
} from '@shared/model';
import { fsErrorCode } from '../lib/paths';
import type { DecisionStore } from '../sync/ports';
import {
  JsonStore,
  nodeStoreFs,
  writeFileAtomic,
  type Migrations,
  type StoreFs,
  type StoreWarningSink,
} from './jsonStore';

/**
 * `entries/<entryId>/decisions.json` (decisionRecordsFileSchema; open records keep their
 * `decision` snapshot, R0-07) and plan versions `entries/<entryId>/plans/v<N>.md` (text exactly as
 * received from canUseTool). One JsonStore per entry, created lazily.
 */
export const ENTRIES_DIR = 'entries';
export const DECISIONS_FILE = 'decisions.json';
export const DECISIONS_MIGRATIONS: Migrations = {};

const planVersionSchema = z.number().int().positive();

/** `PARALLAX_HOME/entries/<entryId>` – the id is validated, so it can never escape the folder. */
export function entryDir(home: string, entryId: EntryId): string {
  return path.join(home, ENTRIES_DIR, entryIdSchema.parse(entryId));
}

export function planPath(home: string, entryId: EntryId, version: number): string {
  return path.join(entryDir(home, entryId), 'plans', `v${String(planVersionSchema.parse(version))}.md`);
}

export interface DecisionStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

export interface FileDecisionStore extends DecisionStore {
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createDecisionStore(options: DecisionStoreOptions): FileDecisionStore {
  const stores = new Map<EntryId, JsonStore<DecisionRecordsFile>>();

  const storeFor = (entryId: EntryId) => {
    let store = stores.get(entryId);
    if (store === undefined) {
      store = new JsonStore<DecisionRecordsFile>({
        file: path.join(entryDir(options.home, entryId), DECISIONS_FILE),
        schema: decisionRecordsFileSchema,
        version: DECISIONS_SCHEMA_VERSION,
        defaults: () => ({ schemaVersion: DECISIONS_SCHEMA_VERSION, records: [] }),
        migrations: DECISIONS_MIGRATIONS,
        debounceMs: options.debounceMs,
        warnings: options.warnings,
        fs: options.fs,
        retryDelaysMs: options.retryDelaysMs,
        logger: options.logger,
      });
      stores.set(entryId, store);
    }
    return store;
  };

  const flushAll = async () => {
    await Promise.all([...stores.values()].map((store) => store.flush()));
  };

  return {
    load: async (entryId): Promise<DecisionRecord[]> => (await storeFor(entryId).load()).records,
    save: (entryId, records) => {
      storeFor(entryId).set({ schemaVersion: DECISIONS_SCHEMA_VERSION, records });
    },
    savePlan: async (entryId, version, text) => {
      await writeFileAtomic(planPath(options.home, entryId, version), text, {
        fs: options.fs,
        retryDelaysMs: options.retryDelaysMs,
      });
    },
    readPlan: async (entryId, version) => {
      try {
        return await (options.fs ?? nodeStoreFs).readFile(planPath(options.home, entryId, version));
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    flush: flushAll,
    close: async () => {
      await Promise.all([...stores.values()].map((store) => store.close()));
    },
  };
}
