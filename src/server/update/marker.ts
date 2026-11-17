/**
 * `<home>\update-result.json` (WP-87 §1.7, E3): the outcome of a version switch, written by the
 * orchestrator of the OLD version (`pending`, `failed`) or by the launcher after an install.cmd
 * (`installed`), read once by the next server start (`justUpdated` / `failedUpdate`). Stable across
 * versions: changes only additive (unknown fields are dropped when parsing), a break needs a MAJOR
 * version. Like `last-version.json` not a store (no schema hash, no backup).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import { appVersionSchema, type UpdateState } from '@shared/model';
import { withFsRetry, writeFileAtomic } from '../lib/fs';

export const UPDATE_RESULT_FILE = 'update-result.json';
export const UPDATE_RESULT_SCHEMA_VERSION = 1;

const buildIdSchema = z.string().min(1).max(LIMITS.buildIdChars);

export const updateResultSchema = z.object({
  schemaVersion: z.literal(UPDATE_RESULT_SCHEMA_VERSION),
  /** `pending` = switched, the new version starts; `failed` = went back; `installed` = install.cmd. */
  outcome: z.enum(['pending', 'failed', 'installed']),
  /** The version before the switch (null fields: unknown, e.g. a checkout before the installation). */
  from: z.object({ version: appVersionSchema.nullable(), buildId: buildIdSchema.nullable() }),
  to: z.object({ version: appVersionSchema, buildId: buildIdSchema }),
  at: z.iso.datetime(),
  backupDir: z.string().max(LIMITS.pathChars).nullable(),
  error: errorPayloadSchema.nullable(),
  /** Absolute path of `logs\update-<time>.log`. */
  log: z.string().max(LIMITS.pathChars).nullable(),
});
export type UpdateResult = z.infer<typeof updateResultSchema>;

export function updateResultPath(home: string): string {
  return path.join(home, UPDATE_RESULT_FILE);
}

export async function writeUpdateResult(home: string, result: UpdateResult): Promise<void> {
  await writeFileAtomic(
    updateResultPath(home),
    `${JSON.stringify(updateResultSchema.parse(result), null, 2)}\n`,
  );
}

export interface ConsumedUpdateResult {
  justUpdated: UpdateState['justUpdated'];
  failedUpdate: UpdateState['failedUpdate'];
}

/**
 * Reads and always deletes the marker. `pending`/`installed` for this build → `justUpdated`;
 * `failed` whose `from` is this build (the orchestrator went back to it) → `failedUpdate`; anything
 * else (another build, broken, missing) is stale → both null. Never throws.
 */
export async function consumeUpdateResult(
  home: string,
  own: { version: string; buildId: string },
): Promise<ConsumedUpdateResult> {
  const none: ConsumedUpdateResult = { justUpdated: null, failedUpdate: null };
  const file = updateResultPath(home);
  let raw: unknown;
  try {
    raw = JSON.parse(await withFsRetry(() => readFile(file, 'utf8')));
  } catch {
    return none;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
  const parsed = updateResultSchema.safeParse(raw);
  if (!parsed.success) return none;
  const result = parsed.data;
  if (result.outcome !== 'failed') {
    if (result.to.buildId !== own.buildId) return none;
    return { ...none, justUpdated: { from: result.from.version, to: result.to.version, at: result.at } };
  }
  const restoredTo = appVersionSchema.safeParse(result.from.version ?? own.version);
  if (result.from.buildId !== own.buildId || !restoredTo.success) return none;
  const error: ErrorPayload =
    result.error ?? makeError('UPDATE_RESTART_FAILED', { version: result.to.version, reason: 'exited' });
  return {
    ...none,
    failedUpdate: {
      version: result.to.version,
      restoredTo: restoredTo.data,
      at: result.at,
      error,
      log: result.log,
    },
  };
}
