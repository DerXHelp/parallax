import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadAllFixtures, mergeByTime } from '../../sessions/normalizer/testing/harness';
import { fixtureCallPayloadSchema } from '../fixture';
import type { HistoryMessage } from '../types';
import { mergeHistory, sliceSubagentMessages, toHistoryMessages, toSessionInfo, toSubagentSlice } from './parse';

const fixtures = await loadAllFixtures();
const history = fixtures.get('history');
if (history === undefined) throw new Error('history fixture missing');
const calls = history.events
  .filter((e) => e.kind === 'call')
  .map((e) => fixtureCallPayloadSchema.parse(e.payload));

function message(
  uuid: string,
  timestamp: string | null,
  parentToolUseId: string | null = null,
): HistoryMessage {
  return { type: 'assistant', uuid, sessionId: 's1', message: {}, parentToolUseId, timestamp, origin: null };
}

describe('toHistoryMessages', () => {
  const arrays = calls.filter(
    (c) => (c.fn === 'getSessionMessages' || c.fn === 'getSubagentMessages') && Array.isArray(c.result),
  );

  it('maps every recorded SessionMessage (incl. timestamp and origin)', () => {
    expect(arrays.length).toBeGreaterThanOrEqual(5);
    for (const call of arrays) {
      const raw = z.array(z.unknown()).parse(call.result);
      const mapped = toHistoryMessages(raw);
      expect(mapped).toHaveLength(raw.length);
      for (const m of mapped) {
        expect(m.timestamp).not.toBeNull();
        expect(['user', 'assistant', 'system']).toContain(m.type);
      }
    }
    const all = arrays.flatMap((c) => toHistoryMessages(c.result));
    expect(all.some((m) => m.origin?.kind === 'human')).toBe(true);
    expect(all.some((m) => m.origin?.kind === 'task-notification')).toBe(true);
    expect(all.filter((m) => m.type === 'assistant').every((m) => m.origin === null)).toBe(true);
    expect(all.some((m) => m.parentToolUseId !== null)).toBe(true);
  });

  it('maps the fields exactly', () => {
    expect(
      toHistoryMessages([
        {
          type: 'user',
          uuid: 'u1',
          session_id: 's1',
          message: { role: 'user', content: 'hi' },
          parent_tool_use_id: null,
          parent_agent_id: null,
          timestamp: '2026-10-15T08:00:00.000Z',
          origin: { kind: 'human', extra: 1 },
        },
      ]),
    ).toEqual([
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 's1',
        message: { role: 'user', content: 'hi' },
        parentToolUseId: null,
        timestamp: '2026-10-15T08:00:00.000Z',
        origin: { kind: 'human' },
      },
    ]);
  });

  it('skips unknown types and invalid entries, tolerates broken optional fields', () => {
    const out = toHistoryMessages([
      { type: 'progress', uuid: 'x', session_id: 's1' },
      { type: 'user', session_id: 's1' },
      'nope',
      null,
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        message: {},
        parent_tool_use_id: 7,
        timestamp: 5,
        origin: 'x',
      },
    ]);
    expect(out).toEqual([
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: 's1',
        message: {},
        parentToolUseId: null,
        timestamp: null,
        origin: null,
      },
    ]);
  });

  it('non-arrays (summary calls, null) → []', () => {
    expect(toHistoryMessages({ count: 4, types: [] })).toEqual([]);
    expect(toHistoryMessages(null)).toEqual([]);
    expect(toHistoryMessages(undefined)).toEqual([]);
  });
});

describe('mergeHistory', () => {
  it('merges by time, stable, main first on ties', () => {
    const main = [message('m1', '2026-10-15T08:00:00.000Z'), message('m2', '2026-10-15T08:00:02.000Z')];
    const sub = [
      message('s1', '2026-10-15T08:00:01.000Z', 't1'),
      message('s2', '2026-10-15T08:00:02.000Z', 't1'),
    ];
    expect(mergeHistory(main, [sub]).map((m) => m.uuid)).toEqual(['m1', 's1', 'm2', 's2']);
  });

  it('a message without timestamp keeps its predecessor’s key (R0-18)', () => {
    const main = [
      message('m1', '2026-10-15T08:00:00.000Z'),
      message('m2', null),
      message('m3', '2026-10-15T08:00:05.000Z'),
    ];
    const sub = [message('s1', '2026-10-15T08:00:01.000Z', 't1')];
    expect(mergeHistory(main, [sub]).map((m) => m.uuid)).toEqual(['m1', 'm2', 's1', 'm3']);
    // Leading messages without timestamp come first.
    expect(
      mergeHistory([message('x', null)], [[message('y', '2026-10-15T08:00:00.000Z', 't')]]).map(
        (m) => m.uuid,
      ),
    ).toEqual(['x', 'y']);
  });

  it('keeps the order inside each list even if timestamps go backwards', () => {
    const main = [message('m1', '2026-10-15T08:00:05.000Z'), message('m2', '2026-10-15T08:00:01.000Z')];
    expect(mergeHistory(main, []).map((m) => m.uuid)).toEqual(['m1', 'm2']);
  });

  it('equals the WP-12 harness merge for the recorded subagent history', () => {
    const subagentSession = 'f406f5df-fee1-4f18-8d56-528330faa035';
    const mainCall = calls.find(
      (c) => c.fn === 'getSessionMessages' && c.args[0] === subagentSession && Array.isArray(c.result),
    );
    const subCall = calls.find((c) => c.fn === 'getSubagentMessages' && Array.isArray(c.result));
    const main = toHistoryMessages(mainCall?.result);
    const sub = toHistoryMessages(subCall?.result);
    expect(main.length).toBeGreaterThan(0);
    expect(sub.length).toBeGreaterThan(0);
    expect(mergeHistory(main, [sub]).map((m) => m.uuid)).toEqual(mergeByTime(main, sub).map((m) => m.uuid));
  });
});

describe('toSessionInfo', () => {
  it('maps every recorded getSessionInfo result', () => {
    const infos = calls.filter((c) => c.fn === 'getSessionInfo' && c.result !== null);
    expect(infos.length).toBeGreaterThanOrEqual(8);
    for (const call of infos) {
      const info = toSessionInfo(call.result);
      expect(info).not.toBeNull();
      expect(info?.sessionId).toBe(call.args[0]);
      expect(info?.firstPrompt).toEqual(expect.any(String));
    }
    const first = toSessionInfo(infos[0]?.result);
    expect(first).toEqual({
      sessionId: 'b5b08dcc-9154-4b5d-ab66-bd7ac894c16a',
      summary: 'Reply with exact OK',
      customTitle: 'Reply with exact OK',
      firstPrompt: 'Reply with exactly: OK',
      lastModified: 1794417835573,
    });
  });

  it('null/invalid → null, missing optional fields → null/defaults', () => {
    expect(toSessionInfo(null)).toBeNull();
    expect(toSessionInfo(undefined)).toBeNull();
    expect(toSessionInfo({ summary: 'no id' })).toBeNull();
    expect(toSessionInfo('x')).toBeNull();
    expect(toSessionInfo({ sessionId: 's1' })).toEqual({
      sessionId: 's1',
      summary: '',
      customTitle: null,
      firstPrompt: null,
      lastModified: 0,
    });
  });
});

describe('WP-69: subagent slices', () => {
  const raw = (uuid: string) => ({
    type: 'assistant',
    uuid,
    session_id: 's1',
    message: {},
    parent_tool_use_id: 'toolu_a',
    timestamp: null,
  });

  it('sliceSubagentMessages: from the known count, the uuid before it and the last; from is clamped', () => {
    const list = [raw('a1'), raw('a2'), raw('a3')];
    const slice = sliceSubagentMessages(list, 1);
    expect(slice).toMatchObject({ total: 3, previousUuid: 'a1', lastUuid: 'a3' });
    expect(slice.messages.map((m) => m.uuid)).toEqual(['a2', 'a3']);
    expect(sliceSubagentMessages(list, 0)).toMatchObject({ previousUuid: null, lastUuid: 'a3' });
    expect(sliceSubagentMessages(list, 7)).toEqual({ total: 3, previousUuid: 'a3', lastUuid: 'a3', messages: [] });
    expect(sliceSubagentMessages(list, -2).messages).toHaveLength(3);
    expect(sliceSubagentMessages([], 0)).toEqual({ total: 0, previousUuid: null, lastUuid: null, messages: [] });
  });

  it('toSubagentSlice: checked answer, invalid messages skipped (total stays), unusable → empty', () => {
    const slice = toSubagentSlice({ total: 4, previousUuid: 'a1', lastUuid: 'a3', messages: [raw('a2'), 'x', raw('a3')] });
    expect(slice).toMatchObject({ total: 4, previousUuid: 'a1', lastUuid: 'a3' });
    expect(slice.messages.map((m) => m.uuid)).toEqual(['a2', 'a3']);
    expect(toSubagentSlice({ total: 1, previousUuid: 5, lastUuid: null, messages: [] })).toMatchObject({
      previousUuid: null,
    });
    for (const unusable of [null, 'x', { total: -1, messages: [] }, { total: 1 }]) {
      expect(toSubagentSlice(unusable)).toEqual({ total: 0, previousUuid: null, lastUuid: null, messages: [] });
    }
  });
});
