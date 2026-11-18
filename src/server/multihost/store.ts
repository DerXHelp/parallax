/**
 * `<home>/multi-host.json` – role and listener settings (docs/wp/WP-76.md §C.2, ADR-224). A strict
 * file (atomic, no `.bak`: an old backup must not switch sharing back on). Missing → the defaults
 * (`off`); unusable → quarantined (host warning STORE_CORRUPT_QUARANTINED) and the defaults.
 * A file of a newer schema version or one that cannot be read is left alone: the defaults apply, a
 * host warning is raised and every save is refused (`blockedError`) until a restart.
 */
import path from 'node:path';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  DEFAULT_MULTI_HOST_CONFIG,
  MULTI_HOST_SCHEMA_VERSION,
  multiHostConfigSchema,
  multiHostFileSchema,
  type MultiHostConfig,
} from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { readStrictJson, writeStrictJson, type StrictFileOptions } from '../secure/strictJsonFile';
import { StoreVersionTooNewError } from '../store/jsonStore';

export const MULTI_HOST_FILE = 'multi-host.json';

export interface MultiHostStoreOptions extends StrictFileOptions {
  home: string;
}

export interface MultiHostStore {
  /** Never throws: problems are logged, raised as host warnings and leave the defaults. */
  load(): Promise<MultiHostConfig>;
  /** Throws when the store is blocked or the write failed. */
  save(config: MultiHostConfig): Promise<void>;
  /** Why saving is refused (newer schema version, unreadable file) – null when saving is allowed. */
  blockedError(): ErrorPayload | null;
}

export function createMultiHostStore(options: MultiHostStoreOptions): MultiHostStore {
  const file = path.join(options.home, MULTI_HOST_FILE);
  const log = (options.logger ?? rootLogger).child({ module: 'multiHostStore' });
  let blocked: ErrorPayload | null = null;
  return {
    blockedError: () => blocked,
    async load() {
      try {
        const read = await readStrictJson(file, multiHostFileSchema, MULTI_HOST_SCHEMA_VERSION, options);
        return read.kind === 'ok' ? read.value.config : { ...DEFAULT_MULTI_HOST_CONFIG };
      } catch (error) {
        blocked =
          error instanceof StoreVersionTooNewError
            ? error.error
            : makeError('STORE_WRITE_FAILED', { file: MULTI_HOST_FILE, reason: 'unreadable' });
        options.warnings?.add(blocked);
        log.error({ err: error }, 'multi-host.json could not be used – role off, saving blocked');
        return { ...DEFAULT_MULTI_HOST_CONFIG };
      }
    },
    async save(config) {
      if (blocked !== null) throw new Error('multi-host.json is blocked (unreadable or newer version)');
      await writeStrictJson(
        file,
        { schemaVersion: MULTI_HOST_SCHEMA_VERSION, config: multiHostConfigSchema.parse(config) },
        options,
      );
    },
  };
}
