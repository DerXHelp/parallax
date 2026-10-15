/**
 * Mirror view of one entry (WP-13 §2.3 Nr. 1, §3.5.11, R0-20, WP-10 Punkt 5): the engine applies
 * every op it publishes to its own `SessionViewState` (`applySessionOp` + `trimItems`, exactly
 * like the hub), so `loadView` can answer synchronously for loaded entries and the broker finds
 * tool calls (requester, capped input). A dormant entry's view is built from the transcript log
 * (fallback A.3: history of the Claude JSONL, imported once) plus the ops published meanwhile.
 */
import { LIMITS, type ConversationId, type EntryId } from '@shared/common';
import {
  currentConversation,
  currentSessionId,
  type Conversation,
  type Decision,
  type Entry,
  type ModelOption,
  type QueuedPrompt,
  type SessionDetail,
  type ToolCallItem,
  type TranscriptItem,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { applySessionOp, trimItems, type SessionViewState } from '@shared/sync';
import type { AgentBackend } from '../backend/types';
import type { ClaudeIntegration } from '../claude/ports';
import type { NormalizeHistory, NormalizerContext } from './ports';
import type { TranscriptStore } from '../sync/ports';

export function emptyDetail(o: {
  entryId: EntryId;
  conversationId: ConversationId;
  conversations: Conversation[];
  models: ModelOption[] | null;
  queue: QueuedPrompt[];
}): SessionDetail {
  return {
    entryId: o.entryId,
    conversationId: o.conversationId,
    conversations: o.conversations,
    init: null,
    models: o.models,
    commands: null,
    queue: o.queue,
    backgroundTasks: [],
    promptSuggestion: null,
    rateLimit: null,
    unknownCounts: {},
  };
}

export function sortDecisions(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Applies ops like the hub does (`applySessionOp` + `trimItems(LIMITS.snapshotItems)`). */
export function applyToMirror(view: SessionViewState, ops: readonly SessionOp[]): SessionViewState {
  let next = view;
  for (const op of ops) next = trimItems(applySessionOp(next, op), LIMITS.snapshotItems);
  return next;
}

export function findToolCallIn(view: SessionViewState | null, toolUseId: string): ToolCallItem | null {
  if (view === null) return null;
  for (let i = view.items.length - 1; i >= 0; i -= 1) {
    const item = view.items[i];
    if (item?.kind === 'tool_call' && item.toolUseId === toolUseId) return item;
  }
  return null;
}

export interface MirrorSourceDeps {
  transcripts: TranscriptStore;
  backend: AgentBackend;
  claude: ClaudeIntegration;
  normalizeHistory: NormalizeHistory;
  storeBlob: NormalizerContext['storeBlob'];
  now: () => Date;
  onHistoryError(error: unknown): void;
}

export interface MirrorItems {
  items: TranscriptItem[];
  hasEarlier: boolean;
  /** Items imported from the Claude history (to be written into the log once), else []. */
  imported: TranscriptItem[];
}

/**
 * Items of the current conversation: the log tail; when it is empty although the conversation
 * has a Claude session (log lost or foreign, A.3) → `readHistory` → `normalizeHistory` (orders
 * from 1). A failing lookup leaves the view empty (logged), it is tried again on the next load.
 */
export async function readMirrorItems(entry: Entry, deps: MirrorSourceDeps): Promise<MirrorItems> {
  const current = currentConversation(entry);
  const tail = await deps.transcripts.readTail(entry.id, current.id, LIMITS.snapshotItems);
  const sessionId = currentSessionId(entry);
  // Without a Claude session id there is nothing to import (lastOrder > 0 alone cannot be read).
  if (tail.items.length > 0 || sessionId === null) {
    return { items: tail.items, hasEarlier: tail.hasEarlier, imported: [] };
  }
  try {
    const launch = await deps.claude.launchSpecFor(entry.profileId, entry.id);
    const messages = await deps.backend.readHistory({ sessionId, cwd: entry.cwd, launch });
    const { items } = deps.normalizeHistory(messages, {
      entryId: entry.id,
      conversationId: current.id,
      nextOrder: 1,
      storeBlob: deps.storeBlob,
      now: deps.now,
    });
    const start = Math.max(0, items.length - LIMITS.snapshotItems);
    return { items: items.slice(start), hasEarlier: start > 0, imported: items };
  } catch (error) {
    deps.onHistoryError(error);
    return { items: [], hasEarlier: false, imported: [] };
  }
}

/** Base view of a loaded entry (§3.5.11): items + open/expired decisions + engine detail. */
export function baseView(o: {
  entry: Entry;
  items: TranscriptItem[];
  hasEarlier: boolean;
  decisions: readonly Decision[];
  models: ModelOption[] | null;
  queue: QueuedPrompt[];
}): SessionViewState {
  const current = currentConversation(o.entry);
  return {
    entryId: o.entry.id,
    seq: 0,
    conversationId: current.id,
    items: [...o.items].sort((a, b) => a.order - b.order),
    hasEarlier: o.hasEarlier,
    decisions: sortDecisions(o.decisions),
    detail: emptyDetail({
      entryId: o.entry.id,
      conversationId: current.id,
      conversations: o.entry.conversations,
      models: o.models,
      queue: o.queue,
    }),
  };
}
