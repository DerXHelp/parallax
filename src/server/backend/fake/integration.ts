/**
 * `createFakeClaudeIntegration()` (WP-13 §3.3): port `ClaudeIntegration` without a real `claude`
 * – for `pnpm dev --backend=fake`, engine tests and E2E. Profiles come from the WP-11 profile
 * store; every profile reports `ok`/`logged_in` (no setup screen), `launchSpecFor` returns a
 * LaunchSpec with a fake executable and an empty env. Tests can make the next launches fail.
 */
import type { EntryId, ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile, ProfileSummary } from '@shared/model';
import { parseProfileArgs } from '../../claude/profileArgs';
import { createProfileStore, type MutableProfileStore } from '../../claude/profiles';
import type { ClaudeIntegration, LaunchSpec, ProfileStore } from '../../claude/ports';
import { CommandError } from '../../sync/ports';

export const FAKE_CLAUDE_PATH = 'C:\\fake\\claude.exe';
export const FAKE_CLAUDE_VERSION = '2.1.300';

export interface FakeClaudeIntegrationOptions {
  /** Default: only the built-in profile "Standard". */
  profiles?: readonly Profile[];
  /** Overrides ProfileSummary.allowsBypass and LaunchSpec.allowDangerouslySkipPermissions (C.3). */
  allowsBypass?: boolean;
  now?: () => Date;
}

export interface FakeClaudeIntegration extends ClaudeIntegration {
  readonly profiles: ProfileStore;
  /** Every launchSpecFor call. */
  readonly launches: readonly { profileId: ProfileId; entryId: EntryId }[];
  /** Test: launchSpecFor throws CommandError(error) until reset with null (e.g. CLAUDE_NOT_FOUND). */
  setLaunchError(error: ErrorPayload | null): void;
}

function okStatus(at: Date): ClaudeInstallStatus {
  return {
    state: 'ok',
    path: FAKE_CLAUDE_PATH,
    version: FAKE_CLAUDE_VERSION,
    versionStatus: 'ok',
    auth: { state: 'logged_in', method: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
    error: null,
    checkedAt: at.toISOString(),
  };
}

export function createFakeClaudeIntegration(
  options: FakeClaudeIntegrationOptions = {},
): FakeClaudeIntegration {
  const now = options.now ?? (() => new Date());
  const store: MutableProfileStore = createProfileStore(options.profiles);
  for (const profile of store.list()) store.setClaudeStatus(profile.id, okStatus(now()));
  const launches: { profileId: ProfileId; entryId: EntryId }[] = [];
  let launchError: ErrorPayload | null = null;

  const bypassOverride = (summary: ProfileSummary): ProfileSummary =>
    options.allowsBypass === undefined ? summary : { ...summary, allowsBypass: options.allowsBypass };

  const profiles: ProfileStore = {
    list: () => store.list(),
    get: (id) => store.get(id),
    getDefault: () => store.getDefault(),
    summaries: () => store.summaries().map(bypassOverride),
  };

  return {
    profiles,
    launches,

    setLaunchError(error) {
      launchError = error;
    },

    launchSpecFor(profileId, entryId) {
      launches.push({ profileId, entryId });
      if (launchError !== null) return Promise.reject(new CommandError(launchError));
      const profile = store.get(profileId);
      if (profile === undefined)
        return Promise.reject(new CommandError(makeError('PROFILE_NOT_FOUND', { profileId })));
      const args = parseProfileArgs(profile.args, profile.passRawArgs);
      if (args.errors.length > 0) {
        return Promise.reject(new CommandError(makeError('PROFILE_INVALID', { count: args.errors.length })));
      }
      const spec: LaunchSpec = {
        profileId: profile.id,
        executablePath: FAKE_CLAUDE_PATH,
        executableVersion: FAKE_CLAUDE_VERSION,
        env: {},
        configDir: profile.configDir,
        sdkOptions: args.sdkOptions,
        extraArgs: args.extraArgs,
        allowDangerouslySkipPermissions: options.allowsBypass ?? args.allowDangerouslySkipPermissions,
        autoCompactWindow: profile.contextWindow,
        contextWindow: profile.contextWindow,
      };
      return Promise.resolve(spec);
    },

    checkProfile(profileId) {
      if (store.get(profileId) === undefined) {
        return Promise.reject(new CommandError(makeError('PROFILE_NOT_FOUND', { profileId })));
      }
      const status = okStatus(now());
      store.setClaudeStatus(profileId, status);
      return Promise.resolve(status);
    },
  };
}
