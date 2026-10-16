/**
 * Pure reducers shared by the server hub (materialized view for snapshots, WP-10) and the web
 * store (WP-14): both apply the SAME ops with the same code. Design: docs/wp/WP-02.md §8.
 * All functions are pure: inputs are never mutated (structural sharing is fine).
 */
import type { ConversationId, EntryId } from './common';
import type { Decision, SessionDetail, SessionDetailPatch, TranscriptItem } from './model';
import type { SeqOp, SessionOp, SessionSnapshot } from './protocol';

export interface SessionViewState {
  entryId: EntryId;
  /** Seq of the last applied op (only applySeqOps changes it). */
  seq: number;
  conversationId: ConversationId;
  /** Ascending by order, no duplicate ids. */
  items: TranscriptItem[];
  hasEarlier: boolean;
  /** Open + expired, by createdAt. */
  decisions: Decision[];
  detail: SessionDetail;
}

/** Index of the first item with `order` greater than the given one (insert position, stable). */
function upperBound(items: readonly TranscriptItem[], order: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = items[mid];
    if (item !== undefined && item.order <= order) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sorted by order (stable), first occurrence of an id wins. */
function normalizeItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return unique.sort((a, b) => a.order - b.order);
}

function sortDecisions(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function viewStateFromSnapshot(s: SessionSnapshot): SessionViewState {
  return {
    entryId: s.entryId,
    seq: s.seq,
    conversationId: s.detail.conversationId,
    items: normalizeItems(s.items),
    hasEarlier: s.hasEarlier,
    decisions: sortDecisions(s.decisions),
    detail: s.detail,
  };
}

function upsertItem(items: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    // Replace in place: the position stays (order never changes for an id).
    const next = [...items];
    next[index] = item;
    return next;
  }
  const at = upperBound(items, item.order);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/**
 * Deltas only apply to items that are still streaming (R0-15): a late delta after the final
 * `item.upsert` would otherwise append text twice (on both sides equally wrong).
 */
function applyDelta(
  item: TranscriptItem,
  field: 'text' | 'thinking' | 'inputPartial',
  append: string,
): TranscriptItem | null {
  switch (item.kind) {
    case 'assistant_text':
      return field === 'text' && item.streaming ? { ...item, text: item.text + append } : null;
    case 'thinking':
      return (field === 'text' || field === 'thinking') && item.streaming
        ? { ...item, text: { ...item.text, text: item.text.text + append } }
        : null;
    case 'tool_call':
      return field === 'inputPartial' && item.status === 'streaming_input'
        ? { ...item, inputPartial: (item.inputPartial ?? '') + append }
        : null;
    default:
      return null;
  }
}

function upsertDecision(decisions: readonly Decision[], decision: Decision): Decision[] {
  const index = decisions.findIndex((d) => d.id === decision.id);
  if (index >= 0) {
    const next = [...decisions];
    next[index] = decision;
    return next;
  }
  const at = Date.parse(decision.createdAt);
  const pos = decisions.findIndex((d) => Date.parse(d.createdAt) > at);
  return pos < 0 ? [...decisions, decision] : [...decisions.slice(0, pos), decision, ...decisions.slice(pos)];
}

/**
 * Flat overwrite of the given fields. Keys present with `undefined` are ignored, so a server-side
 * view (ops built in TS) and a client view (ops after JSON) cannot diverge.
 */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const result = { ...base };
  for (const key in patch) {
    const value = patch[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function patchDetail(detail: SessionDetail, patch: SessionDetailPatch): SessionDetail {
  return mergeDefined<SessionDetail>(detail, patch);
}

/** Applies one op. Pure, returns a new object (structural sharing ok); never throws on unknown ids. */
export function applySessionOp(state: SessionViewState, op: SessionOp): SessionViewState {
  switch (op.op) {
    case 'item.upsert':
      return { ...state, items: upsertItem(state.items, op.item) };
    case 'item.delta': {
      const index = state.items.findIndex((item) => item.id === op.itemId);
      const current = state.items[index];
      if (current === undefined) return state;
      const updated = applyDelta(current, op.field, op.append);
      if (updated === null) return state;
      const items = [...state.items];
      items[index] = updated;
      return { ...state, items };
    }
    case 'item.remove':
      return state.items.some((item) => item.id === op.itemId)
        ? { ...state, items: state.items.filter((item) => item.id !== op.itemId) }
        : state;
    case 'conversation.reset':
      // Phase 2 (ADR-107): a switch to an earlier conversation keeps `hasEarlier` from the op; the
      // engine follows with item.upserts of that conversation's tail.
      return {
        ...state,
        conversationId: op.conversationId,
        items: [],
        decisions: [],
        hasEarlier: op.hasEarlier,
        detail: { ...state.detail, conversationId: op.conversationId },
      };
    case 'decision.upsert':
      return { ...state, decisions: upsertDecision(state.decisions, op.decision) };
    case 'decision.resolved':
      // The outcome lives in tool_call.decision, which the server updates via item.upsert.
      return state.decisions.some((d) => d.id === op.decisionId)
        ? { ...state, decisions: state.decisions.filter((d) => d.id !== op.decisionId) }
        : state;
    case 'detail.patch':
      return { ...state, detail: patchDetail(state.detail, op.patch) };
  }
}

/** Applies several ops in order (without seq handling). */
export function applySessionOps(state: SessionViewState, ops: readonly SessionOp[]): SessionViewState {
  return ops.reduce(applySessionOp, state);
}

/**
 * Applies seq ops. Ops with `seq <= state.seq` were already applied and are skipped (idempotent
 * replay overlap). If the remaining ops do not continue at `state.seq + 1` without gaps, nothing
 * is applied and `gap` is true (client re-subscribes with `sinceSeq = state.seq`).
 */
export function applySeqOps(
  state: SessionViewState,
  ops: readonly SeqOp[],
): { state: SessionViewState; gap: boolean } {
  const fresh = ops.filter((o) => o.seq > state.seq);
  const contiguous = fresh.every((o, i) => o.seq === state.seq + 1 + i);
  if (!contiguous) return { state, gap: true };
  const last = fresh.at(-1);
  if (last === undefined) return { state, gap: false };
  const next = applySessionOps(
    state,
    fresh.map((o) => o.op),
  );
  return { state: { ...next, seq: last.seq }, gap: false };
}

/**
 * Merges loadEarlier items into the current items (sorted by order, de-duplicated by id).
 * For an id present in both, the existing item wins (it may carry newer live updates).
 */
export function mergeItems(
  items: readonly TranscriptItem[],
  incoming: readonly TranscriptItem[],
): TranscriptItem[] {
  return normalizeItems([...items, ...incoming]);
}

/** Keeps only the newest `limit` items (snapshot / cache trimming); sets hasEarlier if trimmed. */
export function trimItems(state: SessionViewState, limit: number): SessionViewState {
  if (state.items.length <= limit) return state;
  return { ...state, items: state.items.slice(state.items.length - Math.max(0, limit)), hasEarlier: true };
}
