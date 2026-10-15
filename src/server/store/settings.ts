import path from 'node:path';
import type { Logger } from 'pino';
import {
  SETTINGS_SCHEMA_VERSION,
  settingsFileSchema,
  settingsPatchSchema,
  settingsSchema,
  type Settings,
  type SettingsFile,
} from '@shared/model';
import type { SettingsStore } from '../sync/ports';
import { JsonStore, type Migrations, type StoreFs, type StoreWarningSink } from './jsonStore';

/** `PARALLAX_HOME/settings.json` (settingsFileSchema). */
export const SETTINGS_FILE = 'settings.json';

export const SETTINGS_MIGRATIONS: Migrations = {};

export interface SettingsStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

export interface OpenSettingsStore extends SettingsStore {
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function openSettingsStore(options: SettingsStoreOptions): Promise<OpenSettingsStore> {
  const store = new JsonStore<SettingsFile>({
    file: path.join(options.home, SETTINGS_FILE),
    schema: settingsFileSchema,
    version: SETTINGS_SCHEMA_VERSION,
    defaults: () => ({ schemaVersion: SETTINGS_SCHEMA_VERSION, settings: settingsSchema.parse({}) }),
    migrations: SETTINGS_MIGRATIONS,
    debounceMs: options.debounceMs,
    warnings: options.warnings,
    fs: options.fs,
    retryDelaysMs: options.retryDelaysMs,
    logger: options.logger,
  });
  await store.load();

  return {
    get: () => store.get().settings,
    update: (patch) => {
      // Only the given fields change; a patch never injects defaults (settingsPatchSchema).
      const parsed = settingsPatchSchema.parse(patch);
      const entries: [string, unknown][] = Object.entries(parsed);
      const changes = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
      const next: Settings = settingsSchema.parse({ ...store.get().settings, ...changes });
      return store.set({ schemaVersion: SETTINGS_SCHEMA_VERSION, settings: next }).settings;
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}
