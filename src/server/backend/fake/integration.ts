/**
 * `createFakeClaudeIntegration()` (WP-13 §3.3): port `ClaudeIntegration` without a real `claude`
 * – for `pnpm dev --backend=fake`, engine tests and E2E. Profiles come from a profile store (a
 * passed one – e.g. the persistent `profiles.json` store of WP-32 – wins over `profiles`); every
 * profile reports `ok`/`logged_in` (no setup screen), `launchSpecFor` returns a LaunchSpec with a
 * fake executable and an empty env, `consoleLaunchFor` (Phase 2, WP-34) the console spec of
 * `claude --resume <id>` for the fake console. Tests can make the next launches fail.
 */
import type { EntryId, ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile, ProfileSummary } from '@shared/model';
import { parseProfileArgs } from '../../claude/profileArgs';
import { createProfileStore, type MutableProfileStore } from '../../claude/profiles';
import type {
  ClaudeIntegration,
  ConsoleLaunchRequest,
  ConsoleLaunchSpec,
  LaunchSpec,
  ProfileStore,
} from '../../claude/ports';
import { CommandError } from '../../sync/ports';

export const FAKE_CLAUDE_PATH = 'C:\\fake\\claude.exe';
export const FAKE_CLAUDE_VERSION = '2.1.300';

export interface FakeClaudeIntegrationOptions {
  /** Default: only the built-in profile "Standard". Ignored when `store` is given. */
  profiles?: readonly Profile[];
  /**
   * Phase 2 (WP-34): an existing store (e.g. the persistent profile store of WP-32) – it wins over
   * `profiles`; `checkProfile` writes the ok status into it.
   */
  store?: MutableProfileStore;
  /** Overrides ProfileSummary.allowsBypass and LaunchSpec.allowDangerouslySkipPermissions (C.3). */
  allowsBypass?: boolean;
  /**
   * Test seam (WP-34): env of every console spec (`env` and `explicitEnv`), e.g. a fake secret that
   * must never reach a log, an op or an item. Default {}.
   */
  consoleEnv?: Readonly<Record<string, string>>;
  now?: () => Date;
}

export interface FakeClaudeIntegration extends ClaudeIntegration {
  readonly profiles: ProfileStore;
  /** Every launchSpecFor call. */
  readonly launches: readonly { profileId: ProfileId; entryId: EntryId }[];
  /** Every consoleLaunchFor call (Phase 2). */
  readonly consoleLaunches: readonly ConsoleLaunchRequest[];
  /**
   * Test: launchSpecFor and consoleLaunchFor throw CommandError(error) until reset with null (e.g.
   * CLAUDE_NOT_FOUND).
   */
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
  const store: MutableProfileStore = options.store ?? createProfileStore(options.profiles);
  for (const profile of store.list()) store.setClaudeStatus(profile.id, okStatus(now()));
  const launches: { profileId: ProfileId; entryId: EntryId }[] = [];
  const consoleLaunches: ConsoleLaunchRequest[] = [];
  const consoleEnv = { ...options.consoleEnv };
  let launchError: ErrorPayload | null = null;

  const bypassOverride = (summary: ProfileSummary): ProfileSummary =>
    options.allowsBypass === undefined ? summary : { ...summary, allowsBypass: options.allowsBypass };

  const profiles: ProfileStore = {
    list: () => store.list(),
    get: (id) => store.get(id),
    getDefault: () => store.getDefault(),
    summaries: () => store.summaries().map(bypassOverride),
  };

  /** The profile of a launch, or the error the launch fails with (set launch error first). */
  const launchProfile = (profileId: ProfileId): Profile | CommandError => {
    if (launchError !== null) return new CommandError(launchError);
    return store.get(profileId) ?? new CommandError(makeError('PROFILE_NOT_FOUND', { profileId }));
  };

  return {
    profiles,
    launches,
    consoleLaunches,

    setLaunchError(error) {
      launchError = error;
    },

    launchSpecFor(profileId, entryId) {
      launches.push({ profileId, entryId });
      const profile = launchProfile(profileId);
      if (profile instanceof CommandError) return Promise.reject(profile);
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

    // Phase 2 (WP-34): what the fake console (system/fakeConsole.ts) gets – `claude --resume <id>`.
    consoleLaunchFor(req) {
      consoleLaunches.push({ ...req });
      const profile = launchProfile(req.profileId);
      if (profile instanceof CommandError) return Promise.reject(profile);
      const spec: ConsoleLaunchSpec = {
        executablePath: FAKE_CLAUDE_PATH,
        args: ['--resume', req.resumeSessionId],
        env: { ...consoleEnv },
        explicitEnv: { ...consoleEnv },
        cwd: req.cwd,
      };
      return Promise.resolve(spec);
    },
  };
}
