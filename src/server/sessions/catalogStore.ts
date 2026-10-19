/**
 * Persistent per-profile catalogs of the engine (ADR-114, architecture §4/§8):
 * `PARALLAX_HOME/model-catalogs.json` (the last `supportedModels()` answer per profile, so the model
 * picker of a dormant entry is filled after a server restart) and `PARALLAX_HOME/account-limits.json`
 * (the last rate-limit info per profile, only from subscription sessions – `apiKeySource 'none'`).
 * Server-internal schemas (no contract), `schemaVersion: 1`, both over `JsonStore` (WP-10: atomic,
 * `.bak`, quarantine of corrupt files, a NEWER schemaVersion aborts the start like ADR-020).
 * `createMemoryCatalogStore()` is the test double and the manager's default when no store is passed
 * (engine tests); compose.ts passes the file store (`openCatalogStore`).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isoDateTimeSchema, type ProfileId } from '@shared/common';
import { modelOptionSchema, rateLimitInfoSchema, type ModelOption, type RateLimitInfo } from '@shared/model';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';

export const MODEL_CATALOGS_FILE = 'model-catalogs.json';
export const ACCOUNT_LIMITS_FILE = 'account-limits.json';
export const CATALOGS_SCHEMA_VERSION = 1;

/**
 * One profile's model catalog: the options shown, alias → resolved model, time of the answer and
 * the profile it belongs to.
 */
export const storedModelCatalogSchema = z.object({
  options: z.array(modelOptionSchema),
  /** value → resolvedModel (matches the actual model of a dormant entry to its row). */
  resolved: z.record(z.string(), z.string()).default({}),
  at: isoDateTimeSchema,
  /**
   * CR2-05: `profileCacheKey` (manager.ts, ADR-102) of the profile when the catalog was stored; the
   * next start ignores a catalog whose profile differs now (profiles.json changed while the server
   * was down – another executable or config dir is another account). null = unknown (older file).
   */
  profileKey: z.string().nullable().default(null),
});
export type StoredModelCatalog = z.infer<typeof storedModelCatalogSchema>;

export const modelCatalogsFileSchema = z.object({
  schemaVersion: z.literal(CATALOGS_SCHEMA_VERSION),
  /** Profile id → catalog. */
  profiles: z.record(z.string(), storedModelCatalogSchema),
});
export type ModelCatalogsFile = z.infer<typeof modelCatalogsFileSchema>;

export const accountLimitsFileSchema = z.object({
  schemaVersion: z.literal(CATALOGS_SCHEMA_VERSION),
  /** Profile id → last rate-limit info of a subscription session. */
  profiles: z.record(z.string(), rateLimitInfoSchema),
});
export type AccountLimitsFile = z.infer<typeof accountLimitsFileSchema>;

export interface CatalogStore {
  /** Model catalogs per profile (copies). */
  models(): Record<ProfileId, StoredModelCatalog>;
  /** Debounced write. */
  setModels(
    profileId: ProfileId,
    catalog: {
      options: ModelOption[];
      resolved: Record<string, string>;
      at: string;
      profileKey: string | null;
    },
  ): void;
  /** Account limits per profile (copies). */
  limits(): Record<ProfileId, RateLimitInfo>;
  /** Debounced write. */
  setLimit(profileId: ProfileId, info: RateLimitInfo): void;
  /** ADR-102 (WP-34): the profile changed or was deleted – its catalog is dropped (debounced write). */
  removeModels(profileId: ProfileId): void;
  /** ADR-102 (WP-34): the profile was deleted – its limits are dropped (debounced write). */
  removeLimit(profileId: ProfileId): void;
  flush(): Promise<void>;
}

/** The record without `key` (no dynamic delete). */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

export interface OpenCatalogStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  logger?: Logger;
}

/**
 * Loads both files (JsonStore rules). Rejects with `StoreVersionTooNewError` when one of them was
 * written by a newer Parallax – the composition maps it to exit code 3 like every other store.
 */
export async function openCatalogStore(
  options: OpenCatalogStoreOptions,
): Promise<CatalogStore & { close(): Promise<void> }> {
  const common = {
    version: CATALOGS_SCHEMA_VERSION,
    debounceMs: options.debounceMs,
    warnings: options.warnings,
    fs: options.fs,
    logger: options.logger,
  };
  const models = new JsonStore<ModelCatalogsFile>({
    ...common,
    file: path.join(options.home, MODEL_CATALOGS_FILE),
    schema: modelCatalogsFileSchema,
    defaults: () => ({ schemaVersion: CATALOGS_SCHEMA_VERSION, profiles: {} }),
  });
  const limits = new JsonStore<AccountLimitsFile>({
    ...common,
    file: path.join(options.home, ACCOUNT_LIMITS_FILE),
    schema: accountLimitsFileSchema,
    defaults: () => ({ schemaVersion: CATALOGS_SCHEMA_VERSION, profiles: {} }),
  });
  await models.load();
  await limits.load();
  return {
    models: () => structuredClone(models.get().profiles),
    setModels: (profileId, catalog) => {
      models.update((file) => ({ ...file, profiles: { ...file.profiles, [profileId]: catalog } }));
    },
    limits: () => structuredClone(limits.get().profiles),
    setLimit: (profileId, info) => {
      limits.update((file) => ({ ...file, profiles: { ...file.profiles, [profileId]: info } }));
    },
    removeModels: (profileId) => {
      if (!(profileId in models.get().profiles)) return;
      models.update((file) => ({ ...file, profiles: without(file.profiles, profileId) }));
    },
    removeLimit: (profileId) => {
      if (!(profileId in limits.get().profiles)) return;
      limits.update((file) => ({ ...file, profiles: without(file.profiles, profileId) }));
    },
    flush: async () => {
      await Promise.all([models.flush(), limits.flush()]);
    },
    close: async () => {
      await Promise.all([models.close(), limits.close()]);
    },
  };
}

export interface MemoryCatalogStore extends CatalogStore {
  readonly flushes: number;
}

/** In-memory double with the same validation (the stored values must survive the file schema). */
export function createMemoryCatalogStore(
  seed: { models?: Record<string, StoredModelCatalog>; limits?: Record<string, RateLimitInfo> } = {},
): MemoryCatalogStore {
  let models = modelCatalogsFileSchema.parse({ schemaVersion: 1, profiles: seed.models ?? {} }).profiles;
  let limits = accountLimitsFileSchema.parse({ schemaVersion: 1, profiles: seed.limits ?? {} }).profiles;
  let flushes = 0;
  return {
    models: () => structuredClone(models),
    setModels: (profileId, catalog) => {
      models = { ...models, [profileId]: storedModelCatalogSchema.parse(catalog) };
    },
    limits: () => structuredClone(limits),
    setLimit: (profileId, info) => {
      limits = { ...limits, [profileId]: rateLimitInfoSchema.parse(info) };
    },
    removeModels: (profileId) => {
      models = without(models, profileId);
    },
    removeLimit: (profileId) => {
      limits = without(limits, profileId);
    },
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    get flushes() {
      return flushes;
    },
  };
}
