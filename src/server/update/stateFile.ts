/**
 * `<home>\update-state.json` (WP-87 §2.1 "Zustand", E5): the only update state on disk besides the
 * marker – the version whose header hint the user dismissed. Not a store (no schema hash, no
 * backup); a missing or broken file means "nothing dismissed".
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { appVersionSchema } from '@shared/model';
import { withFsRetry, writeFileAtomic } from '../lib/fs';

export const UPDATE_STATE_FILE = 'update-state.json';

const updateStateFileSchema = z.object({
  schemaVersion: z.literal(1),
  dismissedVersion: appVersionSchema.nullable(),
});

/** The dismissed version, or null (missing, broken, nothing dismissed). Never throws. */
export async function readDismissedVersion(home: string): Promise<string | null> {
  try {
    const text = await withFsRetry(() => readFile(path.join(home, UPDATE_STATE_FILE), 'utf8'));
    const parsed = updateStateFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.dismissedVersion : null;
  } catch {
    return null;
  }
}

export async function writeDismissedVersion(home: string, version: string | null): Promise<void> {
  const file = updateStateFileSchema.parse({ schemaVersion: 1, dismissedVersion: version });
  await writeFileAtomic(path.join(home, UPDATE_STATE_FILE), `${JSON.stringify(file, null, 2)}\n`);
}
