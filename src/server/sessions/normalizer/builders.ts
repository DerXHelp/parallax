/**
 * Pure item builders shared by BOTH adapters (live and history), so the same SDK content always
 * becomes the same item (A.3). Ids follow docs/architecture.md §6: `${message.id}:${blockIndex}`
 * for assistant blocks, the SDK `uuid` for prompts/system/result frames, `px:${conversationId}:${n}`
 * for items Parallax creates itself (n = the item's order, unique per conversation).
 */
import type { ConversationId, JsonValue } from '@shared/common';
import { errorCodeForAssistantError, makeError, type ErrorPayload } from '@shared/errors';
import type {
  AssistantTextItem,
  BlobRef,
  CappedText,
  RateLimitInfo,
  SystemItem,
  TaskInfo,
  ThinkingItem,
  ToolCallItem,
  ToolCallStatus,
  ToolDecisionRef,
  ToolResult,
  ToolResultContent,
  TranscriptItem,
  UserMessageItem,
} from '@shared/model';
import { capInput, capStructured, capText, dedupeStructured, fitToolCall, type BlobSink } from './limits';
import {
  contentBlockSchema,
  imageBlockSchema,
  redactedThinkingBlockSchema,
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  type SdkToolResultBlock,
  type SdkToolResultMeta,
} from './sdk-schemas';

// ---- Small helpers ----

/** unknown (from JSON) → JsonValue; drops `undefined`, non-finite numbers become null. */
export function toJson(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object': {
      if (Array.isArray(value)) return value.map(toJson);
      const out: Record<string, JsonValue> = {};
      for (const [key, v] of Object.entries(value)) {
        if (v !== undefined) out[key] = toJson(v);
      }
      return out;
    }
    default:
      return null;
  }
}

/** SDK timestamp normalized via toISOString (live and history alike), else the fallback time. */
export function isoTime(value: string | null | undefined, fallback: Date): string {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallback.toISOString();
}

/** Epoch seconds (rate limits) → ISO, null if missing/invalid. */
export function secondsToIso(value: number | undefined): string | null {
  return value === undefined || !Number.isFinite(value) ? null : new Date(value * 1000).toISOString();
}

/** Epoch milliseconds (task end_time) → ISO, null if missing/invalid. */
export function millisToIso(value: number | undefined): string | null {
  return value === undefined || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

export function blockItemId(messageId: string, blockIndex: number): string {
  return `${messageId}:${String(blockIndex)}`;
}

export function pxItemId(conversationId: ConversationId, order: number): string {
  return `px:${conversationId}:${String(order)}`;
}

export function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export interface ItemBase {
  id: string;
  order: number;
  at: string;
  parentToolUseId: string | null;
}

// ---- User text classification (prompts, interrupt markers, CLI meta texts) ----

const INTERRUPT_RE = /^\[Request interrupted by user( for tool use)?\]$/;
const COMMAND_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;
const CAVEAT_RE = /^\s*<local-command-caveat>/;
const TASK_NOTIFICATION_RE = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;

/** Parsed `<task-notification>` (history: the CLI stores it as a user message, live: system/task_notification). */
export interface TaskNotificationText {
  taskId: string;
  toolUseId: string | null;
  status: string;
  summary: string | null;
  usage: TaskInfo['usage'];
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return match?.[1]?.trim() ?? null;
}

function tagNumber(body: string, name: string): number | null {
  const value = tag(body, name);
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTaskNotification(body: string): TaskNotificationText | null {
  const taskId = tag(body, 'task-id');
  if (taskId === null || taskId === '') return null;
  const totalTokens = tagNumber(body, 'subagent_tokens') ?? tagNumber(body, 'total_tokens');
  const toolUses = tagNumber(body, 'tool_uses');
  const durationMs = tagNumber(body, 'duration_ms');
  return {
    taskId,
    toolUseId: tag(body, 'tool-use-id'),
    status: tag(body, 'status') ?? 'completed',
    summary: tag(body, 'result') ?? tag(body, 'summary'),
    usage:
      totalTokens !== null && toolUses !== null && durationMs !== null
        ? { totalTokens, toolUses, durationMs }
        : null,
  };
}

export type UserTextKind =
  | { kind: 'interrupted'; forToolUse: boolean }
  | { kind: 'task_notification'; task: TaskNotificationText }
  | { kind: 'local_output'; text: string }
  | { kind: 'caveat' }
  | { kind: 'prompt'; text: string };

/**
 * What a user text is. Live prompts come from `registerPrompt` (F.9); the CLI-internal tag
 * formats (`<command-name>`, `<local-command-stdout>`, `<task-notification>`) appear in the
 * history JSONL (assumption for the local-command tags: not recorded in full, docs/wp/WP-12.md).
 */
export function classifyUserText(text: string): UserTextKind {
  const interrupt = INTERRUPT_RE.exec(text.trim());
  if (interrupt !== null) return { kind: 'interrupted', forToolUse: interrupt[1] !== undefined };
  const task = TASK_NOTIFICATION_RE.exec(text);
  if (task?.[1] !== undefined) {
    const parsed = parseTaskNotification(task[1]);
    if (parsed !== null) return { kind: 'task_notification', task: parsed };
  }
  const output = LOCAL_OUTPUT_RE.exec(text);
  if (output?.[2] !== undefined) return { kind: 'local_output', text: output[2] };
  if (CAVEAT_RE.test(text)) return { kind: 'caveat' };
  const command = COMMAND_NAME_RE.exec(text);
  if (command?.[1] !== undefined && command[1] !== '') {
    const name = command[1].startsWith('/') ? command[1] : `/${command[1]}`;
    const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() ?? '';
    return { kind: 'prompt', text: args === '' ? name : `${name} ${args}` };
  }
  return { kind: 'prompt', text };
}

/** '/clear', '/rename' … when the text starts with '/' (model.ts userMessage.slashCommand). */
export function slashCommandOf(text: string): string | null {
  const match = /^\s*(\/[^\s/][^\s]*)/.exec(text);
  return match?.[1] ?? null;
}

// ---- Items ----

export function userMessageItem(
  base: ItemBase,
  text: CappedText,
  opts: { attachments: BlobRef[]; origin: 'human' | 'other'; priority: 'next' | 'now' | null },
): UserMessageItem {
  return {
    ...base,
    kind: 'user_message',
    text,
    attachments: opts.attachments,
    origin: opts.origin,
    slashCommand: slashCommandOf(text.text),
    priority: opts.priority,
  };
}

export interface BlockContext {
  messageId: string;
  blockIndex: number;
  model: string | null;
  /** assistant.aborted (only meaningful for text). */
  aborted: boolean;
  localCommand: AssistantTextItem['localCommand'];
}

/** Block types that become a streaming item at `content_block_start` (others wait for the final message). */
export function isStreamableBlock(block: { type: string }): boolean {
  return (
    block.type === 'text' ||
    block.type === 'thinking' ||
    block.type === 'redacted_thinking' ||
    toolUseBlockSchema.safeParse(block).success
  );
}

/** A streaming item right after `content_block_start` (null for block types that do not stream). */
export function streamingBlockItem(base: ItemBase, block: unknown, ctx: BlockContext): TranscriptItem | null {
  const head = contentBlockSchema.safeParse(block);
  if (!head.success) return null;
  switch (head.data.type) {
    case 'text': {
      const text = textBlockSchema.safeParse(block);
      return assistantText(base, ctx, text.success ? text.data.text : '', true);
    }
    case 'thinking': {
      const thinking = thinkingBlockSchema.safeParse(block);
      return thinkingItem(
        base,
        ctx,
        { text: thinking.success ? (thinking.data.thinking ?? '') : '', truncated: null },
        false,
        true,
      );
    }
    case 'redacted_thinking':
      return thinkingItem(base, ctx, { text: '', truncated: null }, true, true);
    default: {
      const tool = toolUseBlockSchema.safeParse(block);
      if (!tool.success) return null;
      return {
        ...base,
        kind: 'tool_call',
        messageId: ctx.messageId,
        blockIndex: ctx.blockIndex,
        model: ctx.model,
        toolUseId: tool.data.id,
        toolName: tool.data.name,
        input: {},
        inputTruncated: null,
        inputPartial: '',
        status: 'streaming_input',
        result: null,
        elapsedSeconds: null,
        task: null,
        decision: null,
      };
    }
  }
}

function assistantText(
  base: ItemBase,
  ctx: BlockContext,
  text: string,
  streaming: boolean,
): AssistantTextItem {
  return {
    ...base,
    kind: 'assistant_text',
    messageId: ctx.messageId,
    blockIndex: ctx.blockIndex,
    model: ctx.model,
    text,
    streaming,
    aborted: streaming ? false : ctx.aborted,
    localCommand: ctx.localCommand,
  };
}

function thinkingItem(
  base: ItemBase,
  ctx: BlockContext,
  text: CappedText,
  redacted: boolean,
  streaming: boolean,
): ThinkingItem {
  return {
    ...base,
    kind: 'thinking',
    messageId: ctx.messageId,
    blockIndex: ctx.blockIndex,
    model: ctx.model,
    text,
    redacted,
    streaming,
  };
}

export type FinalBlock =
  | { kind: 'item'; item: AssistantTextItem | ThinkingItem | ToolCallItem }
  | { kind: 'unknown'; blockType: string; preview: string };

/**
 * The final item of one assistant content block. A tool_call keeps the live state of an existing
 * item (status, result, task, decision); `streaming_input`/new → `pending`.
 */
export function finalBlockItem(
  base: ItemBase,
  block: unknown,
  ctx: BlockContext,
  sink: BlobSink,
  existing: TranscriptItem | undefined,
): FinalBlock {
  const head = contentBlockSchema.safeParse(block);
  const blockType = head.success ? head.data.type : 'invalid';
  switch (blockType) {
    case 'text': {
      const text = textBlockSchema.safeParse(block);
      if (text.success) return { kind: 'item', item: assistantText(base, ctx, text.data.text, false) };
      break;
    }
    case 'thinking': {
      const thinking = thinkingBlockSchema.safeParse(block);
      if (thinking.success) {
        return {
          kind: 'item',
          item: thinkingItem(base, ctx, capText(thinking.data.thinking ?? '', sink), false, false),
        };
      }
      break;
    }
    case 'redacted_thinking':
      if (redactedThinkingBlockSchema.safeParse(block).success) {
        return { kind: 'item', item: thinkingItem(base, ctx, { text: '', truncated: null }, true, false) };
      }
      break;
    default: {
      const tool = toolUseBlockSchema.safeParse(block);
      if (!tool.success) break;
      const capped = capInput(toJson(tool.data.input ?? {}), tool.data.name, sink);
      const prev = existing?.kind === 'tool_call' ? existing : null;
      const item: ToolCallItem = {
        ...base,
        kind: 'tool_call',
        messageId: ctx.messageId,
        blockIndex: ctx.blockIndex,
        model: ctx.model,
        toolUseId: tool.data.id,
        toolName: tool.data.name,
        input: capped.input,
        inputTruncated: capped.inputTruncated,
        inputPartial: null,
        status: prev === null || prev.status === 'streaming_input' ? 'pending' : prev.status,
        result: prev?.result ?? null,
        elapsedSeconds: prev?.elapsedSeconds ?? null,
        task: prev?.task ?? null,
        decision: prev?.decision ?? null,
      };
      return { kind: 'item', item: fitToolCall(item, sink) };
    }
  }
  return { kind: 'unknown', blockType, preview: JSON.stringify(block ?? null).slice(0, 2000) };
}

export function unknownItem(
  base: ItemBase,
  sdkType: string,
  sdkSubtype: string | null,
  raw: unknown,
): SystemItem {
  let preview: string;
  try {
    preview = JSON.stringify(raw ?? null).slice(0, 2000);
  } catch {
    preview = '';
  }
  return { ...base, kind: 'system', event: 'unknown', sdkType, sdkSubtype, preview };
}

export function errorItem(base: ItemBase, error: ErrorPayload): SystemItem {
  return { ...base, kind: 'system', event: 'error', error };
}

export function assistantErrorPayload(error: string): ErrorPayload {
  return makeError(errorCodeForAssistantError(error), { reason: error.slice(0, 200) });
}

// ---- Tool results ----

/** tool_result content → text parts (capped) and images (blobs); other blocks as JSON text. */
export function toolResultContent(
  content: SdkToolResultBlock['content'],
  sink: BlobSink,
): ToolResultContent[] {
  if (content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: capText(content, sink) }];
  const parts: ToolResultContent[] = [];
  for (const block of content) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) {
      parts.push({ type: 'text', text: capText(text.data.text, sink) });
      continue;
    }
    const image = imageBlockSchema.safeParse(block);
    if (image.success && image.data.source.data !== undefined) {
      const mediaType = (image.data.source.media_type ?? 'application/octet-stream').slice(0, 100);
      parts.push({
        type: 'image',
        image: sink.storeBlob(Buffer.from(image.data.source.data, 'base64'), mediaType),
      });
      continue;
    }
    parts.push({ type: 'text', text: capText(JSON.stringify(block ?? null), sink) });
  }
  return parts;
}

export function resultText(content: ToolResultContent[]): string {
  return content.map((part) => (part.type === 'text' ? part.text.text : '')).join('\n');
}

/** Full (uncapped) text of a raw tool_result content – the reference for the R0-11 dedupe. */
function rawResultText(content: SdkToolResultBlock['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      const text = textBlockSchema.safeParse(block);
      return text.success ? text.data.text : '';
    })
    .join('\n');
}

/** tool_result block → ToolResult. `structured` = live `tool_use_result` (null in history, F.15). */
export function buildToolResult(
  block: SdkToolResultBlock,
  structuredRaw: unknown,
  toolName: string,
  at: string,
  sink: BlobSink,
): ToolResult {
  const content = toolResultContent(block.content, sink);
  const structured =
    structuredRaw === undefined || structuredRaw === null
      ? null
      : dedupeStructured(toolName, toJson(structuredRaw), rawResultText(block.content));
  const capped = capStructured(structured, sink);
  return {
    isError: block.is_error === true,
    content,
    structured: capped.structured,
    structuredTruncated: capped.structuredTruncated,
    at,
  };
}

/** The CLI's tool_result text when the user stopped/rejected the tool (interrupt or deny+interrupt). */
const USER_REJECTED_PREFIX = "The user doesn't want to proceed with this tool use";

const DENIED_OUTCOMES: ReadonlySet<string> = new Set(['denied', 'declined', 'plan_revised']);
const TERMINAL_TASK_STATUS: Readonly<Record<string, ToolCallStatus>> = {
  completed: 'done',
  failed: 'error',
  stopped: 'interrupted',
  killed: 'interrupted',
};

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a task status that ends the task (completed/failed/stopped/killed). */
export function isTerminalTaskStatus(status: string): boolean {
  return Object.hasOwn(TERMINAL_TASK_STATUS, status);
}

/**
 * Status after the tool_result: denied (decision outcome, rejecting permission decision,
 * permission_denied) → `denied`; user stop (`non_execution_kind: user-rejected` or the CLI text)
 * → `interrupted`; error → `error`; async agent / moved to background / backgrounded task →
 * `background` until the task ends; else `done`.
 */
export function statusAfterResult(
  call: ToolCallItem,
  result: ToolResult,
  meta: SdkToolResultMeta | undefined,
  structuredRaw: unknown,
  deniedByCli: boolean,
): ToolCallStatus {
  const outcome = call.decision?.outcome?.type;
  if (result.isError) {
    if (outcome !== undefined && DENIED_OUTCOMES.has(outcome)) return 'denied';
    if (meta?.permission_decision?.decision === 'reject' || deniedByCli) return 'denied';
    if (
      meta?.non_execution_kind === 'user-rejected' ||
      resultText(result.content).startsWith(USER_REJECTED_PREFIX)
    ) {
      return 'interrupted';
    }
    return 'error';
  }
  const structured = toJson(structuredRaw ?? null);
  if (
    isRecord(structured) &&
    (structured.isAsync === true || typeof structured.backgroundTaskId === 'string')
  ) {
    return call.task !== null && isTerminalTaskStatus(call.task.status)
      ? taskEndStatus(call.task)
      : 'background';
  }
  if (call.task?.isBackgrounded === true && !isTerminalTaskStatus(call.task.status)) return 'background';
  return 'done';
}

export function taskEndStatus(task: TaskInfo): ToolCallStatus {
  return TERMINAL_TASK_STATUS[task.status] ?? 'done';
}

/** Tool status after a task change: background calls end with their task; a running task marks pending → running. */
export function statusWithTask(call: ToolCallItem, task: TaskInfo): ToolCallStatus {
  if (call.result === null) return call.status === 'pending' ? 'running' : call.status;
  if (isTerminalTaskStatus(task.status))
    return call.status === 'background' ? taskEndStatus(task) : call.status;
  return task.isBackgrounded && call.status === 'done' && !call.result.isError ? 'background' : call.status;
}

/** SDK task usage → TaskInfo.usage (all three numbers or nothing). */
export function taskUsage(
  usage:
    | { total_tokens?: number | undefined; tool_uses?: number | undefined; duration_ms?: number | undefined }
    | undefined,
): TaskInfo['usage'] {
  if (usage?.total_tokens === undefined || usage.tool_uses === undefined || usage.duration_ms === undefined)
    return null;
  return { totalTokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms };
}

/** Status after a decision ref (attachDecision): open → awaiting_decision, allowed → running … */
export function statusAfterDecision(call: ToolCallItem, ref: ToolDecisionRef): ToolCallStatus {
  if (call.result !== null) {
    return ref.outcome !== null && DENIED_OUTCOMES.has(ref.outcome.type) && call.result.isError
      ? 'denied'
      : call.status;
  }
  const outcome = ref.outcome;
  if (outcome === null) return 'awaiting_decision';
  switch (outcome.type) {
    case 'denied':
    case 'declined':
    case 'plan_revised':
      return 'denied';
    case 'cancelled':
    case 'expired':
      return 'interrupted';
    default:
      return 'running';
  }
}

export function emptyTask(taskId: string): TaskInfo {
  return {
    taskId,
    taskType: null,
    status: 'running',
    description: '',
    subagentType: null,
    isBackgrounded: false,
    summary: null,
    usage: null,
    startedAt: null,
    endedAt: null,
  };
}

/** Task info of an Agent/Task tool call derived from its input (history has no task_started). */
export function taskFromAgentInput(call: ToolCallItem, taskId: string): TaskInfo {
  const task = emptyTask(taskId);
  const input = call.input;
  if (!isRecord(input) || (call.toolName !== 'Agent' && call.toolName !== 'Task')) return task;
  return {
    ...task,
    taskType: 'local_agent',
    description: typeof input.description === 'string' ? input.description : '',
    subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
  };
}

/**
 * Internal diagnostics of the CLI in `result.errors`, e.g. `[ede_diagnostic] result_type=user
 * last_content_type=n/a stop_reason=tool_use` after every Stop (WP22-08) – no error for the user.
 */
const CLI_DIAGNOSTIC = /^\s*\[[a-z0-9_]*diagnostic\]/i;

export function isCliDiagnostic(error: string): boolean {
  return CLI_DIAGNOSTIC.test(error);
}

/**
 * Caps `turn_result.errors` (may carry stderr). CLI diagnostics are left out (WP22-08): they are
 * known, not unknown (no `unknownCounts` key), and stay in the CLI's own transcript.
 */
export function resultErrors(errors: unknown[] | undefined): string[] {
  if (errors === undefined) return [];
  return errors
    .filter((e): e is string => typeof e === 'string' && !isCliDiagnostic(e))
    .slice(0, 20)
    .map((e) => e.slice(0, 4000));
}

/** rate_limit_info → RateLimitInfo (seconds → ISO, `unifiedWindows` → windows). */
export function toRateLimitInfo(
  raw: {
    status: string;
    resetsAt?: number | undefined;
    rateLimitType?: string | undefined;
    utilization?: number | undefined;
    unifiedWindows?:
      Record<string, { utilization?: number | undefined; resetsAt?: number | undefined }> | undefined;
  },
  at: Date,
): RateLimitInfo | null {
  const status = raw.status;
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return null;
  const windows: RateLimitInfo['windows'] = {};
  for (const [key, w] of Object.entries(raw.unifiedWindows ?? {})) {
    windows[key] = { utilization: w.utilization ?? null, resetsAt: secondsToIso(w.resetsAt) };
  }
  return {
    status,
    rateLimitType: raw.rateLimitType ?? null,
    resetsAt: secondsToIso(raw.resetsAt),
    utilization: raw.utilization ?? null,
    windows,
    at: at.toISOString(),
  };
}

/** Text of a user message content (string or text blocks); images separately. */
export function userContent(
  content: string | unknown[],
  sink: BlobSink,
): { text: string; images: BlobRef[]; toolResults: unknown[] } {
  if (typeof content === 'string') return { text: content, images: [], toolResults: [] };
  const texts: string[] = [];
  const images: BlobRef[] = [];
  const toolResults: unknown[] = [];
  for (const block of content) {
    const head = contentBlockSchema.safeParse(block);
    if (!head.success) continue;
    if (head.data.type === 'tool_result') {
      toolResults.push(block);
      continue;
    }
    const text = textBlockSchema.safeParse(block);
    if (text.success) {
      texts.push(text.data.text);
      continue;
    }
    const image = imageBlockSchema.safeParse(block);
    if (image.success && image.data.source.data !== undefined) {
      const mediaType = (image.data.source.media_type ?? 'application/octet-stream').slice(0, 100);
      images.push(sink.storeBlob(Buffer.from(image.data.source.data, 'base64'), mediaType));
    }
  }
  return { text: texts.join('\n'), images, toolResults };
}
