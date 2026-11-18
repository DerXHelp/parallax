/**
 * The one list of persisted stores in PARALLAX_HOME (WP-85, docs/wp/WP-83.md §8.4/§9.4): id, scope
 * and zod schema. `scripts/release-pack.ts` hashes the schemas into `release.json`; the backup on a
 * version change (WP-86, store/backup.ts) saves exactly these files (`backup: true`). A new store is
 * added here (pinned by schemas.test.ts, which scans for `new JsonStore`).
 *
 * The hash covers the JSON Schema of the INPUT side (what a version can read), without
 * `description`/`title` texts: it changes with a new field or value, not with a comment.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  decisionRecordsFileSchema,
  draftFileSchema,
  keyFileSchema,
  multiHostFileSchema,
  profilesFileSchema,
  registryFileSchema,
  remoteEventsFileSchema,
  remotePeerFileSchema,
  sessionFilesFileSchema,
  settingsFileSchema,
} from '@shared/model';
import { PROFILES_FILE } from '../claude/profileStore';
import { SESSION_FILES_FILE } from '../files/sessionIndex';
import { AUTH_SECRET_FILE, authSecretFileSchema } from '../http/auth';
import {
  ACCOUNT_LIMITS_FILE,
  accountLimitsFileSchema,
  MODEL_CATALOGS_FILE,
  modelCatalogsFileSchema,
} from '../sessions/catalogStore';
import { COMMANDS_FILE, commandsCacheFileSchema } from '../sessions/commandCatalog';
import { PROCESSES_FILE, processesFileSchema } from '../sessions/processStore';
import { transcriptLogLineSchema } from '../sync/ports';
import { DECISIONS_FILE } from './decisions';
import { DRAFT_FILE } from './drafts';
import { REGISTRY_FILE } from './registry';
import { SETTINGS_FILE } from './settings';
import { TRANSCRIPT_SUFFIX } from './transcripts';

export interface StoreSchema {
  /** Path pattern below PARALLAX_HOME, `/`-separated (`entries/*\/decisions.json`). */
  id: string;
  /** `home`: one file in the data directory; `entry`: one per entry (`entries/<entryId>/`). */
  scope: 'home' | 'entry';
  /** JSON store (`schemaVersion`, `.bak`) or append-only JSON lines (transcripts). */
  kind: 'json' | 'jsonl';
  schema: z.ZodType;
  /**
   * Part of the backup on a build change (store/backup.ts; default true). False: the file is
   * neither saved nor touched by a restore – `processes.json` (the current file must survive a
   * rollback, else entries of orphaned processes are lost), `auth-secret.json` (never changes,
   * holds a secret) and the files of "Several computers" (WP-78a: a rollback must never bring back
   * a revoked coupling or a role the user left). Not part of the schema hash.
   */
  backup: boolean;
}

const home = (file: string, schema: z.ZodType, options: { backup?: boolean } = {}): StoreSchema => ({
  id: file,
  scope: 'home',
  kind: 'json',
  schema,
  backup: options.backup ?? true,
});
const entry = (file: string, schema: z.ZodType, kind: StoreSchema['kind'] = 'json'): StoreSchema => ({
  id: `entries/*/${file}`,
  scope: 'entry',
  kind,
  schema,
  backup: true,
});

export const STORE_SCHEMAS: readonly StoreSchema[] = [
  home(REGISTRY_FILE, registryFileSchema),
  home(PROFILES_FILE, profilesFileSchema),
  home(SETTINGS_FILE, settingsFileSchema),
  home(PROCESSES_FILE, processesFileSchema, { backup: false }),
  home(MODEL_CATALOGS_FILE, modelCatalogsFileSchema),
  home(ACCOUNT_LIMITS_FILE, accountLimitsFileSchema),
  home(AUTH_SECRET_FILE, authSecretFileSchema, { backup: false }),
  // WP-78a "Several computers": never rolled back – a restore could bring back a revoked coupling,
  // a removed key or the sharing role the user switched off (WP-76 §B.8). Literal ids: the folders
  // are `remote/` (remote/eventLog.ts REMOTE_DIR) and `keys/` (secure/identityStore.ts KEYS_DIR).
  home('multi-host.json', multiHostFileSchema, { backup: false }),
  home('remote/peer.json', remotePeerFileSchema, { backup: false }),
  home('remote/events.json', remoteEventsFileSchema, { backup: false }),
  home('keys/*.json', keyFileSchema, { backup: false }),
  entry(DECISIONS_FILE, decisionRecordsFileSchema),
  entry(COMMANDS_FILE, commandsCacheFileSchema),
  entry(SESSION_FILES_FILE, sessionFilesFileSchema),
  entry(DRAFT_FILE, draftFileSchema),
  entry(`*${TRANSCRIPT_SUFFIX}`, transcriptLogLineSchema, 'jsonl'),
];

const TEXT_KEYS = new Set(['description', 'title']);

/** Sorted keys, without description/title texts (a property NAMED "description" is an object, kept). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item: unknown = (value as Record<string, unknown>)[key];
    if (TEXT_KEYS.has(key) && typeof item === 'string') continue;
    out[key] = canonical(item);
  }
  return out;
}

/** SHA-256 (hex) of the canonical input JSON Schema of `schema`. */
export function schemaHash(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return createHash('sha256')
    .update(JSON.stringify(canonical(json)))
    .digest('hex');
}

/** Store id → schema hash, for `release.json` (§9.4: a rollback without restore needs equal hashes). */
export function storeSchemaHashes(stores: readonly StoreSchema[] = STORE_SCHEMAS): Record<string, string> {
  return Object.fromEntries(stores.map((store) => [store.id, schemaHash(store.schema)]));
}
