/**
 * The backup before a new server starts (WP-86, docs/wp/WP-83.md §8.4): when the build id differs
 * from the last start (`last-version.json`), the stores are saved (`store/backup.ts`, the one list
 * `STORE_SCHEMAS`), the build id is remembered and only the newest backups are kept. A home without
 * any store file gets no backup (first start). Runs in package mode and in a checkout
 * (`parallax.cmd`); `pnpm dev` starts no launcher.
 *
 * A failed backup does not block the start (the caller prints a note) and does not remember the
 * build id: the next start tries again.
 */
import { rm } from 'node:fs/promises';
import { toError } from '../lib/async';
import { createBackup, pruneBackups, readLastBuildId, writeLastBuildId } from '../store/backup';
import type { BackupStep } from './launcher';

export async function backupBeforeStart(
  home: string,
  buildId: string | null,
  now: () => Date = () => new Date(),
): Promise<BackupStep> {
  if (buildId === null) return { kind: 'unchanged' };
  try {
    const last = await readLastBuildId(home);
    if (last === buildId) return { kind: 'unchanged' };
    const backup = await createBackup(home, { from: last, to: buildId, now: now() });
    const empty = backup.files.length === 0 && Object.keys(backup.transcripts).length === 0;
    if (empty) await rm(backup.dir, { recursive: true, force: true });
    await writeLastBuildId(home, buildId, now());
    await pruneBackups(home, undefined, { now: now() });
    return empty ? { kind: 'unchanged' } : { kind: 'saved', dir: backup.dir, from: last, to: buildId };
  } catch (error) {
    return { kind: 'failed', reason: toError(error).message };
  }
}
