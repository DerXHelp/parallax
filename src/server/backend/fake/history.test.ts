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
    // permissions: full getSessionMessages array (33 messages).
    expect(toHistoryMessages(store.messages('a81548fd-0d35-40a2-97f8-c4091b6bd31c'))).toHaveLength(33);
    // auth-probe: only summary answers ({count, types}) → no messages, but the info.
    expect(store.messages('a2aa36f5-56fb-42f9-af06-3db55a33470f')).toEqual([]);
    expect(toSessionInfo(store.info('a2aa36f5-56fb-42f9-af06-3db55a33470f'))).toMatchObject({
      summary: 'Simple OK reply',
      firstPrompt: 'Reply with exactly: OK',
    });
    expect(store.info('a2aa36f5-56fb-42f9-af06-3db55a33470f')).toMatchObject({ gitBranch: 'HEAD' });
    const subagents = store.subagents('a0cb07c5-45cb-4164-b7d5-c808ecf195a6');
    expect(subagents.map((s) => s.agentId)).toEqual(['a21769cfed6286bb5']);
    expect(subagents[0]?.messages.length).toBeGreaterThan(0);
  });
});
