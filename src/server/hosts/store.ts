/**
 * `<home>/hosts.json` – the computers of a controlling computer (docs/wp/WP-75.md §4.3, WP-76 §C.5,
 * `hostsFileSchema`). A strict file like the other files of "Several computers" (atomic, every write
 * awaited, no `.bak`: a backup could bring back a removed computer and its coupling secret).
 *
 * Missing → no computers; unusable → quarantined (host warning STORE_CORRUPT_QUARANTINED) and no
 * computers. A file of a newer schema version or one that cannot be read is left alone: the list is
 * empty, a host warning is raised and every save is refused (`blockedError`) until a restart.
 */
import path from 'node:path';
import { makeError, type ErrorPayload } from '@shared/errors';
import { HOSTS_SCHEMA_VERSION, hostRecordSchema, hostsFileSchema, type HostRecord } from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { readStrictJson, writeStrictJson, type StrictFileOptions } from '../secure/strictJsonFile';
import { StoreVersionTooNewError } from '../store/jsonStore';

export const HOSTS_FILE = 'hosts.json';

export interface HostsStoreOptions extends StrictFileOptions {
  home: string;
}

export interface HostsStore {
  /** Never throws: problems are logged, raised as host warnings and give an empty list. */
  load(): Promise<HostRecord[]>;
  /** Throws when the store is blocked or the write failed (nothing half-written is visible). */
  save(hosts: readonly HostRecord[]): Promise<void>;
  /** Why saving is refused (newer schema version, unreadable file) – null when saving is allowed. */
  blockedError(): ErrorPayload | null;
}

export function createHostsStore(options: HostsStoreOptions): HostsStore {
  const file = path.join(options.home, HOSTS_FILE);
  const log = (options.logger ?? rootLogger).child({ module: 'hostsStore' });
  let blocked: ErrorPayload | null = null;
  return {
    blockedError: () => blocked,
    async load() {
      try {
        const read = await readStrictJson(file, hostsFileSchema, HOSTS_SCHEMA_VERSION, options);
        return read.kind === 'ok' ? read.value.hosts : [];
      } catch (error) {
        blocked =
          error instanceof StoreVersionTooNewError
            ? error.error
            : makeError('STORE_WRITE_FAILED', { file: HOSTS_FILE, reason: 'unreadable' });
        options.warnings?.add(blocked);
        log.error({ err: error }, 'hosts.json could not be used – no computers, saving blocked');
        return [];
      }
    },
    async save(hosts) {
      if (blocked !== null) throw new Error('hosts.json is blocked (unreadable or newer version)');
      await writeStrictJson(
        file,
        hostsFileSchema.parse({
          schemaVersion: HOSTS_SCHEMA_VERSION,
          hosts: hosts.map((host) => hostRecordSchema.parse(host)),
        }),
        options,
      );
    },
  };
}
