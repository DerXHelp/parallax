/**
 * Persistent profile store (ADR-102): `PARALLAX_HOME/profiles.json` (`profilesFileSchema` v1,
 * JsonStore with `.bak`, quarantine and host warnings) with all profiles including "Standard".
 *
 * Invariants (repaired on load, logged as a warning, written back):
 * - a missing file means only STANDARD_PROFILE in memory – written on the first save/setDefault;
 * - "Standard" always exists (added in front if the file lacks it), `builtin` only for `standard`;
 * - profile ids are unique (the first one wins);
 * - exactly one `isDefault` (several → the first, none → "Standard").
 * Values of secret env names (`isSecretEnvKey`) are registered with the logger on load and save.
 * The mutations are no port (WP-30 §4.11): only the profile commands and the composition use them.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { STANDARD_PROFILE_ID, type ProfileId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  PROFILES_SCHEMA_VERSION,
  profilesFileSchema,
  type ClaudeInstallStatus,
  type Profile,
  type ProfileInput,
  type ProfileIssue,
  type ProfilesFile,
} from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { newId } from '../lib/ids';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { JsonStore, type Migrations, type StoreWarningSink } from '../store/jsonStore';
import { CommandError } from '../sync/ports';
import { errorCount, profileIssues, type ProfileIssueContext } from './profileIssues';
import {
  STANDARD_PROFILE,
  profileSummary,
  registerEnvSecrets,
  uncheckedClaudeStatus,
  type MutableProfileStore,
} from './profiles';

/** `PARALLAX_HOME/profiles.json` (profilesFileSchema). */
export const PROFILES_FILE = 'profiles.json';

export const PROFILES_MIGRATIONS: Migrations = {};

export interface PersistentProfileStore extends MutableProfileStore {
  /**
   * New profile (`input.id` absent: `pf_…`, not default) or a change of an existing one (`id`,
   * `isDefault`, `builtin`, `createdAt` stay). Throws CommandError PROFILE_NOT_FOUND (unknown id) or
   * PROFILE_INVALID {count} (error issues).
   */
  save(input: ProfileInput, now: Date): Profile;
  /** PROFILE_NOT_FOUND / PROFILE_NOT_DELETABLE; PROFILE_IN_USE is the caller's check. Default → "Standard". */
  remove(id: ProfileId): void;
  /** PROFILE_NOT_FOUND / PROFILE_INVALID {count}. Writes profiles.json even if nothing changed. */
  setDefault(id: ProfileId): void;
  /** After save/remove/setDefault/setClaudeStatus. Returns unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Fresh findings (profile.get, profile.validate) – summaries() caches them until the next change. */
  issuesOf(profile: Profile | ProfileInput): ProfileIssue[];
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenProfileStoreOptions {
  home: string;
  /** Quarantine and write failures become host warnings (createStoreWarnings). */
  warnings: StoreWarningSink;
  now?: () => Date;
  fs?: FsOps;
  /** Environment and file check of profileIssues (default: defaultProfileIssueContext()). */
  issueContext?: () => ProfileIssueContext;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  logger?: Logger;
}

/** True for an existing regular file; unsafe paths (UNC, device, ADS …) are never touched (C.10). */
function isExistingFile(file: string): boolean {
  if (windowsPathIssue(file) !== null) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** process.env, no persistent exception (it does not change `${env:NAME}`), the real file system. */
export function defaultProfileIssueContext(): ProfileIssueContext {
  return { env: process.env, persistentEnv: new Map(), exists: isExistingFile };
}

// ---- invariants (pure) ----

/** What normalizeProfiles repaired (English, for the log and preflight). */
export type ProfilesRepair =
  'standard_added' | 'duplicate_id' | 'builtin_fixed' | 'several_defaults' | 'no_default';

/** Applies the invariants of the module comment; `repairs` is empty for a consistent list. */
export function normalizeProfiles(input: readonly Profile[]): {
  profiles: Profile[];
  repairs: ProfilesRepair[];
} {
  const repairs = new Set<ProfilesRepair>();
  const seen = new Set<ProfileId>();
  let profiles: Profile[] = [];
  for (const profile of input) {
    if (seen.has(profile.id)) {
      repairs.add('duplicate_id');
      continue;
    }
    seen.add(profile.id);
    const builtin = profile.id === STANDARD_PROFILE_ID;
    if (profile.builtin !== builtin) repairs.add('builtin_fixed');
    profiles.push(profile.builtin === builtin ? profile : { ...profile, builtin });
  }
  if (!seen.has(STANDARD_PROFILE_ID)) {
    repairs.add('standard_added');
    profiles.unshift({ ...STANDARD_PROFILE, isDefault: false });
  }
  const defaults = profiles.filter((profile) => profile.isDefault);
  const keep = defaults[0]?.id ?? STANDARD_PROFILE_ID;
  if (defaults.length > 1) repairs.add('several_defaults');
  if (defaults.length === 0) repairs.add('no_default');
  if (defaults.length !== 1) {
    profiles = profiles.map((profile) =>
      profile.isDefault === (profile.id === keep) ? profile : { ...profile, isDefault: profile.id === keep },
    );
  }
  return { profiles, repairs: [...repairs] };
}

// ---- read-only access (pnpm preflight) ----

export type ProfilesFileRead =
  | { kind: 'missing' }
  | { kind: 'ok'; profiles: Profile[]; repairs: ProfilesRepair[] }
  /** Written by a newer Parallax (never touched). */
  | { kind: 'newer'; version: number }
  /** Unreadable or invalid (the server would quarantine it); `reason` like the store warning. */
  | { kind: 'invalid'; reason: string };

/**
 * Reads `<home>/profiles.json` without writing anything (no quarantine, no migration on disk, no
 * `.bak`): `pnpm preflight` checks the profiles of a data folder a server may be using.
 */
export async function readProfilesFile(
  home: string,
  fs: Pick<FsOps, 'readFile'> = nodeFsOps,
): Promise<ProfilesFileRead> {
  let text: string;
  try {
    text = await fs.readFile(path.join(home, PROFILES_FILE));
  } catch (error) {
    const code = fsErrorCode(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid', reason: code ?? 'read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'json' };
  }
  const version: unknown =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? raw.schemaVersion : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version))
    return { kind: 'invalid', reason: 'schema_version' };
  if (version > PROFILES_SCHEMA_VERSION) return { kind: 'newer', version };
  const parsed = profilesFileSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', reason: 'schema' };
  return { kind: 'ok', ...normalizeProfiles(parsed.data.profiles) };
}

/** The profiles a read stands for: the file's (normalized) or only "Standard". */
export function profilesOf(read: ProfilesFileRead | null): Profile[] {
  return read?.kind === 'ok' ? read.profiles : [STANDARD_PROFILE];
}

// ---- the store ----

export async function openProfileStore(options: OpenProfileStoreOptions): Promise<PersistentProfileStore> {
  const log = (options.logger ?? rootLogger).child({ module: 'profiles' });
  const issueContext = options.issueContext ?? defaultProfileIssueContext;
  const store = new JsonStore<ProfilesFile>({
    file: path.join(options.home, PROFILES_FILE),
    schema: profilesFileSchema,
    version: PROFILES_SCHEMA_VERSION,
    defaults: () => ({ schemaVersion: PROFILES_SCHEMA_VERSION, profiles: [STANDARD_PROFILE] }),
    migrations: PROFILES_MIGRATIONS,
    backup: true,
    warnings: options.warnings,
    debounceMs: options.debounceMs,
    fs: options.fs,
    retryDelaysMs: options.retryDelaysMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    logger: options.logger,
  });
  const loaded = await store.load();
  const { profiles: initial, repairs } = normalizeProfiles(loaded.profiles);
  if (repairs.length > 0) {
    log.warn({ repairs }, 'profiles.json repaired (ADR-102 invariants)');
    store.set({ schemaVersion: PROFILES_SCHEMA_VERSION, profiles: initial });
  }
  for (const profile of store.get().profiles) registerEnvSecrets(profile.env);

  const statuses = new Map<ProfileId, ClaudeInstallStatus>();
  /** Findings per profile for summaries(); dropped on every change (and "Profil testen"). */
  const issueCache = new Map<ProfileId, ProfileIssue[]>();
  const listeners = new Set<() => void>();

  const list = (): Profile[] => store.get().profiles;
  const get = (id: ProfileId): Profile | undefined => list().find((profile) => profile.id === id);
  const requireProfile = (id: ProfileId): Profile => {
    const profile = get(id);
    if (profile === undefined) throw new CommandError(makeError('PROFILE_NOT_FOUND', { profileId: id }));
    return profile;
  };
  const issuesOf = (profile: Profile | ProfileInput): ProfileIssue[] =>
    profileIssues(profile, issueContext());
  const cachedIssues = (profile: Profile): ProfileIssue[] => {
    let issues = issueCache.get(profile.id);
    if (issues === undefined) {
      issues = issuesOf(profile);
      issueCache.set(profile.id, issues);
    }
    return issues;
  };
  const assertNoErrors = (issues: readonly ProfileIssue[]): void => {
    const count = errorCount(issues);
    if (count > 0) throw new CommandError(makeError('PROFILE_INVALID', { count }));
  };
  const commit = (profiles: Profile[]): void => {
    store.set({ schemaVersion: PROFILES_SCHEMA_VERSION, profiles });
  };
  const changed = (): void => {
    issueCache.clear();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'profile change listener failed');
      }
    }
  };
  const claudeStatus = (id: ProfileId): ClaudeInstallStatus => statuses.get(id) ?? uncheckedClaudeStatus();
  const getDefault = (): Profile => {
    const all = list();
    const found = all.find((profile) => profile.isDefault) ?? all.find((p) => p.id === STANDARD_PROFILE_ID);
    // normalizeProfiles guarantees "Standard"; the fallback only satisfies the type.
    return found ?? STANDARD_PROFILE;
  };

  return {
    list: () => [...list()],
    get,
    getDefault,
    summaries: () =>
      list().map((profile) => profileSummary(profile, claudeStatus(profile.id), cachedIssues(profile))),
    claudeStatus,
    setClaudeStatus: (id, status) => {
      statuses.set(id, status);
      changed();
    },
    issuesOf,

    save: (input, now) => {
      const existing = input.id === undefined ? undefined : requireProfile(input.id);
      assertNoErrors(issuesOf(input));
      const at = now.toISOString();
      const id: ProfileId = existing?.id ?? newId('pf');
      const profile: Profile = {
        id,
        name: input.name,
        color: input.color,
        isDefault: existing?.isDefault ?? false,
        builtin: id === STANDARD_PROFILE_ID,
        executable: input.executable,
        configDir: input.configDir,
        env: { ...input.env },
        contextWindow: input.contextWindow,
        args: [...input.args],
        passRawArgs: input.passRawArgs,
        defaults: { ...input.defaults },
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      commit(existing === undefined ? [...list(), profile] : list().map((p) => (p.id === id ? profile : p)));
      registerEnvSecrets(profile.env);
      log.info({ profileId: id, created: existing === undefined }, 'profile saved');
      changed();
      return requireProfile(id);
    },

    remove: (id) => {
      const existing = requireProfile(id);
      if (existing.builtin || existing.id === STANDARD_PROFILE_ID) {
        throw new CommandError(makeError('PROFILE_NOT_DELETABLE', { profileId: id }));
      }
      const rest = list().filter((profile) => profile.id !== id);
      commit(
        existing.isDefault
          ? rest.map((profile) =>
              profile.id === STANDARD_PROFILE_ID ? { ...profile, isDefault: true } : profile,
            )
          : rest,
      );
      statuses.delete(id);
      log.info({ profileId: id, wasDefault: existing.isDefault }, 'profile deleted');
      changed();
    },

    setDefault: (id) => {
      assertNoErrors(issuesOf(requireProfile(id)));
      commit(
        list().map((profile) =>
          profile.isDefault === (profile.id === id) ? profile : { ...profile, isDefault: profile.id === id },
        ),
      );
      log.info({ profileId: id }, 'default profile set');
      changed();
    },

    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}
