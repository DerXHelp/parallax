/**
 * Backup of the stores when the build id changes (WP-86 86a, docs/wp/WP-83.md §8.4, §9.3 step 5).
 *
 * Before a server of another build starts, the launcher copies every JSON store file of
 * `STORE_SCHEMAS` (`kind: 'json'`, `backup: true`; per entry, with `.bak`) to
 * `<home>\backups\<from>-zu-<to>-<YYYYMMDD-HHmmss>\` (UTC) and records only the byte length of each
 * transcript (append-only, possibly large) in `backup.json`. The list comes from `STORE_SCHEMAS`
 * only – a list, not exclusions: blobs, attachments, `ui/`, `chrome/`, logs, `processes.json`,
 * `auth-secret.json` and older backups are never part of it.
 *
 * A backup is written to `backups\.partial-<name>` and renamed when complete: an aborted run never
 * leaves a half backup (a killed process leaves a `.partial-*`, removed by `pruneBackups` after an
 * hour). `restoreBackup` (rollback, WP-87) writes the files back, cuts transcripts to the saved
 * length and moves store files that are newer than the backup to `<backup>\newer\`. `listBackups`
 * and `findBackup` find the backup of a build change (WP-87: "back to <version>" with a backup).
 *
 * Paths follow the rules of the host (WP-108, `HOST_PATH_RULES`): case-insensitive on Windows,
 * exact on Linux.
 */
import { lstat, readdir, readFile, rm, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isoDateTimeSchema } from '@shared/common';
import { nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from '../lib/fs';
import { logger as rootLogger } from '../lib/logger';
import { HOST_PATH_RULES, fsErrorCode } from '../lib/paths';
import { ENTRIES_DIR } from './decisions';
import { STORE_SCHEMAS, type StoreSchema } from './schemas';

export const BACKUPS_DIR = 'backups';
export const BACKUP_MANIFEST = 'backup.json';
export const BACKUPS_KEPT = 3;
export const LAST_VERSION_FILE = 'last-version.json';
/** Store files newer than a restored backup go to `<backup>\newer\<relative path>`. */
export const BACKUP_NEWER_DIR = 'newer';

const PARTIAL_PREFIX = '.partial-';
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
/** Folder name part for an unknown previous build (first start with a backup). */
const UNKNOWN_BUILD = 'unbekannt';
const BUILD_ID_NAME_MAX = 80;

const buildIdSchema = z.string().min(1).max(200);

// =====================================================================================
// Which files: the store list (one place, schemas.ts)
// =====================================================================================

/**
 * A `*` of a store id: one file name segment of ids and suffixes (`en_<hex>`, `cv_<hex>`), never
 * `.`/`..`, never a separator – so a relative path from a manifest cannot leave its folder.
 */
const WILDCARD = '[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function storePattern(store: StoreSchema): RegExp {
  const body = store.id
    .split('/')
    .map((segment) => segment.split('*').map(escapeRegExp).join(WILDCARD))
    .join('/');
  // A JSON store keeps the previous version in `<file>.bak` (JsonStore): saved with the file.
  return new RegExp(`^${body}${store.kind === 'json' ? '(?:\\.bak)?' : ''}$`, 'i');
}

const MATCHERS = STORE_SCHEMAS.filter((store) => store.backup).map((store) => ({
  kind: store.kind,
  pattern: storePattern(store),
}));

/** `json` (copied), `jsonl` (length only) or null (not part of a backup) for a `/`-separated path. */
function classifyStoreFile(rel: string): StoreSchema['kind'] | null {
  return MATCHERS.find((matcher) => matcher.pattern.test(rel))?.kind ?? null;
}

function toAbsolute(base: string, rel: string): string {
  return path.join(base, ...rel.split('/'));
}

/** Key of a relative path by the host's rules (case-insensitive on Windows, exact on Linux). */
function relKey(rel: string): string {
  return HOST_PATH_RULES.key(rel);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function listNames(dir: string, want: 'file' | 'dir'): Promise<string[]> {
  try {
    const items = await withFsRetry(() => readdir(dir, { withFileTypes: true }));
    // Dirent never follows links: junctions and symlinks are neither files nor folders here.
    return items
      .filter((item) => (want === 'file' ? item.isFile() : item.isDirectory()))
      .map((item) => item.name);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT' || fsErrorCode(error) === 'ENOTDIR') return [];
    throw error;
  }
}

interface StoreFile {
  /** Relative to the home, `/`-separated. */
  rel: string;
  kind: StoreSchema['kind'];
}

/** Store files of the backup list that exist in `home` (home scope and `entries/<id>/`), sorted. */
async function listStoreFiles(home: string): Promise<StoreFile[]> {
  const found: StoreFile[] = [];
  const consider = (rel: string) => {
    const kind = classifyStoreFile(rel);
    if (kind !== null) found.push({ rel, kind });
  };
  for (const name of await listNames(home, 'file')) consider(name);
  const entries = path.join(home, ENTRIES_DIR);
  for (const entry of await listNames(entries, 'dir')) {
    for (const name of await listNames(path.join(entries, entry), 'file')) {
      consider(`${ENTRIES_DIR}/${entry}/${name}`);
    }
  }
  return found.sort((a, b) => compareText(a.rel, b.rel));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Size in bytes, or null if the file is missing. */
async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await withFsRetry(() => stat(file))).size;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

// =====================================================================================
// last-version.json
// =====================================================================================

const lastVersionFileSchema = z.object({
  schemaVersion: z.literal(1),
  buildId: buildIdSchema,
  at: isoDateTimeSchema,
});

/** Build id of the last started version, or null if `last-version.json` is missing or broken. */
export async function readLastBuildId(home: string): Promise<string | null> {
  try {
    const text = await withFsRetry(() => readFile(path.join(home, LAST_VERSION_FILE), 'utf8'));
    const parsed = lastVersionFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.buildId : null;
  } catch {
    return null;
  }
}

/** Writes `last-version.json` atomically: `{schemaVersion: 1, buildId, at}`. */
export async function writeLastBuildId(home: string, buildId: string, now: Date = new Date()): Promise<void> {
  const file = lastVersionFileSchema.parse({ schemaVersion: 1, buildId, at: now.toISOString() });
  await writeFileAtomic(path.join(home, LAST_VERSION_FILE), `${JSON.stringify(file, null, 2)}\n`);
}

// =====================================================================================
// backup.json
// =====================================================================================

export const backupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  from: buildIdSchema.nullable(),
  to: buildIdSchema,
  createdAt: isoDateTimeSchema,
  /** Copied store files (with `.bak`), relative to the home, `/`-separated. */
  files: z.array(z.string().refine((rel) => classifyStoreFile(rel) === 'json', 'not a JSON store file')),
  /** Transcript path → length in bytes at backup time. */
  transcripts: z.record(
    z.string().refine((rel) => classifyStoreFile(rel) === 'jsonl', 'not a transcript'),
    z.number().int().nonnegative(),
  ),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** A backup that cannot be used (missing or broken `backup.json`, missing file); nothing was changed. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** Reads and checks `<dir>\backup.json`; throws `BackupError` if it is missing or broken. */
export async function readBackupManifest(dir: string): Promise<BackupManifest> {
  const file = path.join(dir, BACKUP_MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(await withFsRetry(() => readFile(file, 'utf8')));
  } catch (error) {
    throw new BackupError(
      `${BACKUP_MANIFEST} is missing or not JSON (${fsErrorCode(error) ?? 'json'}): ${file}`,
    );
  }
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
    throw new BackupError(`${BACKUP_MANIFEST} is invalid (${where}): ${file}`);
  }
  return parsed.data;
}

// =====================================================================================
// createBackup
// =====================================================================================

export interface CreateBackupOptions {
  /** Build id of the last started version; null = unknown (no `last-version.json`). */
  from: string | null;
  /** Build id of the version about to start. */
  to: string;
  now?: Date;
  /** Seam: copy, rename, mkdir and the manifest write (tests inject failures). */
  fs?: FsOps;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

export interface BackupResult {
  /** Absolute folder of the finished backup. */
  dir: string;
  /** Copied files, relative to the home, `/`-separated. */
  files: string[];
  /** Transcript path → saved length in bytes. */
  transcripts: Record<string, number>;
}

/** Build id as a folder name part: `+` and `.` stay, never `:` or a separator, never a leading dot. */
function buildIdPart(buildId: string | null): string {
  if (buildId === null) return UNKNOWN_BUILD;
  const safe = buildId.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, BUILD_ID_NAME_MAX);
  return safe.startsWith('.') ? `_${safe}` : safe;
}

/** `YYYYMMDD-HHmmss` in UTC. */
function folderTime(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** First unused `<base>`, `<base>-2`, … (neither finished nor partial). */
async function freeBackupName(root: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${String(n)}`;
    if (
      !(await exists(path.join(root, name))) &&
      !(await exists(path.join(root, `${PARTIAL_PREFIX}${name}`)))
    ) {
      return name;
    }
  }
}

/**
 * Saves the store files of `home` to `<home>\backups\<from|unbekannt>-zu-<to>-<time>` (written as
 * `.partial-…` first, renamed when complete). On a failure the partial folder is removed and the
 * error rethrown.
 */
export async function createBackup(home: string, options: CreateBackupOptions): Promise<BackupResult> {
  const fs = options.fs ?? nodeFsOps;
  const log = (options.logger ?? rootLogger).child({ module: 'backup' });
  const now = options.now ?? new Date();
  const from = buildIdSchema.nullable().parse(options.from);
  const to = buildIdSchema.parse(options.to);
  const root = path.join(home, BACKUPS_DIR);
  await fs.mkdir(root);
  const name = await freeBackupName(root, `${buildIdPart(from)}-zu-${buildIdPart(to)}-${folderTime(now)}`);
  const partial = path.join(root, `${PARTIAL_PREFIX}${name}`);
  const dir = path.join(root, name);
  await fs.mkdir(partial);
  try {
    const files: string[] = [];
    const transcripts: Record<string, number> = {};
    for (const file of await listStoreFiles(home)) {
      const source = toAbsolute(home, file.rel);
      if (file.kind === 'jsonl') {
        const size = await sizeOf(source);
        if (size !== null) transcripts[file.rel] = size;
        continue;
      }
      const target = toAbsolute(partial, file.rel);
      await fs.mkdir(path.dirname(target));
      try {
        await withFsRetry(() => fs.copyFile(source, target), options.retryDelaysMs);
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') continue; // vanished since the listing
        throw error;
      }
      files.push(file.rel);
    }
    const manifest: BackupManifest = {
      schemaVersion: 1,
      from,
      to,
      createdAt: now.toISOString(),
      files,
      transcripts,
    };
    await writeFileAtomic(path.join(partial, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      fs,
      retryDelaysMs: options.retryDelaysMs,
    });
    await withFsRetry(() => fs.rename(partial, dir), options.retryDelaysMs);
    log.info(
      { dir, files: files.length, transcripts: Object.keys(transcripts).length },
      'stores backed up before a build change',
    );
    return { dir, files, transcripts };
  } catch (error) {
    await rm(partial, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    log.error({ err: error, partial }, 'store backup failed (partial folder removed)');
    throw error;
  }
}

// =====================================================================================
// restoreBackup (rollback, WP-87)
// =====================================================================================

export interface RestoreWarning {
  /** Transcript, relative to the home, `/`-separated. */
  file: string;
  /** `shorter`: shorter than saved (left as it is); `missing`: saved, but no longer there. */
  reason: 'shorter' | 'missing';
  savedBytes: number;
  /** Current length; null if missing. */
  currentBytes: number | null;
}

export interface RestoreResult {
  /** Files written back from the backup. */
  restored: string[];
  /** Store files and transcripts that were not in the backup, now below `<dir>\newer\`. */
  movedToNewer: string[];
  /** Transcripts cut back to their saved length. */
  truncated: string[];
  warnings: RestoreWarning[];
}

export interface RestoreBackupOptions {
  /** Seam: the atomic writes, rename and mkdir (tests inject failures). */
  fs?: FsOps;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

/** `<dir>\newer\<rel>`, or `<rel>.<n>` there if an earlier restore already put a file there. */
async function newerTarget(dir: string, rel: string): Promise<string> {
  const base = toAbsolute(path.join(dir, BACKUP_NEWER_DIR), rel);
  for (let n = 0; ; n++) {
    const target = n === 0 ? base : `${base}.${String(n)}`;
    if (!(await exists(target))) return target;
  }
}

/**
 * Brings the store state of the backup in `dir` back: every saved file (atomically), store files
 * that exist now but not in the backup go to `<dir>\newer\`, transcripts are cut to the saved
 * length (newer ones go to `newer\`, shorter ones stay and are reported). `processes.json` and
 * `auth-secret.json` are never touched. The manifest and every saved file are checked first: a
 * broken backup throws `BackupError` and nothing is changed.
 */
export async function restoreBackup(
  home: string,
  dir: string,
  options: RestoreBackupOptions = {},
): Promise<RestoreResult> {
  const fs = options.fs ?? nodeFsOps;
  const log = (options.logger ?? rootLogger).child({ module: 'backup' });
  const manifest = await readBackupManifest(dir);
  for (const rel of [...manifest.files, ...Object.keys(manifest.transcripts)]) {
    const issue = HOST_PATH_RULES.issue(toAbsolute(home, rel));
    if (issue !== null) throw new BackupError(`${BACKUP_MANIFEST} lists an unsafe path (${issue}): ${rel}`);
  }
  for (const rel of manifest.files) {
    const info = await withFsRetry(() => lstat(toAbsolute(dir, rel))).catch(() => null);
    if (info?.isFile() !== true) throw new BackupError(`backup file is missing: ${rel} in ${dir}`);
  }

  const current = await listStoreFiles(home);
  const savedFiles = new Set(manifest.files.map(relKey));
  const savedTranscripts = new Map(
    Object.entries(manifest.transcripts).map(([rel, bytes]) => [relKey(rel), { rel, bytes }]),
  );
  const result: RestoreResult = { restored: [], movedToNewer: [], truncated: [], warnings: [] };

  for (const rel of manifest.files) {
    const data = await withFsRetry(() => readFile(toAbsolute(dir, rel)), options.retryDelaysMs);
    await writeFileAtomic(toAbsolute(home, rel), data, { fs, retryDelaysMs: options.retryDelaysMs });
    result.restored.push(rel);
  }

  const moveToNewer = async (rel: string) => {
    const target = await newerTarget(dir, rel);
    await fs.mkdir(path.dirname(target));
    await withFsRetry(() => fs.rename(toAbsolute(home, rel), target), options.retryDelaysMs);
    result.movedToNewer.push(rel);
  };

  const present = new Set<string>();
  for (const file of current) {
    const key = relKey(file.rel);
    if (file.kind === 'json') {
      if (!savedFiles.has(key)) await moveToNewer(file.rel);
      continue;
    }
    const saved = savedTranscripts.get(key);
    if (saved === undefined) {
      await moveToNewer(file.rel);
      continue;
    }
    const absolute = toAbsolute(home, file.rel);
    const size = await sizeOf(absolute);
    if (size === null) continue; // vanished since the listing: reported as missing below
    present.add(key);
    if (size > saved.bytes) {
      await withFsRetry(() => truncate(absolute, saved.bytes), options.retryDelaysMs);
      result.truncated.push(file.rel);
    } else if (size < saved.bytes) {
      result.warnings.push({
        file: file.rel,
        reason: 'shorter',
        savedBytes: saved.bytes,
        currentBytes: size,
      });
    }
  }
  for (const [key, saved] of savedTranscripts) {
    if (present.has(key)) continue;
    result.warnings.push({ file: saved.rel, reason: 'missing', savedBytes: saved.bytes, currentBytes: null });
  }

  log.info(
    {
      dir,
      restored: result.restored.length,
      movedToNewer: result.movedToNewer.length,
      truncated: result.truncated.length,
      warnings: result.warnings,
    },
    'store backup restored',
  );
  return result;
}

// =====================================================================================
// listBackups / findBackup (update and rollback, WP-87)
// =====================================================================================

export interface BackupInfo {
  /** Absolute folder of the backup. */
  dir: string;
  /** Folder name below `backups\`. */
  name: string;
  manifest: BackupManifest;
}

/** Newest first by `createdAt`; equal times by name (the `-2` suffix of a second backup). */
function newestFirst(a: { name: string; createdAt: number }, b: { name: string; createdAt: number }): number {
  return a.createdAt === b.createdAt ? compareText(b.name, a.name) : a.createdAt < b.createdAt ? 1 : -1;
}

/**
 * The finished backups of `home` (with a valid `backup.json`), newest first. `.partial-*` folders
 * and backups with a missing or broken manifest are skipped.
 */
export async function listBackups(home: string): Promise<BackupInfo[]> {
  const root = path.join(home, BACKUPS_DIR);
  const found: (BackupInfo & { createdAt: number })[] = [];
  for (const name of await listNames(root, 'dir')) {
    if (name.startsWith(PARTIAL_PREFIX)) continue;
    const dir = path.join(root, name);
    const manifest = await readBackupManifest(dir).catch(() => null);
    if (manifest === null) continue;
    found.push({ dir, name, manifest, createdAt: Date.parse(manifest.createdAt) });
  }
  return found.sort(newestFirst).map(({ dir, name, manifest }) => ({ dir, name, manifest }));
}

/**
 * The newest finished backup made for exactly this build change (`from` null = the backup of a
 * first start without `last-version.json`), or null. Build ids are compared exactly.
 */
export async function findBackup(
  home: string,
  change: { from: string | null; to: string },
): Promise<BackupInfo | null> {
  const backups = await listBackups(home);
  return (
    backups.find((backup) => backup.manifest.from === change.from && backup.manifest.to === change.to) ?? null
  );
}

// =====================================================================================
// pruneBackups
// =====================================================================================

export interface PruneBackupsOptions {
  /** Reference time for the age of `.partial-*` folders (default: now). */
  now?: Date;
  logger?: Logger;
}

/**
 * Deletes finished backups beyond the `keep` newest (by `createdAt` of `backup.json`; unreadable
 * ones count as oldest) and `.partial-*` folders older than an hour. Returns the deleted folders
 * (absolute). A folder that cannot be deleted is logged and skipped.
 */
export async function pruneBackups(
  home: string,
  keep: number = BACKUPS_KEPT,
  options: PruneBackupsOptions = {},
): Promise<string[]> {
  const log = (options.logger ?? rootLogger).child({ module: 'backup' });
  const now = (options.now ?? new Date()).getTime();
  const root = path.join(home, BACKUPS_DIR);
  const deleted: string[] = [];
  const remove = async (dir: string) => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      deleted.push(dir);
    } catch (error) {
      log.warn({ err: error, dir }, 'could not delete an old store backup');
    }
  };

  const finished: { dir: string; name: string; createdAt: number }[] = [];
  for (const name of await listNames(root, 'dir')) {
    const dir = path.join(root, name);
    if (name.startsWith(PARTIAL_PREFIX)) {
      const info = await stat(dir).catch(() => null);
      if (info !== null && now - info.mtimeMs > PARTIAL_MAX_AGE_MS) await remove(dir);
      continue;
    }
    const manifest = await readBackupManifest(dir).catch(() => null);
    const createdAt = manifest === null ? Number.NEGATIVE_INFINITY : Date.parse(manifest.createdAt);
    finished.push({ dir, name, createdAt: Number.isNaN(createdAt) ? Number.NEGATIVE_INFINITY : createdAt });
  }
  finished.sort(newestFirst);
  for (const item of finished.slice(Math.max(0, Math.floor(keep)))) await remove(item.dir);
  if (deleted.length > 0) log.info({ deleted }, 'old store backups deleted');
  return deleted;
}
