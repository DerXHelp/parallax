/**
 * Helpers for synthetic test streams (R0-06): SDK message types without a recorded fixture as
 * `.ts` modules in fixture format v1 (`export const events: FixtureEvent[]`). The factories mirror
 * the shapes of SDK 0.3.296 (sdk.d.ts) and of the recorded fixtures (snake_case, untyped extras).
 */
import type { EventKind, FixtureEvent } from '../../../backend/fixture';

export const SESSION_ID = '5e550000-0000-4000-8000-000000000001';
export const SESSION_ID_2 = '5e550000-0000-4000-8000-000000000002';

/** Deterministic UUID for synthetic frames: `00000000-0000-4000-9000-<n>`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-9000-${n.toString(16).padStart(12, '0')}`;
}

/** Events with gap-free seq and tMs = index × stepMs; starts with a `spawn` like a recording. */
export function sequence(steps: readonly (readonly [EventKind, unknown])[], stepMs = 10): FixtureEvent[] {
  const spawn: readonly [EventKind, unknown] = [
    'spawn',
    { pid: 4242, command: '<HOME>\\.local\\bin\\claude.exe', args: [], cwd: 'D:\\work\\synthetic' },
  ];
  return [spawn, ...steps].map(([kind, payload], index) => ({ seq: index + 1, tMs: index * stepMs, kind, payload }));
}

export function input(id: string, text: string, priority: 'next' | 'now' = 'next'): readonly [EventKind, unknown] {
  return [
    'input',
    {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: id,
      origin: { kind: 'human' },
      priority,
    },
  ];
}

export function msg(payload: Record<string, unknown>, sessionId = SESSION_ID): readonly [EventKind, unknown] {
  return ['message', { ...payload, session_id: sessionId }];
}

export function init(
  n: number,
  extra: Record<string, unknown> = {},
  sessionId = SESSION_ID,
): readonly [EventKind, unknown] {
  return msg(
    {
      type: 'system',
      subtype: 'init',
      cwd: 'D:\\work\\synthetic',
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Agent'],
      mcp_servers: [],
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      slash_commands: ['clear', 'compact'],
      apiKeySource: 'none',
      claude_code_version: '2.1.300',
      output_style: 'default',
      agents: ['general-purpose'],
      skills: [],
      plugins: [],
      capabilities: ['msg_lifecycle_v1'],
      fast_mode_state: 'off',
      uuid: uuid(n),
      ...extra,
    },
    sessionId,
  );
}

export function state(n: number, value: 'running' | 'requires_action' | 'idle'): readonly [EventKind, unknown] {
  return msg({ type: 'system', subtype: 'session_state_changed', state: value, uuid: uuid(n) });
}

export function lifecycle(n: number, commandUuid: string, value: string): readonly [EventKind, unknown] {
  return msg({ type: 'command_lifecycle', command_uuid: commandUuid, state: value, uuid: uuid(n) });
}

export function usage(input = 2, output = 10, cacheRead = 20_000, cacheCreation = 500): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

export function assistant(
  n: number,
  messageId: string,
  content: unknown,
  extra: Record<string, unknown> = {},
  model = 'claude-haiku-5-5',
): readonly [EventKind, unknown] {
  return msg({
    type: 'assistant',
    message: {
      model,
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [content],
      stop_reason: null,
      usage: usage(),
    },
    parent_tool_use_id: null,
    uuid: uuid(n),
    timestamp: new Date(Date.UTC(2026, 9, 15, 8, 0, 0, n)).toISOString(),
    ...extra,
  });
}

export function toolResult(
  n: number,
  toolUseId: string,
  content: unknown,
  extra: Record<string, unknown> = {},
  isError = false,
): readonly [EventKind, unknown] {
  return msg({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: uuid(n),
    timestamp: new Date(Date.UTC(2026, 9, 15, 8, 0, 1, n)).toISOString(),
    ...extra,
  });
}

export function stream(n: number, messageId: string, event: Record<string, unknown>): readonly [EventKind, unknown] {
  return msg({ type: 'stream_event', event, parent_tool_use_id: null, uuid: uuid(n), api_message_id: messageId });
}

export function messageStart(n: number, messageId: string, model = 'claude-haiku-5-5'): readonly [EventKind, unknown] {
  return stream(n, messageId, {
    type: 'message_start',
    message: { id: messageId, model, type: 'message', role: 'assistant', content: [], usage: usage(2, 1) },
  });
}

export function result(n: number, extra: Record<string, unknown> = {}, sessionId = SESSION_ID): readonly [EventKind, unknown] {
  return msg(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1200,
      duration_api_ms: 1000,
      num_turns: 1,
      result: 'OK',
      stop_reason: 'end_turn',
      total_cost_usd: 0.001,
      usage: usage(),
      modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000, costUSD: 0.001 } },
      permission_denials: [],
      terminal_reason: 'completed',
      uuid: uuid(n),
      ...extra,
    },
    sessionId,
  );
}

export function system(n: number, subtype: string, extra: Record<string, unknown> = {}): readonly [EventKind, unknown] {
  return msg({ type: 'system', subtype, uuid: uuid(n), ...extra });
}
