import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  LOCAL_HOST_ID,
  makeSessionKey,
  parseSessionKey,
  type ConversationId,
  type DecisionId,
  type HostId,
} from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { Decision, HostState, SessionDetail, SessionSummary, TranscriptItem } from '@shared/model';
import type { Command, CommandResult } from '@shared/protocol';
import { deriveDisplayStatus, type DisplayStatus } from '@shared/status';
import type { SessionViewState } from '@shared/sync';
import { useNowUntil } from './clock';
import {
  ClientCommandError,
  getConnection,
  getConnectionRegistryVersion,
  subscribeConnectionRegistry,
} from './connection';
import { setSelectedSession } from './selection';
import {
  EMPTY_SESSION_RECORD,
  clientStore,
  emptyHostRecord,
  type ClientState,
  type ClientStore,
  type ConnectionStatus,
  type HostCounters,
  type HostRecord,
  type SessionRecord,
  type WindowPresence,
} from './store';

/**
 * React hooks over the client store (WP-02 §10.3; B "Zustand-Selektoren pro Session"). Every hook
 * selects exactly what it returns, so a delta in session A never re-renders session B. Hooks that
 * need live session data subscribe automatically (ref-counted, `useSessionSubscription`).
 */

const EMPTY_DECISIONS: readonly Decision[] = Object.freeze([]);
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const NO_DEADLINES: readonly string[] = Object.freeze([]);
/** `needsAttention` (rows 2/3 of deriveDisplayStatus) does not depend on the time. */
const ANY_TIME = new Date(0);

// ---- hosts ----

const emptyRecords = new Map<HostId, HostRecord>();
function emptyRecordFor(hostId: HostId): HostRecord {
  let record = emptyRecords.get(hostId);
  if (record === undefined) {
    record = emptyHostRecord(hostId);
    emptyRecords.set(hostId, record);
  }
  return record;
}

/** Connection record of a host (phase, error, counters …); an empty record before it exists. */
export function useHostRecord(hostId: HostId = LOCAL_HOST_ID): HostRecord {
  return useStore(clientStore, (state) => state.hosts[hostId] ?? emptyRecordFor(hostId));
}

export function useHostState(hostId: HostId = LOCAL_HOST_ID): HostState | null {
  return useStore(clientStore, (state) => state.hosts[hostId]?.hostState ?? null);
}

export function useConnectionStatus(hostId: HostId = LOCAL_HOST_ID): ConnectionStatus {
  return useStore(clientStore, (state) => state.hosts[hostId]?.status ?? 'connecting');
}

/** One counter of the host connection (e.g. `invalidMessages`, R3-05); re-renders only when it changes. */
export function useHostCounter(counter: keyof HostCounters, hostId: HostId = LOCAL_HOST_ID): number {
  return useStore(clientStore, (state) => state.hosts[hostId]?.counters[counter] ?? 0);
}

/** Connection status of the host of a session (e.g. disable "Send" while not `open`). */
export function useSessionConnectionStatus(sessionKey: string | null): ConnectionStatus {
  const hostId = sessionKey === null ? LOCAL_HOST_ID : (parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  return useConnectionStatus(hostId);
}

/** A `summaries.snapshot` of the host arrived since the last (re)sync (skeleton vs. "not found"). */
export function useSummariesLoaded(hostId: HostId = LOCAL_HOST_ID): boolean {
  return useStore(clientStore, (state) => state.hosts[hostId]?.summariesLoaded ?? false);
}

// ---- summaries (channel 1) ----

export interface SummaryEntry {
  sessionKey: string;
  hostId: HostId;
  summary: SessionSummary;
}

/** One stable entry object per summary object (keeps the shallow comparison effective). */
const entryCache = new WeakMap<SessionSummary, SummaryEntry>();

export function selectSummaryEntries(state: ClientState): SummaryEntry[] {
  const result: SummaryEntry[] = [];
  for (const host of Object.values(state.hosts)) {
    for (const summary of Object.values(host.summaries)) {
      let entry = entryCache.get(summary);
      if (entry === undefined) {
        entry = { sessionKey: makeSessionKey(host.hostId, summary.entryId), hostId: host.hostId, summary };
        entryCache.set(summary, entry);
      }
      result.push(entry);
    }
  }
  return result;
}

/** All summaries of all hosts (unsorted; archived included – filter in the view). */
export function useSummaries(): SummaryEntry[] {
  return useStore(clientStore, useShallow(selectSummaryEntries));
}

export function selectSummary(state: ClientState, sessionKey: string | null): SessionSummary | null {
  if (sessionKey === null) return null;
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return null;
  return state.hosts[parsed.hostId]?.summaries[parsed.entryId] ?? null;
}

export function useSummary(sessionKey: string | null): SessionSummary | null {
  return useStore(clientStore, (state) => selectSummary(state, sessionKey));
}

/**
 * Derived data of one summary, compared shallowly (primitives, arrays/objects of primitives or
 * stable references): re-renders only when the selected value changes, not on every
 * `summary.upsert` of the session. `select` must be pure. Example (WP-16 ModePicker):
 * `useSummarySelector(key, (s) => s.permissionMode, null)`.
 */
export function useSummarySelector<T>(
  sessionKey: string | null,
  select: (summary: SessionSummary) => T,
  fallback: T,
): T {
  return useStore(
    clientStore,
    useShallow((state: ClientState) => {
      const summary = selectSummary(state, sessionKey);
      return summary === null ? fallback : select(summary);
    }),
  );
}

/** `deriveDisplayStatus(summary.status, now)`; re-renders when `rateLimitedUntil`/`wakeupAt` pass. */
export function useDisplayStatus(sessionKey: string | null): DisplayStatus | null {
  const facts = useSummary(sessionKey)?.status ?? null;
  const now = useNowUntil(facts === null ? NO_DEADLINES : [facts.rateLimitedUntil, facts.wakeupAt]);
  return useMemo(() => (facts === null ? null : deriveDisplayStatus(facts, new Date(now))), [facts, now]);
}

/** Number of non-archived sessions waiting for the user (window title, "Wartet auf dich (n)"). */
export function useAttentionCount(): number {
  const entries = useSummaries();
  return useMemo(
    () =>
      entries.filter(
        (entry) =>
          !entry.summary.archived && deriveDisplayStatus(entry.summary.status, ANY_TIME).needsAttention,
      ).length,
    [entries],
  );
}

// ---- sessions (channel 2) ----

function useConnectionRegistryVersion(): number {
  return useSyncExternalStore(
    subscribeConnectionRegistry,
    getConnectionRegistryVersion,
    getConnectionRegistryVersion,
  );
}

/** Keeps the session subscribed while mounted (ref-counted; also re-subscribes after a host switch). */
export function useSessionSubscription(sessionKey: string | null): void {
  const registryVersion = useConnectionRegistryVersion();
  useEffect(() => {
    if (sessionKey === null) return undefined;
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return undefined;
    return getConnection(parsed.hostId).subscribe(parsed.entryId);
  }, [sessionKey, registryVersion]);
}

export function selectSessionRecord(state: ClientState, sessionKey: string | null): SessionRecord {
  return sessionKey === null ? EMPTY_SESSION_RECORD : (state.sessions[sessionKey] ?? EMPTY_SESSION_RECORD);
}

/**
 * View + loading + `session.unavailable` error; subscribes automatically. Changes with EVERY
 * applied op (deltas included) – components prefer `useSessionMeta`/`useSessionSelector`.
 */
export function useSessionState(sessionKey: string | null): SessionRecord {
  useSessionSubscription(sessionKey);
  return useStore(clientStore, (state) => selectSessionRecord(state, sessionKey));
}

/**
 * Materialized session (items, decisions, detail); subscribes automatically. Changes with every
 * applied op – for lists use `useTopLevelItemIds`/`useSessionSelector` + `useItem`.
 */
export function useSessionView(sessionKey: string | null): SessionViewState | null {
  return useSessionState(sessionKey).view;
}

/** `SessionDetail` (queue, models, init …); subscribes automatically. */
export function useSessionDetail(sessionKey: string | null): SessionDetail | null {
  useSessionSubscription(sessionKey);
  return useStore(clientStore, (state) => selectSessionRecord(state, sessionKey).view?.detail ?? null);
}

// ---- derived session data (R1W-02, ADR-032) ----

/** Meta data of a session view – stable across deltas and new items. */
export interface SessionMeta {
  /** A snapshot arrived: items, decisions and detail are available. */
  hasView: boolean;
  /** Waiting for the snapshot/replay of the current subscription. */
  loading: boolean;
  /** `session.unavailable` answer (ENTRY_NOT_FOUND …), else null. */
  unavailable: ErrorPayload | null;
  /** Older items can be loaded (`loadEarlier`, actions.ts). */
  hasEarlier: boolean;
  /** Current conversation (changes on `/clear`), null before the first snapshot. */
  conversationId: ConversationId | null;
}

export function selectSessionMeta(record: SessionRecord): SessionMeta {
  return {
    hasView: record.view !== null,
    loading: record.loading,
    unavailable: record.unavailable,
    hasEarlier: record.view?.hasEarlier ?? false,
    conversationId: record.view?.conversationId ?? null,
  };
}

/** `{ hasView, loading, unavailable, hasEarlier, conversationId }`; re-renders only when one changes. Subscribes. */
export function useSessionMeta(sessionKey: string | null): SessionMeta {
  useSessionSubscription(sessionKey);
  return useStore(
    clientStore,
    useShallow((state: ClientState) => selectSessionMeta(selectSessionRecord(state, sessionKey))),
  );
}

/**
 * Derived data of one session view, compared shallowly: the component re-renders only when the
 * selected value changes (arrays/objects element-wise by `Object.is`), not on every delta.
 * `select` must be pure; cache expensive results per `view.items` (WeakMap), like
 * `selectItemTree`. `fallback` is returned while there is no view. Subscribes the session.
 * Example: `useSessionSelector(key, (view) => view.items.length, 0)`.
 */
export function useSessionSelector<T>(
  sessionKey: string | null,
  select: (view: SessionViewState) => T,
  fallback: T,
): T {
  useSessionSubscription(sessionKey);
  return useStore(
    clientStore,
    useShallow((state: ClientState) => {
      const view = selectSessionRecord(state, sessionKey).view;
      return view === null ? fallback : select(view);
    }),
  );
}

/** Items grouped for the transcript (B "Message-Routing": subagent items under the Agent card). */
export interface ItemTree {
  /**
   * Ids of the top-level rows in `order`: items with `parentToolUseId === null`, plus items whose
   * parent tool call is not loaded (trimmed snapshot, before `loadEarlier`) – they are never lost.
   */
  topLevel: readonly string[];
  /** Ids per parent `toolUseId` in `order` (nested subagents: one entry per level). */
  children: ReadonlyMap<string, readonly string[]>;
}

const itemTreeCache = new WeakMap<readonly TranscriptItem[], ItemTree>();

/** Groups `view.items` by `parentToolUseId`; cached per items array (cheap for every selector call). */
export function selectItemTree(view: SessionViewState): ItemTree {
  const cached = itemTreeCache.get(view.items);
  if (cached !== undefined) return cached;
  const toolUseIds = new Set<string>();
  for (const item of view.items) if (item.kind === 'tool_call') toolUseIds.add(item.toolUseId);
  const topLevel: string[] = [];
  const children = new Map<string, string[]>();
  for (const item of view.items) {
    const parent = item.parentToolUseId;
    if (parent === null || !toolUseIds.has(parent)) {
      topLevel.push(item.id);
      continue;
    }
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [item.id]);
    else list.push(item.id);
  }
  const tree: ItemTree = { topLevel, children };
  itemTreeCache.set(view.items, tree);
  return tree;
}

export function selectTopLevelItemIds(view: SessionViewState): readonly string[] {
  return selectItemTree(view).topLevel;
}

/**
 * Top-level row ids for the virtualized transcript list (WP-15: one `useItem` per row); stable
 * across deltas and across new subagent items. Subscribes.
 */
export function useTopLevelItemIds(sessionKey: string | null): readonly string[] {
  return useSessionSelector(sessionKey, selectTopLevelItemIds, EMPTY_IDS);
}

/** Ids of the items produced inside the tool call `toolUseId` (Agent card); stable across deltas. Subscribes. */
export function useChildItemIds(sessionKey: string | null, toolUseId: string): readonly string[] {
  const select = useCallback(
    (view: SessionViewState) => selectItemTree(view).children.get(toolUseId) ?? EMPTY_IDS,
    [toolUseId],
  );
  return useSessionSelector(sessionKey, select, EMPTY_IDS);
}

const itemIndexCache = new WeakMap<readonly TranscriptItem[], Map<string, TranscriptItem>>();
function itemById(items: readonly TranscriptItem[], itemId: string): TranscriptItem | null {
  let index = itemIndexCache.get(items);
  if (index === undefined) {
    index = new Map(items.map((item) => [item.id, item]));
    itemIndexCache.set(items, index);
  }
  return index.get(itemId) ?? null;
}

const itemIdsCache = new WeakMap<readonly TranscriptItem[], readonly string[]>();
function itemIds(items: readonly TranscriptItem[]): readonly string[] {
  let ids = itemIdsCache.get(items);
  if (ids === undefined) {
    ids = items.map((item) => item.id);
    itemIdsCache.set(items, ids);
  }
  return ids;
}

/**
 * One item (re-renders only when this item changes, e.g. its own deltas). Does not subscribe:
 * use it below a component that holds the subscription (`useSessionView`/`useItemIds`).
 */
export function useItem(sessionKey: string | null, itemId: string): TranscriptItem | null {
  return useStore(clientStore, (state) => {
    const view = selectSessionRecord(state, sessionKey).view;
    return view === null ? null : itemById(view.items, itemId);
  });
}

/** Item ids in `order` (for virtualized lists); changes only when items are added/removed. Subscribes. */
export function useItemIds(sessionKey: string | null): readonly string[] {
  useSessionSubscription(sessionKey);
  return useStore(
    clientStore,
    useShallow((state: ClientState) => {
      const view = selectSessionRecord(state, sessionKey).view;
      return view === null ? EMPTY_IDS : itemIds(view.items);
    }),
  );
}

/** Open + expired decisions, oldest first; subscribes automatically. */
export function useDecisions(sessionKey: string | null): readonly Decision[] {
  useSessionSubscription(sessionKey);
  return useStore(
    clientStore,
    (state) => selectSessionRecord(state, sessionKey).view?.decisions ?? EMPTY_DECISIONS,
  );
}

/**
 * One decision (DecisionCard slot): open or expired, `null` once resolved (the outcome then lives in
 * `tool_call.decision`, architecture §2.3e). Does not subscribe.
 */
export function useDecision(sessionKey: string | null, decisionId: DecisionId): Decision | null {
  return useStore(
    clientStore,
    (state) =>
      selectSessionRecord(state, sessionKey).view?.decisions.find((d) => d.id === decisionId) ?? null,
  );
}

// ---- selection ----

/** Focus, visibility and typing state of this window (A.9). */
export function useWindowPresence(): WindowPresence {
  return useStore(clientStore, (state) => state.presence);
}

/** Selected session of this window + setter (mirrors `#session=…`). */
export function useSelectedSession(): [string | null, (sessionKey: string | null) => void] {
  const selected = useStore(clientStore, (state) => state.selectedSession);
  const select = useCallback((sessionKey: string | null) => {
    setSelectedSession(sessionKey);
  }, []);
  return [selected, select];
}

// ---- commands ----

/**
 * Sends a command to the host of `sessionKey` (null = local host, e.g. `session.create`,
 * `settings.update`). Rejects with `ClientCommandError` (translate `error.error` with `tError`).
 */
export function sendCommand<C extends Command>(
  sessionKey: string | null,
  cmd: C,
): Promise<CommandResult<C['name']>> {
  const hostId = sessionKey === null ? LOCAL_HOST_ID : parseSessionKey(sessionKey)?.hostId;
  if (hostId === undefined) {
    return Promise.reject(new ClientCommandError(makeError('VALIDATION_FAILED', { path: 'sessionKey' })));
  }
  return getConnection(hostId).send(cmd);
}

export type SendCommand = typeof sendCommand;

/** Stable `sendCommand` for components (WP-02 §10.3). */
export function useCommand(): SendCommand {
  return sendCommand;
}

// ---- notifications (A.9) ----
// Server notifications (`ClientState.notifications`, until `notify.clear`) are shown once each by
// src/web/notifications/delivery.ts as an in-app hint or a Web Notification – no React hook.

export function dismissNotification(id: string, store: ClientStore = clientStore): void {
  if (!store.getState().notifications.some((n) => n.id === id)) return;
  store.setState((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
}

/** All notifications of one session (the window shows it now – they are seen). */
export function dismissSessionNotifications(sessionKey: string, store: ClientStore = clientStore): void {
  if (!store.getState().notifications.some((n) => n.sessionKey === sessionKey)) return;
  store.setState((state) => ({
    notifications: state.notifications.filter((n) => n.sessionKey !== sessionKey),
  }));
}
