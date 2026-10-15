import { describe, expect, it } from 'vitest';
import type { SeqOp, SessionOp } from './protocol';
import {
  SAMPLE_IDS,
  sampleDecisions,
  sampleDetail,
  sampleId,
  sampleItems,
  sampleQueuedPrompt,
  sampleSessionSnapshot,
  sampleTime,
} from './samples';
import {
  applySeqOps,
  applySessionOp,
  applySessionOps,
  mergeItems,
  trimItems,
  viewStateFromSnapshot,
  type SessionViewState,
} from './sync';

/** Recursively freezes the input so any mutation by a reducer throws (purity check). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function state(): SessionViewState {
  return deepFreeze(viewStateFromSnapshot(sampleSessionSnapshot()));
}

const ids = (s: SessionViewState) => s.items.map((i) => i.id);
const seqOps = (from: number, ops: SessionOp[]): SeqOp[] =>
  ops.map((op, i) => ({ seq: from + i, at: sampleTime(from + i), op }));

describe('viewStateFromSnapshot', () => {
  it('takes seq, conversation and sorted, de-duplicated items', () => {
    const [a, b, c] = [sampleItems.userMessage(), sampleItems.thinking(), sampleItems.assistantText()];
    const view = viewStateFromSnapshot(
      sampleSessionSnapshot({
        seq: 42,
        items: [c, a, b, a],
        decisions: [sampleDecisions.plan(), sampleDecisions.permission()],
      }),
    );
    expect(view.seq).toBe(42);
    expect(view.conversationId).toBe(SAMPLE_IDS.conversation);
    expect(ids(view)).toEqual([a.id, b.id, c.id]);
    expect(view.decisions.map((d) => d.kind)).toEqual(['permission', 'plan']);
  });
});

describe('applySessionOp – op table', () => {
  it('item.upsert replaces an existing id in place', () => {
    const s = state();
    const updated = sampleItems.thinking({ text: { text: 'changed', truncated: null } });
    const next = applySessionOp(s, { op: 'item.upsert', item: updated });
    expect(ids(next)).toEqual(ids(s));
    expect(next.items[1]).toEqual(updated);
  });

  it('item.upsert inserts a new item by order (end and middle)', () => {
    const s = state();
    const last = sampleItems.assistantText({ id: 'new-last', order: 99 });
    const middle = sampleItems.assistantText({ id: 'new-mid', order: 3 });
    const next = applySessionOps(s, [
      { op: 'item.upsert', item: last },
      { op: 'item.upsert', item: middle },
    ]);
    expect(ids(next)).toEqual([...ids(s).slice(0, 3), 'new-mid', ...ids(s).slice(3), 'new-last']);
  });

  it('item.upsert of an old item out of order lands at its order', () => {
    const s = trimItems(state(), 2);
    const old = sampleItems.userMessage();
    const next = applySessionOp(s, { op: 'item.upsert', item: old });
    expect(next.items[0]?.id).toBe(old.id);
  });

  it('item.delta appends to assistant text, thinking text and tool input', () => {
    const streaming = sampleItems.assistantText({ id: 'a', order: 50, text: 'O', streaming: true });
    const thinking = sampleItems.thinking({
      id: 't',
      order: 51,
      text: { text: 'Hm', truncated: null },
      streaming: true,
    });
    const tool = sampleItems.toolCall({ id: 'c', order: 52, inputPartial: null, status: 'streaming_input' });
    const s = applySessionOps(state(), [
      { op: 'item.upsert', item: streaming },
      { op: 'item.upsert', item: thinking },
      { op: 'item.upsert', item: tool },
    ]);
    const next = applySessionOps(deepFreeze(s), [
      { op: 'item.delta', itemId: 'a', field: 'text', append: 'K' },
      { op: 'item.delta', itemId: 't', field: 'thinking', append: 'm' },
      { op: 'item.delta', itemId: 't', field: 'text', append: '!' },
      { op: 'item.delta', itemId: 'c', field: 'inputPartial', append: '{"command":' },
    ]);
    const byId = new Map(next.items.map((i) => [i.id, i]));
    expect(byId.get('a')).toMatchObject({ text: 'OK' });
    expect(byId.get('t')).toMatchObject({ text: { text: 'Hmm!' } });
    expect(byId.get('c')).toMatchObject({ inputPartial: '{"command":' });
  });

  it('item.delta on an unknown id or a non-matching field is ignored', () => {
    const s = state();
    expect(applySessionOp(s, { op: 'item.delta', itemId: 'nope', field: 'text', append: 'x' })).toBe(s);
    const userId = sampleItems.userMessage().id;
    expect(applySessionOp(s, { op: 'item.delta', itemId: userId, field: 'text', append: 'x' })).toBe(s);
    const textId = sampleItems.assistantText().id;
    expect(applySessionOp(s, { op: 'item.delta', itemId: textId, field: 'inputPartial', append: 'x' })).toBe(
      s,
    );
  });

  it('item.remove removes if present', () => {
    const s = state();
    const id = sampleItems.thinking().id;
    expect(ids(applySessionOp(s, { op: 'item.remove', itemId: id }))).not.toContain(id);
    expect(applySessionOp(s, { op: 'item.remove', itemId: 'nope' })).toBe(s);
  });

  it('conversation.reset clears items, decisions and hasEarlier and switches the conversation', () => {
    const s = deepFreeze({ ...state(), hasEarlier: true, decisions: [sampleDecisions.permission()] });
    const next = applySessionOp(s, {
      op: 'conversation.reset',
      conversationId: sampleId('cv', 2),
      previousConversationId: SAMPLE_IDS.conversation,
      trigger: 'clear',
    });
    expect(next.items).toEqual([]);
    expect(next.decisions).toEqual([]);
    expect(next.hasEarlier).toBe(false);
    expect(next.conversationId).toBe(sampleId('cv', 2));
    expect(next.detail.conversationId).toBe(sampleId('cv', 2));
    expect(next.seq).toBe(s.seq);
  });

  it('decision.upsert inserts by createdAt and replaces by id', () => {
    const s = state();
    const late = sampleDecisions.plan({ createdAt: sampleTime(100) });
    const early = sampleDecisions.permission({ createdAt: sampleTime(1) });
    const next = applySessionOps(s, [
      { op: 'decision.upsert', decision: late },
      { op: 'decision.upsert', decision: early },
      { op: 'decision.upsert', decision: { ...late, state: 'expired' } },
    ]);
    expect(next.decisions.map((d) => [d.kind, d.state])).toEqual([
      ['permission', 'open'],
      ['plan', 'expired'],
    ]);
  });

  it('decision.resolved removes the decision; unknown ids are ignored', () => {
    const s = applySessionOp(state(), { op: 'decision.upsert', decision: sampleDecisions.question() });
    const resolved = {
      op: 'decision.resolved',
      outcome: { type: 'answered' },
      byClientId: null,
      at: sampleTime(),
    } as const;
    const id = sampleDecisions.question().id;
    expect(applySessionOp(s, { ...resolved, decisionId: id }).decisions).toEqual([]);
    expect(applySessionOp(s, { ...resolved, decisionId: sampleId('dc', 99) })).toBe(s);
  });

  it('detail.patch overwrites exactly the given fields (arrays are replaced)', () => {
    const s = deepFreeze({
      ...state(),
      detail: sampleDetail({ queue: [sampleQueuedPrompt()], unknownCounts: { 'x/y': 2 } }),
    });
    const next = applySessionOp(s, { op: 'detail.patch', patch: { queue: [], promptSuggestion: 'go on' } });
    expect(next.detail.queue).toEqual([]);
    expect(next.detail.promptSuggestion).toBe('go on');
    expect(next.detail.unknownCounts).toEqual({ 'x/y': 2 });
    expect(next.detail.init).toEqual(s.detail.init);
  });

  it('detail.patch ignores keys present with undefined', () => {
    const s = state();
    const next = applySessionOp(s, {
      op: 'detail.patch',
      patch: { models: undefined, promptSuggestion: 'x' },
    });
    expect(next.detail.models).toEqual(s.detail.models);
  });

  it('applying the same upsert twice is idempotent', () => {
    const op: SessionOp = { op: 'item.upsert', item: sampleItems.assistantText({ id: 'z', order: 70 }) };
    const once = applySessionOp(state(), op);
    expect(applySessionOp(once, op)).toEqual(once);
  });
});

describe('applySeqOps', () => {
  const upsert = (id: string, order: number): SessionOp => ({
    op: 'item.upsert',
    item: sampleItems.assistantText({ id, order }),
  });

  it('applies a contiguous replay and advances seq', () => {
    const s = state();
    const { state: next, gap } = applySeqOps(s, seqOps(s.seq + 1, [upsert('r1', 60), upsert('r2', 61)]));
    expect(gap).toBe(false);
    expect(next.seq).toBe(s.seq + 2);
    expect(ids(next).slice(-2)).toEqual(['r1', 'r2']);
  });

  it('an empty replay changes nothing', () => {
    const s = state();
    expect(applySeqOps(s, [])).toEqual({ state: s, gap: false });
  });

  it('a gap leaves the state unchanged', () => {
    const s = state();
    expect(applySeqOps(s, seqOps(s.seq + 2, [upsert('g', 60)]))).toEqual({ state: s, gap: true });
    expect(
      applySeqOps(s, [...seqOps(s.seq + 1, [upsert('a', 60)]), ...seqOps(s.seq + 3, [upsert('b', 61)])]),
    ).toEqual({
      state: s,
      gap: true,
    });
  });

  it('already applied ops (duplicates / replay overlap) are skipped', () => {
    const s = state();
    const first = applySeqOps(s, seqOps(s.seq + 1, [upsert('d1', 60), upsert('d2', 61)])).state;
    const again = applySeqOps(
      first,
      seqOps(s.seq + 1, [upsert('d1', 60), upsert('d2', 61), upsert('d3', 62)]),
    );
    expect(again.gap).toBe(false);
    expect(again.state.seq).toBe(s.seq + 3);
    expect(ids(again.state).filter((id) => id.startsWith('d'))).toEqual(['d1', 'd2', 'd3']);
    expect(applySeqOps(again.state, seqOps(s.seq + 1, [upsert('d1', 60)])).state).toBe(again.state);
  });

  it('snapshot then live ops (subscribe flow)', () => {
    const view = viewStateFromSnapshot(sampleSessionSnapshot({ seq: 0, items: [] }));
    const { state: next } = applySeqOps(view, seqOps(1, [upsert('first', 1)]));
    expect(next.seq).toBe(1);
    expect(ids(next)).toEqual(['first']);
  });
});

describe('mergeItems (loadEarlier)', () => {
  it('merges by order and de-duplicates by id; existing items win', () => {
    const current = [
      sampleItems.assistantText({ id: 'c', order: 3, text: 'live' }),
      sampleItems.turnResult({ id: 'd', order: 4 }),
    ];
    const earlier = [
      sampleItems.userMessage({ id: 'a', order: 1 }),
      sampleItems.thinking({ id: 'b', order: 2 }),
      sampleItems.assistantText({ id: 'c', order: 3, text: 'stale' }),
    ];
    deepFreeze(current);
    deepFreeze(earlier);
    const merged = mergeItems(current, earlier);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged[2]).toMatchObject({ text: 'live' });
  });
});

describe('trimItems', () => {
  it('keeps the newest items and sets hasEarlier', () => {
    const s = state();
    const trimmed = trimItems(s, 2);
    expect(ids(trimmed)).toEqual(ids(s).slice(-2));
    expect(trimmed.hasEarlier).toBe(true);
  });

  it('returns the same state when nothing is trimmed', () => {
    const s = state();
    expect(trimItems(s, 150)).toBe(s);
  });
});
