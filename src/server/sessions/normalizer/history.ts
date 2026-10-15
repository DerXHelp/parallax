/**
 * History adapter (A.3): messages from `getSessionMessages` (+ `getSubagentMessages`, merged by
 * time – `AgentBackend.readHistory`, WP-13) → the same items as the live adapter. The history has
 * timestamps but no `tool_use_result` (F.15) → `result.structured = null`; renderers build the
 * Edit diff from `input.old_string`/`new_string`, which stay in the input. Known differences to
 * live (no turn_result/system frames, statuses without permission metadata …): docs/wp/WP-12.md.
 * Pure: no I/O, the messages are already loaded (the worker per config dir belongs to WP-13).
 */
import { z } from 'zod';
import type { TranscriptItem, ToolCallItem, TaskInfo } from '@shared/model';
import type { HistoryMessage } from '../../backend/types';
import type { NormalizeHistory, NormalizerContext } from '../ports';
import {
  blockItemId,
  buildToolResult,
  bump,
  classifyUserText,
  emptyTask,
  finalBlockItem,
  isoTime,
  pxItemId,
  statusAfterResult,
  statusWithTask,
  taskFromAgentInput,
  unknownItem,
  userContent,
  userMessageItem,
  type ItemBase,
  type TaskNotificationText,
} from './builders';
import { capText, fitToolCall } from './limits';
import { opt, toolResultBlockSchema } from './sdk-schemas';

const historyAssistantSchema = z.looseObject({
  id: opt(z.string()),
  model: opt(z.string()),
  content: z.array(z.unknown()),
});
const historyUserSchema = z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) });

/** Tool statuses that cannot continue in a loaded (dormant) history. */
const OPEN_STATUSES: ReadonlySet<ToolCallItem['status']> = new Set([
  'streaming_input',
  'pending',
  'awaiting_decision',
  'running',
  'background',
]);

class HistoryBuilder {
  private readonly items = new Map<string, TranscriptItem>();
  private readonly toolCalls = new Map<string, string>();
  private readonly ordinals = new Map<string, number>();
  private order: number;
  readonly unknownCounts: Record<string, number> = {};

  constructor(private readonly ctx: NormalizerContext) {
    this.order = ctx.nextOrder;
  }

  private base(id: string, at: string, parentToolUseId: string | null): ItemBase {
    const existing = this.items.get(id);
    return { id, order: existing?.order ?? this.order++, at, parentToolUseId };
  }

  private uuidBase(uuid: string, at: string, parentToolUseId: string | null): ItemBase {
    if (uuid !== '') return this.base(uuid, at, parentToolUseId);
    const order = this.order++;
    return { id: pxItemId(this.ctx.conversationId, order), order, at, parentToolUseId };
  }

  private put(item: TranscriptItem): void {
    this.items.set(item.id, item);
    if (item.kind === 'tool_call') this.toolCalls.set(item.toolUseId, item.id);
  }

  private toolCall(toolUseId: string): ToolCallItem | null {
    const id = this.toolCalls.get(toolUseId);
    const item = id === undefined ? undefined : this.items.get(id);
    return item?.kind === 'tool_call' ? item : null;
  }

  add(message: HistoryMessage): void {
    const at = isoTime(message.timestamp, this.ctx.now());
    const parent = message.parentToolUseId;
    switch (message.type) {
      case 'assistant':
        this.assistant(message, at, parent);
        return;
      case 'user':
        this.user(message, at, parent);
        return;
      default:
        bump(this.unknownCounts, 'history/system');
    }
  }

  private assistant(message: HistoryMessage, at: string, parent: string | null): void {
    const parsed = historyAssistantSchema.safeParse(message.message);
    if (!parsed.success) {
      bump(this.unknownCounts, 'invalid:history/assistant');
      return;
    }
    const messageId = parsed.data.id ?? message.uuid;
    const model = parsed.data.model ?? null;
    let ordinal = this.ordinals.get(messageId) ?? 0;
    for (const block of parsed.data.content) {
      const blockIndex = ordinal++;
      const id = blockItemId(messageId, blockIndex);
      const final = finalBlockItem(
        this.base(id, at, parent),
        block,
        { messageId, blockIndex, model, aborted: false, localCommand: null },
        this.ctx,
        this.items.get(id),
      );
      if (final.kind === 'unknown') {
        bump(this.unknownCounts, `assistant/block:${final.blockType}`);
        this.put(unknownItem(this.base(id, at, parent), 'assistant', final.blockType, block));
      } else {
        this.put(final.item);
      }
    }
    this.ordinals.set(messageId, ordinal);
  }

  private user(message: HistoryMessage, at: string, parent: string | null): void {
    const parsed = historyUserSchema.safeParse(message.message);
    if (!parsed.success) {
      bump(this.unknownCounts, 'invalid:history/user');
      return;
    }
    const content = userContent(parsed.data.content, this.ctx);
    for (const block of content.toolResults) {
      const tr = toolResultBlockSchema.safeParse(block);
      if (!tr.success) {
        bump(this.unknownCounts, 'invalid:history/tool_result');
        continue;
      }
      const call = this.toolCall(tr.data.tool_use_id);
      if (call === null) {
        bump(this.unknownCounts, 'history/orphan_tool_result');
        continue;
      }
      const result = buildToolResult(tr.data, undefined, call.toolName, at, this.ctx);
      const status = statusAfterResult(call, result, undefined, undefined, false);
      this.put(fitToolCall({ ...call, result, status, inputPartial: null }, this.ctx));
    }
    if (content.text.trim() === '' && content.images.length === 0) return;

    const kind = classifyUserText(content.text);
    switch (kind.kind) {
      case 'interrupted':
        this.put({ ...this.uuidBase(message.uuid, at, parent), kind: 'system', event: 'interrupted', forToolUse: kind.forToolUse });
        return;
      case 'task_notification':
        this.taskNotification(kind.task, message.uuid, at);
        return;
      case 'local_output':
        this.put({
          ...this.uuidBase(message.uuid, at, parent),
          kind: 'system',
          event: 'local_command_output',
          text: capText(kind.text, this.ctx),
        });
        return;
      case 'caveat':
        return;
      case 'prompt':
        // A subagent's own prompt (parentToolUseId set) is the Agent tool input – live shows no item.
        if (parent !== null) return;
        this.put(
          userMessageItem(this.uuidBase(message.uuid, at, null), capText(kind.text, this.ctx), {
            attachments: content.images,
            // HistoryMessage.origin (R1-07): like live; unknown (absent/null) counts as human.
            origin: (message.origin?.kind ?? 'human') === 'human' ? 'human' : 'other',
            priority: null,
          }),
        );
    }
  }

  private taskNotification(n: TaskNotificationText, uuid: string, at: string): void {
    const call = n.toolUseId === null ? null : this.toolCall(n.toolUseId);
    const previous: TaskInfo = call?.task ?? (call === null ? emptyTask(n.taskId) : taskFromAgentInput(call, n.taskId));
    const task: TaskInfo = {
      ...previous,
      status: n.status,
      summary: n.summary ?? previous.summary,
      usage: n.usage ?? previous.usage,
      endedAt: previous.endedAt ?? at,
    };
    if (call === null) {
      this.put({ ...this.uuidBase(uuid, at, null), kind: 'system', event: 'task_notification', task });
      return;
    }
    this.put({ ...call, task, status: statusWithTask(call, task) });
  }

  finish(): TranscriptItem[] {
    const items = [...this.items.values()].map((item) =>
      item.kind === 'tool_call' && OPEN_STATUSES.has(item.status) ? { ...item, status: 'interrupted' as const } : item,
    );
    return items.sort((a, b) => a.order - b.order);
  }
}

/** History adapter (port `NormalizeHistory`). Messages must already be in time order. */
export const normalizeHistory: NormalizeHistory = (messages, ctx) => {
  const builder = new HistoryBuilder(ctx);
  for (const message of messages) builder.add(message);
  return { items: builder.finish(), unknownCounts: { ...builder.unknownCounts } };
};
