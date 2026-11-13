import { describe, expect, it } from 'vitest';
import { toHistoryMessages, toSessionInfo } from '../history/parse';
import { createFakeHistoryStore } from './history';
import { loadFixtureScenario } from './testing';

const S = '5e550000-0000-4000-8000-0000000000d1';

describe('FakeHistoryStore', () => {
  it('records live user/assistant messages (no replays, no other types), subagent messages separately', () => {
    const store = createFakeHistoryStore({ now: () => new Date('2026-10-15T08:00:00.000Z') });
    store.record(S, {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First prompt' },
      origin: { kind: 'human' },
    });
    store.record(S, {
      type: 'user',
      uuid: 'u1r',
      message: { role: 'user', content: 'First prompt' },
      isReplay: true,
    });
    store.record(S, { type: 'system', subtype: 'init', uuid: 'i1' });
    store.record(S, { type: 'stream_event', uuid: 'se' });
    store.record(S, {
      type: 'assistant',
      uuid: 'a1',
      message: { content: [] },
      parent_tool_use_id: null,
      timestamp: '2026-10-15T08:00:01.000Z',
    });
    store.record(S, {
      type: 'assistant',
      uuid: 'sa1',
      message: { content: [] },
      parent_tool_use_id: 'toolu_agent',
      agent_id: 'agent-1',
    });
    store.record('', { type: 'assistant', uuid: 'ignored' });
    const main = toHistoryMessages(store.messages(S));
    expect(main.map((m) => [m.type, m.uuid])).toEqual([
      ['user', 'u1'],
      ['assistant', 'a1'],
    ]);
    expect(main[0]).toMatchObject({ timestamp: '2026-10-15T08:00:00.000Z', origin: { kind: 'human' } });
    expect(store.subagents(S)).toEqual([
      {
        agentId: 'agent-1',
        messages: [expect.objectContaining({ uuid: 'sa1', parent_tool_use_id: 'toolu_agent' })],
      },
    ]);
    expect(toSessionInfo(store.info(S))).toEqual({
      sessionId: S,
      summary: 'First prompt',
      customTitle: null,
      firstPrompt: 'First prompt',
      lastModified: Date.parse('2026-10-15T08:00:00.000Z'),
    });
    expect(store.info('unknown')).toBeNull();
  });

  it('WP-69: task_started links the Agent tool use to its agent id; recordSubagent appends transcript-only messages', () => {
    const store = createFakeHistoryStore({ now: () => new Date('2026-10-15T08:00:00.000Z') });
    store.record(S, { type: 'system', subtype: 'task_started', task_id: 'task_toolu_a', tool_use_id: 'toolu_a' });
    store.recordSubagent(S, 'task_toolu_a', {
      type: 'user',
      uuid: 'p1',
      message: { role: 'user', content: 'Look around.' },
      parent_tool_use_id: 'toolu_a',
    });
    store.record(S, { type: 'assistant', uuid: 'sa1', message: { content: [] }, parent_tool_use_id: 'toolu_a' });
    store.record(S, { type: 'assistant', uuid: 'sb1', message: { content: [] }, parent_tool_use_id: 'toolu_b' });
    store.recordSubagent(S, '', { type: 'user', uuid: 'ignored', message: {} });
    store.recordSubagent(S, 'task_toolu_a', { type: 'system', uuid: 'not-a-message' });
    expect(store.subagentMessages(S, 'task_toolu_a')).toEqual([
      expect.objectContaining({ uuid: 'p1', session_id: S, timestamp: '2026-10-15T08:00:00.000Z' }),
      expect.objectContaining({ uuid: 'sa1', parent_tool_use_id: 'toolu_a' }),
    ]);
    // Without task_started the tool use id names the file (as before).
    expect(store.subagentMessages(S, 'toolu_b')).toEqual([expect.objectContaining({ uuid: 'sb1' })]);
    expect(store.subagentMessages(S, 'unknown')).toEqual([]);
    expect(store.subagentMessages('other', 'task_toolu_a')).toEqual([]);
    expect(store.messages(S)).toEqual([]);
  });

  it('summary: custom title > AI title > first prompt', () => {
    const store = createFakeHistoryStore();
    store.record(S, {
      type: 'user',
      uuid: 'u',
      message: { role: 'user', content: [{ type: 'text', text: 'Do it' }] },
    });
    store.setAiTitle(S, 'Fake: Do it');
    // Like SDK 0.3.296 (WP22-02): the AI title also comes as customTitle.
    expect(toSessionInfo(store.info(S))).toMatchObject({
      summary: 'Fake: Do it',
      customTitle: 'Fake: Do it',
      firstPrompt: 'Do it',
    });
    store.rename(S, 'Mine');
    expect(toSessionInfo(store.info(S))).toMatchObject({ summary: 'Mine', customTitle: 'Mine' });
    expect(store.sessionIds()).toEqual([S]);
  });

  it('seedFromHistoryFixture: first array/object answer per session, summary calls skipped', async () => {
    const store = createFakeHistoryStore();
    store.seedFromHistoryFixture(await loadFixtureScenario('history'));
    // permissions: full getSessionMessages array (36 messages).
    expect(toHistoryMessages(store.messages('8d6345bc-8000-47cb-ab61-4aa2fde7130a'))).toHaveLength(36);
    // auth-probe: only summary answers ({count, types}) → no messages, but the info.
    expect(store.messages('b5b08dcc-9154-4b5d-ab66-bd7ac894c16a')).toEqual([]);
    expect(toSessionInfo(store.info('b5b08dcc-9154-4b5d-ab66-bd7ac894c16a'))).toMatchObject({
      summary: 'Reply with exact OK',
      firstPrompt: 'Reply with exactly: OK',
    });
    expect(store.info('b5b08dcc-9154-4b5d-ab66-bd7ac894c16a')).toMatchObject({ gitBranch: 'HEAD' });
    const subagents = store.subagents('f406f5df-fee1-4f18-8d56-528330faa035');
    expect(subagents.map((s) => s.agentId)).toEqual(['a09720160328a4872']);
    expect(subagents[0]?.messages.length).toBeGreaterThan(0);
  });
});
