/**
 * Port: Claude integration (WP-11 implements, WP-13 uses). Types only; frozen like src/shared.
 * Design: docs/wp/WP-02.md §9.1. Module names of WP-11 (fixed): resolveClaude.ts, env.ts,
 * profileArgs.ts, profiles.ts, authStatus.ts, integration.ts, preflight.ts.
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

/** Result of `parseProfileArgs(args, passRaw)` (WP-11). */
export interface ProfileArgsResult {
  sdkOptions: ProfileSdkOptions;
  /** C.12: a record, one value per flag (null = flag without value). */
  extraArgs: Record<string, string | null>;
  /** C.3: profile bypass flags are mapped here, never to extraArgs. */
  allowDangerouslySkipPermissions: boolean;
  /** E.g. blanket --allowedTools (C.12). */
  warnings: ErrorPayload[];
  /** Blocked flags → the profile is invalid. */
  errors: ErrorPayload[];
}

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
  /** resolveClaude (cached) + buildEnv(entryId) + parseProfileArgs; throws CommandError(CLAUDE_NOT_FOUND …). */
  launchSpecFor(profileId: ProfileId, entryId: EntryId): Promise<LaunchSpec>;
  /** `claude --version` + `claude auth status --json` (F.17); never logs e-mail/org. */
  checkProfile(profileId: ProfileId): Promise<ClaudeInstallStatus>;
}
