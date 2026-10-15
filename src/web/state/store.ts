import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntryId, HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { HostState, SessionSummary, Settings } from '@shared/model';
import type { Notification } from '@shared/protocol';
import type { SessionViewState } from '@shared/sync';

/**
 * Client state (Zustand, one vanilla store; React reads it through the selector hooks in
 * hooks.ts). Only state/* writes it. Session data is keyed by `sessionKey = hostId:entryId`
 * (client only, architecture §3.2); the views are produced by the shared reducer (@shared/sync).
 */

export const CONNECTION_STATUSES = ['connecting', 'open', 'reconnecting', 'closed'] as const;
/** Coarse connection state of a host (WP-02 §10.3 `HostConnection.status()`). */
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Detailed phase of a host connection (drives banners and the auth gate). */
export type HostPhase =
  /** Nothing tried yet. */
  | 'idle'
  /** `GET /api/auth/status` (before every WS attempt, architecture §5.1 step 3). */
  | 'checking-auth'
  /** WS opened, waiting for `hello`. */
  | 'connecting'
  | 'open'
  /** Waiting for the next attempt (`nextAttemptAt`); `error` says why (CONNECTION_LOST …). */
  | 'reconnecting'
  /** No valid cookie (status `authenticated:false` or close 4401): no WS until `retryNow()`. */
  | 'unauthenticated'
  /** Close 4503 (server shut down). */
  | 'server-stopped'
  /** Protocol/build mismatch and the reload guard kicked in (banner PROTOCOL_VERSION_MISMATCH). */
  | 'version-mismatch'
  /** `stop()` was called (tests, playground). */
  | 'stopped';

export interface HostCounters {
  /** Server messages with an unknown `type` (forward compatible, WP-02 §2.3). */
  ignoredMessages: number;
  /** Server messages that failed the schema. */
  invalidMessages: number;
  /** `error` messages from the server (INVALID_MESSAGE …). */
  serverErrors: number;
}

export interface HostRecord {
  hostId: HostId;
  status: ConnectionStatus;
  phase: HostPhase;
  /** True once a `hello` was accepted (later outages show a banner instead of the full-page state). */
  everConnected: boolean;
  /** Epoch ms of the next attempt while `reconnecting`. */
  nextAttemptAt: number | null;
  /** Why the host is not open (CONNECTION_LOST, PROTOCOL_VERSION_MISMATCH …), null when open. */
  error: ErrorPayload | null;
  /** The one-time code from the URL was rejected (auth gate shows AUTH_CODE_INVALID). */
  authCodeRejected: boolean;
  serverInstanceId: string | null;
  serverVersion: string | null;
  hostState: HostState | null;
  /** Last writer wins per entryId (channel 1). */
  summaries: Readonly<Record<EntryId, SessionSummary>>;
  /** A `summaries.snapshot` arrived since the last (re)sync. */
  summariesLoaded: boolean;
  /** Last `error` message of the server (dev information, no banner). */
  lastServerError: ErrorPayload | null;
  counters: HostCounters;
}

export interface SessionRecord {
  /** Materialized view (snapshot + ops via @shared/sync); null until the first snapshot. */
  view: SessionViewState | null;
  /** `session.unavailable` answer (ENTRY_NOT_FOUND …). */
  unavailable: ErrorPayload | null;
  /** Waiting for the snapshot/replay of the current subscription. */
  loading: boolean;
}

/** A `notify` message with its client-side session key (A.9). */
export interface ClientNotification extends Notification {
  hostId: HostId;
  sessionKey: string;
}

export interface WindowPresence {
  /** `document.hasFocus()`. */
  focused: boolean;
  /** `visibilityState === 'visible'`. */
  visible: boolean;
  /** Composer used within the last 5 s (`reportTyping`). */
  typing: boolean;
}

export interface ClientState {
  hosts: Readonly<Record<HostId, HostRecord>>;
  sessions: Readonly<Record<string, SessionRecord>>;
  /** Session shown in this window (`#session=…`). */
  selectedSession: string | null;
  presence: WindowPresence;
  notifications: readonly ClientNotification[];
  /** Settings used while no host delivered `host.state` (playground, before connecting). */
  localSettings: Settings;
}

export type ClientStore = StoreApi<ClientState>;

export const DEFAULT_SETTINGS: Settings = { language: 'en', theme: 'dark' };

export function initialClientState(): ClientState {
  return {
    hosts: {},
    sessions: {},
    selectedSession: null,
    presence: { focused: true, visible: true, typing: false },
    notifications: [],
    localSettings: DEFAULT_SETTINGS,
  };
}

export function emptyHostRecord(hostId: HostId): HostRecord {
  return {
    hostId,
    status: 'connecting',
    phase: 'idle',
    everConnected: false,
    nextAttemptAt: null,
    error: null,
    authCodeRejected: false,
    serverInstanceId: null,
    serverVersion: null,
    hostState: null,
    summaries: {},
    summariesLoaded: false,
    lastServerError: null,
    counters: { ignoredMessages: 0, invalidMessages: 0, serverErrors: 0 },
  };
}

export const EMPTY_SESSION_RECORD: SessionRecord = Object.freeze({
  view: null,
  unavailable: null,
  loading: false,
});

/** A separate store (tests); the app and the hooks use `clientStore`. */
export function createClientStore(): ClientStore {
  return createStore<ClientState>()(() => initialClientState());
}

/** The one client store of this window. */
export const clientStore: ClientStore = createClientStore();

/** Back to the initial state (tests, playground scenario switch). */
export function resetClientStore(store: ClientStore = clientStore): void {
  store.setState(initialClientState(), true);
}

/** Immutable update of one host record (created on demand). */
export function updateHost(
  store: ClientStore,
  hostId: HostId,
  update: (host: HostRecord) => Partial<HostRecord>,
): void {
  store.setState((state) => {
    const current = state.hosts[hostId] ?? emptyHostRecord(hostId);
    return { hosts: { ...state.hosts, [hostId]: { ...current, ...update(current) } } };
  });
}

/** Immutable update of one session record (created on demand). */
export function updateSession(
  store: ClientStore,
  sessionKey: string,
  update: (session: SessionRecord) => Partial<SessionRecord>,
): void {
  store.setState((state) => {
    const current = state.sessions[sessionKey] ?? EMPTY_SESSION_RECORD;
    return { sessions: { ...state.sessions, [sessionKey]: { ...current, ...update(current) } } };
  });
}

/** Removes session records (cache eviction, full resync). */
export function removeSessions(store: ClientStore, sessionKeys: readonly string[]): void {
  if (sessionKeys.length === 0) return;
  store.setState((state) => {
    const sessions = { ...state.sessions };
    for (const key of sessionKeys) Reflect.deleteProperty(sessions, key);
    return { sessions };
  });
}
