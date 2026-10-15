/**
 * Live adapter (A.3): raw SDK messages incl. `stream_event` deltas → `{ops, signals}`
 * (port `LiveNormalizer`, src/server/sessions/ports.ts). Rules: docs/architecture.md §6 table and
 * "Normalizer-Regeln aus R0"; details and decisions: docs/wp/WP-12.md. Pure apart from
 * `ctx.storeBlob`; one instance per CLI process.
 */
import {
  LIMITS,
  parseEffortLevel,
  parsePermissionMode,
  unknownEnumCountKey,
  type ConversationId,
  type EffortLevel,
  type PermissionMode,
} from '@shared/common';
import { errorCodeForRateLimitError, errorCodeForStartupFailure, makeError, type ErrorPayload } from '@shared/errors';
import type {
  BackgroundTask,
  SessionDetailPatch,
  SessionInitInfo,
  SlashCommandInfo,
  SystemItem,
  TaskInfo,
  ToolCallItem,
  ToolDecisionRef,
  TranscriptItem,
  TurnResultItem,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import type {
  LiveNormalizer,
  NormalizerContext,
  NormalizerOutput,
  PendingPrompt,
  StatusSignal,
} from '../ports';
import {
  assistantErrorPayload,
  blockItemId,
  buildToolResult,
  bump,
  classifyUserText,
  emptyTask,
  errorItem,
  finalBlockItem,
  isoTime,
  millisToIso,
  pxItemId,
  resultErrors,
  statusAfterDecision,
  statusAfterResult,
  statusWithTask,
  streamingBlockItem,
  taskFromAgentInput,
  taskUsage,
  toJson,
  toRateLimitInfo,
  isStreamableBlock,
  unknownItem,
  userContent,
  userMessageItem,
  type ItemBase,
  type TaskNotificationText,
} from './builders';
import { capText, fitToolCall, shareBudget } from './limits';
import {
  apiRetryMessageSchema,
  assistantMessageSchema,
  backgroundTasksMessageSchema,
  commandLifecycleMessageSchema,
  commandsChangedMessageSchema,
  compactBoundaryMessageSchema,
  contentBlockDeltaEventSchema,
  contentBlockStartEventSchema,
  conversationResetMessageSchema,
  hookMessageSchema,
  informationalMessageSchema,
  initMessageSchema,
  localCommandOutputMessageSchema,
  memoryRecallMessageSchema,
  messageDeltaEventSchema,
  messageStartEventSchema,
  modelRefusalFallbackMessageSchema,
  modelRefusalNoFallbackMessageSchema,
  notificationMessageSchema,
  permissionDeniedMessageSchema,
  promptSuggestionMessageSchema,
  rateLimitEventSchema,
  resultMessageSchema,
  sdkMessageBaseSchema,
  sessionStateMessageSchema,
  statusMessageSchema,
  streamEventMessageSchema,
  taskNotificationMessageSchema,
  taskProgressMessageSchema,
  taskStartedMessageSchema,
  taskUpdatedMessageSchema,
  titleChangedMessageSchema,
  toolProgressMessageSchema,
  toolResultBlockSchema,
  userMessageSchema,
  type SdkMessageBase,
  type SdkResultMessage,
  type SdkToolResultBlock,
  type SdkToolResultMeta,
  type SdkUsage,
} from './sdk-schemas';

/** Known types/subtypes without an item or signal (WP-02 §5.6): only counted in ignoredCounts. */
const IGNORED_TYPES: ReadonlySet<string> = new Set(['tool_use_summary', 'auth_status', 'active_goal']);
const IGNORED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'files_persisted',
  'elicitation_complete',
  'plugin_install',
  'mirror_error',
  'worker_shutting_down',
  'control_request_progress',
]);
/** MCP server status values that mean "not approved / not loaded" (C.5; heuristic, see WP-12.md). */
const NOT_APPROVED_MCP_STATUS: ReadonlySet<string> = new Set(['disabled', 'needs-approval', 'rejected']);
const SYNTHETIC_MODEL = '<synthetic>';
const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

interface ItemEntry {
  item: TranscriptItem;
  conversationId: ConversationId;
}

interface StreamInfo {
  messageId: string;
  model: string | null;
  parent: string | null;
}

interface PendingResult {
  block: SdkToolResultBlock;
  structured: unknown;
  meta: SdkToolResultMeta | undefined;
  at: string;
}

interface Out {
  ops: SessionOp[];
  signals: StatusSignal[];
  detail: SessionDetailPatch;
}

function usageTotal(usage: SdkUsage | undefined): number | null {
  if (usage === undefined) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

function nonNegativeInt(value: number | undefined, fallback = 0): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.round(value));
}

function turnOutcome(r: SdkResultMessage): TurnResultItem['outcome'] {
  if (r.terminal_reason?.startsWith('aborted_') === true) return 'interrupted';
  return r.subtype === 'success' && r.is_error !== true ? 'success' : 'error';
}

class LiveNormalizerImpl implements LiveNormalizer {
  private conversationId: ConversationId;
  private nextOrder: number;
  private readonly items = new Map<string, ItemEntry>();
  /** toolUseId → item id of the tool_call. */
  private readonly toolCalls = new Map<string, string>();
  /** message.id → number of content blocks seen in final assistant messages (blockIndex). */
  private readonly blockOrdinals = new Map<string, number>();
  /** api_message_id / message.id → stream state from message_start. */
  private readonly streams = new Map<string, StreamInfo>();
  private lastStreamMessageId: string | null = null;
  /** Ids of items that are still streaming (`streaming: true` / `streaming_input`). */
  private readonly streaming = new Set<string>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private readonly pendingDecisions = new Map<string, ToolDecisionRef>();
  private readonly pendingResults = new Map<string, PendingResult>();
  /** task_id → task and its tool_use_id. */
  private readonly tasks = new Map<string, { toolUseId: string | null; task: TaskInfo }>();
  /** hook_id → item id (one hook item, upserted). */
  private readonly hooks = new Map<string, string>();
  /** Wire uuid of an assistant/system frame → item ids (model refusal fallback retractions). */
  private readonly frames = new Map<string, string[]>();
  /** tool_use_ids auto-denied by the CLI (system/permission_denied). */
  private readonly deniedByCli = new Set<string>();
  private retryItemId: string | null = null;
  private compacting = false;
  private sessionId: string | null = null;
  /** Session ids of conversations ended by a conversation_reset. */
  private readonly retiredSessionIds = new Set<string>();
  private lifecycleSupported: boolean | null = null;
  private lastModel: string | null = null;
  private lastEstimate: number | null = null;
  private lastCostTotal: number | null = null;
  private turnAssistantError: ErrorPayload | null = null;
  private lastInitJson: string | null = null;
  private notApprovedKey = '';
  private promptSuggestion: string | null = null;
  private pendingReset: { id: string | null; trigger: string | null; at: string } | null = null;
  /** Ops emitted at the start of the next output (reset marker after startConversation). */
  private queued: SessionOp[] = [];
  private readonly unknown: Record<string, number> = {};
  private readonly ignored: Record<string, number> = {};
  private unknownDirty = false;

  constructor(private readonly ctx: NormalizerContext) {
    this.conversationId = ctx.conversationId;
    this.nextOrder = ctx.nextOrder;
  }

  get unknownCounts(): Readonly<Record<string, number>> {
    return { ...this.unknown };
  }

  get ignoredCounts(): Readonly<Record<string, number>> {
    return { ...this.ignored };
  }

  // ---- Port methods ----

  push(message: unknown, receivedAt: Date): NormalizerOutput {
    const out = this.begin();
    const base = sdkMessageBaseSchema.safeParse(message);
    if (!base.success) {
      this.countUnknown('invalid');
      return this.end(out);
    }
    const msg = base.data;
    this.trackSessionId(msg.session_id, out);
    switch (msg.type) {
      case 'stream_event':
        this.onStreamEvent(message, receivedAt, out);
        break;
      case 'assistant':
        this.onAssistant(message, receivedAt, out);
        break;
      case 'user':
        this.onUser(message, receivedAt, out);
        break;
      case 'result':
        this.onResult(message, receivedAt, out);
        break;
      case 'system':
        this.onSystem(message, msg, receivedAt, out);
        break;
      case 'command_lifecycle':
        this.onLifecycle(message, out);
        break;
      case 'conversation_reset':
        this.onReset(message, receivedAt, out);
        break;
      case 'rate_limit_event':
        this.onRateLimit(message, msg, receivedAt, out);
        break;
      case 'prompt_suggestion': {
        const parsed = promptSuggestionMessageSchema.safeParse(message);
        if (!parsed.success) this.countUnknown('invalid:prompt_suggestion');
        else if (parsed.data.suggestion !== this.promptSuggestion) {
          this.promptSuggestion = parsed.data.suggestion;
          out.detail.promptSuggestion = parsed.data.suggestion;
        }
        break;
      }
      case 'tool_progress':
        this.onToolProgress(message, out);
        break;
      case 'keep_alive':
        break;
      default:
        if (IGNORED_TYPES.has(msg.type)) bump(this.ignored, msg.type);
        else this.unknownMessage(message, msg, receivedAt, out);
    }
    return this.end(out);
  }

  registerPrompt(prompt: PendingPrompt): void {
    this.pendingPrompts.set(prompt.messageUuid, prompt);
  }

  attachDecision(toolUseId: string, ref: ToolDecisionRef): NormalizerOutput {
    const out = this.begin();
    const call = this.toolCall(toolUseId);
    if (call === null) {
      this.pendingDecisions.set(toolUseId, ref);
      return this.end(out);
    }
    this.put({ ...call, decision: ref, status: statusAfterDecision(call, ref) }, out);
    return this.end(out);
  }

  finalizeOpen(reason: 'turn_end' | 'process_exit'): NormalizerOutput {
    const out = this.begin();
    this.closeStreaming(out);
    if (reason === 'process_exit') {
      for (const entry of this.items.values()) {
        const item = entry.item;
        if (entry.conversationId !== this.conversationId || item.kind !== 'tool_call') continue;
        if (['pending', 'awaiting_decision', 'running', 'background'].includes(item.status)) {
          this.put({ ...item, status: 'interrupted' }, out);
        }
      }
      this.endRetrySeries(out);
      if (this.compacting) {
        this.compacting = false;
        out.signals.push({ type: 'compacting', active: false });
      }
    }
    return this.end(out);
  }

  startConversation(conversationId: ConversationId, nextOrder: number): void {
    this.conversationId = conversationId;
    this.nextOrder = nextOrder;
    this.lastCostTotal = null;
    this.streaming.clear();
    const reset = this.pendingReset;
    this.pendingReset = null;
    if (reset !== null) {
      const order = this.nextOrder++;
      const item: SystemItem = {
        id: reset.id ?? pxItemId(conversationId, order),
        order,
        at: reset.at,
        parentToolUseId: null,
        kind: 'system',
        event: 'conversation_reset',
        trigger: reset.trigger,
      };
      this.items.set(item.id, { item, conversationId });
      this.queued.push({ op: 'item.upsert', item });
    }
  }

  // ---- Output plumbing ----

  private begin(): Out {
    const out: Out = { ops: this.queued, signals: [], detail: {} };
    this.queued = [];
    return out;
  }

  private end(out: Out): NormalizerOutput {
    if (this.unknownDirty) {
      out.detail.unknownCounts = { ...this.unknown };
      this.unknownDirty = false;
    }
    if (Object.keys(out.detail).length > 0) out.ops.push({ op: 'detail.patch', patch: out.detail });
    return { ops: out.ops, signals: out.signals };
  }

  private countUnknown(key: string): void {
    bump(this.unknown, key);
    this.unknownDirty = true;
  }

  /** Item base; keeps the `order` of an existing item of the current conversation. */
  private base(id: string, at: string, parentToolUseId: string | null): ItemBase {
    const existing = this.items.get(id);
    const order = existing?.conversationId === this.conversationId ? existing.item.order : this.nextOrder++;
    return { id, order, at, parentToolUseId };
  }

  /** Base for a Parallax-made item without SDK uuid: `px:<conversationId>:<order>`. */
  private pxBase(at: string, parentToolUseId: string | null = null): ItemBase {
    const order = this.nextOrder++;
    return { id: pxItemId(this.conversationId, order), order, at, parentToolUseId };
  }

  /** Base keyed by the SDK uuid, else a px id. */
  private uuidBase(uuid: string | undefined, at: string, parentToolUseId: string | null = null): ItemBase {
    return uuid === undefined || uuid === '' ? this.pxBase(at, parentToolUseId) : this.base(uuid, at, parentToolUseId);
  }

  /** Store an item and emit `item.upsert` – unless it belongs to an older conversation (R0-05f). */
  private put(item: TranscriptItem, out: Out): void {
    const existing = this.items.get(item.id);
    const conversationId = existing?.conversationId ?? this.conversationId;
    this.items.set(item.id, { item, conversationId });
    if (item.kind === 'tool_call') this.toolCalls.set(item.toolUseId, item.id);
    if (conversationId === this.conversationId) out.ops.push({ op: 'item.upsert', item });
    else bump(this.ignored, 'staleConversation');
  }

  private toolCall(toolUseId: string): ToolCallItem | null {
    const id = this.toolCalls.get(toolUseId);
    const entry = id === undefined ? undefined : this.items.get(id);
    return entry?.item.kind === 'tool_call' ? entry.item : null;
  }

  /**
   * `session_id` signal for every new session id (F.7: after /clear the id comes with the next
   * frames/init, not from new_conversation_id). Ids retired by a reset never come back: a late
   * frame of the old conversation must not switch the new conversation back.
   */
  private trackSessionId(sessionId: string | undefined, out: Out): void {
    if (sessionId === undefined || sessionId === '' || sessionId.length > 100 || sessionId === this.sessionId) return;
    if (this.retiredSessionIds.has(sessionId)) return;
    this.sessionId = sessionId;
    out.signals.push({ type: 'session_id', sessionId });
  }

  private emitModel(model: string | null, out: Out): void {
    if (model === null || model === '' || model === SYNTHETIC_MODEL || model === this.lastModel) return;
    this.lastModel = model;
    out.signals.push({ type: 'assistant_model', model });
  }

  private emitEstimate(usage: SdkUsage | undefined, model: string | null, out: Out): void {
    const total = usageTotal(usage);
    if (total === null || total === this.lastEstimate) return;
    this.lastEstimate = total;
    out.signals.push({ type: 'context_estimate', totalTokens: total, model });
  }

  // ---- stream_event ----

  private onStreamEvent(raw: unknown, receivedAt: Date, out: Out): void {
    const parsed = streamEventMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:stream_event');
      return;
    }
    const se = parsed.data;
    const event = se.event;
    const parent = se.parent_tool_use_id ?? null;
    switch (event.type) {
      case 'message_start': {
        const start = messageStartEventSchema.safeParse(event);
        if (!start.success) {
          this.countUnknown('invalid:stream_event/message_start');
          return;
        }
        const message = start.data.message;
        const info: StreamInfo = { messageId: message.id, model: message.model ?? null, parent };
        this.streams.set(se.api_message_id ?? message.id, info);
        this.lastStreamMessageId = message.id;
        this.endRetrySeries(out);
        if (parent === null) {
          this.emitModel(info.model, out);
          this.emitEstimate(message.usage, info.model, out);
        }
        this.fallbackPrompts(se.user_message_uuids, out);
        return;
      }
      case 'content_block_start': {
        const start = contentBlockStartEventSchema.safeParse(event);
        const messageId = se.api_message_id ?? this.lastStreamMessageId;
        if (!start.success || messageId === null) {
          this.countUnknown('invalid:stream_event/content_block_start');
          return;
        }
        const id = blockItemId(messageId, start.data.index);
        if (this.items.has(id)) return;
        const block = start.data.content_block;
        if (!isStreamableBlock(block)) {
          // Not streamed as an item: the final assistant message creates it.
          bump(this.ignored, `stream/content_block:${block.type}`);
          return;
        }
        const stream = this.streams.get(messageId);
        const item = streamingBlockItem(this.base(id, receivedAt.toISOString(), parent ?? stream?.parent ?? null), block, {
          messageId,
          blockIndex: start.data.index,
          model: stream?.model ?? null,
          aborted: false,
          localCommand: null,
        });
        if (item === null) return;
        if (item.kind === 'tool_call') {
          const decision = this.pendingDecisions.get(item.toolUseId);
          if (decision !== undefined) this.pendingDecisions.delete(item.toolUseId);
          this.streaming.add(id);
          this.put(decision === undefined ? item : { ...item, decision }, out);
          return;
        }
        this.streaming.add(id);
        this.put(item, out);
        return;
      }
      case 'content_block_delta': {
        const delta = contentBlockDeltaEventSchema.safeParse(event);
        const messageId = se.api_message_id ?? this.lastStreamMessageId;
        if (!delta.success || messageId === null) {
          this.countUnknown('invalid:stream_event/content_block_delta');
          return;
        }
        this.onDelta(blockItemId(messageId, delta.data.index), delta.data.delta, out);
        return;
      }
      case 'message_delta': {
        const md = messageDeltaEventSchema.safeParse(event);
        if (md.success && parent === null) {
          const stream = this.streams.get(se.api_message_id ?? this.lastStreamMessageId ?? '');
          this.emitEstimate(md.data.usage, stream?.model ?? null, out);
        }
        return;
      }
      case 'message_stop':
        this.streams.delete(se.api_message_id ?? this.lastStreamMessageId ?? '');
        return;
      case 'content_block_stop':
      case 'ping':
        return;
      default:
        bump(this.ignored, `stream/${event.type}`);
    }
  }

  private onDelta(
    id: string,
    delta: { type: string; text?: string | undefined; thinking?: string | undefined; partial_json?: string | undefined },
    out: Out,
  ): void {
    const entry = this.items.get(id);
    if (entry === undefined || !this.streaming.has(id) || entry.conversationId !== this.conversationId) return;
    const item = entry.item;
    switch (delta.type) {
      case 'text_delta': {
        const append = delta.text ?? '';
        if (append === '' || item.kind !== 'assistant_text') return;
        this.items.set(id, { ...entry, item: { ...item, text: item.text + append } });
        out.ops.push({ op: 'item.delta', itemId: id, field: 'text', append });
        return;
      }
      case 'thinking_delta': {
        if (item.kind !== 'thinking') return;
        const append = this.clip(item.text.text.length, delta.thinking ?? '');
        if (append === '') return;
        this.items.set(id, { ...entry, item: { ...item, text: { ...item.text, text: item.text.text + append } } });
        out.ops.push({ op: 'item.delta', itemId: id, field: 'thinking', append });
        return;
      }
      case 'input_json_delta': {
        if (item.kind !== 'tool_call' || item.status !== 'streaming_input') return;
        const partial = item.inputPartial ?? '';
        const append = this.clip(partial.length, delta.partial_json ?? '');
        if (append === '') return;
        this.items.set(id, { ...entry, item: { ...item, inputPartial: partial + append } });
        out.ops.push({ op: 'item.delta', itemId: id, field: 'inputPartial', append });
        return;
      }
      case 'signature_delta':
        return;
      default:
        bump(this.ignored, `stream/delta:${delta.type}`);
    }
  }

  /** Streamed thinking/partial input stays within LIMITS.itemTextChars (the final item is capped). */
  private clip(current: number, append: string): string {
    const room = LIMITS.itemTextChars - current;
    return room <= 0 ? '' : append.length <= room ? append : append.slice(0, room);
  }

  /** Close every streaming item of the current conversation (turn end, process exit). */
  private closeStreaming(out: Out): void {
    for (const id of [...this.streaming]) {
      this.streaming.delete(id);
      const entry = this.items.get(id);
      if (entry?.conversationId !== this.conversationId) continue;
      const item = entry.item;
      if (item.kind === 'assistant_text') this.put({ ...item, streaming: false, aborted: true }, out);
      else if (item.kind === 'thinking') this.put({ ...item, streaming: false, text: capText(item.text.text, this.ctx) }, out);
      else if (item.kind === 'tool_call' && item.status === 'streaming_input') {
        this.put(fitToolCall({ ...item, status: 'interrupted', ...this.partialInput(item) }, this.ctx), out);
      }
    }
  }

  /** Aborted tool input: parsed partial JSON if complete, else the raw partial stays. */
  private partialInput(item: ToolCallItem): Pick<ToolCallItem, 'input' | 'inputPartial'> {
    const partial = item.inputPartial;
    if (partial === null || partial === '') return { input: item.input, inputPartial: null };
    try {
      const parsed: unknown = JSON.parse(partial);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return { input: toJson(parsed), inputPartial: null };
      }
    } catch {
      // incomplete JSON: keep the raw partial for the renderer
    }
    return { input: item.input, inputPartial: partial };
  }

  // ---- assistant ----

  private onAssistant(raw: unknown, receivedAt: Date, out: Out): void {
    const parsed = assistantMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:assistant');
      return;
    }
    const a = parsed.data;
    const parent = a.parent_tool_use_id ?? null;
    const messageId = a.message.id ?? a.uuid ?? pxItemId(this.conversationId, this.nextOrder);
    const model = a.message.model ?? null;
    const at = isoTime(a.timestamp, receivedAt);
    if (parent === null) {
      this.endRetrySeries(out);
      this.emitModel(model, out);
    }
    if (a.supersedes !== undefined) this.retract(a.supersedes, out);

    let ordinal = this.blockOrdinals.get(messageId) ?? 0;
    const ids: string[] = [];
    for (const block of a.message.content) {
      const blockIndex = ordinal++;
      const id = blockItemId(messageId, blockIndex);
      const existing = this.items.get(id);
      this.streaming.delete(id);
      const final = finalBlockItem(
        this.base(id, at, parent),
        block,
        {
          messageId,
          blockIndex,
          model,
          aborted: a.aborted === true,
          localCommand:
            a.local_command_run === undefined
              ? null
              : { command: a.local_command_run.command, args: a.local_command_run.args ?? '' },
        },
        this.ctx,
        existing?.item,
      );
      if (final.kind === 'unknown') {
        this.countUnknown(`assistant/block:${final.blockType}`);
        this.put(unknownItem(this.base(id, at, parent), 'assistant', final.blockType, block), out);
      } else if (final.item.kind === 'tool_call') {
        this.putToolCall(final.item, out);
      } else {
        this.put(final.item, out);
      }
      ids.push(id);
    }
    this.blockOrdinals.set(messageId, ordinal);
    if (a.uuid !== undefined) this.frames.set(a.uuid, ids);

    if (a.error !== undefined) {
      const error = assistantErrorPayload(a.error);
      const item = errorItem(this.uuidBase(a.uuid, at, parent), error);
      this.put(item, out);
      if (parent === null) {
        this.turnAssistantError = error;
        out.signals.push({ type: 'assistant_error', error });
      }
    }
    this.fallbackPrompts(a.user_message_uuids, out);
  }

  /** A (new or final) tool_call: applies a decision or result that arrived before the item. */
  private putToolCall(call: ToolCallItem, out: Out): void {
    let item = call;
    const decision = this.pendingDecisions.get(item.toolUseId);
    if (decision !== undefined) {
      this.pendingDecisions.delete(item.toolUseId);
      item = { ...item, decision, status: statusAfterDecision(item, decision) };
    }
    if (item.task === null) {
      const known = [...this.tasks.values()].find((t) => t.toolUseId === item.toolUseId);
      if (known !== undefined) item = { ...item, task: known.task };
    }
    const result = this.pendingResults.get(item.toolUseId);
    if (result !== undefined) {
      this.pendingResults.delete(item.toolUseId);
      item = this.withResult(item, result);
    }
    this.put(fitToolCall(item, this.ctx), out);
  }

  private withResult(call: ToolCallItem, pending: PendingResult): ToolCallItem {
    const result = buildToolResult(pending.block, pending.structured, call.toolName, pending.at, this.ctx);
    const status = statusAfterResult(call, result, pending.meta, pending.structured, this.deniedByCli.has(call.toolUseId));
    return { ...call, result, status, inputPartial: null };
  }

  /** model_refusal_fallback / supersedes: evict the items of these wire uuids (idempotent). */
  private retract(uuids: string[], out: Out): void {
    for (const uuid of uuids) {
      const ids = this.frames.get(uuid) ?? [uuid];
      this.frames.delete(uuid);
      for (const id of ids) {
        const entry = this.items.get(id);
        if (entry === undefined) continue;
        this.items.delete(id);
        this.streaming.delete(id);
        if (entry.item.kind === 'tool_call') this.toolCalls.delete(entry.item.toolUseId);
        if (entry.conversationId === this.conversationId) out.ops.push({ op: 'item.remove', itemId: id });
      }
    }
  }

  // ---- user ----

  private onUser(raw: unknown, receivedAt: Date, out: Out): void {
    const parsed = userMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:user');
      return;
    }
    const u = parsed.data;
    if (u.isReplay === true) {
      bump(this.ignored, 'user/replay');
      return;
    }
    const at = isoTime(u.timestamp, receivedAt);
    const parent = u.parent_tool_use_id ?? null;
    const content = userContent(u.message.content, this.ctx);
    for (const block of content.toolResults) {
      const tr = toolResultBlockSchema.safeParse(block);
      if (!tr.success) {
        this.countUnknown('invalid:user/tool_result');
        continue;
      }
      const meta = u.tool_result_meta?.find((m) => m.id === tr.data.tool_use_id);
      const structured = content.toolResults.length === 1 ? u.tool_use_result : undefined;
      this.applyToolResult({ block: tr.data, structured, meta, at }, out);
    }
    if (content.text.trim() === '' && content.images.length === 0) return;

    const kind = classifyUserText(content.text);
    switch (kind.kind) {
      case 'interrupted':
        this.put(
          { ...this.uuidBase(u.uuid, at, parent), kind: 'system', event: 'interrupted', forToolUse: kind.forToolUse },
          out,
        );
        return;
      case 'task_notification':
        this.applyTaskNotificationText(kind.task, u.uuid, at, out);
        return;
      case 'local_output':
        this.put(
          { ...this.uuidBase(u.uuid, at, parent), kind: 'system', event: 'local_command_output', text: capText(kind.text, this.ctx) },
          out,
        );
        return;
      case 'caveat':
        bump(this.ignored, 'user/local_command_caveat');
        return;
      case 'prompt': {
        if (parent !== null) {
          bump(this.ignored, 'user/subagent_prompt');
          return;
        }
        const uuid = u.uuid;
        if (uuid !== undefined && this.pendingPrompts.has(uuid)) {
          this.createPrompt(uuid, out);
          return;
        }
        if (uuid !== undefined && this.items.has(uuid)) return;
        this.put(
          userMessageItem(this.uuidBase(uuid, at), capText(kind.text, this.ctx), {
            attachments: content.images,
            origin: u.origin?.kind === 'human' ? 'human' : 'other',
            priority: null,
          }),
          out,
        );
      }
    }
  }

  private applyToolResult(pending: PendingResult, out: Out): void {
    const call = this.toolCall(pending.block.tool_use_id);
    if (call === null) {
      this.pendingResults.set(pending.block.tool_use_id, pending);
      return;
    }
    this.streaming.delete(call.id);
    this.put(fitToolCall(this.withResult(call, pending), this.ctx), out);
  }

  private createPrompt(uuid: string, out: Out): void {
    const prompt = this.pendingPrompts.get(uuid);
    if (prompt === undefined) return;
    this.pendingPrompts.delete(uuid);
    if (this.items.has(uuid)) return;
    this.put(
      userMessageItem(this.base(uuid, prompt.at.toISOString(), null), capText(prompt.text, this.ctx), {
        attachments: prompt.attachments,
        origin: 'human',
        priority: prompt.priority,
      }),
      out,
    );
  }

  /** R0-29: without `msg_lifecycle_v1` the prompt item appears with its first `user_message_uuids`. */
  private fallbackPrompts(uuids: string[] | undefined, out: Out): void {
    if (this.lifecycleSupported !== false || uuids === undefined) return;
    for (const uuid of uuids) this.createPrompt(uuid, out);
  }

  // ---- command_lifecycle (untyped, F.9) ----

  private onLifecycle(raw: unknown, out: Out): void {
    const parsed = commandLifecycleMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:command_lifecycle');
      return;
    }
    const { command_uuid: uuid, state } = parsed.data;
    if (state !== 'queued' && state !== 'started' && state !== 'completed' && state !== 'cancelled') {
      this.countUnknown(`command_lifecycle/${state.slice(0, 50)}`);
      return;
    }
    if (state === 'started') {
      this.createPrompt(uuid, out);
      if (this.promptSuggestion !== null) {
        this.promptSuggestion = null;
        out.detail.promptSuggestion = null;
      }
    }
    if (state === 'cancelled' || state === 'completed') this.pendingPrompts.delete(uuid);
    out.signals.push({ type: 'prompt_lifecycle', messageUuid: uuid, state });
  }

  // ---- result ----

  private onResult(raw: unknown, receivedAt: Date, out: Out): void {
    const parsed = resultMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:result');
      return;
    }
    const r = parsed.data;
    const at = receivedAt.toISOString();
    this.closeStreaming(out);
    this.endRetrySeries(out);

    const listed = r.user_message_uuids ?? (r.user_message_uuid === undefined ? undefined : [r.user_message_uuid]);
    if (this.lifecycleSupported !== true) {
      // R0-29: at the latest with the turn_result (no list at all: every pending prompt).
      for (const uuid of listed ?? [...this.pendingPrompts.keys()]) this.createPrompt(uuid, out);
    }

    const numTurns = nonNegativeInt(r.num_turns);
    const outcome = turnOutcome(r);
    const startupFailure = r.startup_failure_reason !== undefined;
    const error: ErrorPayload | null =
      outcome !== 'error'
        ? null
        : startupFailure
          ? makeError(errorCodeForStartupFailure(r.startup_failure_reason ?? ''), {
              reason: (r.startup_failure_reason ?? '').slice(0, 200),
            })
          : (this.turnAssistantError ??
            (r.api_error_status !== undefined && r.api_error_status !== null
              ? makeError('API_ERROR', { status: r.api_error_status })
              : makeError('TURN_FAILED', { subtype: r.subtype.slice(0, 100) })));

    const total = r.total_cost_usd !== undefined && r.total_cost_usd >= 0 ? r.total_cost_usd : null;
    // Difference to the previous result of this query segment (none yet → unknown: a resumed
    // session's first total already contains the earlier turns, F.14). Rounded against float noise.
    const costTurn =
      total !== null && this.lastCostTotal !== null
        ? Math.max(0, Math.round((total - this.lastCostTotal) * 1e9) / 1e9)
        : null;
    if (total !== null) this.lastCostTotal = total;

    const usage = r.usage;
    const item: TurnResultItem = {
      ...this.uuidBase(r.uuid, at),
      kind: 'turn_result',
      outcome,
      subtype: r.subtype,
      terminalReason: r.terminal_reason ?? null,
      stopReason: r.stop_reason ?? null,
      durationMs: Math.max(0, r.duration_ms ?? 0),
      durationApiMs: r.duration_api_ms !== undefined && r.duration_api_ms >= 0 ? r.duration_api_ms : null,
      numTurns,
      usage: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        cacheCreation: usage?.cache_creation_input_tokens ?? 0,
      },
      costUsdTotal: total,
      costUsdTurn: costTurn,
      permissionDenials: r.permission_denials?.length ?? 0,
      errors: resultErrors(r.errors),
      userMessageUuids: listed ?? [],
      synthetic: numTurns === 0,
    };
    this.put(item, out);
    // A result error without an assistant error of this turn gets its own error item.
    if (error !== null && (startupFailure || this.turnAssistantError === null)) {
      this.put(errorItem(this.pxBase(at), error), out);
    }
    const excerpt = (r.result ?? '').trim();
    out.signals.push({
      type: 'turn_result',
      outcome,
      durationMs: item.durationMs,
      costUsdTotal: total,
      error,
      resultExcerpt: excerpt === '' ? null : excerpt.slice(0, 500),
      userMessageUuids: item.userMessageUuids,
      synthetic: item.synthetic,
      startupFailure,
    });
    this.turnAssistantError = null;
  }

  // ---- system/* ----

  private onSystem(raw: unknown, msg: SdkMessageBase, receivedAt: Date, out: Out): void {
    const subtype = msg.subtype ?? '';
    const at = receivedAt.toISOString();
    const invalid = (): void => {
      this.countUnknown(`invalid:system/${subtype}`);
    };
    switch (subtype) {
      case 'init':
        this.onInit(raw, out);
        return;
      case 'status': {
        const s = statusMessageSchema.safeParse(raw);
        if (!s.success) {
          invalid();
          return;
        }
        const compacting = s.data.status === 'compacting';
        if (compacting !== this.compacting) {
          this.compacting = compacting;
          out.signals.push({ type: 'compacting', active: compacting });
        }
        if (s.data.permissionMode !== undefined && s.data.permissionMode !== null) {
          out.signals.push({ type: 'permission_mode', mode: this.readPermissionMode(s.data.permissionMode) });
        }
        this.fallbackPrompts(s.data.user_message_uuids, out);
        return;
      }
      case 'session_state_changed': {
        const s = sessionStateMessageSchema.safeParse(raw);
        if (!s.success) {
          invalid();
          return;
        }
        const state = s.data.state;
        if (state === 'running' || state === 'requires_action' || state === 'idle') {
          out.signals.push({ type: 'session_state', state });
        } else {
          this.countUnknown(`system/session_state_changed:${state.slice(0, 50)}`);
        }
        return;
      }
      case 'thinking_tokens':
        return;
      case 'compact_boundary': {
        const c = compactBoundaryMessageSchema.safeParse(raw);
        if (!c.success) {
          invalid();
          return;
        }
        const meta = c.data.compact_metadata;
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'compact_boundary',
            trigger: meta?.trigger === 'manual' ? 'manual' : 'auto',
            preTokens: meta?.pre_tokens ?? null,
            postTokens: meta?.post_tokens ?? null,
          },
          out,
        );
        return;
      }
      case 'api_retry': {
        const r = apiRetryMessageSchema.safeParse(raw);
        if (!r.success) {
          invalid();
          return;
        }
        const existing = this.retryItemId === null ? undefined : this.items.get(this.retryItemId);
        if (this.retryItemId === null) out.signals.push({ type: 'retry', active: true });
        const base =
          existing === undefined
            ? this.uuidBase(msg.uuid, at)
            : { id: existing.item.id, order: existing.item.order, at: existing.item.at, parentToolUseId: null };
        this.retryItemId = base.id;
        this.put(
          {
            ...base,
            kind: 'system',
            event: 'api_retry',
            attempt: nonNegativeInt(r.data.attempt, 1),
            maxRetries: nonNegativeInt(r.data.max_retries),
            retryDelayMs: Math.max(0, r.data.retry_delay_ms ?? 0),
            errorStatus: r.data.error_status ?? null,
            errorCode: assistantErrorPayload(r.data.error ?? 'unknown').code,
            active: true,
          },
          out,
        );
        return;
      }
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response': {
        const h = hookMessageSchema.safeParse(raw);
        if (!h.success) {
          invalid();
          return;
        }
        const known = this.hooks.get(h.data.hook_id);
        const existing = known === undefined ? undefined : this.items.get(known)?.item;
        const prev = existing?.kind === 'system' && existing.event === 'hook' ? existing : null;
        const base =
          prev === null ? this.uuidBase(msg.uuid, at) : { id: prev.id, order: prev.order, at: prev.at, parentToolUseId: null };
        this.hooks.set(h.data.hook_id, base.id);
        const text =
          h.data.output !== undefined && h.data.output !== ''
            ? h.data.output
            : [h.data.stdout, h.data.stderr].filter((s): s is string => s !== undefined && s !== '').join('\n');
        this.put(
          {
            ...base,
            kind: 'system',
            event: 'hook',
            hookName: h.data.hook_name ?? prev?.hookName ?? '',
            hookEvent: h.data.hook_event ?? prev?.hookEvent ?? '',
            outcome: h.data.outcome ?? prev?.outcome ?? null,
            output: text === '' && prev !== null ? prev.output : capText(text, this.ctx),
          },
          out,
        );
        return;
      }
      case 'informational': {
        const i = informationalMessageSchema.safeParse(raw);
        if (!i.success) {
          invalid();
          return;
        }
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'informational',
            level: i.data.level ?? 'info',
            text: capText(i.data.content ?? '', this.ctx),
            tag: i.data.tag ?? null,
            preventContinuation: i.data.prevent_continuation ?? false,
          },
          out,
        );
        return;
      }
      case 'notification': {
        const n = notificationMessageSchema.safeParse(raw);
        if (!n.success) {
          invalid();
          return;
        }
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'notification',
            key: n.data.key ?? '',
            text: (n.data.text ?? '').slice(0, LIMITS.itemTextChars),
            priority: n.data.priority ?? 'low',
          },
          out,
        );
        return;
      }
      case 'permission_denied': {
        const p = permissionDeniedMessageSchema.safeParse(raw);
        if (!p.success) {
          invalid();
          return;
        }
        const toolUseId = p.data.tool_use_id ?? '';
        if (toolUseId !== '') this.deniedByCli.add(toolUseId);
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'permission_denied',
            toolName: p.data.tool_name ?? '',
            toolUseId,
            message: (p.data.message ?? '').slice(0, LIMITS.itemTextChars),
            reasonType: p.data.decision_reason_type ?? null,
          },
          out,
        );
        const call = this.toolCall(toolUseId);
        if (call?.result?.isError === true && call.status === 'error') this.put({ ...call, status: 'denied' }, out);
        return;
      }
      case 'memory_recall': {
        const m = memoryRecallMessageSchema.safeParse(raw);
        if (!m.success) {
          invalid();
          return;
        }
        const memories = (m.data.memories ?? []).map((e) => ({
          path: e.path ?? '',
          scope: e.scope ?? '',
          content: e.content === undefined ? null : capText(e.content, this.ctx),
        }));
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'memory_recall',
            mode: m.data.mode ?? 'select',
            memories: shareBudget(memories, LIMITS.itemTotalChars - 8 * 1024, this.ctx),
          },
          out,
        );
        return;
      }
      case 'local_command_output': {
        const l = localCommandOutputMessageSchema.safeParse(raw);
        if (!l.success) {
          invalid();
          return;
        }
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'local_command_output',
            text: capText(l.data.content ?? '', this.ctx),
          },
          out,
        );
        return;
      }
      case 'model_refusal_fallback': {
        const f = modelRefusalFallbackMessageSchema.safeParse(raw);
        if (!f.success) {
          invalid();
          return;
        }
        this.retract(f.data.retracted_message_uuids ?? [], out);
        this.put(
          {
            ...this.uuidBase(msg.uuid, at),
            kind: 'system',
            event: 'model_fallback',
            originalModel: f.data.original_model ?? '',
            fallbackModel: f.data.fallback_model ?? '',
            text: (f.data.content ?? '').slice(0, LIMITS.itemTextChars),
          },
          out,
        );
        return;
      }
      case 'model_refusal_no_fallback': {
        const f = modelRefusalNoFallbackMessageSchema.safeParse(raw);
        if (!f.success) {
          invalid();
          return;
        }
        this.put(
          errorItem(this.uuidBase(msg.uuid, at), makeError('MODEL_REFUSAL', { model: (f.data.original_model ?? '').slice(0, 200) })),
          out,
        );
        return;
      }
      case 'task_started': {
        const t = taskStartedMessageSchema.safeParse(raw);
        if (!t.success) {
          invalid();
          return;
        }
        const d = t.data;
        this.updateTask(d.task_id, d.tool_use_id, (task) => ({
          ...task,
          taskType: d.task_type ?? task.taskType,
          description: d.description ?? task.description,
          subagentType: d.subagent_type ?? task.subagentType,
          isBackgrounded: d.is_backgrounded ?? task.isBackgrounded,
          status: 'running',
          startedAt: task.startedAt ?? at,
        }), out);
        return;
      }
      case 'task_updated': {
        const t = taskUpdatedMessageSchema.safeParse(raw);
        if (!t.success) {
          invalid();
          return;
        }
        const patch = t.data.patch ?? {};
        this.updateTask(t.data.task_id, undefined, (task) => ({
          ...task,
          status: patch.status ?? task.status,
          description: patch.description ?? task.description,
          isBackgrounded: patch.is_backgrounded ?? task.isBackgrounded,
          endedAt: millisToIso(patch.end_time) ?? task.endedAt,
        }), out);
        return;
      }
      case 'task_progress': {
        const t = taskProgressMessageSchema.safeParse(raw);
        if (!t.success) {
          invalid();
          return;
        }
        const d = t.data;
        this.updateTask(d.task_id, d.tool_use_id, (task) => ({
          ...task,
          description: d.description ?? task.description,
          subagentType: d.subagent_type ?? task.subagentType,
          summary: d.summary ?? task.summary,
          usage: taskUsage(d.usage) ?? task.usage,
        }), out);
        return;
      }
      case 'task_notification': {
        const t = taskNotificationMessageSchema.safeParse(raw);
        if (!t.success) {
          invalid();
          return;
        }
        const d = t.data;
        const matched = this.updateTask(d.task_id, d.tool_use_id, (task) => ({
          ...task,
          status: d.status ?? 'completed',
          summary: d.summary ?? task.summary,
          usage: taskUsage(d.usage) ?? task.usage,
          endedAt: task.endedAt ?? at,
        }), out);
        if (!matched.matched) {
          this.put({ ...this.uuidBase(msg.uuid, at), kind: 'system', event: 'task_notification', task: matched.task }, out);
        }
        return;
      }
      case 'background_tasks_changed': {
        const b = backgroundTasksMessageSchema.safeParse(raw);
        if (!b.success) {
          invalid();
          return;
        }
        const tasks: BackgroundTask[] = b.data.tasks.map((t) => ({
          taskId: t.task_id,
          taskType: t.task_type ?? '',
          description: t.description ?? '',
          subagentType: t.subagent_type ?? null,
          parentTaskId: t.parent_task_id ?? null,
          ambient: t.ambient ?? false,
        }));
        out.detail.backgroundTasks = tasks;
        out.signals.push({ type: 'background_tasks', count: tasks.filter((t) => !t.ambient).length });
        return;
      }
      case 'session_title_changed': {
        const t = titleChangedMessageSchema.safeParse(raw);
        if (!t.success) {
          invalid();
          return;
        }
        out.signals.push({ type: 'title_changed', title: t.data.title });
        return;
      }
      case 'commands_changed': {
        const c = commandsChangedMessageSchema.safeParse(raw);
        if (!c.success) {
          invalid();
          return;
        }
        const commands: SlashCommandInfo[] = c.data.commands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description ?? '',
          argumentHint: cmd.argumentHint ?? '',
          aliases: cmd.aliases ?? [],
          builtin: cmd.builtin ?? false,
        }));
        out.detail.commands = commands;
        return;
      }
      default:
        if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) {
          bump(this.ignored, `system/${subtype}`);
          return;
        }
        this.unknownMessage(raw, msg, receivedAt, out);
    }
  }

  private readPermissionMode(value: unknown): PermissionMode | null {
    const mode = parsePermissionMode(value);
    if (mode === null && typeof value === 'string') this.countUnknown(unknownEnumCountKey('permissionMode', value));
    return mode;
  }

  private readEffort(value: unknown): EffortLevel | null {
    if (value === undefined || value === null) return null;
    const effort = parseEffortLevel(value);
    if (effort === null && typeof value === 'string') this.countUnknown(unknownEnumCountKey('effort', value));
    return effort;
  }

  private onInit(raw: unknown, out: Out): void {
    const parsed = initMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.session_id.length > 100) {
      this.countUnknown('invalid:system/init');
      return;
    }
    const i = parsed.data;
    const permissionMode = this.readPermissionMode(i.permissionMode);
    const capabilities = i.capabilities ?? [];
    const info: SessionInitInfo = {
      sessionId: i.session_id,
      cwd: i.cwd ?? '',
      model: i.model ?? '',
      permissionMode,
      apiKeySource: i.apiKeySource ?? '',
      cliVersion: i.claude_code_version ?? '',
      tools: i.tools ?? [],
      slashCommands: i.slash_commands ?? [],
      terminalSlashCommands: i.terminal_slash_commands ?? [],
      mcpServers: (i.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status, source: s.source ?? null })),
      skills: i.skills ?? [],
      agents: i.agents ?? [],
      plugins: (i.plugins ?? []).map((p) => ({ name: p.name, version: p.version ?? null })),
      capabilities,
      outputStyle: i.output_style ?? null,
      fastModeState: i.fast_mode_state ?? null,
      effort: this.readEffort(i.effort),
    };
    const json = JSON.stringify(info);
    if (json !== this.lastInitJson) {
      this.lastInitJson = json;
      out.detail.init = info;
    }
    this.lifecycleSupported = capabilities.includes(LIFECYCLE_CAPABILITY);
    out.signals.push({
      type: 'init',
      sessionId: info.sessionId,
      model: info.model,
      permissionMode,
      cliVersion: info.cliVersion,
      apiKeySource: info.apiKeySource,
      capabilities,
    });
    const notApproved = info.mcpServers
      .filter((s) => NOT_APPROVED_MCP_STATUS.has(s.status) && (s.source ?? '').startsWith('project'))
      .map((s) => s.name)
      .sort();
    const key = notApproved.join('\n');
    if (key !== this.notApprovedKey) {
      this.notApprovedKey = key;
      out.signals.push({ type: 'mcp_servers', notApproved });
    }
  }

  // ---- tasks (F.11) ----

  private updateTask(
    taskId: string,
    toolUseId: string | undefined,
    patch: (task: TaskInfo) => TaskInfo,
    out: Out,
  ): { matched: boolean; task: TaskInfo } {
    const known = this.tasks.get(taskId);
    const tuid = toolUseId ?? known?.toolUseId ?? null;
    const call = tuid === null ? null : this.toolCall(tuid);
    const previous = known?.task ?? (call?.task?.taskId === taskId ? call.task : null);
    const task = patch(previous ?? (call === null ? emptyTask(taskId) : taskFromAgentInput(call, taskId)));
    this.tasks.set(taskId, { toolUseId: tuid, task });
    if (call === null) return { matched: false, task };
    this.put({ ...call, task, status: statusWithTask(call, task) }, out);
    return { matched: true, task };
  }

  private applyTaskNotificationText(n: TaskNotificationText, uuid: string | undefined, at: string, out: Out): void {
    const matched = this.updateTask(n.taskId, n.toolUseId ?? undefined, (task) => ({
      ...task,
      status: n.status,
      summary: n.summary ?? task.summary,
      usage: n.usage ?? task.usage,
      endedAt: task.endedAt ?? at,
    }), out);
    if (!matched.matched) {
      this.put({ ...this.uuidBase(uuid, at), kind: 'system', event: 'task_notification', task: matched.task }, out);
    }
  }

  private onToolProgress(raw: unknown, out: Out): void {
    const parsed = toolProgressMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:tool_progress');
      return;
    }
    const call = this.toolCall(parsed.data.tool_use_id);
    if (call === null) return;
    const seconds = Math.max(0, Math.floor(parsed.data.elapsed_time_seconds));
    if (seconds === call.elapsedSeconds) return;
    const status = call.status === 'pending' ? 'running' : call.status;
    this.put({ ...call, elapsedSeconds: seconds, status }, out);
  }

  private endRetrySeries(out: Out): void {
    const id = this.retryItemId;
    if (id === null) return;
    this.retryItemId = null;
    const entry = this.items.get(id);
    if (entry?.item.kind === 'system' && entry.item.event === 'api_retry') this.put({ ...entry.item, active: false }, out);
    out.signals.push({ type: 'retry', active: false });
  }

  // ---- conversation_reset, rate limits, unknown ----

  private onReset(raw: unknown, receivedAt: Date, out: Out): void {
    const parsed = conversationResetMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.countUnknown('invalid:conversation_reset');
      return;
    }
    const r = parsed.data;
    const trigger = r.trigger ?? null;
    this.pendingReset = { id: r.uuid ?? null, trigger, at: isoTime(r.timestamp, receivedAt) };
    this.lastCostTotal = null;
    if (this.sessionId !== null) this.retiredSessionIds.add(this.sessionId);
    out.signals.push({
      type: 'conversation_reset',
      trigger,
      correlationId: r.new_conversation_id ?? r.uuid ?? '',
    });
  }

  private onRateLimit(raw: unknown, msg: SdkMessageBase, receivedAt: Date, out: Out): void {
    const parsed = rateLimitEventSchema.safeParse(raw);
    const info = parsed.success ? toRateLimitInfo(parsed.data.rate_limit_info, receivedAt) : null;
    if (!parsed.success || info === null) {
      this.countUnknown('invalid:rate_limit_event');
      return;
    }
    out.detail.rateLimit = info;
    out.signals.push({ type: 'rate_limit', info });
    if (info.status === 'allowed') return;
    this.put({ ...this.uuidBase(msg.uuid, info.at), kind: 'system', event: 'rate_limit', info }, out);
    if (info.status === 'rejected') {
      // C.5: only `rejected` is an error (credits_required → CLAUDE_BILLING, a setup error).
      const code = errorCodeForRateLimitError(parsed.data.rate_limit_info.errorCode ?? '');
      out.signals.push({ type: 'assistant_error', error: makeError(code, { rateLimitType: info.rateLimitType }) });
    }
  }

  private unknownMessage(raw: unknown, msg: SdkMessageBase, receivedAt: Date, out: Out): void {
    const subtype = msg.subtype ?? null;
    this.countUnknown(subtype === null ? msg.type : `${msg.type}/${subtype}`);
    const item = unknownItem(this.uuidBase(msg.uuid, receivedAt.toISOString()), msg.type, subtype, raw);
    if (msg.uuid !== undefined) this.frames.set(msg.uuid, [item.id]);
    this.put(item, out);
  }
}

/** Live adapter factory (port `CreateLiveNormalizer`). */
export function createLiveNormalizer(ctx: NormalizerContext): LiveNormalizer {
  return new LiveNormalizerImpl(ctx);
}
