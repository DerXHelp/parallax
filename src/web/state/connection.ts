import { BUILD_ID } from '@shared/build';
import {
  LOCAL_HOST_ID,
  makeSessionKey,
  parseSessionKey,
  type ClientId,
  type EntryId,
  type HostId,
} from '@shared/common';
import { makeError, type ErrorCode, type ErrorPayload } from '@shared/errors';
import {
  PROTOCOL_VERSION,
  WS_CLOSE,
  cmdMessageSchema,
  parseCommandResult,
  parseServerMessage,
  type AckMessage,
  type ClientMessage,
  type Command,
  type CommandResult,
  type HelloMessage,
  type PresenceState,
  type SeqOp,
  type ServerMessage,
} from '@shared/protocol';
import { applySeqOps, viewStateFromSnapshot, type SessionViewState } from '@shared/sync';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from '@web/lib/backoff';
import { newCmdId } from '@web/lib/ids';
import type { AuthCheckResult } from './auth';
import { RELOAD_GUARD_MS, getWindowClientId, sessionReloadGuard, type ReloadGuard } from './client-id';
import {
  clientStore,
  removeSessions,
  updateHost,
  updateSession,
  type ClientState,
  type ClientStore,
  type ConnectionStatus,
  type HostPhase,
  type HostRecord,
  type SessionRecord,
} from './store';
import type { Transport } from './transport';

/**
 * Connection to one host (WP-02 §7, architecture §5): handshake with resync/reload, reconnect with
 * backoff (auth status first, §5.1), ref-counted subscriptions with `sinceSeq`, ops through the
 * shared reducer once per animation frame, commands with `cmdId` and a promise per `ack`,
 * presence after every change (debounced). `hostId` exists only here; the wire knows `entryId`.
 */

/** A command failed: `error` is the server's (or a client-side) ErrorPayload – translate with `tError`. */
export class ClientCommandError extends Error {
  readonly error: ErrorPayload;

  constructor(error: ErrorPayload) {
    super(error.message ?? error.code);
    this.name = 'ClientCommandError';
    this.error = error;
  }

  get code(): ErrorCode {
    return this.error.code;
  }
}

/** Errors of `send()` as ErrorPayload (anything else becomes INTERNAL_ERROR). */
export function errorPayloadOf(error: unknown): ErrorPayload {
  return error instanceof ClientCommandError ? error.error : makeError('INTERNAL_ERROR');
}

/** WP-02 §10.3. */
export interface HostConnection {
  readonly hostId: HostId;
  status(): ConnectionStatus;
  /**
   * Resolves with the typed `ack.result` (`commandResultSchemas[cmd.name]`); rejects with
   * `ClientCommandError`. Generic over the command object (call-compatible with WP-02 §10.3).
   */
  send<C extends Command>(cmd: C): Promise<CommandResult<C['name']>>;
  /** Ref-counted; the returned function unsubscribes (idempotent). */
  subscribe(entryId: EntryId): () => void;
}

/** What the app (bootstrap, playground, tests) controls in addition. */
export interface ManagedHostConnection extends HostConnection {
  start(): void;
  /** Ends everything: transport closed, timers cleared, open commands → CONNECTION_LOST. */
  stop(): void;
  /** Skips the backoff wait / re-checks the sign-in (buttons in banners and the auth gate). */
  retryNow(): void;
  /** Applies queued session ops now instead of on the next animation frame (tests). */
  flush(): void;
}

export interface HostConnectionOptions {
  hostId: HostId;
  /** Called for every connection attempt (may return the same instance). */
  createTransport: () => Transport;
  /** Auth status before every attempt (architecture §5.1); omitted = always signed in. */
  checkAuth?: () => Promise<AuthCheckResult>;
  /** Home host compares `buildId` and reloads on a mismatch (WP-02 §7.1); default true. */
  homeHost?: boolean;
  /** Default: BUILD_ID of this bundle. */
  buildId?: string;
  /** Default: getWindowClientId(). */
  clientId?: ClientId;
  /** Default: `location.reload()`. */
  reload?: () => void;
  reloadGuard?: ReloadGuard;
  backoff?: BackoffOptions;
  random?: () => number;
  now?: () => number;
  /** Open commands fail with COMMAND_TIMEOUT after this (default 60 s). */
  commandTimeoutMs?: number;
  /** Delay before an unsubscribe is sent (StrictMode remounts, quick switching); default 1500 ms. */
  unsubscribeDelayMs?: number;
  /** Views of unsubscribed sessions kept for a quick re-subscribe with `sinceSeq` (LRU, default 8). */
  maxCachedViews?: number;
  /** Presence debounce (A.9: 250 ms). */
  presenceDebounceMs?: number;
  /** Batches ops per frame; default requestAnimationFrame (setTimeout while hidden). */
  scheduleFrame?: (callback: () => void) => void;
  store?: ClientStore;
}

export const COMMAND_TIMEOUT_MS = 60_000;
export const UNSUBSCRIBE_DELAY_MS = 1500;
export const MAX_CACHED_VIEWS = 8;
export const PRESENCE_DEBOUNCE_MS = 250;
const MAX_NOTIFICATIONS = 20;

/** rAF while visible; rAF does not run in hidden windows, so a timer backs it up. */
export function defaultScheduleFrame(callback: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    callback();
  };
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  setTimeout(run, hidden ? 100 : 250);
}

interface PendingCommand {
  readonly text: string;
  readonly settle: (ack: AckMessage) => void;
  readonly fail: (error: ErrorPayload) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Subscription {
  count: number;
  /** Pending delayed unsubscribe. */
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** A gap re-subscribe (`sinceSeq`) is on its way. */
  resyncPending: boolean;
}

const CLOSED_PHASES: ReadonlySet<HostPhase> = new Set<HostPhase>([
  'unauthenticated',
  'server-stopped',
  'version-mismatch',
  'stopped',
]);

function statusOf(phase: HostPhase, everConnected: boolean): ConnectionStatus {
  if (phase === 'open') return 'open';
  if (phase === 'reconnecting') return 'reconnecting';
  if (CLOSED_PHASES.has(phase)) return 'closed';
  return everConnected ? 'reconnecting' : 'connecting';
}

function presenceOf(state: ClientState, hostId: HostId): PresenceState {
  const selected = state.selectedSession === null ? null : parseSessionKey(state.selectedSession);
  return {
    focused: state.presence.focused,
    visible: state.presence.visible,
    typing: state.presence.typing,
    viewingEntryId: selected !== null && selected.hostId === hostId ? selected.entryId : null,
  };
}

export function createHostConnection(options: HostConnectionOptions): ManagedHostConnection {
  const hostId = options.hostId;
  const store = options.store ?? clientStore;
  const homeHost = options.homeHost ?? true;
  const buildId = options.buildId ?? BUILD_ID;
  const clientId = options.clientId ?? getWindowClientId();
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });
  const reloadGuard = options.reloadGuard ?? sessionReloadGuard;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const unsubscribeDelayMs = options.unsubscribeDelayMs ?? UNSUBSCRIBE_DELAY_MS;
  const maxCachedViews = options.maxCachedViews ?? MAX_CACHED_VIEWS;
  const presenceDebounceMs = options.presenceDebounceMs ?? PRESENCE_DEBOUNCE_MS;
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;

  let started = false;
  let phase: HostPhase = 'idle';
  let everConnected = false;
  /** Bumped on every attempt and on stop(): stale async results are dropped. */
  let generation = 0;
  let transport: Transport | null = null;
  let helloReceived = false;
  let lastInstanceId: string | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const subscriptions = new Map<EntryId, Subscription>();
  /** Unsubscribed entries whose view is still cached, oldest first. */
  const cachedOrder: EntryId[] = [];
  const pending = new Map<string, PendingCommand>();
  const opQueue = new Map<EntryId, SeqOp[][]>();
  let frameScheduled = false;

  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentPresence: string | null = null;
  let unsubscribeStore: (() => void) | null = null;

  const keyOf = (entryId: EntryId) => makeSessionKey(hostId, entryId);
  const sessionRecord = (entryId: EntryId): SessionRecord | undefined =>
    store.getState().sessions[keyOf(entryId)];
  const viewOf = (entryId: EntryId): SessionViewState | null => sessionRecord(entryId)?.view ?? null;

  function setPhase(next: HostPhase, patch: Partial<HostRecord> = {}): void {
    phase = next;
    if (next === 'open') everConnected = true;
    updateHost(store, hostId, () => ({
      phase: next,
      status: statusOf(next, everConnected),
      everConnected,
      ...(next === 'reconnecting' ? {} : { nextAttemptAt: null }),
      ...patch,
    }));
  }

  function count(counter: keyof HostRecord['counters']): void {
    updateHost(store, hostId, (host) => ({
      counters: { ...host.counters, [counter]: host.counters[counter] + 1 },
    }));
  }

  // ---- sending ----

  function transmit(message: ClientMessage | string): boolean {
    if (transport === null || !helloReceived) return false;
    try {
      transport.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function failAllPending(code: ErrorCode): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.fail(makeError(code));
  }

  // ---- lifecycle ----

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function closeTransport(): void {
    const current = transport;
    transport = null;
    helloReceived = false;
    current?.close();
  }

  function scheduleReconnect(error: ErrorPayload): void {
    clearReconnectTimer();
    const delay = backoffDelay(attempt, backoff, random);
    attempt++;
    setPhase('reconnecting', { nextAttemptAt: now() + delay, error });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void beginAttempt();
    }, delay);
  }

  async function beginAttempt(): Promise<void> {
    const own = ++generation;
    clearReconnectTimer();
    if (options.checkAuth !== undefined) {
      setPhase('checking-auth');
      let result: AuthCheckResult;
      try {
        result = await options.checkAuth();
      } catch {
        result = { kind: 'unreachable' };
      }
      if (own !== generation) return;
      if (result.kind === 'unreachable') {
        scheduleReconnect(makeError('CONNECTION_LOST'));
        return;
      }
      if (result.kind === 'unauthenticated') {
        failAllPending('AUTH_REQUIRED');
        setPhase('unauthenticated', {
          authCodeRejected: result.codeRejected,
          error: makeError('AUTH_REQUIRED'),
        });
        return;
      }
      // A restarted server is visible before the WS (architecture §5.1 step 5).
      if (lastInstanceId !== null && result.serverInstanceId !== lastInstanceId) {
        fullResync();
        lastInstanceId = result.serverInstanceId;
      }
    }
    openTransport();
  }

  function openTransport(): void {
    closeTransport();
    setPhase('connecting');
    const current = options.createTransport();
    transport = current;
    current.connect(
      (text) => {
        if (transport === current) handleText(text);
      },
      (code) => {
        if (transport === current) handleClose(code);
      },
    );
  }

  function handleClose(code: number): void {
    transport = null;
    helloReceived = false;
    if (code === WS_CLOSE.AUTH_REVOKED) {
      failAllPending('AUTH_REQUIRED');
      setPhase('unauthenticated', { error: makeError('AUTH_REQUIRED') });
      return;
    }
    if (code === WS_CLOSE.SERVER_SHUTDOWN) {
      failAllPending('CONNECTION_LOST');
      setPhase('server-stopped', { error: makeError('SERVER_SHUTTING_DOWN') });
      return;
    }
    if (code === WS_CLOSE.PROTOCOL_VERSION_MISMATCH) {
      versionMismatch(null);
      return;
    }
    // 1006 (also a rejected upgrade), 1000, 1001, 4400 …: back to the auth check, then reconnect.
    scheduleReconnect(makeError('CONNECTION_LOST', { code }));
  }

  /** Full resync (new serverInstanceId): drop summaries, views, seqs and open commands of this host. */
  function fullResync(): void {
    opQueue.clear();
    failAllPending('CONNECTION_LOST');
    const prefix = `${hostId}:`;
    const keys = Object.keys(store.getState().sessions).filter((key) => key.startsWith(prefix));
    removeSessions(store, keys);
    cachedOrder.length = 0;
    for (const sub of subscriptions.values()) sub.resyncPending = false;
    updateHost(store, hostId, () => ({ summaries: {}, summariesLoaded: false }));
  }

  function versionMismatch(hello: HelloMessage | null): void {
    closeTransport();
    failAllPending('CONNECTION_LOST');
    const error = makeError('PROTOCOL_VERSION_MISMATCH', {
      clientProtocol: PROTOCOL_VERSION,
      serverProtocol: hello?.protocolVersion ?? null,
      clientBuild: buildId,
      serverBuild: hello?.buildId ?? null,
    });
    const last = reloadGuard.read();
    const at = now();
    if (homeHost && (last === null || at - last >= RELOAD_GUARD_MS)) {
      reloadGuard.write(at);
      setPhase('version-mismatch', { error });
      reload();
      return;
    }
    setPhase('version-mismatch', { error });
  }

  // ---- incoming ----

  function handleText(text: string): void {
    const parsed = parseServerMessage(text);
    if (parsed.ok === 'ignored') {
      count('ignoredMessages');
      return;
    }
    if (!parsed.ok) {
      count('invalidMessages');
      return;
    }
    const message = parsed.message;
    if (!helloReceived) {
      if (message.type === 'hello') handleHello(message);
      else count('ignoredMessages');
      return;
    }
    handleMessage(message);
  }

  function handleHello(hello: HelloMessage): void {
    const protocolOk = hello.protocolVersion === PROTOCOL_VERSION;
    const buildOk = !homeHost || hello.buildId === buildId;
    if (!protocolOk || !buildOk) {
      versionMismatch(hello);
      return;
    }
    if (lastInstanceId !== null && lastInstanceId !== hello.serverInstanceId) fullResync();
    const sameInstance = lastInstanceId === hello.serverInstanceId;
    lastInstanceId = hello.serverInstanceId;
    helloReceived = true;
    attempt = 0;

    const presence = presenceOf(store.getState(), hostId);
    lastSentPresence = JSON.stringify(presence);
    transmit({ type: 'clientHello', protocolVersion: PROTOCOL_VERSION, buildId, clientId, presence });
    setPhase('open', {
      error: null,
      serverInstanceId: hello.serverInstanceId,
      serverVersion: hello.serverVersion,
      authCodeRejected: false,
    });

    for (const [entryId, sub] of subscriptions) {
      if (sub.count > 0) {
        sendSubscribe(entryId, sameInstance);
      } else {
        // A delayed unsubscribe: the new socket has no subscription anyway.
        if (sub.releaseTimer !== null) clearTimeout(sub.releaseTimer);
        releaseNow(entryId, false);
      }
    }
    // Same instance: unacknowledged commands again with the SAME cmdId (idempotent on the server).
    for (const entry of pending.values()) transmit(entry.text);
  }

  function handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'hello':
        // A second hello on the same socket is not expected; treat it like a new handshake.
        helloReceived = false;
        handleHello(message);
        return;
      case 'host.state':
        updateHost(store, hostId, () => ({ hostState: message.host }));
        return;
      case 'summaries.snapshot':
        updateHost(store, hostId, () => ({
          summaries: Object.fromEntries(message.summaries.map((summary) => [summary.entryId, summary])),
          summariesLoaded: true,
        }));
        return;
      case 'summary.upsert':
        updateHost(store, hostId, (host) => ({
          summaries: { ...host.summaries, [message.summary.entryId]: message.summary },
        }));
        return;
      case 'summary.remove':
        updateHost(store, hostId, (host) => {
          const summaries = { ...host.summaries };
          Reflect.deleteProperty(summaries, message.entryId);
          return { summaries };
        });
        return;
      case 'session.snapshot': {
        // Queued ops are older than the snapshot (the WS is ordered) – it contains their effect.
        opQueue.delete(message.entryId);
        const sub = subscriptions.get(message.entryId);
        if (sub !== undefined) sub.resyncPending = false;
        updateSession(store, keyOf(message.entryId), () => ({
          view: viewStateFromSnapshot(message),
          unavailable: null,
          loading: false,
        }));
        return;
      }
      case 'session.ops': {
        const batches = opQueue.get(message.entryId);
        if (batches === undefined) opQueue.set(message.entryId, [message.ops]);
        else batches.push(message.ops);
        scheduleFlush();
        return;
      }
      case 'session.unavailable':
        opQueue.delete(message.entryId);
        updateSession(store, keyOf(message.entryId), () => ({
          view: null,
          unavailable: message.error,
          loading: false,
        }));
        return;
      case 'ack': {
        const entry = pending.get(message.cmdId);
        if (entry === undefined) return;
        pending.delete(message.cmdId);
        entry.settle(message);
        return;
      }
      case 'error':
        count('serverErrors');
        updateHost(store, hostId, () => ({ lastServerError: message.error }));
        return;
      case 'notify': {
        const notification = {
          ...message.notification,
          hostId,
          sessionKey: keyOf(message.notification.entryId),
        };
        store.setState((state) => ({
          notifications: [...state.notifications.filter((n) => n.id !== notification.id), notification].slice(
            -MAX_NOTIFICATIONS,
          ),
        }));
        return;
      }
      case 'notify.clear': {
        const sessionKey = keyOf(message.entryId);
        store.setState((state) => ({
          notifications: state.notifications.filter((n) => n.sessionKey !== sessionKey),
        }));
        return;
      }
    }
  }

  // ---- ops per animation frame ----

  function scheduleFlush(): void {
    if (frameScheduled) return;
    frameScheduled = true;
    scheduleFrame(flush);
  }

  function flush(): void {
    frameScheduled = false;
    if (opQueue.size === 0) return;
    const queued = [...opQueue];
    opQueue.clear();
    const state = store.getState();
    const updates: Record<string, SessionRecord> = {};
    for (const [entryId, batches] of queued) {
      const key = keyOf(entryId);
      const record = state.sessions[key];
      // No snapshot yet: these ops predate our subscription; the snapshot follows.
      if (record === undefined || record.view === null) continue;
      let view: SessionViewState = record.view;
      let loading = record.loading;
      for (const ops of batches) {
        const result = applySeqOps(view, ops);
        if (result.gap) {
          requestResync(entryId, view.seq);
          break;
        }
        view = result.state;
        loading = false;
        const sub = subscriptions.get(entryId);
        if (sub !== undefined) sub.resyncPending = false;
      }
      if (view !== record.view || loading !== record.loading) updates[key] = { ...record, view, loading };
    }
    if (Object.keys(updates).length > 0) {
      store.setState((current) => ({ sessions: { ...current.sessions, ...updates } }));
    }
  }

  /** Gap in live ops (ops[0].seq ≠ lastSeq + 1): subscribe again with sinceSeq = lastSeq. */
  function requestResync(entryId: EntryId, seq: number): void {
    const sub = subscriptions.get(entryId);
    if (sub === undefined || sub.resyncPending) return;
    sub.resyncPending = true;
    transmit({ type: 'subscribe', entryId, sinceSeq: seq });
  }

  // ---- subscriptions ----

  function sendSubscribe(entryId: EntryId, sameInstance: boolean): void {
    const view = sameInstance ? viewOf(entryId) : null;
    const sub = subscriptions.get(entryId);
    if (sub !== undefined) sub.resyncPending = false;
    updateSession(store, keyOf(entryId), () => ({ loading: true, unavailable: null }));
    transmit(
      view === null ? { type: 'subscribe', entryId } : { type: 'subscribe', entryId, sinceSeq: view.seq },
    );
  }

  function touchCache(entryId: EntryId): void {
    const index = cachedOrder.indexOf(entryId);
    if (index >= 0) cachedOrder.splice(index, 1);
  }

  function releaseNow(entryId: EntryId, sendUnsubscribe: boolean): void {
    const sub = subscriptions.get(entryId);
    if (sub === undefined || sub.count > 0) return;
    subscriptions.delete(entryId);
    if (sendUnsubscribe) transmit({ type: 'unsubscribe', entryId });
    updateSession(store, keyOf(entryId), () => ({ loading: false }));
    // Keep the view for a quick re-subscribe with sinceSeq; evict the oldest beyond the limit
    // (B "Transkripte nicht abonnierter Sessions werden aus dem Cache verdrängt").
    touchCache(entryId);
    cachedOrder.push(entryId);
    const evicted = cachedOrder.splice(0, Math.max(0, cachedOrder.length - maxCachedViews));
    removeSessions(store, evicted.map(keyOf));
  }

  function subscribe(entryId: EntryId): () => void {
    let sub = subscriptions.get(entryId);
    if (sub === undefined) {
      sub = { count: 0, releaseTimer: null, resyncPending: false };
      subscriptions.set(entryId, sub);
    }
    sub.count++;
    if (sub.count === 1 && started) {
      if (sub.releaseTimer !== null) {
        // Still subscribed on the server (delayed unsubscribe not sent yet).
        clearTimeout(sub.releaseTimer);
        sub.releaseTimer = null;
      } else {
        touchCache(entryId);
        if (phase === 'open') sendSubscribe(entryId, true);
        else updateSession(store, keyOf(entryId), (record) => ({ loading: record.view === null }));
      }
    }
    let released = false;
    const own = sub;
    return () => {
      if (released) return;
      released = true;
      own.count--;
      // A stopped connection must not touch the store any more (a successor may own the keys).
      if (!started || own.count > 0 || subscriptions.get(entryId) !== own) return;
      own.releaseTimer = setTimeout(() => {
        own.releaseTimer = null;
        releaseNow(entryId, true);
      }, unsubscribeDelayMs);
    };
  }

  // ---- commands ----

  function send<C extends Command>(cmd: C): Promise<CommandResult<C['name']>> {
    if (CLOSED_PHASES.has(phase) || !started) {
      return Promise.reject(new ClientCommandError(makeError('CONNECTION_LOST')));
    }
    const cmdId = newCmdId();
    const parsed = cmdMessageSchema.safeParse({ type: 'cmd', cmdId, cmd });
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
      return Promise.reject(new ClientCommandError(makeError('VALIDATION_FAILED', { path })));
    }
    const name: C['name'] = cmd.name;
    const text = JSON.stringify(parsed.data);
    return new Promise<CommandResult<C['name']>>((resolve, reject) => {
      const entry: PendingCommand = {
        text,
        timer: null,
        settle: (ack) => {
          if (entry.timer !== null) clearTimeout(entry.timer);
          if (!ack.ok) {
            reject(new ClientCommandError(ack.error));
            return;
          }
          const result = parseCommandResult(name, ack.result);
          if (result === null)
            reject(new ClientCommandError(makeError('INVALID_MESSAGE', { reason: 'result', name })));
          else resolve(result);
        },
        fail: (error) => {
          if (entry.timer !== null) clearTimeout(entry.timer);
          reject(new ClientCommandError(error));
        },
      };
      entry.timer = setTimeout(() => {
        pending.delete(cmdId);
        reject(new ClientCommandError(makeError('COMMAND_TIMEOUT', { name })));
      }, commandTimeoutMs);
      pending.set(cmdId, entry);
      transmit(text);
    });
  }

  // ---- presence (A.9) ----

  function schedulePresence(): void {
    if (presenceTimer !== null) clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      if (phase !== 'open') return;
      const presence = presenceOf(store.getState(), hostId);
      const text = JSON.stringify(presence);
      if (text === lastSentPresence) return;
      if (transmit({ type: 'presence', presence })) lastSentPresence = text;
    }, presenceDebounceMs);
  }

  function onStoreChange(state: ClientState, previous: ClientState): void {
    if (state.presence !== previous.presence || state.selectedSession !== previous.selectedSession) {
      schedulePresence();
    }
  }

  // ---- public ----

  return {
    hostId,
    status: () => statusOf(phase, everConnected),
    send,
    subscribe,
    start() {
      if (started) return;
      started = true;
      unsubscribeStore = store.subscribe(onStoreChange);
      void beginAttempt();
    },
    stop() {
      if (!started) return;
      started = false;
      generation++;
      clearReconnectTimer();
      if (presenceTimer !== null) clearTimeout(presenceTimer);
      presenceTimer = null;
      for (const sub of subscriptions.values()) {
        if (sub.releaseTimer !== null) clearTimeout(sub.releaseTimer);
      }
      unsubscribeStore?.();
      unsubscribeStore = null;
      closeTransport();
      failAllPending('CONNECTION_LOST');
      setPhase('stopped');
    },
    retryNow() {
      if (!started || phase === 'open' || phase === 'connecting' || phase === 'checking-auth') return;
      void beginAttempt();
    },
    flush,
  };
}

// ---------------------------------------------------------------------------------------------
// Connection manager (n hosts; Phase 1 only 'local')
// ---------------------------------------------------------------------------------------------

const connections = new Map<HostId, ManagedHostConnection>();
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function registryChanged(): void {
  registryVersion++;
  for (const listener of [...registryListeners]) listener();
}

/** Changes whenever a connection is (un)registered (hooks re-subscribe sessions then). */
export function getConnectionRegistryVersion(): number {
  return registryVersion;
}

export function subscribeConnectionRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/** Registers (and replaces) the connection of its host; the previous one is stopped. */
export function registerConnection(connection: ManagedHostConnection): void {
  const previous = connections.get(connection.hostId);
  if (previous === connection) return;
  previous?.stop();
  connections.set(connection.hostId, connection);
  registryChanged();
}

/** Stops and forgets one host (or all hosts). */
export function unregisterConnection(hostId?: HostId): void {
  const ids = hostId === undefined ? [...connections.keys()] : [hostId];
  let changed = false;
  for (const id of ids) {
    const connection = connections.get(id);
    if (connection === undefined) continue;
    connection.stop();
    connections.delete(id);
    changed = true;
  }
  if (changed) registryChanged();
}

export function listConnections(): ManagedHostConnection[] {
  return [...connections.values()];
}

/** "Retry now" / "Check again" buttons: skips the backoff or re-checks the sign-in. */
export function retryConnection(hostId: HostId = LOCAL_HOST_ID): void {
  connections.get(hostId)?.retryNow();
}

/** Stand-in while no connection is registered (tests, playground before start): rejects and ignores. */
function detachedConnection(hostId: HostId): HostConnection {
  return {
    hostId,
    status: () => 'closed',
    send: () => Promise.reject(new ClientCommandError(makeError('CONNECTION_LOST'))),
    subscribe: () => () => undefined,
  };
}

/** WP-02 §10.3. Unknown hosts get a detached stand-in (never throws). */
export function getConnection(hostId: HostId = LOCAL_HOST_ID): HostConnection {
  return connections.get(hostId) ?? detachedConnection(hostId);
}
