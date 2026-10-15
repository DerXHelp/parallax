/**
 * Pure mapping StartSessionRequest → SDK `Options` (WP-13 §3.2, table-tested in sdkOptions.test.ts;
 * the full table with sources is in docs/wp/WP-13c.md). No I/O, no logging: issues the backend
 * should log come from `optionIssues`, the post-start flag settings from `flagSettingsAfterStart`.
 *
 * Deliberately NOT set: enableFileCheckpointing, extraArgs 'replay-user-messages' (F.9),
 * perTaskStopAffordance (C.5, needs the task panel), sessionId, forkSession, maxTurns,
 * abortController (close() goes through Query.close() + the spawn wrapper, C.8).
 */
import type {
  CanUseTool,
  Options,
  SdkBeta,
  SdkPluginConfig,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { LaunchSpec } from '../claude/ports';
import type { StartSessionRequest } from './types';

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

function settingsOf(launch: LaunchSpec): Options['settings'] {
  const path = launch.sdkOptions.settings;
  if (path !== undefined) return path;
  if (launch.autoCompactWindow !== null) return { autoCompactWindow: launch.autoCompactWindow };
  return undefined;
}

function extraArgsOf(launch: LaunchSpec): Record<string, string | null> | undefined {
  const args: Record<string, string | null> = { ...launch.extraArgs };
  const mcpConfig = launch.sdkOptions.mcpConfig?.[0];
  // extraArgs is a record (C.12): one value per flag. Further values: optionIssues (Phase 2, §7).
  if (mcpConfig !== undefined) args['mcp-config'] = mcpConfig;
  return Object.keys(args).length > 0 ? args : undefined;
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

  if (nonEmpty(sdk.additionalDirectories)) options.additionalDirectories = [...sdk.additionalDirectories];
  if (nonEmpty(sdk.allowedTools)) options.allowedTools = [...sdk.allowedTools];
  if (nonEmpty(sdk.disallowedTools)) options.disallowedTools = [...sdk.disallowedTools];
  const betas = betasOf(sdk.betas ?? []);
  if (betas.length > 0) options.betas = betas;
  if (nonEmpty(sdk.plugins)) {
    options.plugins = sdk.plugins.map((path): SdkPluginConfig => ({ type: 'local', path }));
  }

  const settings = settingsOf(launch);
  if (settings !== undefined) options.settings = settings;
  const extraArgs = extraArgsOf(launch);
  if (extraArgs !== undefined) options.extraArgs = extraArgs;
  return options;
}

/**
 * C.1: with a settings FILE and a profile `autoCompactWindow`, the window cannot ride along in
 * `settings`; the backend applies it via `applyFlagSettings` once the session is ready.
 */
export function flagSettingsAfterStart(launch: LaunchSpec): { autoCompactWindow: number } | null {
  if (launch.sdkOptions.settings === undefined || launch.autoCompactWindow === null) return null;
  return { autoCompactWindow: launch.autoCompactWindow };
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
