import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { makeError, type ErrorCode, type ErrorPayload } from '@shared/errors';
import type { HostWarning } from '@shared/model';
import { DEFAULT_RETRY_DELAYS_MS, nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import type { StoreWarnings } from '../sync/ports';

/**
 * `JsonStore<T>` (B "Persistenz", architecture §8): zod schema + `schemaVersion` + migrations;
 * atomic writes via temp file + rename with retry on EPERM/EBUSY (virus scanner, indexer);
 * `.bak` copy of the previous version; corrupt files go to quarantine (`<file>.corrupt-<time>`)
 * with a host warning `STORE_CORRUPT_QUARANTINED`; one writer per file, debounced writes.
 *
 * A file with a NEWER `schemaVersion` (written by a newer Parallax, e.g. another checkout on the
 * same PARALLAX_HOME) is never moved, migrated or overwritten: `load()` rejects with
 * `StoreVersionTooNewError` (`STORE_VERSION_TOO_NEW`), the store stays blocked and the server start
 * is aborted ("update Parallax"; R1-06, ADR-020). Nothing is ever written before the file was read.
 */

/** Process exit code of a server start aborted by STORE_VERSION_TOO_NEW (WP-20 main.ts, WP-21 launcher). */
export const STORE_VERSION_TOO_NEW_EXIT_CODE = 3;

/**
 * A store file was written by a newer Parallax (`schemaVersion` > supported). The file is left
 * unchanged; the caller aborts the server start and shows `message` (English, "update Parallax").
 */
export class StoreVersionTooNewError extends Error {
  /** STORE_VERSION_TOO_NEW {file, version, supported}. */
  readonly error: ErrorPayload;
  /** Absolute path of the file (unchanged on disk). */
  readonly file: string;

  constructor(file: string, version: number, supported: number) {
    super(
      `${path.basename(file)} was written by a newer Parallax (schemaVersion ${String(version)}, this build ` +
        `supports ${String(supported)}) – update Parallax. The file was left unchanged: ${file}`,
    );
    this.name = 'StoreVersionTooNewError';
    this.file = file;
    this.error = makeError('STORE_VERSION_TOO_NEW', { file: path.basename(file), version, supported });
  }
}

// =====================================================================================
// File system seam, retry and atomic replace: lib/fs.ts (R2-10), re-exported here unchanged
// =====================================================================================

/** File system seam of the stores (tests inject failures, e.g. EPERM on rename). */
export type StoreFs = FsOps;
export const nodeStoreFs: StoreFs = nodeFsOps;
export { DEFAULT_RETRY_DELAYS_MS, withFsRetry, writeFileAtomic };

/** `20261015T080000123Z` – a timestamp that is a valid Windows file name part. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

// =====================================================================================
// Store warnings (host warnings, B "Quarantäne korrupter Dateien + UI-Warnung")
// =====================================================================================

export interface StoreWarningSink {
  add(error: ErrorPayload): void;
}

export interface StoreWarningRegistry extends StoreWarnings, StoreWarningSink {
  /** Called after every new warning (the engine republishes `host.state`). Returns unsubscribe. */
  onChange(listener: (warnings: HostWarning[]) => void): () => void;
}

export function createStoreWarnings(
  options: { now?: () => Date; logger?: Logger } = {},
): StoreWarningRegistry {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? rootLogger.child({ module: 'store' });
  const warnings: HostWarning[] = [];
  const listeners = new Set<(warnings: HostWarning[]) => void>();
  let counter = 0;
  return {
    list: () => [...warnings],
    add: (error) => {
      counter += 1;
      const warning: HostWarning = { id: `store-${String(counter)}`, error, at: now().toISOString() };
      warnings.push(warning);
      log.warn({ warning }, 'store warning');
      for (const listener of listeners) listener([...warnings]);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// =====================================================================================
// JsonStore
// =====================================================================================

export interface Versioned {
  schemaVersion: number;
}

/** `migrations[n]` turns a raw file of version n into version n + 1 (raw JSON → raw JSON). */
export type Migrations = Readonly<Partial<Record<number, (raw: Record<string, unknown>) => unknown>>>;

export interface JsonStoreOptions<T extends Versioned> {
  /** Absolute file path. */
  file: string;
  /** Schema of the whole file (including `schemaVersion`). */
  schema: z.ZodType<T>;
  /** Current schema version (written files carry it). */
  version: number;
  /** Content when the file does not exist (or nothing usable is left after quarantine). */
  defaults: () => T;
  migrations?: Migrations;
  /** Max delay between `set()` and the write (default 200 ms). */
  debounceMs?: number;
  /**
   * Copy the previous version to `<file>.bak` before each write (default true). False for secrets
   * whose old value must not come back from a backup (auth secret after a rotation, R1-11).
   */
  backup?: boolean;
  warnings?: StoreWarningSink;
  fs?: StoreFs;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  logger?: Logger;
}

interface LoadIssue {
  code: ErrorCode;
  reason: string;
  params?: Record<string, string | number>;
}

class LoadProblem extends Error {
  readonly issue: LoadIssue;

  constructor(issue: LoadIssue) {
    super(issue.reason);
    this.issue = issue;
  }
}

/** Thrown by `parse` for a file of a newer schema version (never quarantined). */
class NewerVersion extends Error {
  constructor(readonly version: number) {
    super('newer_version');
  }
}

type FileRead<T> =
  | { kind: 'ok'; value: T; migrated: boolean }
  | { kind: 'missing' }
  | { kind: 'problem'; issue: LoadIssue }
  | { kind: 'newer'; version: number };

/** unread → reading → done; `blocked` = newer schema version (load rejects, nothing is written). */
type ReadState = 'unread' | 'reading' | 'done' | 'blocked';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class JsonStore<T extends Versioned> {
  private readonly options: JsonStoreOptions<T>;
  private readonly fs: StoreFs;
  private readonly log: Logger;
  private value: T | null = null;
  private loading: Promise<T> | null = null;
  private readState: ReadState = 'unread';
  /** Set when the file (or its .bak) has a newer schema version: the store refuses everything. */
  private blockedBy: StoreVersionTooNewError | null = null;
  /** Unsaved changes. */
  private dirty = false;
  /** The last write failed: wait for the next set()/flush() instead of retrying in a loop. */
  private failed = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private closed = false;

  constructor(options: JsonStoreOptions<T>) {
    this.options = options;
    this.fs = options.fs ?? nodeStoreFs;
    this.log = (options.logger ?? rootLogger).child({
      module: 'jsonStore',
      file: path.basename(options.file),
    });
  }

  get file(): string {
    return this.options.file;
  }

  /**
   * Reads the file once (later calls return the cached value). Rejects for unreadable files and
   * with `StoreVersionTooNewError` for a file of a newer schema version (the store stays blocked).
   */
  load(): Promise<T> {
    if (this.blockedBy !== null) return Promise.reject(this.blockedBy);
    if (this.readState === 'done' && this.value !== null) return Promise.resolve(this.value);
    if (this.loading === null) {
      this.readState = 'reading';
      this.loading = this.readValue().then(
        ({ value, persist }) => {
          this.loading = null;
          this.readState = 'done';
          // A set() before/during the read wins over the file content.
          if (this.value === null) {
            this.value = value;
            if (persist) this.markDirty();
          } else if (this.dirty) {
            this.scheduleWrite();
          }
          return this.value;
        },
        (error: unknown) => {
          if (error instanceof StoreVersionTooNewError) this.block(error);
          throw error;
        },
      );
    }
    return this.loading;
  }

  /** Current value; throws when neither load() finished nor set() was called (or the store is blocked). */
  get(): T {
    if (this.blockedBy !== null) throw this.blockedBy;
    if (this.value === null) throw new Error(`JsonStore ${this.options.file} used before load()`);
    return this.value;
  }

  /** Validates (throws a ZodError on invalid data) and schedules a debounced write. */
  set(value: T): T {
    if (this.closed) throw new Error(`JsonStore ${this.options.file} is closed`);
    if (this.blockedBy !== null) throw this.blockedBy;
    const parsed = this.options.schema.parse(value);
    this.value = parsed;
    this.markDirty();
    return parsed;
  }

  update(fn: (current: T) => T): T {
    return this.set(fn(this.get()));
  }

  /**
   * Writes pending changes now and waits for the write (a failure becomes a host warning). An
   * unread file is read first; a blocked or unreadable store writes nothing.
   */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.dirty && this.readState !== 'done') {
      await this.load().catch(() => undefined);
      this.clearTimer();
    }
    if (this.writing !== null) await this.writing;
    if (this.dirty) {
      this.startWrite();
      if (this.writing !== null) await this.writing;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  // ---- writing (single writer) ----

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Newer schema version: refuse reads and writes from now on, drop pending changes. */
  private block(error: StoreVersionTooNewError): void {
    this.blockedBy = error;
    this.readState = 'blocked';
    this.clearTimer();
    this.dirty = false;
    this.value = null;
    this.log.error(
      { file: error.file, ...error.error.params },
      'store file was written by a newer Parallax – update Parallax (file left unchanged)',
    );
    this.options.warnings?.add(error.error);
  }

  private markDirty(): void {
    this.dirty = true;
    this.failed = false;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.timer !== null || this.writing !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startWrite();
    }, this.options.debounceMs ?? 200);
    this.timer.unref();
  }

  private startWrite(): void {
    const value = this.value;
    if (value === null || !this.dirty || this.writing !== null) return;
    if (this.readState !== 'done') {
      // Never write before the file was read: it may be newer (R1-06). The write follows the read.
      if (this.readState === 'unread') void this.load().catch(() => undefined);
      return;
    }
    this.dirty = false;
    const data = `${JSON.stringify(value, null, 2)}\n`;
    this.writing = writeFileAtomic(this.options.file, data, {
      fs: this.fs,
      backup: this.options.backup ?? true,
      retryDelaysMs: this.options.retryDelaysMs,
    })
      .catch((error: unknown) => {
        // Keep the data in memory; the next set()/flush() tries again.
        this.dirty = true;
        this.failed = true;
        this.log.error({ err: error }, 'store write failed');
        this.options.warnings?.add(
          makeError('STORE_WRITE_FAILED', {
            file: path.basename(this.options.file),
            reason: fsErrorCode(error) ?? 'unknown',
          }),
        );
      })
      .finally(() => {
        this.writing = null;
        // Changes made during the write are written with the next debounce.
        if (this.dirty && !this.failed && !this.closed) this.scheduleWrite();
      });
  }

  // ---- reading ----

  private async readValue(): Promise<{ value: T; persist: boolean }> {
    const main = await this.readFile(this.options.file);
    if (main.kind === 'ok') return { value: main.value, persist: main.migrated };
    if (main.kind === 'newer')
      throw new StoreVersionTooNewError(this.options.file, main.version, this.options.version);
    if (main.kind === 'problem') await this.quarantine(this.options.file, main.issue);

    // Missing or quarantined: fall back to the backup of the previous version.
    const bakFile = `${this.options.file}.bak`;
    const bak = await this.readFile(bakFile);
    if (bak.kind === 'ok') {
      this.log.warn({ restoredFrom: 'bak' }, 'store restored from backup');
      return { value: bak.value, persist: true };
    }
    if (bak.kind === 'newer') throw new StoreVersionTooNewError(bakFile, bak.version, this.options.version);
    if (bak.kind === 'problem') await this.quarantine(bakFile, bak.issue);
    return { value: this.options.defaults(), persist: main.kind === 'problem' };
  }

  private async readFile(file: string): Promise<FileRead<T>> {
    let text: string;
    try {
      text = await withFsRetry(() => this.fs.readFile(file), this.options.retryDelaysMs);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
    try {
      const { value, migrated } = this.parse(text);
      return { kind: 'ok', value, migrated };
    } catch (error) {
      if (error instanceof LoadProblem) return { kind: 'problem', issue: error.issue };
      if (error instanceof NewerVersion) return { kind: 'newer', version: error.version };
      throw error;
    }
  }

  private parse(text: string): { value: T; migrated: boolean } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new LoadProblem({ code: 'STORE_CORRUPT_QUARANTINED', reason: 'json' });
    }
    if (!isRecord(raw) || typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) {
      throw new LoadProblem({ code: 'STORE_CORRUPT_QUARANTINED', reason: 'schema_version' });
    }
    let version = raw.schemaVersion;
    const target = this.options.version;
    // R1-06: never quarantine/overwrite a newer file – the start is aborted instead.
    if (version > target) throw new NewerVersion(version);
    let current: Record<string, unknown> = raw;
    const migrated = version < target;
    while (version < target) {
      const migrate = this.options.migrations?.[version];
      if (migrate === undefined) {
        throw new LoadProblem({
          code: 'STORE_MIGRATION_FAILED',
          reason: 'missing_migration',
          params: { version },
        });
      }
      let next: unknown;
      try {
        next = migrate(current);
      } catch {
        throw new LoadProblem({
          code: 'STORE_MIGRATION_FAILED',
          reason: 'migration_threw',
          params: { version },
        });
      }
      if (!isRecord(next) || next.schemaVersion !== version + 1) {
        throw new LoadProblem({
          code: 'STORE_MIGRATION_FAILED',
          reason: 'migration_result',
          params: { version },
        });
      }
      current = next;
      version += 1;
    }
    const parsed = this.options.schema.safeParse(current);
    if (!parsed.success) {
      throw new LoadProblem({
        code: migrated ? 'STORE_MIGRATION_FAILED' : 'STORE_CORRUPT_QUARANTINED',
        reason: 'schema',
        params: { path: parsed.error.issues[0]?.path.map(String).join('.') ?? '' },
      });
    }
    return { value: parsed.data, migrated };
  }

  /** Moves an unusable file aside and raises the host warning. */
  private async quarantine(file: string, issue: LoadIssue): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    const target = `${file}.corrupt-${fileTimestamp(now)}-${randomBytes(3).toString('hex')}`;
    this.options.warnings?.add(
      makeError(issue.code, {
        file: path.basename(file),
        quarantine: path.basename(target),
        reason: issue.reason,
        ...issue.params,
      }),
    );
    this.log.warn({ quarantine: path.basename(target), reason: issue.reason }, 'store file quarantined');
    try {
      await withFsRetry(() => this.fs.rename(file, target), this.options.retryDelaysMs);
    } catch (error) {
      this.log.error({ err: error }, 'quarantine rename failed');
    }
  }
}
