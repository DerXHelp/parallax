/**
 * WP-66 – side questions (`/btw`) and taking a queued prompt back, through the real manager with the
 * FakeBackend (speed 0), memory stores and a virtual clock: the `side_question` item (pending →
 * answered, no effect on unread/status/lastActivityAt), a dormant entry is woken, follow-ups send the
 * thread's history, levers (busy, unavailable, none, synthetic, fallback, retry), cancel, the process
 * end, delete, persistence and the repair of a crash-left `pending` item, the idle sleep waits for an
 * open question; `session.withdrawQueued` (withdrawn, already taken over, unknown, unavailable).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { SideQuestionItem } from '@shared/model';
import { FAKE_FALLBACK_MODEL } from '../backend/fake/sideQuestion';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';
import { SIDE_HISTORY_MAX } from './sideQuestions';

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

async function restart(h: EngineHarness): Promise<EngineHarness> {
  harnesses.splice(harnesses.indexOf(h), 1);
  const next = await h.restart();
  harnesses.push(next);
  return next;
}

async function untilIdle(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
}

async function idleEntry(h: EngineHarness, prompt = 'hello first world'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await untilIdle(h, entryId);
  return entryId;
}

/** The side-question items of the entry's view (mirror). */
async function sideItems(h: EngineHarness, entryId: EntryId): Promise<SideQuestionItem[]> {
  const view = await h.manager.loadView(entryId);
  return (view?.items ?? []).filter((i): i is SideQuestionItem => i.kind === 'side_question');
}

async function sideItem(h: EngineHarness, entryId: EntryId, itemId: string): Promise<SideQuestionItem> {
  const item = (await sideItems(h, entryId)).find((i) => i.id === itemId);
  if (item === undefined) throw new Error(`no side question ${itemId}`);
  return item;
}

/** Every published upsert of one item, in order. */
function upserts(h: EngineHarness, entryId: EntryId, itemId: string): SideQuestionItem[] {
  return h.publisher
    .opsOf(entryId)
    .flatMap((op) => (op.op === 'item.upsert' && op.item.id === itemId && op.item.kind === 'side_question' ? [op.item] : []));
}

async function ask(h: EngineHarness, entryId: EntryId, question: string, threadId: string | null = null): Promise<string> {
  const { itemId } = await h.cmd({ name: 'session.askSideQuestion', entryId, question, threadId });
  return itemId;
}

/** Asks and waits until the question is no longer pending. */
async function asked(h: EngineHarness, entryId: EntryId, question: string, threadId: string | null = null) {
  const itemId = await ask(h, entryId, question, threadId);
  await h.waitFor(() => upserts(h, entryId, itemId).at(-1)?.status !== 'pending');
  await h.settle();
  return sideItem(h, entryId, itemId);
}

function sideCalls(h: EngineHarness, entryId: EntryId): unknown[][] {
  return h
    .sessions(entryId)
    .flatMap((s) => s.calls.filter((c) => c.fn === 'askSideQuestion').map((c) => c.args));
}

async function runningTurn(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:long-bash' } });
  await h.waitFor(() => h.session(entryId).state === 'waiting-control');
  await h.settle();
}

/** Ends the `fake:long-bash` turn (moved to the background like Ctrl+B) and what was queued after it. */
async function endTurn(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.cmd({ name: 'session.backgroundTasks', entryId, toolUseId: null });
  await h.waitFor(() => h.facts(entryId).runState === 'idle' && h.facts(entryId).queuedPrompts === 0);
  await h.settle();
}

describe('side questions (§1.1)', () => {
  it('idle: pending at once, then answered – unread, status and lastActivityAt stay', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    h.timers.advance(5_000);
    const facts = h.facts(entryId);
    const lastActivityAt = h.summary(entryId).lastActivityAt;
    const notifications = h.publisher.notifications.length;
    const itemId = await ask(h, entryId, 'What does the config do?');
    expect(upserts(h, entryId, itemId)[0]).toMatchObject({
      kind: 'side_question',
      status: 'pending',
      threadId: itemId,
      question: 'What does the config do?',
      response: null,
      answeredAt: null,
    });
    await h.waitFor(() => upserts(h, entryId, itemId).at(-1)?.status === 'answered');
    await h.settle();
    const item = await sideItem(h, entryId, itemId);
    expect(item).toMatchObject({ status: 'answered', synthetic: false, fallbackModel: null, retry: null, error: null });
    expect(item.response).toContain('What does the config do?');
    expect(item.response).toContain('Claude is idle');
    expect(item.answeredAt).not.toBeNull();
    expect(h.facts(entryId)).toEqual(facts);
    expect(h.summary(entryId).lastActivityAt).toBe(lastActivityAt);
    expect(h.publisher.notifications).toHaveLength(notifications);
    expect(sideCalls(h, entryId)).toEqual([['What does the config do?', { history: [] }]]);
  });

  it('the order follows the conversation: after the last item, before the next turn', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const before = (await h.manager.loadView(entryId))?.items.at(-1)?.order ?? 0;
    const item = await asked(h, entryId, 'Quick one');
    expect(item.order).toBeGreaterThan(before);
    expect(item.id).toBe(`px:${(await h.manager.loadView(entryId))?.conversationId ?? ''}:${String(item.order)}`);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'next turn' } });
    await untilIdle(h, entryId);
    const items = (await h.manager.loadView(entryId))?.items ?? [];
    const orders = items.map((i) => i.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    expect(items.findIndex((i) => i.id === item.id)).toBeLessThan(items.length - 1);
  });

  it('during a running turn: answered, the turn goes on', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await runningTurn(h, entryId);
    const item = await asked(h, entryId, 'Is the build broken?');
    expect(item.status).toBe('answered');
    expect(item.response).toContain('Claude is working on a turn');
    expect(h.session(entryId).state).toBe('waiting-control');
    expect(h.facts(entryId).runState).not.toBe('idle');
    await endTurn(h, entryId);
  });

  it('a dormant entry is started without a turn, then asked', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    const turns = h.facts(entryId).lastTurn;
    const item = await asked(h, entryId, 'Still there?');
    expect(item.status).toBe('answered');
    expect(h.sessions(entryId)).toHaveLength(2);
    expect(h.session(entryId).sent).toHaveLength(0);
    expect(h.facts(entryId).lastTurn).toEqual(turns);
  });

  it('follow-ups send the answered questions of the thread as history (oldest first)', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const first = await asked(h, entryId, 'First question');
    const other = await asked(h, entryId, 'Other thread');
    const second = await asked(h, entryId, 'Second question', first.id);
    expect(second.threadId).toBe(first.id);
    expect(second.response).toContain('(follow-up 1)');
    const third = await asked(h, entryId, 'Third question', first.id);
    expect(third.threadId).toBe(first.id);
    const calls = sideCalls(h, entryId);
    expect(calls[2]).toEqual(['Second question', { history: [{ question: 'First question', response: first.response }] }]);
    expect(calls[3]).toEqual([
      'Third question',
      {
        history: [
          { question: 'First question', response: first.response },
          { question: 'Second question', response: second.response },
        ],
      },
    ]);
    expect(other.threadId).toBe(other.id);
  });

  it(`a long thread sends only the newest ${String(SIDE_HISTORY_MAX)} answered questions`, async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const first = await asked(h, entryId, 'Q0');
    for (let i = 1; i <= SIDE_HISTORY_MAX; i += 1) await asked(h, entryId, `Q${String(i)}`, first.id);
    await asked(h, entryId, 'last', first.id);
    const last = sideCalls(h, entryId).at(-1);
    const history = (last?.[1] as { history: { question: string }[] }).history;
    expect(history).toHaveLength(SIDE_HISTORY_MAX);
    expect(history[0]?.question).toBe('Q1');
    expect(history.at(-1)?.question).toBe(`Q${String(SIDE_HISTORY_MAX)}`);
  });

  it('levers: none and synthetic → synthetic, fallback names the model; neither enters the history', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const none = await asked(h, entryId, 'fake:none');
    expect(none).toMatchObject({ status: 'answered', response: null, synthetic: true });
    const synthetic = await asked(h, entryId, 'fake:synthetic', none.id);
    expect(synthetic).toMatchObject({ status: 'answered', synthetic: true });
    expect(sideCalls(h, entryId).at(-1)).toEqual(['fake:synthetic', { history: [] }]);
    const fallback = await asked(h, entryId, 'fake:fallback');
    expect(fallback).toMatchObject({ status: 'answered', synthetic: false, fallbackModel: FAKE_FALLBACK_MODEL });
  });

  it('busy → failed with SESSION_BUSY; unavailable/failed → CLAUDE_CONTROL_FAILED (the command succeeds)', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const busy = await asked(h, entryId, 'fake:busy');
    expect(busy).toMatchObject({ status: 'failed', error: { code: 'SESSION_BUSY' } });
    const unavailable = await asked(h, entryId, 'fake:unavailable');
    expect(unavailable).toMatchObject({
      status: 'failed',
      error: { code: 'CLAUDE_CONTROL_FAILED', params: { method: 'askSideQuestion', reason: 'unavailable' } },
    });
    const failed = await asked(h, entryId, 'fake:fail');
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'CLAUDE_CONTROL_FAILED' } });
  });

  it('the backend option works like the keyword', async () => {
    const h = await setup({ sideQuestions: { mode: 'busy' } });
    const entryId = await idleEntry(h);
    expect(await asked(h, entryId, 'plain')).toMatchObject({ status: 'failed', error: { code: 'SESSION_BUSY' } });
  });

  it('api_retry progress shows at the open question, then the answer clears it', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const item = await asked(h, entryId, 'fake:retry');
    expect(upserts(h, entryId, item.id).map((u) => [u.status, u.retry])).toEqual([
      ['pending', null],
      ['pending', { attempt: 1, maxRetries: 10 }],
      ['answered', null],
    ]);
  });

  it('cancel: cancelled at once, a second cancel and an unknown id are no-ops', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const itemId = await ask(h, entryId, 'fake:slow');
    await h.settle();
    expect((await sideItem(h, entryId, itemId)).status).toBe('pending');
    await h.cmd({ name: 'session.cancelSideQuestion', entryId, itemId });
    expect((await sideItem(h, entryId, itemId)).status).toBe('cancelled');
    await h.cmd({ name: 'session.cancelSideQuestion', entryId, itemId });
    await h.cmd({ name: 'session.cancelSideQuestion', entryId, itemId: 'px:unknown:1' });
    await h.settle();
    expect(upserts(h, entryId, itemId).map((u) => u.status)).toEqual(['pending', 'cancelled']);
  });

  it('the process ends (close) → open questions end failed', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const itemId = await ask(h, entryId, 'fake:slow');
    await h.settle();
    await h.cmd({ name: 'session.close', entryId });
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    await h.settle();
    expect(await sideItem(h, entryId, itemId)).toMatchObject({
      status: 'failed',
      error: { code: 'SESSION_NOT_RUNNING', params: { entryId, reason: 'exited' } },
    });
  });

  it('delete removes the whole thread (an open follow-up is cancelled), also after a restart', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    const first = await asked(h, entryId, 'Keep me?');
    const second = await asked(h, entryId, 'And me?', first.id);
    const keep = await asked(h, entryId, 'Other thread');
    const open = await ask(h, entryId, 'fake:slow', first.id);
    await h.settle();
    await h.cmd({ name: 'session.deleteSideQuestion', entryId, threadId: first.id });
    const removed = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'item.remove' ? [op.itemId] : []))
      .sort();
    expect(removed).toEqual([first.id, second.id, open].sort());
    expect((await sideItems(h, entryId)).map((i) => i.id)).toEqual([keep.id]);
    await h.cmd({ name: 'session.deleteSideQuestion', entryId, threadId: 'px:unknown:1' });
    h = await restart(h);
    expect((await sideItems(h, entryId)).map((i) => i.id)).toEqual([keep.id]);
  });

  it('persisted over a restart; the shutdown ends an open question failed', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    const answered = await asked(h, entryId, 'Remember me');
    const open = await ask(h, entryId, 'fake:slow');
    await h.settle();
    h = await restart(h);
    const items = await sideItems(h, entryId);
    expect(items.find((i) => i.id === answered.id)).toEqual(answered);
    expect(items.find((i) => i.id === open)).toMatchObject({
      status: 'failed',
      error: { code: 'SESSION_NOT_RUNNING', params: { reason: 'shutdown' } },
    });
  });

  it('a pending item left by a crash is repaired (failed) when the mirror loads', async () => {
    let h = await setup();
    const entryId = await idleEntry(h);
    const view = await h.manager.loadView(entryId);
    if (view === null) throw new Error('no view');
    const order = (view.items.at(-1)?.order ?? 0) + 1;
    const stale: SideQuestionItem = {
      id: `px:${view.conversationId}:${String(order)}`,
      order,
      at: h.now().toISOString(),
      parentToolUseId: null,
      kind: 'side_question',
      threadId: `px:${view.conversationId}:${String(order)}`,
      question: 'Left behind',
      status: 'pending',
      response: null,
      synthetic: false,
      fallbackModel: null,
      retry: null,
      error: null,
      answeredAt: null,
    };
    h.stores.transcripts.append(entryId, view.conversationId, {
      v: 1,
      at: h.now().toISOString(),
      op: 'upsert',
      item: stale,
    });
    h = await restart(h);
    await h.manager.loadView(entryId);
    await h.waitFor(() => upserts(h, entryId, stale.id).at(-1)?.status === 'failed');
    expect(await sideItem(h, entryId, stale.id)).toMatchObject({
      status: 'failed',
      error: { code: 'SESSION_NOT_RUNNING' },
    });
  });

  it('the idle sleep waits for an open question and goes once it ended', async () => {
    const h = await setup({ sleepPolicy: { schedule: () => 60_000 } });
    const entryId = await idleEntry(h);
    expect(h.timers.pending().map((t) => t.ms)).toEqual([60_000]);
    const itemId = await ask(h, entryId, 'fake:slow');
    await h.settle();
    h.timers.advance(60_000);
    await h.settle();
    expect(h.session(entryId).state).not.toBe('exited');
    expect(h.facts(entryId).runState).toBe('idle');
    await h.cmd({ name: 'session.cancelSideQuestion', entryId, itemId });
    expect(h.timers.pending().map((t) => t.ms)).toEqual([60_000]);
    h.timers.advance(60_000);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
  });

  it('archived and external entries refuse side questions', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    for (const cmd of [
      { name: 'session.askSideQuestion', entryId, question: 'x', threadId: null },
      { name: 'session.deleteSideQuestion', entryId, threadId: 'px:x:1' },
      { name: 'session.withdrawQueued', entryId, messageUuid: '00000000-0000-4000-8000-000000000001' },
    ] as const) {
      expect((await h.cmdError(cmd)).code).toBe('SESSION_ARCHIVED');
    }
    expect(sideCalls(h, entryId)).toEqual([]);
  });
});

describe('withdraw a queued prompt (§1.5)', () => {
  async function queued(h: EngineHarness, entryId: EntryId, text: string): Promise<string> {
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text } });
    await h.waitFor(() => h.manager.inspect(entryId)?.queue.some((p) => p.text.text === text && p.state === 'queued') === true);
    const entry = h.manager.inspect(entryId)?.queue.find((p) => p.text.text === text);
    if (entry === undefined) throw new Error('not queued');
    return entry.messageUuid;
  }

  it('withdrawn: leaves the queue, the text comes back, never runs', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await runningTurn(h, entryId);
    const uuid = await queued(h, entryId, 'Then do this');
    expect(h.facts(entryId).queuedPrompts).toBe(1);
    expect(await h.cmd({ name: 'session.withdrawQueued', entryId, messageUuid: uuid })).toEqual({
      withdrawn: true,
      text: 'Then do this',
    });
    expect(h.manager.inspect(entryId)?.queue).toEqual([]);
    expect(h.facts(entryId).queuedPrompts).toBe(0);
    await endTurn(h, entryId);
    const view = await h.manager.loadView(entryId);
    expect(view?.items.some((i) => i.kind === 'user_message' && i.text.text.includes('Then do this'))).toBe(false);
  });

  it('already taken over (fake:taken) → not withdrawn, the queue stays', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await runningTurn(h, entryId);
    const uuid = await queued(h, entryId, 'fake:taken please');
    expect(await h.cmd({ name: 'session.withdrawQueued', entryId, messageUuid: uuid })).toEqual({
      withdrawn: false,
      text: null,
    });
    expect(h.manager.inspect(entryId)?.queue).toHaveLength(1);
    await endTurn(h, entryId);
  });

  it('an unknown uuid → not withdrawn (no control request)', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(
      await h.cmd({ name: 'session.withdrawQueued', entryId, messageUuid: '00000000-0000-4000-8000-000000000009' }),
    ).toEqual({ withdrawn: false, text: null });
    expect(h.session(entryId).controls.filter((c) => c.method === 'cancelAsyncMessage')).toEqual([]);
  });

  it('method missing → CLAUDE_CONTROL_FAILED, the queue stays', async () => {
    const h = await setup({ sideQuestions: { withdraw: 'unavailable' } });
    const entryId = await idleEntry(h);
    await runningTurn(h, entryId);
    const uuid = await queued(h, entryId, 'Then this');
    expect(await h.cmdError({ name: 'session.withdrawQueued', entryId, messageUuid: uuid })).toMatchObject({
      code: 'CLAUDE_CONTROL_FAILED',
    });
    expect(h.manager.inspect(entryId)?.queue).toHaveLength(1);
    await endTurn(h, entryId);
  });
});
