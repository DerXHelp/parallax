/**
 * History adapter contract tests (A.3 "zwei Eingangsadapter mit identischen Items"): the recorded
 * `getSessionMessages` (+ `getSubagentMessages`) results of test/fixtures/sdk/history.jsonl are
 * normalized and compared with the live items of the same conversation. Every difference is
 * listed and tested explicitly below (docs/wp/WP-12.md "Live vs. Verlauf").
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolCallItem, TranscriptItem } from '@shared/model';
import { transcriptItemSchema } from '@shared/model';
import { fixtureCallPayloadSchema } from '../../backend/fixture';
import type { HistoryMessage } from '../../backend/types';
import { normalizeHistory } from './index';
import {
  finalItems,
  loadAllFixtures,
  mergeByTime,
  replayLive,
  snapshotJson,
  testContext,
  toHistoryMessages,
} from './testing/harness';

const fixtures = await loadAllFixtures();

function fixture(name: string) {
  const f = fixtures.get(name);
  if (f === undefined) throw new Error(`fixture ${name} missing`);
  return f;
}

/** history.jsonl: `mark session {scenario, sessionId}` followed by the calls for that session. */
interface RecordedSession {
  scenario: string;
  sessionId: string;
  main: HistoryMessage[] | null;
  subagents: HistoryMessage[][];
}

const markSchema = z.looseObject({ label: z.literal('session'), scenario: z.string(), sessionId: z.string() });

function recordedSessions(): RecordedSession[] {
  const sessions: RecordedSession[] = [];
  let current: RecordedSession | null = null;
  for (const event of fixture('history').events) {
    if (event.kind === 'mark') {
      const mark = markSchema.safeParse(event.payload);
      current = mark.success ? { scenario: mark.data.scenario, sessionId: mark.data.sessionId, main: null, subagents: [] } : null;
      if (current !== null) sessions.push(current);
      continue;
    }
    if (event.kind !== 'call' || current === null) continue;
    const call = fixtureCallPayloadSchema.parse(event.payload);
    if (call.fn === 'getSessionMessages' && call.args.length === 1 && current.main === null) {
      current.main = toHistoryMessages(call.result);
    }
    if (call.fn === 'getSubagentMessages') {
      const messages = toHistoryMessages(call.result);
      if (messages !== null) current.subagents.push(messages);
    }
  }
  return sessions;
}

const sessions = recordedSessions();
const full = sessions.filter(
  (s): s is RecordedSession & { main: HistoryMessage[] } => s.main !== null && fixtures.has(s.scenario),
);

function historyItems(session: RecordedSession & { main: HistoryMessage[] }): ReturnType<typeof normalizeHistory> {
  return normalizeHistory(mergeByTime(session.main, ...session.subagents), testContext());
}

function liveItems(scenario: string): TranscriptItem[] {
  const replay = replayLive(fixture(scenario));
  return Object.values(finalItems(replay)).flat();
}

/** Kinds the history can contain at all (no result/system frames in getSessionMessages). */
function inHistoryScope(item: TranscriptItem): boolean {
  if (item.kind === 'turn_result') return false;
  if (item.kind === 'system') {
    return item.event === 'interrupted' || item.event === 'local_command_output' || item.event === 'task_notification';
  }
  return true;
}

/**
 * What the history says for a live `denied` call: the permission decision / tool_result_meta are
 * live-only, so it sees the CLI text – `interrupted` after a deny with interrupt, else `error`.
 */
function historyStatusOfDenied(call: Omit<ToolCallItem, 'order'>): ToolCallItem['status'] {
  const text = call.result?.content.map((c) => (c.type === 'text' ? c.text.text : '')).join('\n') ?? '';
  return text.startsWith("The user doesn't want to proceed with this tool use") ? 'interrupted' : 'error';
}

/**
 * Projection without the documented differences: `order` (history has no turn_result/system
 * items, so absolute orders shift – the relative order is compared), user_message.at/priority,
 * tool_call.result.structured, decision, task details only known live, `denied` (live only).
 */
function comparable(item: TranscriptItem): unknown {
  const { order: _order, ...rest } = item;
  switch (rest.kind) {
    case 'user_message':
      return { ...rest, at: null, priority: null };
    case 'tool_call': {
      const call: Omit<ToolCallItem, 'order'> = rest;
      return {
        ...call,
        status: call.status === 'denied' ? historyStatusOfDenied(call) : call.status,
        decision: null,
        result: call.result === null ? null : { ...call.result, structured: null, structuredTruncated: null },
        task:
          call.task === null
            ? null
            : {
                taskId: call.task.taskId,
                taskType: call.task.taskType,
                status: call.task.status,
                description: call.task.description,
                subagentType: call.task.subagentType,
                summary: call.task.summary,
                usage: call.task.usage,
              },
      };
    }
    default:
      return rest;
  }
}

describe('history fixture', () => {
  it('contains full message lists for permissions, ask-user-question, plan-mode and subagent', () => {
    expect(full.map((s) => s.scenario).sort()).toEqual(['ask-user-question', 'permissions', 'plan-mode', 'subagent']);
    expect(full.find((s) => s.scenario === 'subagent')?.subagents.length).toBe(1);
  });
});

describe.each(full.map((s) => [s.scenario, s] as const))('normalizeHistory: %s', (scenario, session) => {
  const history = historyItems(session);
  const live = liveItems(scenario).filter(inHistoryScope);

  it('produces schema-true items without unknown counts', () => {
    for (const item of history.items) expect(transcriptItemSchema.parse(item)).toStrictEqual(item);
    expect(history.unknownCounts).toEqual({});
  });

  it('yields the same item ids in the same relative order as live', () => {
    expect(history.items.map((i) => i.id)).toEqual(live.map((i) => i.id));
  });

  it('yields identical items apart from the documented differences', () => {
    expect(history.items.map(comparable)).toEqual(live.map(comparable));
  });

  it('documented differences: no structured result, no priority, no decision, statuses without metadata', () => {
    const liveById = new Map(live.map((i) => [i.id, i]));
    for (const item of history.items) {
      const twin = liveById.get(item.id);
      if (item.kind === 'user_message' && twin?.kind === 'user_message') {
        expect(item.priority).toBeNull();
        expect(twin.priority).not.toBeNull();
      }
      if (item.kind === 'tool_call' && twin?.kind === 'tool_call') {
        expect(item.result?.structured ?? null).toBeNull();
        expect(item.decision).toBeNull();
        // `denied` needs the permission decision / tool_result_meta → the history says error/interrupted.
        if (twin.status === 'denied') expect(['error', 'interrupted']).toContain(item.status);
        else expect(item.status).toBe(twin.status);
        // Edit diff fallback (A.3): old_string/new_string stay in the input.
        if (item.toolName === 'Edit') {
          const input = z.looseObject({ old_string: z.string(), new_string: z.string() }).safeParse(item.input);
          expect(input.success).toBe(true);
        }
      }
    }
    expect(history.items.some((i) => i.kind === 'turn_result')).toBe(false);
  });

  it('matches the snapshot', async () => {
    await expect(snapshotJson({ scenario, sessionId: session.sessionId, ...history })).toMatchFileSnapshot(
      `./__snapshots__/history/${scenario}.json`,
    );
  });
});

describe('normalizeHistory details', () => {
  const ctx = testContext();
  const at = '2026-10-15T08:00:00.000Z';
  const user = (uuid: string, content: unknown, parentToolUseId: string | null = null): HistoryMessage => ({
    type: 'user',
    uuid,
    sessionId: 's',
    message: { role: 'user', content },
    parentToolUseId,
    timestamp: at,
  });
  const assistant = (uuid: string, id: string, content: unknown[], parentToolUseId: string | null = null): HistoryMessage => ({
    type: 'assistant',
    uuid,
    sessionId: 's',
    message: { id, model: 'claude-haiku-5-5', content },
    parentToolUseId,
    timestamp: at,
  });

  it('maps CLI meta texts: slash command, local command output, caveat, interrupt marker', () => {
    const { items } = normalizeHistory(
      [
        user('u1', '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>New title</command-args>'),
        user('u2', '<local-command-stdout>Session renamed to: New title</local-command-stdout>'),
        user('u3', '<local-command-caveat>Caveat: …</local-command-caveat>'),
        user('u4', [{ type: 'text', text: '[Request interrupted by user]' }]),
      ],
      ctx,
    );
    expect(items.map((i) => [i.id, i.kind, i.kind === 'system' ? i.event : null])).toEqual([
      ['u1', 'user_message', null],
      ['u2', 'system', 'local_command_output'],
      ['u4', 'system', 'interrupted'],
    ]);
    const prompt = items[0];
    expect(prompt?.kind === 'user_message' ? [prompt.text.text, prompt.slashCommand] : null).toEqual([
      '/rename New title',
      '/rename',
    ]);
  });

  it('closes tool calls without result as interrupted and keeps the Edit input for the diff fallback', () => {
    const { items } = normalizeHistory(
      [
        assistant('a1', 'msg_1', [
          { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'a.txt', old_string: 'a', new_string: 'b' } },
        ]),
      ],
      ctx,
    );
    expect(items[0]).toMatchObject({
      id: 'msg_1:0',
      kind: 'tool_call',
      status: 'interrupted',
      result: null,
      input: { old_string: 'a', new_string: 'b' },
    });
  });

  it('counts system messages and broken messages instead of failing', () => {
    const result = normalizeHistory(
      [
        { type: 'system', uuid: 'x', sessionId: 's', message: { subtype: 'compact_boundary' }, parentToolUseId: null, timestamp: at },
        { type: 'assistant', uuid: 'y', sessionId: 's', message: 'nonsense', parentToolUseId: null, timestamp: null },
        user('u9', [{ type: 'tool_result', tool_use_id: 'toolu_unknown', content: 'x' }]),
      ],
      ctx,
    );
    expect(result.items).toEqual([]);
    expect(result.unknownCounts).toEqual({
      'history/system': 1,
      'invalid:history/assistant': 1,
      'history/orphan_tool_result': 1,
    });
  });
});
