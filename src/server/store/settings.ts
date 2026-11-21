import path from 'node:path';
import type { Logger } from 'pino';
import {
  defaultShellFor,
  SETTINGS_SCHEMA_VERSION,
  settingsFileSchema,
  settingsPatchSchema,
  settingsSchema,
  shellKindsFor,
  type Settings,
  type SettingsFile,
} from '@shared/model';
import { pathFlavorOf } from '@shared/paths';
import type { SettingsStore } from '../sync/ports';
import { JsonStore, type Migrations, type StoreFs, type StoreWarningSink } from './jsonStore';

/** `PARALLAX_HOME/settings.json` (settingsFileSchema). */
export const SETTINGS_FILE = 'settings.json';

export const SETTINGS_MIGRATIONS: Migrations = {};

/**
 * WP-102/103: the settings as this host can use them – a `console.defaultShell` the host does not
 * offer (`shellKindsFor` of its flavor; e.g. the default `cmd` on Linux) becomes the platform's
 * default (`defaultShellFor`: `cmd` on Windows, `login` elsewhere). On Windows only a POSIX shell kind
 * changes (the default `cmd` is valid there). Returns `settings` itself when nothing changes.
 */
export function settingsForHost(settings: Settings, platform: NodeJS.Platform = process.platform): Settings {
  const flavor = pathFlavorOf(platform);
  if (shellKindsFor(flavor).includes(settings.console.defaultShell)) return settings;
  return { ...settings, console: { ...settings.console, defaultShell: defaultShellFor(flavor) } };
}

export interface SettingsStoreOptions {
  home: string;
  warnings?: StoreWarningSink;
  debounceMs?: number;
  fs?: StoreFs;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
  /** Whose shells are valid (`settingsForHost`; default `process.platform`, WP-103). */
  platform?: NodeJS.Platform;
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
  const platform = options.platform ?? process.platform;
  // The stored settings as loaded, and their host view (same object while the store is unchanged).
  let stored = store.get().settings;
  let view = settingsForHost(stored, platform);

  return {
    get: () => {
      const current = store.get().settings;
      if (current !== stored) {
        stored = current;
        view = settingsForHost(current, platform);
      }
      return view;
    },
    update: (patch) => {
      // Only the given fields change; a patch never injects defaults (settingsPatchSchema).
      const parsed = settingsPatchSchema.parse(patch);
      const entries: [string, unknown][] = Object.entries(parsed);
      const changes = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
      const next = settingsForHost(settingsSchema.parse({ ...store.get().settings, ...changes }), platform);
      return store.set({ schemaVersion: SETTINGS_SCHEMA_VERSION, settings: next }).settings;
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}
