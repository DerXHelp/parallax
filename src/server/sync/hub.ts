import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RawData } from 'ws';
import type { z } from 'zod';
import { LIMITS, type ClientId, type EntryId } from '@shared/common';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import { hostStateSchema, sessionSummarySchema, type HostState, type SessionSummary } from '@shared/model';
import {
  PROTOCOL_VERSION,
  WS_CLOSE,
  WS_PATH,
  commandResultSchemas,
  notifySchema,
  parseClientMessage,
  sessionOpSchema,
  sessionSnapshotSchema,
  type AckMessage,
  type ClientHelloMessage,
  type Command,
  type Notification,
  type PresenceState,
  type ServerMessage,
  type SessionOp,
  type SessionSnapshot,
} from '@shared/protocol';
import { applySessionOp, trimItems, type SessionViewState } from '@shared/sync';
import { isTestRun, type ServerInstance } from '../config';
import type { HubAttachOptions } from '../http/app';
import { replyError as replyHttpError, sendError as sendHttpError } from '../http/reply';
import { logger as rootLogger, shouldLogRepeated } from '../lib/logger';
import { CommandError, type ClientPresence, type SessionPublisher, type SessionSource } from './ports';

/**
 * SyncHub (A.2, docs/architecture.md §3.1, §5): WebSocket handshake, channel 1 (host state and
 * summaries, throttled), channel 2 (per-entry subscriptions with seq, ring buffer, replay or
 * snapshot), server-side delta coalescing, command parsing with host-wide `cmdId` idempotency and
 * `ack`, presence, notifications. Implements the `SessionPublisher` port for the engine (WP-13)
 * and forwards commands/presence/subscriber counts to the `SessionSource` port.
 *
 * Contract for `SessionSource.loadView`: the returned view must contain every op published before
 * its promise settles (the hub assigns the current seq to it, R0-20).
 */

// =====================================================================================
// Types and options
// =====================================================================================

/** The subset of a `ws` WebSocket the hub uses (real sockets and test fakes). */
export interface HubSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const SOCKET_OPEN = 1;

/** R0-28: in dev/test mode every published op (and summary/host state) is checked. */
export type OutgoingValidation = 'off' | 'log' | 'throw';

export interface HubTiming {
  /** Delta coalescing window (A.2: 30–50 ms). */
  deltaFlushMs: number;
  /** Min interval of throttled summary updates per entry. */
  summaryThrottleMs: number;
  /** A cached view/ring buffer without subscribers is dropped after this delay. */
  evictAfterMs: number;
  /** WebSocket ping interval; 0 = off. */
  heartbeatMs: number;
  /** Window for counting invalid messages. */
  invalidWindowMs: number;
  /** Sockets that ignore a close frame are terminated after this delay. */
  closeGraceMs: number;
}

export const DEFAULT_HUB_TIMING: HubTiming = {
  deltaFlushMs: LIMITS.deltaFlushMs,
  summaryThrottleMs: LIMITS.summaryThrottleMs,
  evictAfterMs: 60_000,
  heartbeatMs: 30_000,
  invalidWindowMs: 10_000,
  closeGraceMs: 2_000,
};

export const HUB_LIMITS = {
  /** More invalid messages within `invalidWindowMs` → close 4400. */
  maxInvalidMessages: 10,
  /** A client with more unsent data is too slow: close 1013, it reconnects and gets a snapshot. */
  maxBufferedBytes: 16 * 1024 * 1024,
  /** Ring buffer budget per entry in JSON chars (in addition to LIMITS.ringBufferOps). */
  ringBufferChars: 16 * 1024 * 1024,
  /** Windows whose last focus is remembered across reconnects (ADR-129); the oldest go first. */
  focusMemory: 256,
} as const;

/** Close code for a slow consumer (standard "try again later"). */
export const WS_CLOSE_SLOW_CONSUMER = 1013;

export interface SyncHubOptions {
  source: SessionSource;
  instance: ServerInstance;
  /**
   * Default: `throw` under Vitest/NODE_ENV=test, otherwise `off`. The server passes
   * `config.validation` (default `log`, also in production – R3-05).
   */
  validation?: OutgoingValidation;
  timing?: Partial<HubTiming>;
  now?: () => Date;
  logger?: Logger;
}

export interface HubStats {
  /** Outgoing values that failed the schema check (`log` mode: dropped, not sent). */
  invalidOutgoing: number;
}

export interface HubEntryInfo {
  seq: number;
  cached: boolean;
  ringSize: number;
  subscribers: number;
  pendingDeltas: number;
}

export interface SyncHub extends SessionPublisher {
  /**
   * Registers `GET /api/ws` (WebSocket) on the app and disposes the hub when the app closes. The
   * route checks every upgrade with `authorizeUpgrade` in `preValidation` and again in the WS
   * handler (second line besides the app's onRequest guard, R1-01).
   */
  attach(app: FastifyInstance, options: HubAttachOptions): void;
  /** Takes over an authenticated WebSocket (called by the WS route; tests pass fakes). */
  handleConnection(socket: HubSocket): void;
  /** Debug/test view of one entry's sync state. */
  inspect(entryId: EntryId): HubEntryInfo | null;
  /** Counters for the diagnosis (R3-05): outgoing values dropped by the `log` validation. */
  stats(): HubStats;
  /** Stops all timers (sockets are closed by the app's preClose). */
  dispose(): void;
}

// =====================================================================================
// Internal state
// =====================================================================================

type ConnState = 'awaiting-hello' | 'open' | 'closed';

interface Conn {
  socket: HubSocket;
  state: ConnState;
  clientId: ClientId | null;
  presence: PresenceState | null;
  lastFocusAt: Date | null;
  connectedAt: Date;
  /** Entries this connection receives live ops for. */
  subscriptions: Set<EntryId>;
  /** Latest subscribe/unsubscribe per entry (a pending subscribe answers only if still current). */
  subscribeGen: Map<EntryId, number>;
  invalidAt: number[];
  alive: boolean;
}

interface RingOp {
  seq: number;
  json: string;
}

type DeltaField = Extract<SessionOp, { op: 'item.delta' }>['field'];

interface PendingDelta {
  itemId: string;
  field: DeltaField;
  parts: string[];
}

interface EntryState {
  entryId: EntryId;
  /** Last assigned seq (starts at 0 per server instance; the first op gets 1). */
  seq: number;
  view: SessionViewState | null;
  loading: Promise<SessionViewState | null> | null;
  ring: RingOp[];
  ringChars: number;
  deltas: Map<string, PendingDelta>;
  deltaTimer: NodeJS.Timeout | null;
  subscribers: Set<Conn>;
  evictTimer: NodeJS.Timeout | null;
}

interface SummaryState {
  last: SessionSummary | null;
  lastSentAt: number;
  pending: SessionSummary | null;
  timer: NodeJS.Timeout | null;
}

interface CmdCacheEntry {
  ack: AckMessage | null;
  promise: Promise<AckMessage>;
  expiresAt: number;
}

/** Host-wide `cmdId → ack` cache: LRU `LIMITS.cmdCacheSize`, TTL `LIMITS.cmdCacheTtlMs` after completion. */
class CommandCache {
  private readonly entries = new Map<string, CmdCacheEntry>();

  get(cmdId: string, nowMs: number): CmdCacheEntry | undefined {
    const entry = this.entries.get(cmdId);
    if (entry === undefined) return undefined;
    this.entries.delete(cmdId);
    if (entry.ack !== null && entry.expiresAt <= nowMs) return undefined;
    this.entries.set(cmdId, entry);
    return entry;
  }

  pending(cmdId: string, promise: Promise<AckMessage>): void {
    this.entries.set(cmdId, { ack: null, promise, expiresAt: Number.POSITIVE_INFINITY });
    this.prune();
  }

  complete(cmdId: string, ack: AckMessage, nowMs: number): void {
    const entry = this.entries.get(cmdId);
    const expiresAt = nowMs + LIMITS.cmdCacheTtlMs;
    if (entry === undefined) this.entries.set(cmdId, { ack, promise: Promise.resolve(ack), expiresAt });
    else {
      entry.ack = ack;
      entry.expiresAt = expiresAt;
    }
    this.prune();
  }

  /** Oldest completed entries go first; running commands are never evicted. */
  private prune(): void {
    if (this.entries.size <= LIMITS.cmdCacheSize) return;
    for (const [cmdId, entry] of this.entries) {
      if (this.entries.size <= LIMITS.cmdCacheSize) break;
      if (entry.ack !== null) this.entries.delete(cmdId);
    }
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Raw `type` of a client message for `error.inReplyTo`. */
function rawType(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string') {
      return value.type.slice(0, 100);
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Only these summary fields are throttled (A.2); every other change is sent immediately. */
function withoutThrottledFields(
  summary: SessionSummary,
): Omit<SessionSummary, 'context' | 'lastActivityAt' | 'lastResultExcerpt'> {
  const { context: _context, lastActivityAt: _activity, lastResultExcerpt: _excerpt, ...rest } = summary;
  return rest;
}

function defaultValidation(): OutgoingValidation {
  return isTestRun() ? 'throw' : 'off';
}

const itemCharsCache = new WeakMap<object, number>();

function jsonChars(value: object): number {
  let chars = itemCharsCache.get(value);
  if (chars === undefined) {
    chars = JSON.stringify(value).length;
    itemCharsCache.set(value, chars);
  }
  return chars;
}

// =====================================================================================
// Hub
// =====================================================================================

export function createSyncHub(options: SyncHubOptions): SyncHub {
  const { source, instance } = options;
  const timing: HubTiming = { ...DEFAULT_HUB_TIMING, ...options.timing };
  const validation = options.validation ?? defaultValidation();
  const now = options.now ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ module: 'hub' });

  const conns = new Set<Conn>();
  const entries = new Map<EntryId, EntryState>();
  const summaries = new Map<EntryId, SummaryState>();
  const cmdCache = new CommandCache();
  let heartbeat: NodeJS.Timeout | null = null;
  let invalidOutgoing = 0;

  // ---- outgoing validation (R0-28; `log` also in production, R3-05) ----

  function checkOutgoing<T>(schema: z.ZodType<T>, value: T, what: string): boolean {
    if (validation === 'off') return true;
    const parsed = schema.safeParse(value);
    if (parsed.success && isDeepStrictEqual(parsed.data, value)) return true;
    const detail = parsed.success
      ? 'value changes under parse (undefined instead of null, missing default or extra key)'
      : `${parsed.error.issues[0]?.path.map(String).join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
    if (validation === 'throw') throw new Error(`SyncHub: invalid ${what} – ${detail}`);
    invalidOutgoing += 1;
    if (shouldLogRepeated(invalidOutgoing)) {
      log.error({ what, detail, count: invalidOutgoing }, 'invalid outgoing value dropped');
    }
    return false;
  }

  // ---- sending ----

  function sendText(conn: Conn, text: string): void {
    if (conn.state === 'closed' || conn.socket.readyState !== SOCKET_OPEN) return;
    if (conn.socket.bufferedAmount > HUB_LIMITS.maxBufferedBytes) {
      log.warn({ clientId: conn.clientId }, 'slow consumer, closing');
      closeConn(conn, WS_CLOSE_SLOW_CONSUMER, 'slow consumer');
      return;
    }
    conn.socket.send(text);
  }

  function send(conn: Conn, message: ServerMessage): void {
    sendText(conn, JSON.stringify(message));
  }

  function broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const conn of conns) if (conn.state === 'open') sendText(conn, text);
  }

  function sendError(conn: Conn, error: ErrorPayload, inReplyTo: string | null): void {
    send(conn, { type: 'error', error, inReplyTo });
  }

  function closeConn(conn: Conn, code: number, reason: string): void {
    const socket = conn.socket;
    try {
      socket.close(code, reason);
    } catch (error) {
      log.debug({ err: error }, 'socket close failed');
    }
    setTimeout(() => {
      if (socket.readyState !== 3 /* CLOSED */) socket.terminate();
    }, timing.closeGraceMs).unref();
  }

  // ---- presence ----

  /**
   * Last focus per window (`clientId`) across reconnects (ADR-129, WP41-04): a window that comes
   * back unfocused (server restart, network, standby) keeps its rank for the notification target
   * instead of starting as "never focused". Map order = age of the last focus; bounded by
   * HUB_LIMITS.focusMemory (oldest out first).
   */
  const focusMemory = new Map<ClientId, Date>();

  function rememberFocus(clientId: ClientId, at: Date): void {
    focusMemory.delete(clientId);
    focusMemory.set(clientId, at);
    for (const oldest of focusMemory.keys()) {
      if (focusMemory.size <= HUB_LIMITS.focusMemory) break;
      focusMemory.delete(oldest);
    }
  }

  function presenceList(): ClientPresence[] {
    const list: ClientPresence[] = [];
    for (const conn of conns) {
      if (conn.state !== 'open' || conn.clientId === null || conn.presence === null) continue;
      list.push({
        clientId: conn.clientId,
        presence: conn.presence,
        lastFocusAt: conn.lastFocusAt,
        connectedAt: conn.connectedAt,
      });
    }
    return list;
  }

  function notifyPresence(): void {
    try {
      source.onPresenceChanged(presenceList());
    } catch (error) {
      log.error({ err: error }, 'onPresenceChanged failed');
    }
  }

  // ---- entries: seq, view, ring buffer, deltas ----

  function entryFor(entryId: EntryId): EntryState {
    let entry = entries.get(entryId);
    if (entry === undefined) {
      entry = {
        entryId,
        seq: 0,
        view: null,
        loading: null,
        ring: [],
        ringChars: 0,
        deltas: new Map(),
        deltaTimer: null,
        subscribers: new Set(),
        evictTimer: null,
      };
      entries.set(entryId, entry);
    }
    return entry;
  }

  /** Only warm entries keep a ring buffer (a cold one has no client that could replay). */
  function isWarm(entry: EntryState): boolean {
    return entry.subscribers.size > 0 || entry.loading !== null || entry.evictTimer !== null;
  }

  function assign(entry: EntryState, op: SessionOp): RingOp {
    entry.seq += 1;
    const seq = entry.seq;
    const json = JSON.stringify({ seq, at: now().toISOString(), op });
    if (entry.view !== null) entry.view = trimItems(applySessionOp(entry.view, op), LIMITS.snapshotItems);
    const ringOp: RingOp = { seq, json };
    if (isWarm(entry)) {
      entry.ring.push(ringOp);
      entry.ringChars += json.length;
      while (
        entry.ring.length > LIMITS.ringBufferOps ||
        (entry.ringChars > HUB_LIMITS.ringBufferChars && entry.ring.length > 1)
      ) {
        const dropped = entry.ring.shift();
        if (dropped !== undefined) entry.ringChars -= dropped.json.length;
      }
    }
    return ringOp;
  }

  function takeDeltas(entry: EntryState, out: RingOp[]): void {
    if (entry.deltaTimer !== null) {
      clearTimeout(entry.deltaTimer);
      entry.deltaTimer = null;
    }
    if (entry.deltas.size === 0) return;
    const pending = [...entry.deltas.values()];
    entry.deltas.clear();
    for (const delta of pending) {
      out.push(
        assign(entry, {
          op: 'item.delta',
          itemId: delta.itemId,
          field: delta.field,
          append: delta.parts.join(''),
        }),
      );
    }
  }

  function sendOps(entry: EntryState, ops: readonly RingOp[]): void {
    if (ops.length === 0 || entry.subscribers.size === 0) return;
    const text = `{"type":"session.ops","entryId":${JSON.stringify(entry.entryId)},"ops":[${ops.map((o) => o.json).join(',')}]}`;
    for (const conn of entry.subscribers) sendText(conn, text);
  }

  function scheduleDeltaFlush(entry: EntryState): void {
    if (entry.deltaTimer !== null || entry.deltas.size === 0) return;
    entry.deltaTimer = setTimeout(() => {
      entry.deltaTimer = null;
      const out: RingOp[] = [];
      takeDeltas(entry, out);
      sendOps(entry, out);
    }, timing.deltaFlushMs);
    entry.deltaTimer.unref();
  }

  function publishOps(entryId: EntryId, ops: SessionOp[]): void {
    // Validate first: a rejected op (throw mode) must not leave seqs assigned but unsent.
    const valid = ops.filter((op) => checkOutgoing(sessionOpSchema, op, `op ${op.op} of ${entryId}`));
    if (valid.length === 0) return;
    const entry = entryFor(entryId);
    const out: RingOp[] = [];
    for (const op of valid) {
      if (op.op === 'item.delta') {
        const key = `${op.itemId}\u0000${op.field}`;
        const pending = entry.deltas.get(key);
        if (pending === undefined)
          entry.deltas.set(key, { itemId: op.itemId, field: op.field, parts: [op.append] });
        else pending.parts.push(op.append);
        continue;
      }
      // Pending deltas go out before any other op of the entry (order stays intact).
      takeDeltas(entry, out);
      out.push(assign(entry, op));
    }
    sendOps(entry, out);
    scheduleDeltaFlush(entry);
  }

  function scheduleEviction(entry: EntryState): void {
    if (entry.evictTimer !== null || entry.subscribers.size > 0) return;
    entry.evictTimer = setTimeout(() => {
      entry.evictTimer = null;
      if (entry.subscribers.size > 0 || entry.loading !== null) return;
      // Flush pending deltas (their seqs must not be reused), then drop the cache. The seq stays.
      takeDeltas(entry, []);
      entry.view = null;
      entry.ring = [];
      entry.ringChars = 0;
    }, timing.evictAfterMs);
    entry.evictTimer.unref();
  }

  function cancelEviction(entry: EntryState): void {
    if (entry.evictTimer === null) return;
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }

  function subscribersChanged(entry: EntryState): void {
    try {
      source.onSubscribersChanged(entry.entryId, entry.subscribers.size);
    } catch (error) {
      log.error({ err: error }, 'onSubscribersChanged failed');
    }
  }

  function addSubscriber(entry: EntryState, conn: Conn): void {
    conn.subscriptions.add(entry.entryId);
    if (entry.subscribers.has(conn)) return;
    entry.subscribers.add(conn);
    cancelEviction(entry);
    subscribersChanged(entry);
  }

  function removeSubscriber(entry: EntryState, conn: Conn): void {
    conn.subscriptions.delete(entry.entryId);
    if (!entry.subscribers.delete(conn)) return;
    subscribersChanged(entry);
    if (entry.subscribers.size === 0) scheduleEviction(entry);
  }

  async function ensureView(entry: EntryState): Promise<SessionViewState | null> {
    if (entry.view !== null) return entry.view;
    if (entry.loading === null) {
      const loading = (async () => {
        const loaded = await source.loadView(entry.entryId);
        if (loaded === null) return null;
        // R0-20: the hub owns the seq; the loaded view reflects every op published so far.
        entry.view ??= trimItems({ ...loaded, entryId: entry.entryId, seq: entry.seq }, LIMITS.snapshotItems);
        return entry.view;
      })();
      entry.loading = loading;
      const clear = () => {
        if (entry.loading === loading) entry.loading = null;
      };
      void loading.then(clear, clear);
    }
    return entry.loading;
  }

  function buildSnapshot(entry: EntryState, view: SessionViewState): SessionSnapshot {
    let items = view.items.slice(Math.max(0, view.items.length - LIMITS.snapshotItems));
    let hasEarlier = view.hasEarlier || items.length < view.items.length;
    // R0-11: keep the snapshot's items under snapshotMaxChars, dropping the oldest (newest stays).
    let total = 0;
    for (const item of items) total += jsonChars(item);
    let drop = 0;
    while (total > LIMITS.snapshotMaxChars && drop < items.length - 1) {
      const item = items[drop];
      if (item !== undefined) total -= jsonChars(item);
      drop += 1;
    }
    if (drop > 0) {
      items = items.slice(drop);
      hasEarlier = true;
    }
    return {
      type: 'session.snapshot',
      entryId: entry.entryId,
      seq: entry.seq,
      items,
      hasEarlier,
      decisions: view.decisions,
      detail: view.detail,
    };
  }

  function canReplay(entry: EntryState, sinceSeq: number): boolean {
    if (sinceSeq > entry.seq) return false;
    if (sinceSeq === entry.seq) return true;
    const first = entry.ring[0];
    return first !== undefined && first.seq <= sinceSeq + 1;
  }

  async function handleSubscribe(conn: Conn, entryId: EntryId, sinceSeq: number | undefined): Promise<void> {
    const gen = (conn.subscribeGen.get(entryId) ?? 0) + 1;
    conn.subscribeGen.set(entryId, gen);
    const entry = entryFor(entryId);
    cancelEviction(entry);
    let view: SessionViewState | null;
    try {
      view = await ensureView(entry);
    } catch (error) {
      log.error({ err: error, entryId }, 'loadView failed');
      if (conn.subscribeGen.get(entryId) === gen) {
        send(conn, { type: 'session.unavailable', entryId, error: makeError('INTERNAL_ERROR') });
      }
      if (entry.subscribers.size === 0) scheduleEviction(entry);
      return;
    }
    if (conn.state !== 'open' || conn.subscribeGen.get(entryId) !== gen) {
      if (entry.subscribers.size === 0) scheduleEviction(entry);
      return;
    }
    if (view === null) {
      removeSubscriber(entry, conn);
      send(conn, { type: 'session.unavailable', entryId, error: makeError('ENTRY_NOT_FOUND') });
      if (entry.seq === 0 && entry.subscribers.size === 0) {
        cancelEviction(entry);
        entries.delete(entryId);
      }
      return;
    }
    if (sinceSeq !== undefined && canReplay(entry, sinceSeq)) {
      const ops = entry.ring.filter((o) => o.seq > sinceSeq);
      sendText(
        conn,
        `{"type":"session.ops","entryId":${JSON.stringify(entryId)},"ops":[${ops.map((o) => o.json).join(',')}]}`,
      );
    } else {
      // R1-02: ops published while `ensureView` settled replaced `entry.view` (and raised the seq);
      // the snapshot must come from that current view, not from the awaited (older) one.
      const snapshot = buildSnapshot(entry, entry.view ?? view);
      if (!checkOutgoing(sessionSnapshotSchema, snapshot, `snapshot of ${entryId}`)) {
        removeSubscriber(entry, conn);
        send(conn, { type: 'session.unavailable', entryId, error: makeError('INTERNAL_ERROR') });
        return;
      }
      send(conn, snapshot);
    }
    addSubscriber(entry, conn);
  }

  function handleUnsubscribe(conn: Conn, entryId: EntryId): void {
    conn.subscribeGen.set(entryId, (conn.subscribeGen.get(entryId) ?? 0) + 1);
    const entry = entries.get(entryId);
    if (entry !== undefined) removeSubscriber(entry, conn);
  }

  // ---- commands ----

  async function execute(cmd: Command, cmdId: string, clientId: ClientId): Promise<AckMessage> {
    try {
      const result = await source.handleCommand(cmd, { clientId, cmdId });
      const schema: z.ZodType = commandResultSchemas[cmd.name];
      const parsed = schema.safeParse(result);
      if (!parsed.success) {
        log.error(
          { cmd: cmd.name, issue: parsed.error.issues[0] },
          'command result does not match its schema',
        );
        return {
          type: 'ack',
          cmdId,
          ok: false,
          error: makeError('INTERNAL_ERROR', { reason: 'invalid_result' }),
        };
      }
      return { type: 'ack', cmdId, ok: true, result: parsed.data };
    } catch (error) {
      if (error instanceof CommandError) {
        const payload = errorPayloadSchema.safeParse(error.error);
        if (payload.success) return { type: 'ack', cmdId, ok: false, error: payload.data };
        log.error({ cmd: cmd.name, error: error.error }, 'CommandError with invalid payload');
      } else {
        log.error({ err: error, cmd: cmd.name }, 'command failed');
      }
      return { type: 'ack', cmdId, ok: false, error: makeError('INTERNAL_ERROR') };
    }
  }

  /** Duplicate cmdId: the cached ack, or – while the command still runs – the same result later. */
  function sendCached(conn: Conn, entry: CmdCacheEntry): void {
    if (entry.ack !== null) {
      send(conn, entry.ack);
      return;
    }
    void entry.promise.then((ack) => {
      send(conn, ack);
    });
  }

  function handleCmd(conn: Conn, cmdId: string, cmd: Command): void {
    const clientId = conn.clientId;
    if (clientId === null) return;
    const cached = cmdCache.get(cmdId, now().getTime());
    if (cached !== undefined) {
      sendCached(conn, cached);
      return;
    }
    const promise = execute(cmd, cmdId, clientId);
    cmdCache.pending(cmdId, promise);
    void promise.then((ack) => {
      cmdCache.complete(cmdId, ack, now().getTime());
      send(conn, ack);
    });
  }

  // ---- incoming messages ----

  function countInvalid(conn: Conn): void {
    const t = now().getTime();
    conn.invalidAt = conn.invalidAt.filter((at) => t - at < timing.invalidWindowMs);
    conn.invalidAt.push(t);
    if (conn.invalidAt.length > HUB_LIMITS.maxInvalidMessages) {
      closeConn(conn, WS_CLOSE.PROTOCOL_ERROR, 'too many invalid messages');
    }
  }

  function handleHello(conn: Conn, message: ClientHelloMessage): void {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendError(
        conn,
        makeError('PROTOCOL_VERSION_MISMATCH', { server: PROTOCOL_VERSION, client: message.protocolVersion }),
        'clientHello',
      );
      closeConn(conn, WS_CLOSE.PROTOCOL_VERSION_MISMATCH, 'protocol version mismatch');
      return;
    }
    let host: HostState;
    let list: SessionSummary[];
    try {
      host = source.hostState();
      list = source.listSummaries();
    } catch (error) {
      log.error({ err: error }, 'source failed during handshake');
      closeConn(conn, 1011, 'internal error');
      return;
    }
    conn.state = 'open';
    conn.clientId = message.clientId;
    conn.presence = message.presence;
    if (message.presence.focused) {
      conn.lastFocusAt = now();
      rememberFocus(message.clientId, conn.lastFocusAt);
    } else {
      conn.lastFocusAt = focusMemory.get(message.clientId) ?? null;
    }
    if (checkOutgoing(hostStateSchema, host, 'host state')) send(conn, { type: 'host.state', host });
    const valid = list.filter((summary) =>
      checkOutgoing(sessionSummarySchema, summary, `summary ${summary.entryId}`),
    );
    send(conn, { type: 'summaries.snapshot', summaries: valid });
    notifyPresence();
  }

  function onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.state === 'closed') return;
    if (isBinary) {
      sendError(conn, makeError('INVALID_MESSAGE', { reason: 'binary' }), null);
      if (conn.state === 'awaiting-hello') closeConn(conn, WS_CLOSE.PROTOCOL_ERROR, 'clientHello required');
      else countInvalid(conn);
      return;
    }
    const text = rawToString(data);
    const parsed = parseClientMessage(text);

    if (conn.state === 'awaiting-hello') {
      if (parsed.ok && parsed.message.type === 'clientHello') {
        handleHello(conn, parsed.message);
        return;
      }
      const error = parsed.ok ? makeError('INVALID_MESSAGE', { reason: 'hello_required' }) : parsed.error;
      sendError(conn, error, rawType(text));
      closeConn(conn, WS_CLOSE.PROTOCOL_ERROR, 'clientHello required');
      return;
    }

    if (!parsed.ok) {
      if (parsed.cmdId === null) sendError(conn, parsed.error, rawType(text));
      else {
        // Validation failures are cached like results (a resend gets the same ack).
        const cached = cmdCache.get(parsed.cmdId, now().getTime());
        if (cached !== undefined) sendCached(conn, cached);
        else {
          const ack: AckMessage = { type: 'ack', cmdId: parsed.cmdId, ok: false, error: parsed.error };
          cmdCache.complete(parsed.cmdId, ack, now().getTime());
          send(conn, ack);
        }
      }
      countInvalid(conn);
      return;
    }

    const message = parsed.message;
    switch (message.type) {
      case 'clientHello':
        sendError(conn, makeError('INVALID_MESSAGE', { reason: 'duplicate_hello' }), 'clientHello');
        countInvalid(conn);
        return;
      case 'presence':
        conn.presence = message.presence;
        if (message.presence.focused) {
          conn.lastFocusAt = now();
          if (conn.clientId !== null) rememberFocus(conn.clientId, conn.lastFocusAt);
        }
        notifyPresence();
        return;
      case 'subscribe':
        void handleSubscribe(conn, message.entryId, message.sinceSeq);
        return;
      case 'unsubscribe':
        handleUnsubscribe(conn, message.entryId);
        return;
      case 'cmd':
        handleCmd(conn, message.cmdId, message.cmd);
        return;
    }
  }

  function onClose(conn: Conn): void {
    if (conn.state === 'closed') return;
    const wasOpen = conn.state === 'open';
    conn.state = 'closed';
    conns.delete(conn);
    for (const entryId of [...conn.subscriptions]) {
      const entry = entries.get(entryId);
      if (entry !== undefined) removeSubscriber(entry, conn);
    }
    conn.subscriptions.clear();
    conn.subscribeGen.clear();
    if (wasOpen) notifyPresence();
    if (conns.size === 0) stopHeartbeat();
  }

  function ensureHeartbeat(): void {
    if (heartbeat !== null || timing.heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      for (const conn of conns) {
        if (!conn.alive) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          conn.socket.terminate();
        }
      }
    }, timing.heartbeatMs);
    heartbeat.unref();
  }

  function stopHeartbeat(): void {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function handleConnection(socket: HubSocket): void {
    const conn: Conn = {
      socket,
      state: 'awaiting-hello',
      clientId: null,
      presence: null,
      lastFocusAt: null,
      connectedAt: now(),
      subscriptions: new Set(),
      subscribeGen: new Map(),
      invalidAt: [],
      alive: true,
    };
    conns.add(conn);
    socket.on('message', (data, isBinary) => {
      try {
        onMessage(conn, data, isBinary);
      } catch (error) {
        log.error({ err: error }, 'message handling failed');
        closeConn(conn, 1011, 'internal error');
      }
    });
    socket.on('close', () => {
      onClose(conn);
    });
    socket.on('error', (error) => {
      log.debug({ err: error }, 'socket error');
    });
    socket.on('pong', () => {
      conn.alive = true;
    });
    send(conn, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      buildId: instance.buildId,
      serverInstanceId: instance.serverInstanceId,
      serverVersion: instance.serverVersion,
      serverStartedAt: instance.startedAt,
    });
    ensureHeartbeat();
  }

  // ---- channel 1: summaries (status immediately, context/activity ≤ 1/s per entry) ----

  function sendSummaryNow(state: SummaryState, summary: SessionSummary): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending = null;
    state.last = summary;
    state.lastSentAt = now().getTime();
    broadcast({ type: 'summary.upsert', summary });
  }

  function publishSummary(summary: SessionSummary, urgent: boolean): void {
    if (!checkOutgoing(sessionSummarySchema, summary, `summary ${summary.entryId}`)) return;
    let state = summaries.get(summary.entryId);
    if (state === undefined) {
      state = { last: null, lastSentAt: 0, pending: null, timer: null };
      summaries.set(summary.entryId, state);
    }
    const significant =
      urgent ||
      state.last === null ||
      !isDeepStrictEqual(withoutThrottledFields(state.last), withoutThrottledFields(summary));
    const elapsed = now().getTime() - state.lastSentAt;
    if (significant || elapsed >= timing.summaryThrottleMs) {
      sendSummaryNow(state, summary);
      return;
    }
    state.pending = summary;
    if (state.timer !== null) return;
    const current = state;
    current.timer = setTimeout(() => {
      current.timer = null;
      if (current.pending !== null) sendSummaryNow(current, current.pending);
    }, timing.summaryThrottleMs - elapsed);
    current.timer.unref();
  }

  function removeSummary(entryId: EntryId): void {
    const state = summaries.get(entryId);
    if (state !== undefined) {
      if (state.timer !== null) clearTimeout(state.timer);
      summaries.delete(entryId);
    }
    broadcast({ type: 'summary.remove', entryId });
    const entry = entries.get(entryId);
    if (entry === undefined) return;
    for (const conn of [...entry.subscribers]) {
      removeSubscriber(entry, conn);
      send(conn, { type: 'session.unavailable', entryId, error: makeError('ENTRY_NOT_FOUND') });
    }
    takeDeltas(entry, []);
    cancelEviction(entry);
    entry.view = null;
    entry.ring = [];
    entry.ringChars = 0;
  }

  function publishHostState(host: HostState): void {
    if (!checkOutgoing(hostStateSchema, host, 'host state')) return;
    broadcast({ type: 'host.state', host });
  }

  function notify(clientId: ClientId, notification: Notification): void {
    const message: z.infer<typeof notifySchema> = { type: 'notify', notification };
    if (!checkOutgoing(notifySchema, message, 'notification')) return;
    const text = JSON.stringify(message);
    for (const conn of conns) if (conn.state === 'open' && conn.clientId === clientId) sendText(conn, text);
  }

  function clearNotification(entryId: EntryId): void {
    broadcast({ type: 'notify.clear', entryId });
  }

  function closeAll(code: number): void {
    for (const conn of [...conns])
      closeConn(conn, code, code === WS_CLOSE.AUTH_REVOKED ? 'auth revoked' : 'closing');
  }

  function dispose(): void {
    stopHeartbeat();
    for (const state of summaries.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    }
    for (const entry of entries.values()) {
      if (entry.deltaTimer !== null) clearTimeout(entry.deltaTimer);
      entry.deltaTimer = null;
      cancelEviction(entry);
    }
  }

  return {
    publishOps,
    publishSummary,
    removeSummary,
    publishHostState,
    notify,
    clearNotification,
    presence: presenceList,
    closeAll,
    handleConnection,
    dispose,
    inspect: (entryId) => {
      const entry = entries.get(entryId);
      if (entry === undefined) return null;
      return {
        seq: entry.seq,
        cached: entry.view !== null,
        ringSize: entry.ring.length,
        subscribers: entry.subscribers.size,
        pendingDeltas: entry.deltas.size,
      };
    },
    stats: () => ({ invalidOutgoing }),
    attach: (app, attachOptions) => {
      app.route({
        method: 'GET',
        url: WS_PATH,
        // Second line (R1-01): a rejected upgrade gets the HTTP error answer, never a 101.
        preValidation: (request, reply, done) => {
          const error = attachOptions.authorizeUpgrade(request);
          if (error !== null) {
            replyHttpError(reply, error);
            return;
          }
          done();
        },
        handler: (_request, reply) =>
          sendHttpError(reply, makeError('INVALID_MESSAGE', { reason: 'upgrade_required' })),
        wsHandler: (socket, request) => {
          // Last resort if hooks were ever bypassed: an unauthorized socket never reaches the hub.
          if (attachOptions.authorizeUpgrade(request) !== null) {
            log.error('unauthorized WebSocket reached the WS handler – terminated');
            socket.terminate();
            return;
          }
          handleConnection(socket);
        },
      });
      app.addHook('onClose', (_instance, done) => {
        dispose();
        done();
      });
    },
  };
}
