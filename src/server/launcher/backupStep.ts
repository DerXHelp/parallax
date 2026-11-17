/**
 * The backup before a new server starts (WP-86, docs/wp/WP-83.md §8.4): when the build id differs
 * from the last start (`last-version.json`), the stores are saved (`store/backup.ts`, the one list
 * `STORE_SCHEMAS`), the build id is remembered and only the newest backups are kept. A home without
 * any store file gets no backup (first start). Runs in package mode and in a checkout
 * (`parallax.cmd`); `pnpm dev` starts no launcher.
 *
 * A failed backup does not block the start (the caller prints a note) and does not remember the
 * build id: the next start tries again.
 *
 * WP-87b (docs/wp/WP-87.md §2.2): in package mode a saved backup also writes the marker
 * `installed` (`update-result.json`), so the next server shows "Updated to <v>" after an
 * install.cmd as well. `from.version` is the part of the old build id before `+` (null when that is
 * no release version). The orchestrator of an in-app update writes its own marker and skips this.
 */
import { rm } from 'node:fs/promises';
import { appVersionSchema } from '@shared/model';
import { toError } from '../lib/async';
import { createBackup, pruneBackups, readLastBuildId, writeLastBuildId } from '../store/backup';
import { writeUpdateResult, UPDATE_RESULT_SCHEMA_VERSION } from '../update/marker';
import type { BackupStep } from './launcher';

export interface BackupStepOptions {
  /** Default `new Date()`. */
  now?: () => Date;
  /**
   * Package mode: the version of `release.json`. A saved backup then writes the marker `installed`;
   * null/absent (checkout) = no marker.
   */
  installedVersion?: string | null;
  /** Test seam (default `writeUpdateResult`). */
  writeMarker?: typeof writeUpdateResult;
}

/** `1.0.0-rc.2` of `1.0.0-rc.2+abc`; null without `+` or when that part is no release version. */
export function versionOfBuildId(buildId: string | null): string | null {
  if (buildId === null) return null;
  const plus = buildId.indexOf('+');
  if (plus <= 0) return null;
  const version = appVersionSchema.safeParse(buildId.slice(0, plus));
  return version.success ? version.data : null;
}

export async function backupBeforeStart(
  home: string,
  buildId: string | null,
  options: BackupStepOptions = {},
): Promise<BackupStep> {
  const now = options.now ?? (() => new Date());
  if (buildId === null) return { kind: 'unchanged' };
  let step: BackupStep;
  try {
    const last = await readLastBuildId(home);
    if (last === buildId) return { kind: 'unchanged' };
    const backup = await createBackup(home, { from: last, to: buildId, now: now() });
    const empty = backup.files.length === 0 && Object.keys(backup.transcripts).length === 0;
    if (empty) await rm(backup.dir, { recursive: true, force: true });
    await writeLastBuildId(home, buildId, now());
    await pruneBackups(home, undefined, { now: now() });
    step = empty ? { kind: 'unchanged' } : { kind: 'saved', dir: backup.dir, from: last, to: buildId };
  } catch (error) {
    return { kind: 'failed', reason: toError(error).message };
  }
  const version = options.installedVersion ?? null;
  if (step.kind === 'saved' && version !== null) {
    // Only the "What's new" banner depends on it: a failure never fails the start.
    await (options.writeMarker ?? writeUpdateResult)(home, {
      schemaVersion: UPDATE_RESULT_SCHEMA_VERSION,
      outcome: 'installed',
      from: { version: versionOfBuildId(step.from), buildId: step.from },
      to: { version, buildId },
      at: now().toISOString(),
      backupDir: step.dir,
      error: null,
      log: null,
    }).catch(() => undefined);
  }
  return step;
}
