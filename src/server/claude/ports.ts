/**
 * Port: Claude integration (WP-11 implements, WP-13 uses). Types only; frozen like src/shared.
 * Design: docs/wp/WP-02.md §9.1. Module names of WP-11 (fixed): resolveClaude.ts, env.ts,
 * profileArgs.ts, profiles.ts, authStatus.ts, integration.ts, preflight.ts – all in
 * src/server/claude/. Process spawning only via src/server/lib/process.ts (WP-11 owns it); path
 * checks only via @shared/paths (pure rules, no own path helper in claude/, R0-02).
 */
import type { EntryId, PermissionMode, ProfileId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile, ProfileSummary } from '@shared/model';

/** SDK options derived from profile args (C.12: multi-value flags → SDK options). */
export interface ProfileSdkOptions {
  model?: string;
  permissionMode?: PermissionMode;
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpConfig?: string[];
  settings?: string;
  appendSystemPrompt?: string;
  betas?: string[];
  plugins?: string[];
}

/**
 * `params` of every profile issue (R0-04): `index` = 0-based position in `profile.args` of the
 * flag, `flag` = the flag as written (e.g. '--add-dir'); plus `reason`
 * (PROFILE_ARG_INVALID: PROFILE_ARG_INVALID_REASONS) or `value` (PROFILE_ARG_BROAD_ALLOWED_TOOLS).
 * The Phase-2 profile editor marks the line `index` with the translated code.
 */
export interface ProfileArgIssueParams {
  [key: string]: string | number;
  index: number;
  flag: string;
}

/** Result of `parseProfileArgs(args, passRaw)` (WP-11). */
export interface ProfileArgsResult {
  sdkOptions: ProfileSdkOptions;
  /** C.12: a record, one value per flag (null = flag without value). */
  extraArgs: Record<string, string | null>;
  /** C.3: profile bypass flags are mapped here, never to extraArgs. */
  allowDangerouslySkipPermissions: boolean;
  /**
   * Severity warning/info codes: PROFILE_ARG_BROAD_ALLOWED_TOOLS, PROFILE_BYPASS_ENABLED,
   * PROFILE_ARG_RESUME_NO_EFFECT, PROFILE_ARG_PASSED_RAW (params: ProfileArgIssueParams).
   */
  warnings: ErrorPayload[];
  /**
   * PROFILE_ARG_BLOCKED, PROFILE_ARG_NOT_ALLOWED, PROFILE_ARG_INVALID (params:
   * ProfileArgIssueParams). Non-empty → the profile is invalid: launchSpecFor throws
   * CommandError(PROFILE_INVALID, {count}) and ProfileSummary shows the issues (Phase 2).
   */
  errors: ErrorPayload[];
}

/**
 * C.12 (WP-11 `claude/profileArgs.ts`, pure and table-tested, no UI in Phase 1): allowlist of
 * SDK-mapped flags, blocked flags of Parallax and C.12, `passRaw` = "roh durchreichen" (unknown
 * flags go to extraArgs with PROFILE_ARG_PASSED_RAW instead of PROFILE_ARG_NOT_ALLOWED).
 */
export type ParseProfileArgs = (args: readonly string[], passRaw: boolean) => ProfileArgsResult;

/** Everything needed to spawn `claude` for one entry (input of AgentBackend.start). */
export interface LaunchSpec {
  profileId: ProfileId;
  /** Only .exe (C.7). */
  executablePath: string;
  executableVersion: string | null;
  /** buildEnv(): cleaned, + PARALLAX=1, PARALLAX_ENTRY_ID … (C.2). */
  env: Record<string, string>;
  configDir: string | null;
  sdkOptions: ProfileSdkOptions;
  extraArgs: Record<string, string | null>;
  allowDangerouslySkipPermissions: boolean;
  /** C.1: profile contextWindow → settings.autoCompactWindow. */
  autoCompactWindow: number | null;
  /** Gauge override. */
  contextWindow: number | null;
}

export interface ProfileStore {
  list(): Profile[];
  get(id: ProfileId): Profile | undefined;
  getDefault(): Profile;
  /** Including the claude status of the last check. */
  summaries(): ProfileSummary[];
}

export interface ClaudeIntegration {
  readonly profiles: ProfileStore;
  /**
   * resolveClaude (cached) + buildEnv(entryId) + parseProfileArgs; throws CommandError
   * (CLAUDE_NOT_FOUND, PROFILE_INVALID, PROFILE_ENV_REF_UNRESOLVED {name, key} …).
   */
  launchSpecFor(profileId: ProfileId, entryId: EntryId): Promise<LaunchSpec>;
  /** `claude --version` + `claude auth status --json` (F.17); never logs e-mail/org. */
  checkProfile(profileId: ProfileId): Promise<ClaudeInstallStatus>;
}
