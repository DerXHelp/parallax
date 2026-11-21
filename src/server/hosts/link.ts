/**
 * One coupled computer while the role `control` is active (docs/wp/WP-76.md §B.6 "Steuernder
 * Rechner: Client", WP-75 §4.3): its `PinnedAgent` (all TLS options, pins and the connection proof),
 * the watcher (relay), the window connections and the HTTP requests of the forwarder.
 *
 * Watcher: `GET /remote/v1/health` (versions), then one lasting WebSocket with `clientHello.kind:
 * 'relay'` – no subscriptions, no commands. The first `host.state` (sent once the hub accepted the
 * relay's `clientHello`; `hello` comes before that) makes the computer `connected`;
 * `notify`/`notify.clear` go to the relay listeners. The backoff starts over only after a
 * connection held `stableMs` (a relay accepted and dropped at once must not loop every second).
 * Failures:
 * - unreachable → retry with backoff (no loop: one timer, growing delays);
 * - other version (409, `hello`) → `incompatible`, no retry until `hosts.reconnect`;
 * - our key refused after the handshake twice in a row, or close HOST_REVOKED over the proven
 *   connection → `revoked`, no retry (pair again).
 * `incompatible` and `revoked` also end the window connections (HOST_INCOMPATIBLE/HOST_REVOKED).
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import { REMOTE_PATHS, remoteHealthResponseSchema } from '@shared/http';
import type { HostRecord, RemoteHost, RemoteHostStatus } from '@shared/model';
import { PROTOCOL_VERSION, WS_CLOSE, parseServerMessage, type ClientHelloMessage } from '@shared/protocol';
import { shouldLogRepeated } from '../lib/logger';
import {
  PinnedConnectionError,
  REMOTE_WS_CLIENT_OPTIONS,
  remoteVersionHeaders,
  type PinnedAgent,
} from '../secure/pinnedAgent';
import { connectionFailure, type ConnectionFailure } from './failures';
import { HostForwarderError, type RelayEvents, type UpstreamRequest, type UpstreamResponse } from './ports';
import { markWindowClosed } from './windows';

/** The WebSocket paths of the other computer the forwarder opens (WP-107: also the terminal). */
export type RemoteSocketPath = typeof REMOTE_PATHS.ws | typeof REMOTE_PATHS.terminalWs;

export interface HostsTiming {
  /** Delays between attempts while a computer is unreachable (the last one repeats). */
  backoffMs: readonly number[];
  /**
   * Second attempt after the other side dropped our key (before the computer counts as revoked).
   * Longer than the sharing side needs to notice dead sockets (heartbeat 30 s, two misses): a full
   * peer table refuses like a revoked key and must not end the coupling (security review).
   */
  revokeConfirmMs: number;
  /** A relay connection must hold this long before the backoff starts over. */
  stableMs: number;
  /** Health check, whole request. */
  healthTimeoutMs: number;
  /** `DELETE /remote/v1/peer/self` when a computer is removed. */
  unpairTimeoutMs: number;
  /** Forwarded HTTP requests: longest pause of the socket. */
  requestIdleMs: number;
  /** The relay hears nothing (no message, no ping) this long → closed and connected again. */
  relayIdleMs: number;
}

export const HOSTS_TIMING: HostsTiming = {
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  revokeConfirmMs: 70_000,
  stableMs: 30_000,
  healthTimeoutMs: 10_000,
  unpairTimeoutMs: 5_000,
  requestIdleMs: 30_000,
  // The hub pings every 30 s (HubTiming.heartbeatMs): two missed pings and a margin.
  relayIdleMs: 75_000,
};

export interface HostLimits {
  /**
   * Window connections per computer. The sharing computer takes at most 16 sockets of the coupled
   * computer (WP-76 §B.10: windows + relay + HTTP): 12 windows + 1 relay + `httpSockets`.
   */
  windows: number;
  /** Concurrent HTTP sockets of the HTTP agent (blob, file, upload; WebSockets have their own agent). */
  httpSockets: number;
}

export const HOST_LIMITS: HostLimits = { windows: 12, httpSockets: 2 };

/**
 * The agents of one coupling (security review WP-82): HTTP at most `httpSockets` at a time, the
 * WebSockets (windows, watcher) on their own agent – never queued behind a slow download. Both
 * share one HandshakeGate, so the set-ups stay below the sharing side's per-address limit.
 */
export interface LinkAgents {
  http: PinnedAgent;
  ws: PinnedAgent;
}

export function destroyAgents(agents: LinkAgents | null): void {
  agents?.http.destroy();
  agents?.ws.destroy();
}

/** Largest body read from a health or error answer. */
const SMALL_BODY_BYTES = 16 * 1024;

export interface HostLinkDeps {
  appVersion: string;
  buildId: string;
  timing: HostsTiming;
  limits: HostLimits;
  logger: Logger;
  now: () => Date;
  /** Status, version or error changed. */
  changed: () => void;
  /** The relay connected (its `hello` was accepted). */
  connected: (at: Date) => void;
  relay: RelayEvents;
}

/** Status, versions and error of a computer as `HostState.remoteHosts` shows them. */
type LinkState = Pick<RemoteHost, 'status' | 'appVersion' | 'protocolVersion' | 'lastError'>;

/** Reads at most `max` bytes of `stream` (more → null, stream destroyed). Never rejects. */
export function readSmallBody(stream: Readable, max = SMALL_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        stream.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => {
      finish(Buffer.concat(chunks));
    });
    stream.once('error', () => {
      finish(null);
    });
    stream.once('close', () => {
      finish(size <= max ? Buffer.concat(chunks) : null);
    });
  });
}

function parseJson(body: Buffer | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** Version and protocol of a HOST_INCOMPATIBLE answer of the other computer (unknown → null). */
function incompatibleVersions(body: Buffer | null): { version: string | null; protocol: number | null } {
  const parsed = errorPayloadSchema.safeParse(parseJson(body));
  if (!parsed.success || parsed.data.code !== 'HOST_INCOMPATIBLE') return { version: null, protocol: null };
  const { version, protocol } = parsed.data.params;
  return {
    version: typeof version === 'string' && version.length <= 64 ? version : null,
    protocol: typeof protocol === 'number' && Number.isInteger(protocol) && protocol > 0 ? protocol : null,
  };
}

function unreachable(reason: string): ErrorPayload {
  return makeError('HOST_UNREACHABLE', { reason });
}

function flatHeaders(message: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

const BLOB_PATH = /^\/remote\/v1\/blob\/[0-9a-f]{64}$/u;
/** A query string as `URLSearchParams.toString()` writes it (no raw spaces, `#`, CR/LF …). */
const SAFE_QUERY = /^[A-Za-z0-9%._~&=+*-]*$/u;

/** The forwarded requests the HTTP layer may ask for (defence in depth besides its fixed mapping). */
function forwardable(request: UpstreamRequest): boolean {
  if (!SAFE_QUERY.test(request.query)) return false;
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (BLOB_PATH.test(request.path)) return read && request.query === '';
  if (request.path === REMOTE_PATHS.file) return read;
  if (request.path === REMOTE_PATHS.attachments) return request.method === 'POST';
  return false;
}

/** A request of the forwarder, or one of this module (`DELETE /remote/v1/peer/self`). */
export type LinkRequest = Omit<UpstreamRequest, 'method'> & { method: UpstreamRequest['method'] | 'DELETE' };

/** Host for `https.request` (IPv6 without brackets) and port of a record. */
export function hostTarget(record: Pick<HostRecord, 'address' | 'port'>): { host: string; port: number } {
  return { host: record.address.replace(/^\[(.*)\]$/u, '$1'), port: record.port };
}

/**
 * One HTTPS request to a coupled computer over its agent (all TLS options, pins and the connection
 * proof live there); only the version headers, `content-type` and `content-length` are sent.
 * `timeoutMs` bounds the whole request, `idleMs` the longest pause of the socket.
 */
export function upstreamRequest(
  agent: PinnedAgent,
  target: { host: string; port: number },
  appVersion: string,
  request: LinkRequest,
  options: { timeoutMs?: number; idleMs?: number } = {},
): Promise<UpstreamResponse> {
  const signals = [
    ...(request.signal === undefined ? [] : [request.signal]),
    ...(options.timeoutMs === undefined ? [] : [AbortSignal.timeout(options.timeoutMs)]),
  ];
  const headers: Record<string, string> = { ...remoteVersionHeaders(appVersion) };
  const contentType = request.headers['content-type'];
  const contentLength = request.headers['content-length'];
  if (contentType !== undefined) headers['content-type'] = contentType;
  if (contentLength !== undefined) headers['content-length'] = contentLength;
  const signal = signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
  return new Promise<UpstreamResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        agent,
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.query === '' ? request.path : `${request.path}?${request.query}`,
        headers,
        ...(signal === undefined ? {} : { signal }),
      },
      (res) => {
        // A late error (idle timeout, abort) must never become uncaught; consumers add their own.
        res.on('error', () => undefined);
        resolve({ status: res.statusCode ?? 0, headers: flatHeaders(res), body: res });
      },
    );
    if (options.idleMs !== undefined) {
      req.setTimeout(options.idleMs, () => {
        req.destroy(new PinnedConnectionError('timeout'));
      });
    }
    req.on('error', reject);
    const body = request.body;
    if (body === undefined) req.end();
    else if (Buffer.isBuffer(body)) req.end(body);
    else {
      body.on('error', (error: Error) => {
        req.destroy(error);
      });
      body.pipe(req);
    }
  });
}

export class HostLink {
  record: HostRecord;
  private readonly deps: HostLinkDeps;
  private readonly log: Logger;
  private agents: LinkAgents | null = null;
  private state: LinkState = {
    status: 'connecting',
    appVersion: null,
    protocolVersion: null,
    lastError: null,
  };
  private lastConnectedAt: string | null;
  private relaySocket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private refusals = 0;
  /** Raised by every new attempt and by stop(): callbacks of an older attempt do nothing. */
  private cycle = 0;
  private stopped = false;
  private readonly windows = new Set<WebSocket>();
  private pendingWindows = 0;
  private invalidMessages = 0;
  private suspects = 0;
  /** The relay's client id on the other computer (stable while this server runs). */
  private readonly relayClientId = `cl_${randomBytes(16).toString('hex')}`;

  constructor(record: HostRecord, deps: HostLinkDeps) {
    this.record = record;
    this.deps = deps;
    this.log = deps.logger.child({ hostId: record.hostId });
    this.lastConnectedAt = record.lastConnectedAt;
  }

  view(): RemoteHost {
    const { hostId, name, color, address, port, addedAt } = this.record;
    return {
      hostId,
      name,
      color,
      address,
      port,
      ...this.state,
      lastConnectedAt: this.lastConnectedAt,
      addedAt,
    };
  }

  get status(): RemoteHostStatus {
    return this.state.status;
  }

  /** The coupling's agent is loaded (false after a failed load: `hosts.reconnect` loads again). */
  get hasAgent(): boolean {
    return this.agents !== null;
  }

  /** Window connections that are open (diagnostics and tests). */
  windowCount(): number {
    return this.windows.size;
  }

  /** The coupling's agents are ready: start the watcher. */
  attach(agents: LinkAgents): void {
    if (this.stopped) {
      destroyAgents(agents);
      return;
    }
    destroyAgents(this.agents);
    this.agents = agents;
    this.connect('connecting');
  }

  /** The coupling could not be loaded (key store, key file) – no agent, no retry. */
  failLoad(status: 'unreachable' | 'revoked', error: ErrorPayload): void {
    this.setState({ ...this.state, status, lastError: error });
  }

  /** `hosts.reconnect`: a fresh attempt now (also after `incompatible` and `revoked`). */
  reconnect(): void {
    this.attempt = 0;
    this.refusals = 0;
    this.connect('connecting');
  }

  /** New name, color, address or port; another address or port ends the windows and connects again. */
  update(record: HostRecord): void {
    const moved = record.address !== this.record.address || record.port !== this.record.port;
    this.record = record;
    if (!moved) {
      this.deps.changed();
      return;
    }
    this.closeWindows(WS_CLOSE.HOST_UNREACHABLE);
    if (this.agents !== null) this.reconnect();
    else this.deps.changed();
  }

  /** Ends everything (role left, computer removed, shutdown); windows close with `code`. */
  stop(code: number): void {
    this.stopped = true;
    this.cycle += 1;
    this.clearTimer();
    this.closeRelay();
    this.closeWindows(code);
    destroyAgents(this.agents);
    this.agents = null;
  }

  closeWindows(code: number): void {
    for (const ws of [...this.windows]) {
      markWindowClosed(ws, code);
      ws.terminate();
    }
    this.windows.clear();
  }

  // ---- forwarder ----

  /**
   * Opens a window connection (open, version-checked by the other side) – or, WP-107 (E3), a
   * terminal connection (`REMOTE_PATHS.terminalWs`; counted like windows). Throws HostForwarderError.
   */
  connectWindow(signal?: AbortSignal, path: RemoteSocketPath = REMOTE_PATHS.ws): Promise<WebSocket> {
    const refusal = this.refusal();
    if (refusal !== null) return Promise.reject(new HostForwarderError(refusal));
    if (this.windows.size + this.pendingWindows >= this.deps.limits.windows) {
      this.log.warn({ limit: this.deps.limits.windows }, 'too many window connections to this computer');
      return Promise.reject(new HostForwarderError(unreachable('limit')));
    }
    let ws: WebSocket;
    try {
      ws = this.openSocket(path);
    } catch (error) {
      return Promise.reject(new HostForwarderError(connectionFailure(error).error));
    }
    this.pendingWindows += 1;
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        this.pendingWindows -= 1;
        signal?.removeEventListener('abort', onAbort);
        outcome();
      };
      const fail = (error: ErrorPayload): void => {
        settle(() => {
          ws.terminate();
          reject(new HostForwarderError(error));
        });
      };
      const onAbort = (): void => {
        fail(unreachable('closed'));
      };
      ws.once('open', () => {
        settle(() => {
          if (this.stopped) {
            ws.terminate();
            reject(new HostForwarderError(makeError('HOST_NOT_FOUND')));
            return;
          }
          this.windows.add(ws);
          ws.once('close', () => {
            this.windows.delete(ws);
          });
          resolve(ws);
        });
      });
      ws.on('unexpected-response', (req, res) => {
        void readSmallBody(res).then((body) => {
          req.destroy();
          if (res.statusCode === 409) {
            const versions = incompatibleVersions(body);
            this.setIncompatible(versions.version, versions.protocol);
            fail(this.incompatibleError(versions.version, versions.protocol));
          } else fail(unreachable(`status_${String(res.statusCode ?? 0)}`));
        });
      });
      // Stays for the socket's lifetime: a late error must never become uncaught.
      ws.on('error', (error: Error) => {
        if (settled) return;
        const failure = connectionFailure(error);
        this.noteSuspect(failure);
        if (failure.kind === 'refused') {
          // Only the watcher decides `revoked` (a full connection table looks the same).
          this.kick();
          fail(unreachable('closed'));
        } else fail(failure.error);
      });
      ws.once('close', () => {
        fail(unreachable('closed'));
      });
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** A forwarded request (fixed paths only). Throws HostForwarderError; a 4xx/5xx is a normal answer. */
  async request(request: UpstreamRequest): Promise<UpstreamResponse> {
    if (!forwardable(request)) throw new TypeError('request not forwarded');
    const refusal = this.refusal();
    if (refusal !== null) throw new HostForwarderError(refusal);
    try {
      return await this.send(request, { idleMs: this.deps.timing.requestIdleMs });
    } catch (error) {
      if (request.signal?.aborted === true) throw new HostForwarderError(unreachable('closed'));
      const failure = connectionFailure(error);
      this.noteSuspect(failure);
      if (failure.kind === 'refused') {
        this.kick();
        throw new HostForwarderError(unreachable('closed'));
      }
      throw new HostForwarderError(failure.error);
    }
  }

  /**
   * `DELETE /remote/v1/peer/self` (§B.8 step 1): true when the other computer confirmed or had
   * already dropped this coupling; false when it could not be asked (then the user unpairs there).
   */
  async unpairRemote(): Promise<boolean> {
    if (this.agents === null) return false;
    if (this.state.status === 'revoked') return true;
    try {
      const response = await this.send(
        { method: 'DELETE', path: REMOTE_PATHS.peerSelf, query: '', headers: {} },
        { timeoutMs: this.deps.timing.unpairTimeoutMs },
      );
      response.body.resume();
      return response.status === 200;
    } catch (error) {
      this.log.info(
        { reason: connectionFailure(error).error.params.reason ?? 'refused' },
        'unpair not delivered',
      );
      return false;
    }
  }

  // ---- watcher ----

  private connect(status: RemoteHostStatus): void {
    const cycle = ++this.cycle;
    this.clearTimer();
    this.closeRelay();
    if (this.stopped || this.agents === null) return;
    if (status === 'connecting') this.setState({ ...this.state, status, lastError: null });
    void this.runCycle(cycle);
  }

  private current(cycle: number): boolean {
    return cycle === this.cycle && !this.stopped;
  }

  private async runCycle(cycle: number): Promise<void> {
    const health = await this.health();
    if (!this.current(cycle)) return;
    if (health.kind === 'failure') {
      this.onFailure(health.failure);
      return;
    }
    if (health.kind === 'incompatible') {
      this.setIncompatible(health.version, health.protocol);
      return;
    }
    this.openRelay(cycle);
  }

  private async health(): Promise<
    | { kind: 'ok' }
    | { kind: 'incompatible'; version: string | null; protocol: number | null }
    | { kind: 'failure'; failure: ConnectionFailure }
  > {
    let response: UpstreamResponse;
    try {
      response = await this.send(
        { method: 'GET', path: REMOTE_PATHS.health, query: '', headers: {} },
        { timeoutMs: this.deps.timing.healthTimeoutMs },
      );
    } catch (error) {
      return { kind: 'failure', failure: connectionFailure(error) };
    }
    const body = await readSmallBody(response.body);
    if (response.status === 409) return { kind: 'incompatible', ...incompatibleVersions(body) };
    const failure = (reason: string): { kind: 'failure'; failure: ConnectionFailure } => ({
      kind: 'failure',
      failure: { kind: 'unreachable', error: unreachable(reason), suspect: false },
    });
    if (response.status !== 200) return failure(`status_${String(response.status)}`);
    const parsed = remoteHealthResponseSchema.safeParse(parseJson(body));
    if (!parsed.success) return failure('closed');
    const { appVersion, protocolVersion } = parsed.data;
    if (appVersion !== this.deps.appVersion || protocolVersion !== PROTOCOL_VERSION) {
      return { kind: 'incompatible', version: appVersion, protocol: protocolVersion };
    }
    this.setState({ ...this.state, appVersion, protocolVersion });
    return { kind: 'ok' };
  }

  private openRelay(cycle: number): void {
    let ws: WebSocket;
    try {
      ws = this.openSocket();
    } catch (error) {
      this.onFailure(connectionFailure(error));
      return;
    }
    this.relaySocket = ws;
    let opened = false;
    let accepted = false;
    let acceptedAt = 0;
    let handled = false;
    let socketError: unknown = null;
    let idle: NodeJS.Timeout | null = null;
    const alive = (): void => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        this.log.info('relay silent – reconnecting');
        ws.terminate();
      }, this.deps.timing.relayIdleMs);
      idle.unref();
    };
    ws.on('unexpected-response', (req, res) => {
      handled = true;
      void readSmallBody(res).then((body) => {
        req.destroy();
        ws.terminate();
        if (!this.current(cycle)) return;
        if (res.statusCode === 409) {
          const versions = incompatibleVersions(body);
          this.setIncompatible(versions.version, versions.protocol);
        } else {
          this.onFailure({
            kind: 'unreachable',
            error: unreachable(`status_${String(res.statusCode ?? 0)}`),
            suspect: false,
          });
        }
      });
    });
    ws.on('open', () => {
      opened = true;
      alive();
      const hello: ClientHelloMessage = {
        type: 'clientHello',
        protocolVersion: PROTOCOL_VERSION,
        buildId: this.deps.buildId,
        clientId: this.relayClientId,
        presence: { focused: false, visible: false, viewingEntryId: null, typing: false },
        kind: 'relay',
      };
      ws.send(JSON.stringify(hello));
    });
    ws.on('ping', alive);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      alive();
      if (!this.current(cycle) || isBinary) return;
      this.onRelayMessage(ws, data, () => {
        if (accepted) return;
        accepted = true;
        acceptedAt = Date.now();
        this.onConnected();
      });
    });
    ws.on('error', (error: Error) => {
      socketError = error;
    });
    ws.on('close', (code: number) => {
      if (idle !== null) clearTimeout(idle);
      if (this.relaySocket === ws) this.relaySocket = null;
      if (handled || !this.current(cycle)) return;
      const wasConnected = this.state.status === 'connected';
      if (!opened) {
        this.onFailure(connectionFailure(socketError ?? new PinnedConnectionError('network')));
      } else if (code === WS_CLOSE.HOST_REVOKED) {
        this.log.info('coupling revoked by the other computer');
        this.setRevoked();
      } else if (code === WS_CLOSE.PROTOCOL_VERSION_MISMATCH) {
        this.setIncompatible(null, null);
      } else {
        if (wasConnected && Date.now() - acceptedAt >= this.deps.timing.stableMs) this.attempt = 0;
        this.onFailure({ kind: 'unreachable', error: unreachable('closed'), suspect: false });
      }
    });
  }

  private onRelayMessage(ws: WebSocket, data: RawData, accepted: () => void): void {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    const parsed = parseServerMessage(text);
    if (parsed.ok !== true) {
      this.invalidMessages += 1;
      if (parsed.ok === false && shouldLogRepeated(this.invalidMessages)) {
        this.log.warn({ error: parsed.error }, 'invalid message from the relay');
      }
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'hello':
        if (message.protocolVersion !== PROTOCOL_VERSION || message.serverVersion !== this.deps.appVersion) {
          this.setIncompatible(message.serverVersion.slice(0, 64), message.protocolVersion);
          ws.close();
          return;
        }
        return;
      case 'host.state':
        accepted();
        return;
      case 'notify':
        this.emitRelay((listener) => {
          listener.notify(this.record.hostId, message.notification);
        });
        return;
      case 'notify.clear':
        this.emitRelay((listener) => {
          listener.clear(this.record.hostId, message.entryId);
        });
        return;
      default:
        return;
    }
  }

  private emitRelay(deliver: (listener: RelayEvents) => void): void {
    try {
      deliver(this.deps.relay);
    } catch (error) {
      this.log.error({ err: error }, 'relay listener failed');
    }
  }

  private onConnected(): void {
    const at = this.deps.now();
    this.refusals = 0;
    this.lastConnectedAt = at.toISOString();
    this.setState({
      status: 'connected',
      appVersion: this.deps.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      lastError: null,
    });
    this.log.info('computer connected');
    this.deps.connected(at);
  }

  private onFailure(failure: ConnectionFailure): void {
    this.noteSuspect(failure);
    if (failure.kind === 'refused') {
      this.refusals += 1;
      if (this.refusals >= 2) {
        this.log.warn('the other computer refuses this coupling – revoked');
        this.setRevoked();
        return;
      }
      this.schedule(this.deps.timing.revokeConfirmMs);
      return;
    }
    this.refusals = 0;
    this.setState({ ...this.state, status: 'unreachable', lastError: failure.error });
    const delays = this.deps.timing.backoffMs;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 60_000;
    this.attempt += 1;
    // ±20 % so that several computers do not retry in lockstep.
    this.schedule(Math.round(delay * (0.8 + Math.random() * 0.4)));
  }

  private noteSuspect(failure: ConnectionFailure): void {
    if (!failure.suspect) return;
    this.suspects += 1;
    if (shouldLogRepeated(this.suspects)) {
      this.log.warn(
        { count: this.suspects },
        'the computer at this address is not the coupled one (pin or coupling secret)',
      );
    }
  }

  /** A window or request was refused after the handshake: let the watcher check soon. */
  private kick(): void {
    if (this.stopped || this.agents === null || this.timer === null) return;
    if (this.state.status === 'unreachable' || this.state.status === 'connecting') {
      this.schedule(0);
    }
  }

  private setRevoked(): void {
    this.clearTimer();
    this.closeRelay();
    this.closeWindows(WS_CLOSE.HOST_REVOKED);
    this.setState({ ...this.state, status: 'revoked', lastError: makeError('HOST_REVOKED') });
  }

  private incompatibleError(version: string | null, protocol: number | null): ErrorPayload {
    return makeError('HOST_INCOMPATIBLE', {
      ...(version === null ? {} : { version }),
      ...(protocol === null ? {} : { protocol }),
    });
  }

  private setIncompatible(version: string | null, protocol: number | null): void {
    this.clearTimer();
    this.closeRelay();
    this.closeWindows(WS_CLOSE.HOST_INCOMPATIBLE);
    this.setState({
      status: 'incompatible',
      appVersion: version ?? this.state.appVersion,
      protocolVersion: protocol ?? this.state.protocolVersion,
      lastError: this.incompatibleError(version, protocol),
    });
  }

  /** Why windows and requests are refused right away (null = try). */
  private refusal(): ErrorPayload | null {
    if (this.stopped) return makeError('HOST_NOT_FOUND');
    if (this.state.status === 'revoked') return makeError('HOST_REVOKED');
    if (this.state.status === 'incompatible') {
      return this.incompatibleError(this.state.appVersion, this.state.protocolVersion);
    }
    if (this.agents === null) return this.state.lastError ?? unreachable('closed');
    return null;
  }

  private setState(next: LinkState): void {
    const before = JSON.stringify(this.state);
    this.state = next;
    if (JSON.stringify(next) !== before) this.deps.changed();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect(this.state.status);
    }, delayMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private closeRelay(): void {
    const ws = this.relaySocket;
    this.relaySocket = null;
    ws?.terminate();
  }

  // ---- transport ----

  private target(): { host: string; port: number } {
    return hostTarget(this.record);
  }

  private openSocket(path: RemoteSocketPath = REMOTE_PATHS.ws): WebSocket {
    const agent = this.agents?.ws ?? null;
    if (agent === null) throw new PinnedConnectionError('destroyed');
    const { host, port } = this.target();
    const urlHost = host.includes(':') ? `[${host}]` : host;
    // Only the two fixed paths – never one from a request (§B.13).
    return new WebSocket(`wss://${urlHost}:${String(port)}${path}`, {
      agent,
      ...REMOTE_WS_CLIENT_OPTIONS,
      headers: remoteVersionHeaders(this.deps.appVersion),
    });
  }

  /** One HTTPS request over the coupling's HTTP agent (version headers added). */
  private send(
    request: LinkRequest,
    options: { timeoutMs?: number; idleMs?: number },
  ): Promise<UpstreamResponse> {
    const agent = this.agents?.http ?? null;
    if (agent === null) return Promise.reject(new PinnedConnectionError('destroyed'));
    return upstreamRequest(agent, this.target(), this.deps.appVersion, request, options);
  }
}
