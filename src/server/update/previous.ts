/**
 * "Back to <version>" (WP-87 §2.1 "Vorige Version", docs/wp/WP-83.md §9.4): the version
 * `current.json` names as `previous`, when its folder still holds a readable release.json of
 * exactly that version (and not the running build). Whether the way back needs the store backup
 * follows from the schema hashes of both release.json files: any other key or value → the older
 * version could quarantine store files or drop fields, so it only goes with the backup made for
 * that build change (`findBackup`, symmetric: after a rollback the "previous" is the newer one).
 * The same rule decides an older package from a file (`downgradeOf`).
 */
import type { UpdatePrevious } from '@shared/model';
import { readCurrent, versionDir } from '../install/layout';
import { readReleaseInfo, type ReleaseInfo } from '../launcher/release';
import { findBackup } from '../store/backup';

/** True when the store schema hashes of two releases differ (other keys or other values). */
export function schemasDiffer(a: ReleaseInfo['schemas'], b: ReleaseInfo['schemas']): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return true;
  return keysA.some((key, index) => key !== keysB[index] || a[key] !== b[key]);
}

/** createdAt of the newest backup for the change `from` → `to` (build ids), or null. */
export async function backupAtFor(home: string, from: string, to: string): Promise<string | null> {
  try {
    return (await findBackup(home, { from, to }))?.manifest.createdAt ?? null;
  } catch {
    return null;
  }
}

export interface Downgrade {
  needsRestore: boolean;
  backupAt: string | null;
}

/**
 * What switching from the running release `own` to `target` means for the stores: `needsRestore`
 * (other schema hashes) and the backup of the change target → own, if there is one.
 */
export async function downgradeOf(home: string, own: ReleaseInfo, target: ReleaseInfo): Promise<Downgrade> {
  return {
    needsRestore: schemasDiffer(target.schemas, own.schemas),
    backupAt: await backupAtFor(home, target.buildId, own.buildId),
  };
}

/**
 * `current.json` `previous` with an intact release.json of that version, or null (no installation,
 * no previous, folder gone or damaged, the running version itself). Never throws.
 */
export async function findPrevious(
  root: string,
  home: string,
  own: ReleaseInfo,
): Promise<UpdatePrevious | null> {
  let previous: string | null;
  try {
    previous = (await readCurrent(root))?.previous ?? null;
  } catch {
    return null;
  }
  if (previous === null || previous === own.version) return null;
  let release: ReleaseInfo | null;
  try {
    release = await readReleaseInfo(versionDir(root, previous));
  } catch {
    return null;
  }
  if (release?.version !== previous || release.buildId === own.buildId) return null;
  return { version: previous, ...(await downgradeOf(home, own, release)) };
}
