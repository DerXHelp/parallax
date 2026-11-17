/**
 * The version folders of an installation (WP-86, docs/wp/WP-83.md §8.1 "Aufräumen"): which versions
 * are installed, which one a running server uses, and the cleanup after an installation.
 *
 * The cleanup deletes every version that is neither `version` nor `previous` of current.json and
 * not the running one (its build id from the lock file of the data directory – an installation
 * without a restart must not delete the folder the server and its history worker still load from).
 * Deleting takes two steps: rename to `versions\.trash-<stamp>-<v>`, then delete with retries;
 * leftovers (trash, abandoned staging folders) are removed by the next cleanup.
 */
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { toError } from '../lib/async';
import { withFsRetry } from '../lib/fs';
import { RELEASE_FILE, releaseInfoSchema, releaseVersionSchema } from '../launcher/release';
import { STAGING_PREFIX, TRASH_PREFIX, VERSIONS_DIR } from './layout';

export interface InstalledVersion {
  version: string;
  /** From its release.json; null when that file is missing or broken. */
  buildId: string | null;
}

/** Version folders below `<root>\versions` (no staging/trash), with the build id of each. */
export async function listInstalledVersions(root: string): Promise<InstalledVersion[]> {
  let names: string[];
  try {
    names = await readdir(path.join(root, VERSIONS_DIR));
  } catch {
    return [];
  }
  const out: InstalledVersion[] = [];
  for (const name of names.sort()) {
    if (!releaseVersionSchema.safeParse(name).success) continue;
    let buildId: string | null = null;
    try {
      const text = await readFile(path.join(root, VERSIONS_DIR, name, RELEASE_FILE), 'utf8');
      const parsed = releaseInfoSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.version === name) buildId = parsed.data.buildId;
    } catch {
      // missing or broken: no build id
    }
    out.push({ version: name, buildId });
  }
  return out;
}

/** The installed version with this build id (the running server's, from its lock file), or null. */
export function versionOfBuild(
  installed: readonly InstalledVersion[],
  buildId: string | null,
): string | null {
  if (buildId === null) return null;
  return installed.find((entry) => entry.buildId === buildId)?.version ?? null;
}

/** `20261117-093000` (local time) – sortable, valid in folder names. */
export function folderStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** Leftover staging folders younger than this may belong to an installer that still runs. */
export const STALE_STAGING_MS = 60 * 60_000;

export interface CleanupResult {
  /** Versions moved away and deleted (or left in the trash when deleting failed). */
  removed: string[];
  /** Folders that could not be deleted yet (the next cleanup tries again). */
  problems: string[];
}

/**
 * Deletes every version folder not in `keep` (see the file comment) and old leftovers. Never
 * throws; a folder that is in use stays (problems).
 */
export async function cleanupVersions(
  root: string,
  keep: readonly (string | null)[],
  now: Date = new Date(),
): Promise<CleanupResult> {
  const versions = path.join(root, VERSIONS_DIR);
  const result: CleanupResult = { removed: [], problems: [] };
  let names: string[];
  try {
    names = await readdir(versions);
  } catch {
    return result;
  }
  const kept = new Set(keep.filter((v): v is string => v !== null).map((v) => v.toLowerCase()));
  const stamp = folderStamp(now);
  const trash: string[] = [];
  for (const name of names) {
    const full = path.join(versions, name);
    if (name.startsWith(TRASH_PREFIX)) {
      trash.push(full);
    } else if (name.startsWith(STAGING_PREFIX)) {
      try {
        if (now.getTime() - (await stat(full)).mtimeMs > STALE_STAGING_MS) trash.push(full);
      } catch {
        // gone meanwhile
      }
    } else if (releaseVersionSchema.safeParse(name).success && !kept.has(name.toLowerCase())) {
      const target = path.join(versions, `${TRASH_PREFIX}${stamp}-${name}`);
      try {
        await withFsRetry(() => rename(full, target));
        result.removed.push(name);
        trash.push(target);
      } catch (error) {
        result.problems.push(`${name}: ${toError(error).message}`);
      }
    }
  }
  for (const dir of trash) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      result.problems.push(`${path.basename(dir)}: ${toError(error).message}`);
    }
  }
  return result;
}
