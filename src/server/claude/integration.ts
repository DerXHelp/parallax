/**
 * ClaudeIntegration (port `./ports.ts`; WP-11 implements, WP-13 uses, WP-20 wires):
 * - launchSpecFor: profile check (error issues → PROFILE_INVALID, ADR-102) + parseProfileArgs +
 *   buildEnv(entryId) + resolveClaude (cached) → LaunchSpec.
 * - consoleLaunchFor (Phase 2, ADR-104): the same checks and executable, buildEnv(target
 *   'terminal'), `profile.args` + `--resume <id>` (+ --model / --permission-mode / --settings).
 * - checkProfile ("Profil testen", preflight, server start): `claude --version` and
 *   `claude auth status --json` with exactly the env of a real start (buildEnv). Never logs or
 *   returns e-mail/org (parseAuthStatus drops them, F.17).
 * The resolution cache is per profile and keyed by what resolves the executable; a persistent
 * profile store (profileStore.ts) drops stale entries on every change (ADR-102).
 */
import { makeError, type ErrorPayload } from '@shared/errors';
import type { EntryId, ProfileId } from '@shared/common';
import type { ClaudeInstallStatus, Profile } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { logger } from '../lib/logger';
import { errnoCode, runFile, type RunFileFn } from '../lib/process';
import { readPersistentEnvironment, type PersistentEnvironment } from '../lib/registry';
import { getEnvVar, nodeFsProbe, searchPath, type FsProbe } from '../lib/windows';
import { CommandError } from '../sync/ports';
import { parseAuthStatus, UNKNOWN_AUTH, type AuthStatusView } from './authStatus';
import { buildEnv, buildEnvReport, clientAppId, setEnvVar } from './env';
import { parseProfileArgs } from './profileArgs';
import { errorCount, profileIssues } from './profileIssues';
import type { PersistentProfileStore } from './profileStore';
import {
  createProfileStore,
  profileResolutionKey,
  registerEnvSecrets,
  type MutableProfileStore,
} from './profiles';
import type { ClaudeIntegration, ConsoleLaunchRequest, ConsoleLaunchSpec, LaunchSpec } from './ports';
import { cliVersionStatus, readSdkManifest, resolveClaude, type ResolveClaudeResult } from './resolveClaude';

export const AUTH_STATUS_TIMEOUT_MS = 20_000;
const DEFAULT_RESOLVE_CACHE_MS = 5 * 60_000;

export interface ClaudeIntegrationDeps {
  /** Parallax version (package.json) → CLAUDE_AGENT_SDK_CLIENT_APP=parallax/<version>. */
  appVersion: string;
  /**
   * Default: only the built-in profile "Standard" (in memory). A persistent store (openProfileStore)
   * also invalidates the resolution cache of changed profiles.
   */
  profiles?: PersistentProfileStore | MutableProfileStore;
  /** Base environment, read at every call (default: process.env). */
  baseEnv?: () => Readonly<Record<string, string | undefined>>;
  /**
   * Persistent environment for the buildEnv exception (ADR-021), read once per integration and
   * cached (default: HKCU/HKLM `Environment` via reg.exe, errors → no exception). Tests inject.
   */
  persistentEnv?: () => Promise<PersistentEnvironment | null>;
  /** Guarded real file system by default. */
  fs?: FsProbe;
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
  /** resolutionKey() of the profile the result belongs to. */
  key: string;
  result: Extract<ResolveClaudeResult, { ok: true }>;
}

/** Everything the resolution of a profile depends on (executable, env incl. PATH, config dir). */
const resolutionKey = profileResolutionKey;

/**
 * ADR-124 (R4-07): the values of the profile's secret env names as the built env carries them
 * (`${env:NAME}` resolved) are registered with the log redaction at every launch spec, profile
 * check and console spec – not only for the console. Returns those values (name → value).
 */
function registerProfileSecrets(
  profile: Profile,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const name of Object.keys(profile.env)) {
    const value = getEnvVar(env, name);
    if (value !== undefined) resolved[name] = value;
  }
  registerEnvSecrets(resolved);
  return resolved;
}

function notifiesChanges(
  store: MutableProfileStore,
): store is MutableProfileStore & Pick<PersistentProfileStore, 'onChange'> {
  return 'onChange' in store && typeof store.onChange === 'function';
}

export function createClaudeIntegration(deps: ClaudeIntegrationDeps): ClaudeIntegrationImpl {
  const profiles = deps.profiles ?? createProfileStore();
  const baseEnv = deps.baseEnv ?? (() => process.env);
  const fs = deps.fs ?? nodeFsProbe;
  const readPersistent = deps.persistentEnv ?? (() => readPersistentEnvironment({ env: baseEnv() }));
  let persistentCache: Promise<PersistentEnvironment | null> | undefined;
  /** Read once, cached; a failing source means "no exception" (fail closed). */
  const persistentEnv = (): Promise<PersistentEnvironment | null> => {
    persistentCache ??= readPersistent().catch((error: unknown) => {
      logger.debug({ err: error }, 'persistent environment unreadable – no buildEnv exception');
      return null;
    });
    return persistentCache;
  };
  const where =
    deps.where ?? ((name: string, env: Readonly<Record<string, string>>) => searchPath(name, env, fs));
  const run = deps.runFile ?? runFile;
  const now = deps.now ?? (() => new Date());
  const cacheMs = deps.resolveCacheMs ?? DEFAULT_RESOLVE_CACHE_MS;
  const clientApp = clientAppId(deps.appVersion);
  const cache = new Map<ProfileId, CacheEntry>();
  /** Keyed by profile id + resolutionKey: a changed profile never joins an older resolution. */
  const inFlight = new Map<string, Promise<ResolveClaudeResult>>();
  let requiredVersion: Promise<string | null> | undefined;

  if (notifiesChanges(profiles)) {
    profiles.onChange(() => {
      for (const [id, entry] of cache) {
        const current = profiles.get(id);
        if (current !== undefined && resolutionKey(current) === entry.key) continue;
        cache.delete(id);
        logger.debug({ profileId: id }, 'claude resolution cache dropped (profile changed)');
      }
    });
  }

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
    const key = resolutionKey(profile);
    const flight = `${profile.id}\n${key}`;
    const pending = inFlight.get(flight);
    if (pending !== undefined) return pending;
    const promise = resolveClaude(profile, {
      ...fs,
      where: (name) => where(name, env),
      runFile: run,
      env,
      ...(deps.versionTimeoutMs === undefined ? {} : { versionTimeoutMs: deps.versionTimeoutMs }),
    })
      .then((result) => {
        if (result.ok) cache.set(profile.id, { at: now().getTime(), key, result });
        else if (cache.get(profile.id)?.key === key) cache.delete(profile.id);
        return result;
      })
      .finally(() => {
        inFlight.delete(flight);
      });
    inFlight.set(flight, promise);
    return promise;
  };

  const resolveCached = async (
    profile: Profile,
    env: Record<string, string>,
  ): Promise<ResolveClaudeResult> => {
    const hit = cache.get(profile.id);
    if (
      hit?.key === resolutionKey(profile) &&
      now().getTime() - hit.at < cacheMs &&
      (await fs.isFile(hit.result.path))
    )
      return hit.result;
    return resolveFresh(profile, env);
  };

  /**
   * ADR-102: error issues block a start (PROFILE_INVALID {count}). The executable's existence is
   * left to the resolution (CLAUDE_NOT_FOUND with the reason); `${env:NAME}` fails in buildEnv.
   */
  const assertUsable = async (profile: Profile): Promise<void> => {
    const issues = profileIssues(profile, {
      env: baseEnv(),
      persistentEnv: (await persistentEnv()) ?? new Map<string, string>(),
      exists: () => true,
    });
    const count = errorCount(issues);
    if (count > 0) throw new CommandError(makeError('PROFILE_INVALID', { count }));
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
    const report = buildEnvReport({
      base: baseEnv(),
      profile,
      entryId: null,
      clientApp,
      persistent: await persistentEnv(),
    });
    const envIssue = report.issues[0];
    if (envIssue !== undefined) return { ...status, error: envIssue };
    // CLI stderr/stdout of the check may be logged: its secrets are known first (ADR-124).
    registerProfileSecrets(profile, report.env);

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
      await assertUsable(profile);
      const args = parseProfileArgs(profile.args, profile.passRawArgs);
      const env = buildEnv({
        base: baseEnv(),
        profile,
        entryId,
        clientApp,
        persistent: await persistentEnv(),
      });
      // ADR-124: before anything of this start can be logged (CLI stderr, spawn errors).
      registerProfileSecrets(profile, env);
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

    async consoleLaunchFor(req: ConsoleLaunchRequest): Promise<ConsoleLaunchSpec> {
      const profile = requireProfile(req.profileId);
      const cwdIssue = windowsPathIssue(req.cwd);
      if (cwdIssue !== null) {
        throw new CommandError(makeError('PATH_REJECTED', { reason: cwdIssue, field: 'cwd' }));
      }
      await assertUsable(profile);
      const parsed = parseProfileArgs(profile.args, profile.passRawArgs);
      const env = buildEnv({
        base: baseEnv(),
        profile,
        entryId: req.entryId,
        clientApp,
        persistent: await persistentEnv(),
        target: 'terminal',
      });
      // Only what the profile sets, resolved as the console sees it (`${env:NAME}`), + the config
      // dir; its secrets are registered first (ADR-124).
      const explicitEnv = registerProfileSecrets(profile, env);
      const resolved = await resolveCached(profile, env);
      if (!resolved.ok) throw new CommandError(resolved.error);
      if (profile.configDir !== null) setEnvVar(explicitEnv, 'CLAUDE_CONFIG_DIR', profile.configDir);

      // profile.args are C.12-checked; the CLI takes them as written (bypass flags included).
      const args = [...profile.args, '--resume', req.resumeSessionId];
      if (req.model !== null && parsed.sdkOptions.model === undefined) args.push('--model', req.model);
      if (req.permissionMode !== null && parsed.sdkOptions.permissionMode === undefined) {
        args.push('--permission-mode', req.permissionMode);
      }
      if (profile.contextWindow !== null) {
        if (parsed.sdkOptions.settings === undefined) {
          args.push('--settings', JSON.stringify({ autoCompactWindow: profile.contextWindow }));
        } else {
          logger.warn(
            { profileId: profile.id },
            'profile args set --settings: the console gets no autoCompactWindow for contextWindow',
          );
        }
      }
      logger.debug(
        { profileId: profile.id, entryId: req.entryId, executable: resolved.path, args: args.length },
        'claude console launch spec',
      );
      return { executablePath: resolved.path, args, env, explicitEnv, cwd: req.cwd };
    },
  };
}
