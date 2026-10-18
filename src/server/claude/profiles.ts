/**
 * Profiles (Plan "Claude-Profile"): the built-in profile "Standard" (code, not data), the summary
 * the UI sees and the in-memory store (Phase 1, preflight, tests). The persistent store of
 * `profiles.json` (Phase 2, ADR-102) is `profileStore.ts`. Both keep the claude status of the last
 * check per profile (ProfileSummary.claude).
 */
import { STANDARD_PROFILE_ID, type ProfileId } from '@shared/common';
import {
  profileSchema,
  type ClaudeInstallStatus,
  type Profile,
  type ProfileIssue,
  type ProfileSummary,
} from '@shared/model';
import { isSecretEnvKey } from '@shared/secrets';
import { registerSecret } from '../lib/logger';
import { UNKNOWN_AUTH } from './authStatus';
import { parseProfileArgs } from './profileArgs';
import type { ProfileStore } from './ports';

/**
 * Registers the values of secret env names (`isSecretEnvKey` of `@shared/secrets`, ADR-124 – the
 * one rule of server and web) with the logger's redaction (R9).
 */
export function registerEnvSecrets(env: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvKey(name)) registerSecret(value);
  }
}

/**
 * Everything the resolution and the check of a profile's `claude` depend on (executable, env incl.
 * PATH, config dir): the integration's resolution cache (ADR-102) and the reset of the check
 * status after a save (R4-06) compare it.
 */
export function profileResolutionKey(profile: Pick<Profile, 'executable' | 'env' | 'configDir'>): string {
  return JSON.stringify([profile.executable, profile.env, profile.configDir]);
}

/** Fixed timestamps: the built-in profile is code, not data. */
const BUILTIN_TIME = '2026-10-15T00:00:00.000Z';

function deepFreeze<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value)) {
    const child: unknown = Reflect.get(value, key);
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}

/** Built-in default profile: the automatically resolved `claude` without extras (deep-frozen). */
export const STANDARD_PROFILE: Profile = deepFreeze(
  profileSchema.parse({
    id: STANDARD_PROFILE_ID,
    name: 'Standard',
    color: 'slate',
    isDefault: true,
    builtin: true,
    executable: { kind: 'auto' },
    configDir: null,
    env: {},
    contextWindow: null,
    args: [],
    passRawArgs: false,
    defaults: { model: null, permissionMode: null, effort: null },
    createdAt: BUILTIN_TIME,
    updatedAt: BUILTIN_TIME,
  }),
);

/** Status before the first check ("Profil testen" / preflight / server start). */
export function uncheckedClaudeStatus(): ClaudeInstallStatus {
  return {
    state: 'checking',
    path: null,
    version: null,
    versionStatus: 'unknown',
    auth: { ...UNKNOWN_AUTH },
    error: null,
    checkedAt: null,
  };
}

/**
 * ProfileSummary without env values and args (what the UI may see). `issues` come from the
 * persistent store (profileIssues, WP-32); `entryCount` is filled by the engine (WP-31).
 */
export function profileSummary(
  profile: Profile,
  claude: ClaudeInstallStatus,
  issues: readonly ProfileIssue[] = [],
): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    isDefault: profile.isDefault,
    builtin: profile.builtin,
    allowsBypass: parseProfileArgs(profile.args, profile.passRawArgs).allowDangerouslySkipPermissions,
    claude,
    defaults: { ...profile.defaults },
    configDir: profile.configDir,
    issues: [...issues],
    entryCount: 0,
  };
}

export interface MutableProfileStore extends ProfileStore {
  /** Stores the result of the last check (ClaudeIntegration.checkProfile). */
  setClaudeStatus(id: ProfileId, status: ClaudeInstallStatus): void;
  claudeStatus(id: ProfileId): ClaudeInstallStatus;
}

/**
 * Phase 1 store: exactly the given profiles (default: only "Standard"). Exactly one profile must
 * be the default (Plan "isDefault"); the first one wins if the list says otherwise.
 */
export function createProfileStore(profiles: readonly Profile[] = [STANDARD_PROFILE]): MutableProfileStore {
  if (profiles.length === 0) throw new Error('createProfileStore: at least one profile is required');
  const list = [...profiles];
  const statuses = new Map<ProfileId, ClaudeInstallStatus>();
  const fallback = list[0];
  const defaultProfile = list.find((profile) => profile.isDefault) ?? fallback;
  if (defaultProfile === undefined) throw new Error('createProfileStore: no default profile');

  const claudeStatus = (id: ProfileId): ClaudeInstallStatus => statuses.get(id) ?? uncheckedClaudeStatus();
  return {
    list: () => [...list],
    get: (id) => list.find((profile) => profile.id === id),
    getDefault: () => defaultProfile,
    summaries: () =>
      list.map((profile) =>
        profileSummary({ ...profile, isDefault: profile.id === defaultProfile.id }, claudeStatus(profile.id)),
      ),
    setClaudeStatus: (id, status) => {
      statuses.set(id, status);
    },
    claudeStatus,
  };
}
