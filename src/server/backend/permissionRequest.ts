/**
 * `canUseTool(toolName, input, options)` → port `PermissionRequest` (WP-13 §3.1, F.3). Shared by
 * SdkBackend (13c) and FakeBackend (13a). Tolerant: untyped keys (`decisionReasonType`,
 * `requiresUserInteraction`) are taken over, invalid `suggestions` are dropped (logged), wrong
 * types become null/false – this function never throws. `raw` = every option key except `signal`.
 */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { permissionModeSchema } from '@shared/common';
import { logger } from '../lib/logger';
import type { PermissionRequest } from './types';

const log = logger.child({ module: 'permissionRequest' });

const destinationSchema = z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);
const behaviorSchema = z.enum(['allow', 'deny', 'ask']);
const ruleSchema = z.object({ toolName: z.string(), ruleContent: z.string().optional() });
const rulesUpdate = <T extends 'addRules' | 'replaceRules' | 'removeRules'>(type: T) =>
  z.object({
    type: z.literal(type),
    rules: z.array(ruleSchema),
    behavior: behaviorSchema,
    destination: destinationSchema,
  });
const directoriesUpdate = <T extends 'addDirectories' | 'removeDirectories'>(type: T) =>
  z.object({ type: z.literal(type), directories: z.array(z.string()), destination: destinationSchema });

/** SDK 0.3.296 `PermissionUpdate` (unknown keys are stripped). */
export const permissionUpdateSchema: z.ZodType<PermissionUpdate> = z.discriminatedUnion('type', [
  rulesUpdate('addRules'),
  rulesUpdate('replaceRules'),
  rulesUpdate('removeRules'),
  z.object({ type: z.literal('setMode'), mode: permissionModeSchema, destination: destinationSchema }),
  directoriesUpdate('addDirectories'),
  directoriesUpdate('removeDirectories'),
]);

const optString = z.string().optional().catch(undefined);
const optBoolean = z.boolean().optional().catch(undefined);

const optionsSchema = z.looseObject({
  toolUseID: optString,
  requestId: optString,
  agentID: optString,
  suggestions: z.array(z.unknown()).optional().catch(undefined),
  blockedPath: optString,
  decisionReason: optString,
  decisionReasonType: optString,
  title: optString,
  displayName: optString,
  description: optString,
  defaultToNo: optBoolean,
  suppressAlwaysAllowRule: optBoolean,
  requiresUserInteraction: optBoolean,
  mcpServer: z.object({ name: z.string(), source: z.string() }).optional().catch(undefined),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** All option keys except `signal` (AbortSignal is not data). */
function rawOptions(options: unknown): Record<string, unknown> {
  if (!isRecord(options)) return {};
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== 'signal') raw[key] = value;
  }
  return raw;
}

function validSuggestions(toolName: string, suggestions: readonly unknown[] | undefined): PermissionUpdate[] {
  const valid: PermissionUpdate[] = [];
  (suggestions ?? []).forEach((suggestion, index) => {
    const parsed = permissionUpdateSchema.safeParse(suggestion);
    if (parsed.success) {
      valid.push(parsed.data);
      return;
    }
    const issue = parsed.error.issues[0];
    log.warn(
      {
        toolName,
        index,
        issue: `${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? 'invalid'}`,
      },
      'invalid permission suggestion dropped',
    );
  });
  return valid;
}

export function toPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: unknown,
): PermissionRequest {
  const raw = rawOptions(options);
  const parsed = optionsSchema.safeParse(raw);
  // looseObject + catch on every field: only a non-object fails, and rawOptions() returns one.
  const o = parsed.success ? parsed.data : optionsSchema.parse({});
  if (o.toolUseID === undefined || o.requestId === undefined) {
    log.warn(
      { toolName, toolUseID: o.toolUseID ?? null, requestId: o.requestId ?? null },
      'canUseTool without ids',
    );
  }
  return {
    toolName,
    input,
    toolUseId: o.toolUseID ?? '',
    requestId: o.requestId ?? '',
    agentId: o.agentID ?? null,
    suggestions: validSuggestions(toolName, o.suggestions),
    blockedPath: o.blockedPath ?? null,
    decisionReason: o.decisionReason ?? null,
    decisionReasonType: o.decisionReasonType ?? null,
    title: o.title ?? null,
    displayName: o.displayName ?? null,
    description: o.description ?? null,
    defaultToNo: o.defaultToNo === true,
    suppressAlwaysAllowRule: o.suppressAlwaysAllowRule === true,
    requiresUserInteraction: o.requiresUserInteraction === true,
    mcpServer: o.mcpServer ?? null,
    raw,
  };
}
