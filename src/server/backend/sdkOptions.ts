/**
 * Pure mapping StartSessionRequest → SDK `Options` (WP-13 §3.2, table-tested in sdkOptions.test.ts;
 * the full table with sources is in docs/wp/WP-13c.md). No I/O, no logging: issues the backend
 * should log come from `optionIssues`, the post-start flag settings from `flagSettingsAfterStart`.
 *
 * Phase 3 (WP-52): `perTaskStopAffordance` (stop per task, ADR-149) and `agentProgressSummaries`
 * (task_progress.summary) are always on; `additionalDirectories` gets the entry's attachment
 * folder. WP61-02: `todoFeatureEnabled` is NOT sent – with CLI 2.1.322 it has no effect (neither
 * `TodoWrite` nor `TaskCreate` in `init.tools`); todo lists from the stream still reach the task bar.
 *
 * WP-69: `includeHookEvents` is always on (every hook run as hook_started/hook_response; the
 * transcript filters by `settings.hookDisplay`) – takes effect from the next process start.
 *
 * WP-64: extraArgs 'replay-user-messages' is always set (F.9): Remote Control can be switched at
 * runtime, and only the replay shows the text of a prompt sent from the Claude app. The normalizer drops
 * the echoes of Parallax's own prompts (same uuid); queue and "grey until processed" keep using
 * command_lifecycle.
 *
 * Deliberately NOT set: enableFileCheckpointing, sessionId, forkSession, maxTurns, abortController
 * (close() goes through Query.close() + the spawn wrapper, C.8).
 */
import type {
  CanUseTool,
  Options,
  SdkBeta,
  SdkPluginConfig,
  Settings,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { windowsPathsEqual } from '@shared/paths';
import type { LaunchSpec } from '../claude/ports';
import type { LoginRequest, StartSessionRequest } from './types';

export interface QueryOptionHooks {
  /** Wrapper around req.canUseTool (toPermissionRequest + error handling, sdkBackend.ts). */
  canUseTool: CanUseTool;
  /** spawnClaudeCodeProcess wrapper (spawn.ts). */
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /** Never called by the SDK with an own spawn (F.16); kept as a second path into the log. */
  stderr: (data: string) => void;
}

/** `settingSources` of every Parallax session (plan "SessionManager"). */
export const SETTING_SOURCES: NonNullable<Options['settingSources']> = ['user', 'project', 'local'];

function nonEmpty<T>(values: readonly T[] | undefined): values is readonly T[] {
  return values !== undefined && values.length > 0;
}

/** Syntax of an Anthropic beta header value, e.g. `context-1m-2025-08-07`. */
const BETA_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Profile string → `SdkBeta` (R2-11). `SdkBeta` lists only the betas known to this SDK version,
 * but the CLI passes any beta header through – hence the one deliberate type assertion of the
 * engine, guarded by the header syntax. Invalid values → null (dropped, reported by `optionIssues`).
 */
function asSdkBeta(beta: string): SdkBeta | null {
  return BETA_PATTERN.test(beta) ? (beta as SdkBeta) : null;
}

function betasOf(betas: readonly string[]): SdkBeta[] {
  return betas.flatMap((beta) => {
    const value = asSdkBeta(beta);
    return value === null ? [] : [value];
  });
}

/**
 * Bypass needs `allowDangerouslySkipPermissions` at query start (C.3). The manager only passes
 * `bypassPermissions` with `allowsBypass`; without the launch flag the mode is dropped here too
 * (defense in depth – the CLI picks its own start mode, `optionIssues` reports it).
 */
function permissionModeOf(req: StartSessionRequest): Options['permissionMode'] {
  if (req.permissionMode === null) return undefined;
  if (req.permissionMode === 'bypassPermissions' && !req.launch.allowDangerouslySkipPermissions) {
    return undefined;
  }
  return req.permissionMode;
}

/** Flag-tier settings Parallax sets at the start (`Settings` keys of SDK 0.3.322). */
export type StartFlagSettings = Pick<Settings, 'autoCompactWindow' | 'fastMode'>;

/**
 * Flag-tier settings of the start: the profile's `autoCompactWindow` (C.1) and the entry's fast
 * mode (Phase 2, `settings.fastMode`; null/absent = the CLI decides). Null when there is none
 * (WP61-02: no setting without a value is sent).
 */
export function startFlagSettings(req: StartSessionRequest): StartFlagSettings | null {
  const flags: StartFlagSettings = {};
  if (req.launch.autoCompactWindow !== null) flags.autoCompactWindow = req.launch.autoCompactWindow;
  if (req.fastMode !== undefined && req.fastMode !== null) flags.fastMode = req.fastMode;
  return Object.keys(flags).length > 0 ? flags : null;
}

/** Profile directories + the attachment folder, without duplicates (case-insensitive, WP-52). */
function additionalDirectoriesOf(req: StartSessionRequest): string[] {
  const dirs: string[] = [];
  const candidates = [...(req.launch.sdkOptions.additionalDirectories ?? [])];
  if (req.attachmentsDir !== undefined && req.attachmentsDir !== null && req.attachmentsDir !== '') {
    candidates.push(req.attachmentsDir);
  }
  for (const dir of candidates) {
    if (!dirs.some((known) => windowsPathsEqual(known, dir))) dirs.push(dir);
  }
  return dirs;
}

function settingsOf(req: StartSessionRequest): Options['settings'] {
  return req.launch.sdkOptions.settings ?? startFlagSettings(req) ?? undefined;
}

/** WP-64: CLI flag behind the user-message replays (F.9), always on. */
export const REPLAY_USER_MESSAGES_FLAG = 'replay-user-messages';

function extraArgsOf(launch: LaunchSpec): Record<string, string | null> {
  const args: Record<string, string | null> = { ...launch.extraArgs };
  const mcpConfig = launch.sdkOptions.mcpConfig?.[0];
  // extraArgs is a record (C.12): one value per flag. Further values: optionIssues (Phase 2, §7).
  if (mcpConfig !== undefined) args['mcp-config'] = mcpConfig;
  args[REPLAY_USER_MESSAGES_FLAG] = null;
  return args;
}

/** WP-13 §3.2 "Options-Abbildung". Keys with "omit" semantics are left out entirely. */
export function buildQueryOptions(req: StartSessionRequest, hooks: QueryOptionHooks): Options {
  const { launch } = req;
  const sdk = launch.sdkOptions;
  const options: Options = {
    cwd: req.cwd,
    pathToClaudeCodeExecutable: launch.executablePath,
    // The SDK mutates the object it gets (CLAUDE_CODE_ENTRYPOINT, NODE_OPTIONS, DEBUG): pass a copy.
    env: { ...launch.env },
    settingSources: [...SETTING_SOURCES],
    systemPrompt:
      sdk.appendSystemPrompt === undefined
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: sdk.appendSystemPrompt },
    includePartialMessages: true,
    thinking: { type: 'adaptive', display: 'summarized' },
    toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    promptSuggestions: req.promptSuggestions,
    // Phase 3 (WP-52, F4/F5): stop a single task; summaries in task_progress for the task panel.
    perTaskStopAffordance: true,
    agentProgressSummaries: true,
    // WP-69: hook_started/hook_response of every hook (not only SessionStart/Setup); the transcript
    // shows them according to `settings.hookDisplay`.
    includeHookEvents: true,
    canUseTool: hooks.canUseTool,
    stderr: hooks.stderr,
    spawnClaudeCodeProcess: hooks.spawn,
  };

  const permissionMode = permissionModeOf(req);
  if (permissionMode !== undefined) options.permissionMode = permissionMode;
  if (launch.allowDangerouslySkipPermissions) options.allowDangerouslySkipPermissions = true;
  if (req.model !== null) options.model = req.model;
  if (req.effort !== null) options.effort = req.effort;
  if (req.resumeSessionId !== null) options.resume = req.resumeSessionId;

  const additionalDirectories = additionalDirectoriesOf(req);
  if (additionalDirectories.length > 0) options.additionalDirectories = additionalDirectories;
  if (nonEmpty(sdk.allowedTools)) options.allowedTools = [...sdk.allowedTools];
  if (nonEmpty(sdk.disallowedTools)) options.disallowedTools = [...sdk.disallowedTools];
  const betas = betasOf(sdk.betas ?? []);
  if (betas.length > 0) options.betas = betas;
  if (nonEmpty(sdk.plugins)) {
    options.plugins = sdk.plugins.map((path): SdkPluginConfig => ({ type: 'local', path }));
  }

  const settings = settingsOf(req);
  if (settings !== undefined) options.settings = settings;
  options.extraArgs = extraArgsOf(launch);
  return options;
}

/**
 * WP-70: options of a login process (no prompt is ever sent): the profile's executable, env and
 * config folder, a neutral cwd, no settings sources (managed settings still apply – `forceLoginMethod`,
 * `allowedProviders`), no MCP servers, no transcript (`persistSession: false`), no profile args.
 */
export function buildLoginOptions(req: LoginRequest, hooks: QueryOptionHooks): Options {
  return {
    cwd: req.cwd,
    pathToClaudeCodeExecutable: req.launch.executablePath,
    // The SDK mutates the object it gets: pass a copy.
    env: { ...req.launch.env },
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    canUseTool: hooks.canUseTool,
    stderr: hooks.stderr,
    spawnClaudeCodeProcess: hooks.spawn,
  };
}

/**
 * C.1 (+ Phase 2 fast mode): with a settings FILE the flag settings (`autoCompactWindow`,
 * `fastMode`) cannot ride along in `settings`; the backend applies them via `applyFlagSettings`
 * once the session is ready. Null when there is nothing to apply.
 */
export function flagSettingsAfterStart(req: StartSessionRequest): StartFlagSettings | null {
  if (req.launch.sdkOptions.settings === undefined) return null;
  return startFlagSettings(req);
}

/** Things `buildQueryOptions` could not map as configured (English, for the log). */
export function optionIssues(req: StartSessionRequest): string[] {
  const issues: string[] = [];
  const mcpConfigs = req.launch.sdkOptions.mcpConfig ?? [];
  if (mcpConfigs.length > 1) {
    issues.push(
      `only the first of ${mcpConfigs.length} --mcp-config values is passed (extraArgs holds one value per flag)`,
    );
  }
  if (req.permissionMode === 'bypassPermissions' && !req.launch.allowDangerouslySkipPermissions) {
    issues.push('permissionMode bypassPermissions without allowDangerouslySkipPermissions is omitted');
  }
  const invalidBetas = (req.launch.sdkOptions.betas ?? []).filter((beta) => asSdkBeta(beta) === null);
  if (invalidBetas.length > 0) {
    issues.push(
      `invalid beta names are omitted: ${invalidBetas.map((beta) => JSON.stringify(beta)).join(', ')}`,
    );
  }
  return issues;
}
