/**
 * ClaudeIntegration (port `./ports.ts`; WP-11 implements, WP-13 uses, WP-20 wires):
 * - launchSpecFor: parseProfileArgs + buildEnv(entryId) + resolveClaude (cached) → LaunchSpec.
 * - checkProfile ("Profil testen", preflight, server start): `claude --version` and
 *   `claude auth status --json` with exactly the env of a real start (buildEnv). Never logs or
 *   returns e-mail/org (parseAuthStatus drops them, F.17).
 */
import { makeError, type ErrorPayload } from '@shared/errors';
import type { EntryId, ProfileId } from '@shared/common';
import type { ClaudeInstallStatus, Profile } from '@shared/model';
import { logger } from '../lib/logger';
import { errnoCode, runFile } from '../lib/process';
import { CommandError } from '../sync/ports';
import { parseAuthStatus, UNKNOWN_AUTH, type AuthStatusView } from './authStatus';
import { buildEnv, buildEnvReport, clientAppId } from './env';
import { parseProfileArgs } from './profileArgs';
import { createProfileStore, type MutableProfileStore } from './profiles';
import type { ClaudeIntegration, LaunchSpec } from './ports';
import {
  cliVersionStatus,
  nodeFsDeps,
  readSdkManifest,
  resolveClaude,
  searchPath,
  type ClaudeFsDeps,
  type ResolveClaudeResult,
  type RunFileFn,
} from './resolveClaude';

export const AUTH_STATUS_TIMEOUT_MS = 20_000;
const DEFAULT_RESOLVE_CACHE_MS = 5 * 60_000;

export interface ClaudeIntegrationDeps {
  /** Parallax version (package.json) → CLAUDE_AGENT_SDK_CLIENT_APP=parallax/<version>. */
  appVersion: string;
  /** Default: only the built-in profile "Standard". */
  profiles?: MutableProfileStore;
  /** Base environment, read at every call (default: process.env). */
  baseEnv?: () => Readonly<Record<string, string | undefined>>;
  /** Guarded real file system by default. */
  fs?: ClaudeFsDeps;
  /** `where claude` over the built env; default: in-process PATH search (searchPath). */
  where?: (name: string, env: Readonly<Record<string, string>>) => Promise<string[]>;
  runFile?: RunFileFn;
  /** Minimum CLI version (SDK package.json#claudeCodeVersion); default: read from the installed SDK. */
  sdkClaudeCodeVersion?: string | null;
  now?: () => Date;
  /** How long launchSpecFor reuses a resolved executable (default 5 min; the path is re-checked). */
  resolveCacheMs?: number;
  versionTimeoutMs?: number;
  authTimeoutMs?: number;
}

export interface ClaudeIntegrationImpl extends ClaudeIntegration {
  readonly profiles: MutableProfileStore;
}

/** True when sessions of this profile cannot run (claude missing/broken, not logged in) → setup screen. */
export function profileNeedsSetup(status: ClaudeInstallStatus): boolean {
  return status.state !== 'ok' || status.auth.state !== 'logged_in';
}

interface CacheEntry {
  at: number;
  result: Extract<ResolveClaudeResult, { ok: true }>;
}

export function createClaudeIntegration(deps: ClaudeIntegrationDeps): ClaudeIntegrationImpl {
  const profiles = deps.profiles ?? createProfileStore();
  const baseEnv = deps.baseEnv ?? (() => process.env);
  const fs = deps.fs ?? nodeFsDeps;
  const where =
    deps.where ?? ((name: string, env: Readonly<Record<string, string>>) => searchPath(name, env, fs));
  const run = deps.runFile ?? runFile;
  const now = deps.now ?? (() => new Date());
  const cacheMs = deps.resolveCacheMs ?? DEFAULT_RESOLVE_CACHE_MS;
  const clientApp = clientAppId(deps.appVersion);
  const cache = new Map<ProfileId, CacheEntry>();
  const inFlight = new Map<ProfileId, Promise<ResolveClaudeResult>>();
  let requiredVersion: Promise<string | null> | undefined;

  const sdkClaudeCodeVersion = (): Promise<string | null> => {
    if (deps.sdkClaudeCodeVersion !== undefined) return Promise.resolve(deps.sdkClaudeCodeVersion);
    requiredVersion ??= readSdkManifest().then((manifest) => manifest?.claudeCodeVersion ?? null);
    return requiredVersion;
  };

  const requireProfile = (id: ProfileId): Profile => {
    const profile = profiles.get(id);
    if (profile === undefined) throw new CommandError(makeError('PROFILE_NOT_FOUND', { profileId: id }));
    return profile;
  };

  const resolveFresh = (profile: Profile, env: Record<string, string>): Promise<ResolveClaudeResult> => {
    const pending = inFlight.get(profile.id);
    if (pending !== undefined) return pending;
    const promise = resolveClaude(profile, {
      ...fs,
      where: (name) => where(name, env),
      runFile: run,
      env,
      ...(deps.versionTimeoutMs === undefined ? {} : { versionTimeoutMs: deps.versionTimeoutMs }),
    })
      .then((result) => {
        if (result.ok) cache.set(profile.id, { at: Date.now(), result });
        else cache.delete(profile.id);
        return result;
      })
      .finally(() => {
        inFlight.delete(profile.id);
      });
    inFlight.set(profile.id, promise);
    return promise;
  };

  const resolveCached = async (
    profile: Profile,
    env: Record<string, string>,
  ): Promise<ResolveClaudeResult> => {
    const hit = cache.get(profile.id);
    if (hit !== undefined && Date.now() - hit.at < cacheMs && (await fs.isFile(hit.result.path)))
      return hit.result;
    return resolveFresh(profile, env);
  };

  const readAuth = async (
    executable: string,
    env: Record<string, string>,
  ): Promise<{ view: AuthStatusView; error: ErrorPayload | null }> => {
    const failed = (reason: string, extra: Record<string, number | null> = {}) => ({
      view: { ...UNKNOWN_AUTH, state: 'error' as const },
      error: makeError('CLAUDE_AUTH_FAILED', { reason, ...extra }),
    });
    let stdout: string;
    let exitCode: number | null;
    try {
      const result = await run(executable, ['auth', 'status', '--json'], {
        env,
        timeoutMs: deps.authTimeoutMs ?? AUTH_STATUS_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024,
      });
      if (result.timedOut) return failed('timeout');
      stdout = result.stdout;
      exitCode = result.exitCode;
    } catch (error) {
      return failed(errnoCode(error) ?? 'spawn');
    }
    const view = parseAuthStatus(stdout);
    if (view.state === 'error') return failed('unparsable', { exitCode });
    if (view.state === 'logged_out') return { view, error: makeError('CLAUDE_NOT_LOGGED_IN') };
    return { view, error: null };
  };

  const check = async (profile: Profile): Promise<ClaudeInstallStatus> => {
    const status: ClaudeInstallStatus = {
      state: 'error',
      path: null,
      version: null,
      versionStatus: 'unknown',
      auth: { ...UNKNOWN_AUTH },
      error: null,
      checkedAt: now().toISOString(),
    };
    const report = buildEnvReport({ base: baseEnv(), profile, entryId: null, clientApp });
    const envIssue = report.issues[0];
    if (envIssue !== undefined) return { ...status, error: envIssue };

    const resolved = await resolveFresh(profile, report.env);
    if (!resolved.ok) return { ...status, state: 'not_found', error: resolved.error };
    const required = await sdkClaudeCodeVersion();
    const versionStatus = cliVersionStatus(resolved.version, required);
    const found = { ...status, path: resolved.path, version: resolved.version, versionStatus };
    if (resolved.versionError !== null) return { ...found, error: resolved.versionError };

    const auth = await readAuth(resolved.path, report.env);
    const tooOld =
      versionStatus === 'too_old'
        ? makeError('CLAUDE_VERSION_TOO_OLD', { version: resolved.version, required })
        : null;
    return { ...found, state: 'ok', auth: auth.view, error: auth.error ?? tooOld };
  };

  return {
    profiles,

    async launchSpecFor(profileId: ProfileId, entryId: EntryId): Promise<LaunchSpec> {
      const profile = requireProfile(profileId);
      const args = parseProfileArgs(profile.args, profile.passRawArgs);
      if (args.errors.length > 0) {
        throw new CommandError(makeError('PROFILE_INVALID', { count: args.errors.length }));
      }
      const env = buildEnv({ base: baseEnv(), profile, entryId, clientApp });
      const resolved = await resolveCached(profile, env);
      if (!resolved.ok) throw new CommandError(resolved.error);
      logger.debug(
        { profileId, entryId, executable: resolved.path, version: resolved.version, source: resolved.source },
        'claude launch spec',
      );
      return {
        profileId: profile.id,
        executablePath: resolved.path,
        executableVersion: resolved.version,
        env,
        configDir: profile.configDir,
        sdkOptions: args.sdkOptions,
        extraArgs: args.extraArgs,
        allowDangerouslySkipPermissions: args.allowDangerouslySkipPermissions,
        autoCompactWindow: profile.contextWindow,
        contextWindow: profile.contextWindow,
      };
    },

    async checkProfile(profileId: ProfileId): Promise<ClaudeInstallStatus> {
      const profile = requireProfile(profileId);
      const status = await check(profile);
      profiles.setClaudeStatus(profileId, status);
      logger.debug(
        {
          profileId,
          state: status.state,
          path: status.path,
          version: status.version,
          versionStatus: status.versionStatus,
          auth: status.auth,
          error: status.error?.code ?? null,
        },
        'claude profile checked',
      );
      return status;
    },
  };
}
