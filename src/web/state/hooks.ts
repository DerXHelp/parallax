import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { LOCAL_HOST_ID, parseSessionKey, type DecisionId, type HostId } from '@shared/common';
import { makeError } from '@shared/errors';
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
  type ClientNotification,
  type ClientState,
  type ConnectionStatus,
  type HostRecord,
  type SessionRecord,
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
        entry = { sessionKey: `${host.hostId}:${summary.entryId}`, hostId: host.hostId, summary };
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

function selectSessionRecord(state: ClientState, sessionKey: string | null): SessionRecord {
  return sessionKey === null ? EMPTY_SESSION_RECORD : (state.sessions[sessionKey] ?? EMPTY_SESSION_RECORD);
}

/** View + loading + `session.unavailable` error; subscribes automatically. */
export function useSessionState(sessionKey: string | null): SessionRecord {
  useSessionSubscription(sessionKey);
  return useStore(clientStore, (state) => selectSessionRecord(state, sessionKey));
}

/** Materialized session (items, decisions, detail); subscribes automatically. */
export function useSessionView(sessionKey: string | null): SessionViewState | null {
  return useSessionState(sessionKey).view;
}

/** `SessionDetail` (queue, models, init …); subscribes automatically. */
export function useSessionDetail(sessionKey: string | null): SessionDetail | null {
  useSessionSubscription(sessionKey);
  return useStore(clientStore, (state) => selectSessionRecord(state, sessionKey).view?.detail ?? null);
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

/** One decision (DecisionCard slot); null once resolved. Does not subscribe. */
export function useDecision(sessionKey: string | null, decisionId: DecisionId): Decision | null {
  return useStore(
    clientStore,
    (state) =>
      selectSessionRecord(state, sessionKey).view?.decisions.find((d) => d.id === decisionId) ?? null,
  );
}

// ---- selection ----

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

export function useNotifications(): readonly ClientNotification[] {
  return useStore(clientStore, (state) => state.notifications);
}

export function dismissNotification(id: string): void {
  clientStore.setState((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
}
