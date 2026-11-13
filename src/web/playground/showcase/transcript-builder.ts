import type { JsonValue } from '@shared/common';
import type {
  SideQuestionItem,
  TaskInfo,
  ToolCallItem,
  ToolCallStatus,
  ToolDecisionRef,
  ToolResult,
  TranscriptItem,
  TurnResultItem,
  UserMessageItem,
} from '@shared/model';

/**
 * A tiny builder for the showcase transcripts (WP-68): items in order, times as "seconds before
 * now", ids in the engine's shapes (`msg_…:<block>`, `toolu_…`). Only what the showcase needs.
 */

export interface ToolOptions {
  status?: ToolCallStatus;
  /** Text of the tool result (null: no result yet). */
  output?: string | null;
  /** When the result came, seconds before now (default: two seconds after the call). */
  resultSeconds?: number;
  isError?: boolean;
  structured?: JsonValue;
  elapsedSeconds?: number;
  task?: TaskInfo;
  decision?: ToolDecisionRef;
  parentToolUseId?: string;
}

export interface TranscriptBuilder {
  readonly items: TranscriptItem[];
  /** ISO time `seconds` before now. */
  ago(seconds: number): string;
  user(text: string, seconds: number, p?: Partial<UserMessageItem>): void;
  thinking(text: string, seconds: number, streaming?: boolean): void;
  text(markdown: string, seconds: number): void;
  /** Returns the toolUseId. */
  tool(toolName: string, input: JsonValue, seconds: number, options?: ToolOptions): string;
  sideQuestion(question: string, response: string, seconds: number, answeredAfter: number): void;
  turn(seconds: number, p: Partial<TurnResultItem>): void;
}

export function textResult(
  text: string,
  at: string,
  options: { isError?: boolean; structured?: JsonValue } = {},
): ToolResult {
  return {
    isError: options.isError ?? false,
    content: [{ type: 'text', text: { text, truncated: null } }],
    structured: options.structured ?? null,
    structuredTruncated: null,
    at,
  };
}

/** `key`: short word for message/tool ids; `seed`: number for the UUID-shaped ids. */
export function transcriptBuilder(key: string, seed: number, now: number, model: string): TranscriptBuilder {
  const items: TranscriptItem[] = [];
  const uuid = (variant: '8' | '9', n: number) =>
    `00000000-0000-4000-${variant}000-${seed.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
  let order = 0;
  let message = 0;
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const nextMessage = () => {
    message += 1;
    return `msg_01${key}${String(message).padStart(3, '0')}`;
  };

  return {
    items,
    ago,
    user(text, seconds, p = {}) {
      order += 1;
      items.push({
        kind: 'user_message',
        id: uuid('8', order),
        order,
        at: ago(seconds),
        parentToolUseId: null,
        text: { text, truncated: null },
        attachments: [],
        origin: 'human',
        slashCommand: null,
        priority: 'next',
        source: 'local',
        ...p,
      });
    },
    thinking(text, seconds, streaming = false) {
      order += 1;
      const messageId = nextMessage();
      items.push({
        kind: 'thinking',
        id: `${messageId}:0`,
        order,
        at: ago(seconds),
        parentToolUseId: null,
        messageId,
        blockIndex: 0,
        model,
        text: { text, truncated: null },
        redacted: false,
        streaming,
      });
    },
    text(markdown, seconds) {
      order += 1;
      const messageId = nextMessage();
      items.push({
        kind: 'assistant_text',
        id: `${messageId}:0`,
        order,
        at: ago(seconds),
        parentToolUseId: null,
        messageId,
        blockIndex: 0,
        model,
        text: markdown,
        streaming: false,
        aborted: false,
        localCommand: null,
      });
    },
    tool(toolName, input, seconds, options = {}) {
      order += 1;
      const messageId = nextMessage();
      const toolUseId = `toolu_01${key}${String(order).padStart(3, '0')}`;
      const status = options.status ?? 'done';
      const output = options.output === undefined ? 'OK' : options.output;
      const item: ToolCallItem = {
        kind: 'tool_call',
        id: `${messageId}:0`,
        order,
        at: ago(seconds),
        parentToolUseId: options.parentToolUseId ?? null,
        messageId,
        blockIndex: 0,
        model,
        toolUseId,
        toolName,
        input,
        inputTruncated: null,
        inputPartial: null,
        status,
        result:
          output === null
            ? null
            : textResult(output, ago(options.resultSeconds ?? Math.max(0, seconds - 2)), {
                isError: options.isError ?? false,
                ...(options.structured === undefined ? {} : { structured: options.structured }),
              }),
        elapsedSeconds: options.elapsedSeconds ?? null,
        task: options.task ?? null,
        decision: options.decision ?? null,
      };
      items.push(item);
      return toolUseId;
    },
    sideQuestion(question, response, seconds, answeredAfter) {
      order += 1;
      const id = `px:${key}:${String(order)}`;
      const item: SideQuestionItem = {
        kind: 'side_question',
        id,
        order,
        at: ago(seconds),
        parentToolUseId: null,
        threadId: id,
        question,
        status: 'answered',
        response,
        synthetic: false,
        fallbackModel: null,
        retry: null,
        error: null,
        answeredAt: ago(seconds - answeredAfter),
      };
      items.push(item);
    },
    turn(seconds, p) {
      order += 1;
      items.push({
        kind: 'turn_result',
        id: uuid('9', order),
        order,
        at: ago(seconds),
        parentToolUseId: null,
        outcome: 'success',
        subtype: 'success',
        terminalReason: null,
        stopReason: 'end_turn',
        durationMs: 60_000,
        durationApiMs: 52_000,
        numTurns: 8,
        usage: { input: 1_200, output: 4_800, cacheRead: 180_000, cacheCreation: 12_000 },
        costUsdTotal: 0.42,
        costUsdTurn: 0.42,
        permissionDenials: 0,
        errors: [],
        userMessageUuids: [],
        synthetic: false,
        ...p,
      });
    },
  };
}

/** `cat -n` style output of the Read tool. */
export function numbered(text: string, from = 1): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line, index) => `${String(from + index).padStart(6)}\t${line}`)
    .join('\n');
}
