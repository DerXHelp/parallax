/**
 * WP-69 – `session.subagentTranscript` through the real manager with the FakeBackend (its history
 * store plays the CLI's `agent-<id>.jsonl`), memory stores and a virtual clock: the transcript grows
 * while the agent runs (`fake:background`, `fake:subagent`), paging and the tail, the incremental
 * read (only new messages; a rewritten file is read again), dormant/archived/external entries and
 * the error rows. Everything passes the hub-like validation of the harness (command and result
 * schemas).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { SubagentTranscriptPage, TranscriptItem } from '@shared/model';
import { sampleEntry, sampleExternalHandoff, sampleId, SAMPLE_IDS } from '@shared/samples';
import { createFakeHistoryStore, type FakeHistoryStore } from '../backend/fakeBackend';
import { FAKE_BACKGROUND_MS, FAKE_BACKGROUND_SUMMARY } from '../backend/fake/phase3';
import { FAKE_SUBAGENT_STEPS } from '../backend/fake/wp69';
import type { SubagentHistoryRequest } from '../backend/types';
import { nextMacrotask } from '../lib/async';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

async function untilIdle(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
}

/**
 * FakeBackend timing that holds the two long waits of `fake:background` until the test releases
 * them (`release()`), every short delay on the next macrotask.
 */
function heldBackground(): { timing: EngineHarnessOptions['fakeTiming']; held: () => number; release: () => void } {
  const gates: (() => void)[] = [];
  return {
    timing: {
      speed: 1,
      sleep: (ms) =>
        ms >= FAKE_BACKGROUND_MS / 2 ? new Promise<void>((resolve) => gates.push(resolve)) : nextMacrotask(),
    },
    held: () => gates.length,
    release: () => gates.shift()?.(),
  };
}

function page(
  h: EngineHarness,
  entryId: EntryId,
  agentId: string,
  extra: { offset?: number | null; limit?: number; conversationId?: string | null } = {},
): Promise<SubagentTranscriptPage> {
  return h.cmd({ name: 'session.subagentTranscript', entryId, agentId, ...extra });
}

/** Kind and the telling text of each item (tool name, text). */
function shape(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'user_message':
        return `user:${item.text.text}`;
      case 'assistant_text':
        return `text:${item.text}`;
      case 'thinking':
        return 'thinking';
      case 'tool_call':
        return `tool:${item.toolName}:${item.status}`;
      default:
        return item.kind;
    }
  });
}

/** Records the `from` of every subagent read of the backend. */
function recordReads(h: EngineHarness): SubagentHistoryRequest[] {
  const reads: SubagentHistoryRequest[] = [];
  const read = h.backend.readSubagentHistory.bind(h.backend);
  h.backend.readSubagentHistory = (req) => {
    reads.push(req);
    return read(req);
  };
  return reads;
}

/** A user + assistant transcript of `agentId` in the sample session (seeded entries). */
function seededHistory(agentId: string): FakeHistoryStore {
  const history = createFakeHistoryStore();
  history.recordSubagent(SAMPLE_IDS.sessionId, agentId, {
    type: 'user',
    uuid: '5ab00000-0000-4000-8000-000000000001',
    message: { role: 'user', content: 'Find the notes.' },
    parent_tool_use_id: 'toolu_seed',
    timestamp: '2026-10-15T08:00:00.000Z',
  });
  history.recordSubagent(SAMPLE_IDS.sessionId, agentId, {
    type: 'assistant',
    uuid: '5ab00000-0000-4000-8000-000000000002',
    message: {
      id: 'msg_seed',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'They are in notes.md.' }],
    },
    parent_tool_use_id: 'toolu_seed',
    timestamp: '2026-10-15T08:00:01.000Z',
  });
  return history;
}

describe('session.subagentTranscript (WP-69)', () => {
  it('fake:background: grows while the agent runs (running), the whole transcript after its end; ids and orders stay', async () => {
    const hold = heldBackground();
    const h = await setup({ fakeTiming: hold.timing });
    const reads = recordReads(h);
    const entryId = await h.create('fake:background');
    await h.waitFor(() => h.facts(entryId).backgroundTasks === 1 && hold.held() === 1);
    await h.settle();
    const view = await h.manager.loadView(entryId);
    const agentId = view?.detail.backgroundTasks[0]?.taskId;
    if (agentId === undefined) throw new Error('no background task');

    const first = await page(h, entryId, agentId);
    expect(first.running).toBe(true);
    expect(shape(first.items)).toEqual([
      'user:Look through the project and summarize it.',
      'thinking',
      'tool:Bash:done',
    ]);
    expect(first.items.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(first).toMatchObject({ offset: 0, total: 3 });

    hold.release();
    await h.waitFor(() => hold.held() === 1);
    await h.settle();
    const second = await page(h, entryId, agentId);
    expect(second.running).toBe(true);
    expect(shape(second.items).slice(3)).toEqual(['thinking', 'tool:Write:done']);
    expect(second.items.slice(0, 3)).toEqual(first.items);

    hold.release();
    await h.waitFor(() => h.facts(entryId).backgroundTasks === 0);
    await untilIdle(h, entryId);
    const last = await page(h, entryId, agentId);
    expect(last.running).toBe(false);
    expect(shape(last.items).at(-1)).toBe(`text:${FAKE_BACKGROUND_SUMMARY}`);
    expect(last.total).toBe(6);
    // Only the new messages were read each time (the worker slices from the known count).
    expect(reads.map((r) => r.from)).toEqual([0, 3, 5]);
    // Nothing of the agent's transcript went into the session's own items.
    const own = h.publisher.opsOf(entryId).flatMap((op) => (op.op === 'item.upsert' ? [op.item.id] : []));
    expect(last.items.some((item) => own.includes(item.id))).toBe(false);
  });

  it('fake:subagent: prompt, one step per pause, the answer from the stream; running false after the end', async () => {
    const h = await setup();
    const entryId = await h.create('fake:subagent');
    await untilIdle(h, entryId);
    const agent = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'item.upsert' && op.item.kind === 'tool_call' && op.item.toolName === 'Agent' ? [op.item] : []))
      .at(-1);
    const agentId = agent?.kind === 'tool_call' ? agent.task?.taskId : undefined;
    if (agentId === undefined) throw new Error('no agent task');
    const result = await page(h, entryId, agentId);
    expect(result.running).toBe(false);
    expect(shape(result.items)).toEqual([
      'user:Reply with exactly the word PONG.',
      ...FAKE_SUBAGENT_STEPS.flatMap((step) => ['thinking', `tool:${step.tool}:done`]),
      'thinking',
      'text:PONG',
    ]);
  });

  it('paging: offset/limit, the tail for offset null, an offset past the end', async () => {
    const h = await setup({ history: seededHistory('agent-seed'), seed: { entries: [sampleEntry()] } });
    const entryId = SAMPLE_IDS.entry;
    const all = await page(h, entryId, 'agent-seed');
    expect(shape(all.items)).toEqual(['user:Find the notes.', 'text:They are in notes.md.']);
    expect(await page(h, entryId, 'agent-seed', { offset: 0, limit: 1 })).toMatchObject({
      offset: 0,
      total: 2,
      items: [all.items[0]],
    });
    expect(await page(h, entryId, 'agent-seed', { limit: 1 })).toMatchObject({
      offset: 1,
      total: 2,
      items: [all.items[1]],
    });
    expect(await page(h, entryId, 'agent-seed', { offset: 5 })).toEqual({
      items: [],
      offset: 2,
      total: 2,
      running: false,
    });
    // An explicit conversation id reads the same transcript.
    expect((await page(h, entryId, 'agent-seed', { conversationId: SAMPLE_IDS.conversation })).items).toEqual(
      all.items,
    );
  });

  it('a rewritten file (other uuid before the slice) is read again from the start; an unchanged one adds nothing', async () => {
    const h = await setup({ history: seededHistory('agent-seed'), seed: { entries: [sampleEntry()] } });
    const entryId = SAMPLE_IDS.entry;
    const reads = recordReads(h);
    const read = h.backend.readSubagentHistory.bind(h.backend);
    const first = await page(h, entryId, 'agent-seed');
    expect((await page(h, entryId, 'agent-seed')).items).toEqual(first.items);
    let rewritten = true;
    h.backend.readSubagentHistory = async (req) => {
      const slice = await read(req);
      if (!rewritten || req.from === 0) return slice;
      rewritten = false;
      return { ...slice, previousUuid: 'another-chain' };
    };
    const again = await page(h, entryId, 'agent-seed');
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    expect(reads.map((r) => r.from)).toEqual([0, 2, 2, 0]);
  });

  it('dormant after a restart, archived and external entries read the file too; a missing file is an empty page', async () => {
    const archived = sampleEntry({ id: sampleId('en', 4), archived: true, lastRunState: 'sleeping' });
    const external = sampleEntry({
      id: sampleId('en', 3),
      lastRunState: 'external',
      external: sampleExternalHandoff(),
    });
    const h = await setup({ history: seededHistory('agent-seed'), seed: { entries: [archived, external] } });
    for (const entryId of [archived.id, external.id]) {
      expect(shape((await page(h, entryId, 'agent-seed')).items)).toEqual([
        'user:Find the notes.',
        'text:They are in notes.md.',
      ]);
    }
    expect(await page(h, archived.id, 'agent-unknown')).toEqual({ items: [], offset: 0, total: 0, running: false });

    const entryId = await h.create('fake:subagent');
    await untilIdle(h, entryId);
    const agentId = h.backend.history.subagents(h.session(entryId).sessionId ?? '').at(0)?.agentId;
    if (agentId === undefined) throw new Error('no agent transcript');
    const live = await page(h, entryId, agentId);
    harnesses.splice(harnesses.indexOf(h), 1);
    const next = await h.restart();
    harnesses.push(next);
    const dormant = await page(next, entryId, agentId);
    expect(dormant.running).toBe(false);
    expect(shape(dormant.items)).toEqual(shape(live.items));
  });

  it('error rows: ENTRY_NOT_FOUND, CONVERSATION_NOT_FOUND, SESSION_NOT_STARTED, FILE_NOT_READABLE', async () => {
    const h = await setup({ history: seededHistory('agent-seed'), seed: { entries: [sampleEntry()] } });
    const cmd = (entryId: EntryId, extra: { conversationId?: string } = {}) => ({
      name: 'session.subagentTranscript' as const,
      entryId,
      agentId: 'agent-seed',
      ...extra,
    });
    expect((await h.cmdError(cmd(sampleId('en', 99)))).code).toBe('ENTRY_NOT_FOUND');
    expect(await h.cmdError(cmd(SAMPLE_IDS.entry, { conversationId: sampleId('cv', 99) }))).toEqual({
      code: 'CONVERSATION_NOT_FOUND',
      params: { conversationId: sampleId('cv', 99) },
    });
    const dormant = await h.create(null);
    expect(await h.cmdError(cmd(dormant))).toEqual({ code: 'SESSION_NOT_STARTED', params: { entryId: dormant } });

    h.backend.readSubagentHistory = () => Promise.reject(new Error('worker timed out'));
    expect(await h.cmdError(cmd(SAMPLE_IDS.entry))).toEqual({
      code: 'FILE_NOT_READABLE',
      params: { agentId: 'agent-seed' },
    });
  });
});
