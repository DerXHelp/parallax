/**
 * Tolerant zod views of the raw SDK messages (SDK 0.3.296 / CLI 2.1.300, docs/sdk-findings.md).
 * Only the fields the normalizer reads are declared; every object is a `looseObject` (extra keys
 * are kept and ignored) and non-essential fields are wrapped in `opt()`, so a newer CLI that
 * changes or drops such a field degrades to "field missing" instead of rejecting the message.
 * Shared does not know SDK types (ADR-003): these schemas are the only place raw shapes live.
 */
import { z } from 'zod';

/** Optional field that never fails the surrounding object: a wrong type reads as `undefined`. */
export function opt<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

const str = z.string();
const num = z.number();
const bool = z.boolean();
const strArray = z.array(z.string());

// ---- Common pieces ----

export const sdkMessageBaseSchema = z.looseObject({
  type: z.string().min(1),
  subtype: opt(str),
  uuid: opt(str),
  session_id: opt(str),
});
export type SdkMessageBase = z.infer<typeof sdkMessageBaseSchema>;

export const usageSchema = z.looseObject({
  input_tokens: opt(num),
  output_tokens: opt(num),
  cache_creation_input_tokens: opt(num.nullable()),
  cache_read_input_tokens: opt(num.nullable()),
});
export type SdkUsage = z.infer<typeof usageSchema>;

export const contentBlockSchema = z.looseObject({ type: str });
export const textBlockSchema = z.looseObject({ type: z.literal('text'), text: str });
export const thinkingBlockSchema = z.looseObject({ type: z.literal('thinking'), thinking: opt(str) });
export const redactedThinkingBlockSchema = z.looseObject({ type: z.literal('redacted_thinking') });
export const TOOL_USE_BLOCK_TYPES = ['tool_use', 'server_tool_use', 'mcp_tool_use'] as const;
export const toolUseBlockSchema = z.looseObject({
  type: z.enum(TOOL_USE_BLOCK_TYPES),
  id: str,
  name: str,
  input: z.unknown().optional(),
});
export const imageBlockSchema = z.looseObject({
  type: z.literal('image'),
  source: z.looseObject({ type: opt(str), media_type: opt(str), data: opt(str) }),
});
export const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: str,
  content: opt(z.union([str, z.array(z.unknown())])),
  is_error: opt(bool),
});
export type SdkToolResultBlock = z.infer<typeof toolResultBlockSchema>;

// ---- stream_event (SDKPartialAssistantMessage) ----

export const streamEventMessageSchema = z.looseObject({
  type: z.literal('stream_event'),
  event: z.looseObject({ type: str }),
  parent_tool_use_id: opt(str.nullable()),
  /** Untyped (F.13): message id of the API message this event belongs to. */
  api_message_id: opt(str),
  user_message_uuids: opt(strArray),
});

export const messageStartEventSchema = z.looseObject({
  type: z.literal('message_start'),
  message: z.looseObject({ id: str, model: opt(str), usage: opt(usageSchema) }),
});
export const contentBlockStartEventSchema = z.looseObject({
  type: z.literal('content_block_start'),
  index: z.number().int().nonnegative(),
  content_block: contentBlockSchema,
});
export const contentBlockDeltaEventSchema = z.looseObject({
  type: z.literal('content_block_delta'),
  index: z.number().int().nonnegative(),
  delta: z.looseObject({ type: str, text: opt(str), thinking: opt(str), partial_json: opt(str) }),
});
export const contentBlockStopEventSchema = z.looseObject({
  type: z.literal('content_block_stop'),
  index: z.number().int().nonnegative(),
});
export const messageDeltaEventSchema = z.looseObject({
  type: z.literal('message_delta'),
  delta: opt(z.looseObject({ stop_reason: opt(str.nullable()) })),
  usage: opt(usageSchema),
});

// ---- assistant / user ----

export const assistantMessageSchema = z.looseObject({
  type: z.literal('assistant'),
  uuid: opt(str),
  message: z.looseObject({ id: opt(str), model: opt(str), content: z.array(z.unknown()) }),
  parent_tool_use_id: opt(str.nullable()),
  /** SDKAssistantMessageError as plain string. */
  error: opt(str),
  timestamp: opt(str),
  aborted: opt(bool),
  supersedes: opt(strArray),
  /** Untyped (F.8). */
  local_command_run: opt(z.looseObject({ command: str, args: opt(str) })),
  user_message_uuids: opt(strArray),
});
export type SdkAssistantMessage = z.infer<typeof assistantMessageSchema>;

export const toolResultMetaSchema = z.looseObject({
  id: opt(str),
  non_execution_kind: opt(str),
  permission_decision: opt(z.looseObject({ decision: opt(str), source: opt(str) })),
});
export type SdkToolResultMeta = z.infer<typeof toolResultMetaSchema>;

export const userMessageSchema = z.looseObject({
  type: z.literal('user'),
  uuid: opt(str),
  message: z.looseObject({ content: z.union([str, z.array(z.unknown())]) }),
  parent_tool_use_id: opt(str.nullable()),
  isReplay: opt(bool),
  isSynthetic: opt(bool),
  timestamp: opt(str),
  tool_use_result: z.unknown().optional(),
  /** Untyped: per tool_result id, how the permission check ended. */
  tool_result_meta: opt(z.array(toolResultMetaSchema)),
  origin: opt(z.looseObject({ kind: str })),
});
export type SdkUserMessage = z.infer<typeof userMessageSchema>;

// ---- result ----

export const resultMessageSchema = z.looseObject({
  type: z.literal('result'),
  subtype: str,
  uuid: opt(str),
  is_error: opt(bool),
  duration_ms: opt(num),
  duration_api_ms: opt(num),
  num_turns: opt(num),
  stop_reason: opt(str.nullable()),
  terminal_reason: opt(str),
  total_cost_usd: opt(num),
  usage: opt(usageSchema),
  modelUsage: opt(z.record(str, z.looseObject({ contextWindow: opt(num) }))),
  permission_denials: opt(z.array(z.unknown())),
  errors: opt(z.array(z.unknown())),
  result: opt(str),
  startup_failure_reason: opt(str),
  api_error_status: opt(num.nullable()),
  user_message_uuid: opt(str),
  user_message_uuids: opt(strArray),
});
export type SdkResultMessage = z.infer<typeof resultMessageSchema>;

// ---- system/* ----

export const initMessageSchema = z.looseObject({
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  cwd: opt(str),
  model: opt(str),
  permissionMode: z.unknown().optional(),
  apiKeySource: opt(str),
  claude_code_version: opt(str),
  tools: opt(strArray),
  slash_commands: opt(strArray),
  terminal_slash_commands: opt(strArray),
  mcp_servers: opt(z.array(z.looseObject({ name: str, status: str, source: opt(str) }))),
  skills: opt(strArray),
  agents: opt(strArray),
  plugins: opt(z.array(z.looseObject({ name: str, version: opt(str) }))),
  capabilities: opt(strArray),
  output_style: opt(str),
  fast_mode_state: opt(str),
  effort: z.unknown().optional(),
});
export type SdkInitMessage = z.infer<typeof initMessageSchema>;

export const statusMessageSchema = z.looseObject({
  subtype: z.literal('status'),
  status: z.unknown().optional(),
  permissionMode: z.unknown().optional(),
  user_message_uuids: opt(strArray),
});

export const sessionStateMessageSchema = z.looseObject({
  subtype: z.literal('session_state_changed'),
  state: str,
});

export const compactBoundaryMessageSchema = z.looseObject({
  subtype: z.literal('compact_boundary'),
  compact_metadata: opt(
    z.looseObject({ trigger: opt(str), pre_tokens: opt(num), post_tokens: opt(num) }),
  ),
});

export const apiRetryMessageSchema = z.looseObject({
  subtype: z.literal('api_retry'),
  attempt: opt(num),
  max_retries: opt(num),
  retry_delay_ms: opt(num),
  error_status: opt(num.nullable()),
  error: opt(str),
});

export const hookMessageSchema = z.looseObject({
  subtype: z.enum(['hook_started', 'hook_progress', 'hook_response']),
  hook_id: str,
  hook_name: opt(str),
  hook_event: opt(str),
  output: opt(str),
  stdout: opt(str),
  stderr: opt(str),
  outcome: opt(str),
});

export const informationalMessageSchema = z.looseObject({
  subtype: z.literal('informational'),
  content: opt(str),
  level: opt(str),
  tag: opt(str),
  prevent_continuation: opt(bool),
});

export const notificationMessageSchema = z.looseObject({
  subtype: z.literal('notification'),
  key: opt(str),
  text: opt(str),
  priority: opt(str),
});

export const permissionDeniedMessageSchema = z.looseObject({
  subtype: z.literal('permission_denied'),
  tool_name: opt(str),
  tool_use_id: opt(str),
  message: opt(str),
  decision_reason_type: opt(str),
});

export const memoryRecallMessageSchema = z.looseObject({
  subtype: z.literal('memory_recall'),
  mode: opt(str),
  memories: opt(z.array(z.looseObject({ path: opt(str), scope: opt(str), content: opt(str) }))),
});

export const localCommandOutputMessageSchema = z.looseObject({
  subtype: z.literal('local_command_output'),
  content: opt(str),
});

export const modelRefusalFallbackMessageSchema = z.looseObject({
  subtype: z.literal('model_refusal_fallback'),
  original_model: opt(str),
  fallback_model: opt(str),
  content: opt(str),
  retracted_message_uuids: opt(strArray),
});

export const modelRefusalNoFallbackMessageSchema = z.looseObject({
  subtype: z.literal('model_refusal_no_fallback'),
  original_model: opt(str),
  content: opt(str),
});

const taskUsageSchema = z.looseObject({ total_tokens: opt(num), tool_uses: opt(num), duration_ms: opt(num) });

export const taskStartedMessageSchema = z.looseObject({
  subtype: z.literal('task_started'),
  task_id: str,
  tool_use_id: opt(str),
  description: opt(str),
  subagent_type: opt(str),
  is_backgrounded: opt(bool),
  task_type: opt(str),
});

export const taskUpdatedMessageSchema = z.looseObject({
  subtype: z.literal('task_updated'),
  task_id: str,
  patch: opt(
    z.looseObject({
      status: opt(str),
      description: opt(str),
      end_time: opt(num),
      is_backgrounded: opt(bool),
    }),
  ),
});

export const taskProgressMessageSchema = z.looseObject({
  subtype: z.literal('task_progress'),
  task_id: str,
  tool_use_id: opt(str),
  description: opt(str),
  subagent_type: opt(str),
  usage: opt(taskUsageSchema),
  summary: opt(str),
});

export const taskNotificationMessageSchema = z.looseObject({
  subtype: z.literal('task_notification'),
  task_id: str,
  tool_use_id: opt(str),
  status: opt(str),
  summary: opt(str),
  usage: opt(taskUsageSchema),
});

export const backgroundTasksMessageSchema = z.looseObject({
  subtype: z.literal('background_tasks_changed'),
  tasks: z.array(
    z.looseObject({
      task_id: str,
      task_type: opt(str),
      description: opt(str),
      subagent_type: opt(str),
      parent_task_id: opt(str),
      ambient: opt(bool),
    }),
  ),
});

export const titleChangedMessageSchema = z.looseObject({
  subtype: z.literal('session_title_changed'),
  title: str,
});

export const commandsChangedMessageSchema = z.looseObject({
  subtype: z.literal('commands_changed'),
  commands: z.array(
    z.looseObject({
      name: str,
      description: opt(str),
      argumentHint: opt(str),
      aliases: opt(strArray),
      builtin: opt(bool),
    }),
  ),
});

// ---- other top-level types ----

/** Untyped in 0.3.296 (F.9). */
export const commandLifecycleMessageSchema = z.looseObject({
  type: z.literal('command_lifecycle'),
  command_uuid: str,
  state: str,
});

export const conversationResetMessageSchema = z.looseObject({
  type: z.literal('conversation_reset'),
  uuid: opt(str),
  new_conversation_id: opt(str),
  trigger: opt(str),
  timestamp: opt(str),
});

export const rateLimitEventSchema = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    status: str,
    resetsAt: opt(num),
    rateLimitType: opt(str),
    utilization: opt(num),
    errorCode: opt(str),
    /** Untyped (F.13). */
    unifiedWindows: opt(
      z.record(str, z.looseObject({ utilization: opt(num), resetsAt: opt(num) })),
    ),
  }),
});

export const promptSuggestionMessageSchema = z.looseObject({
  type: z.literal('prompt_suggestion'),
  suggestion: str,
});

export const toolProgressMessageSchema = z.looseObject({
  type: z.literal('tool_progress'),
  tool_use_id: str,
  elapsed_time_seconds: num,
});

// ---- getContextUsage() (SDKControlGetContextUsageResponse) ----

export const contextUsageSchema = z.looseObject({
  categories: opt(
    z.array(z.looseObject({ name: str, tokens: num, kind: opt(str), isDeferred: opt(bool) })),
  ),
  totalTokens: num,
  maxTokens: opt(num),
  rawMaxTokens: opt(num),
  model: opt(str),
  autoCompactThreshold: opt(num),
  isAutoCompactEnabled: opt(bool),
});
