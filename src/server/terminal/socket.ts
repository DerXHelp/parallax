/**
 * WebSocket route of the embedded terminal (WP-99, ADR-239): `GET API_PATHS.terminalWs`, one socket
 * per mounted terminal panel, bridged to a `TerminalConnection` of `service.ts`. Protocol:
 * `src/shared/terminal.ts`.
 *
 * Registered like the sync hub's route (R1-01): the app's onRequest guard (route class `ws`) runs
 * first; `authorize` checks the upgrade again in `preValidation` (a rejected upgrade gets the HTTP
 * error, never a 101) and once more in the WS handler (a socket that got past the hooks anyway is
 * terminated). Never in `HOST_API_PATHS`: a window of another computer never reaches a shell here.
 *
 * - `hello` must be the first message, within `helloTimeoutMs` (10 s) → otherwise close 4400.
 *   A protocol other than `TERMINAL_PROTOCOL_VERSION` → 4426; an unknown entry → 4404.
 * - After that: JSON text frames only (`terminalClientMessageSchema`), at most
 *   `TERMINAL_SOCKET_LIMITS.maxMessageBytes`. A binary frame, bad JSON, a schema failure, an
 *   oversized or a second `hello` → `error {INVALID_MESSAGE {reason}}`; more than 10 within 10 s →
 *   close 4400.
 * - Ping every `heartbeatMs` (30 s); a socket without pong since the last ping is terminated.
 * - `onRevoked` (the device lost its sign-in) → every socket closes 4401.
 * - A socket that ignores the close frame is terminated after `closeGraceMs`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { RawData } from 'ws';
import { makeError, type ErrorPayload } from '@shared/errors';
import { API_PATHS } from '@shared/http';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_LIMITS,
  TERMINAL_PROTOCOL_VERSION,
  terminalClientMessageSchema,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@shared/terminal';
import { replyError, sendError } from '../http/reply';
import { logger as rootLogger } from '../lib/logger';
import type { TerminalConnection, TerminalService, TerminalSink } from './ports';

/** The subset of a `ws` WebSocket the route uses (real sockets and test fakes). */
export interface TerminalSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  /** Strings go out as text frames, bytes as binary frames (`ws` default). */
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface TerminalSocketTiming {
  /** `hello` must arrive within this. */
  helloTimeoutMs: number;
  /** Ping interval; 0 = off. */
  heartbeatMs: number;
  /** Window for counting invalid messages. */
  invalidWindowMs: number;
  /** A socket that ignores the close frame is terminated after this. */
  closeGraceMs: number;
}

export const DEFAULT_TERMINAL_SOCKET_TIMING: TerminalSocketTiming = {
  helloTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  invalidWindowMs: 10_000,
  closeGraceMs: 2_000,
};

export const TERMINAL_SOCKET_LIMITS = {
  /** More invalid messages within `invalidWindowMs` → close 4400. */
  maxInvalidMessages: 10,
  /**
   * Largest client message: an `input` of `inputMaxChars` characters, each JSON-escaped to at most
   * 6 bytes (`\u001b`), plus the envelope. The `ws` server's own limit (4 MiB) is far above.
   */
  maxMessageBytes: TERMINAL_LIMITS.inputMaxChars * 6 + 1024,
} as const;

export interface TerminalRouteOptions {
  service: TerminalService;
  /**
   * Second line of the WS guard (like `HubAttachOptions.authorizeUpgrade`): Host, request target,
   * Origin, Sec-Fetch-Site and cookie of the upgrade for the route `API_PATHS.terminalWs`. null =
   * authorized; otherwise the error is answered over HTTP and nothing upgrades.
   */
  authorize(request: FastifyRequest): ErrorPayload | null;
  /** `auth.onRevoked`: every terminal socket closes with 4401; unsubscribed when the app closes. */
  onRevoked?: (listener: () => void) => () => void;
  logger?: Logger;
  timing?: Partial<TerminalSocketTiming>;
}

export interface TerminalRoute {
  /** Takes over an authorized socket (called by the route; tests may pass fakes). */
  handleSocket(socket: TerminalSocket): void;
  /** Closes every terminal socket. */
  closeAll(code: number, reason: string): void;
  /** Open sockets (diagnosis, tests). */
  connections(): number;
}

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
/** Close code of an unexpected failure in the message handling. */
const CLOSE_INTERNAL = 1011;

type ClientState = 'awaiting-hello' | 'open' | 'closed';

interface Client {
  readonly socket: TerminalSocket;
  state: ClientState;
  connection: TerminalConnection | null;
  helloTimer: NodeJS.Timeout | null;
  invalidAt: number[];
  alive: boolean;
}

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

type Parsed = { ok: true; message: TerminalClientMessage } | { ok: false; reason: string };

function parseMessage(data: RawData, isBinary: boolean): Parsed {
  if (isBinary) return { ok: false, reason: 'binary' };
  if (rawLength(data) > TERMINAL_SOCKET_LIMITS.maxMessageBytes) return { ok: false, reason: 'too_large' };
  let json: unknown;
  try {
    json = JSON.parse(rawToString(data));
  } catch {
    return { ok: false, reason: 'json' };
  }
  const parsed = terminalClientMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, reason: 'schema' };
}

function isErrorPayload(value: TerminalConnection | ErrorPayload): value is ErrorPayload {
  return 'code' in value;
}

export function registerTerminalRoute(app: FastifyInstance, options: TerminalRouteOptions): TerminalRoute {
  const log = (options.logger ?? rootLogger).child({ module: 'terminal.socket' });
  const timing: TerminalSocketTiming = { ...DEFAULT_TERMINAL_SOCKET_TIMING, ...options.timing };
  const { service } = options;
  const clients = new Set<Client>();
  let heartbeat: NodeJS.Timeout | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };

  const ensureHeartbeat = (): void => {
    if (heartbeat !== null || timing.heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      for (const client of [...clients]) {
        if (!client.alive) {
          detach(client);
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          detach(client);
          client.socket.terminate();
        }
      }
    }, timing.heartbeatMs);
    heartbeat.unref();
  };

  /** No more messages in either direction (idempotent); the shells keep running. */
  function detach(client: Client): void {
    if (client.state === 'closed') return;
    client.state = 'closed';
    if (client.helloTimer !== null) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    clients.delete(client);
    const connection = client.connection;
    client.connection = null;
    connection?.disconnect();
    if (clients.size === 0) stopHeartbeat();
  }

  const closeClient = (client: Client, code: number, reason: string): void => {
    const socket = client.socket;
    detach(client);
    try {
      socket.close(code, reason);
    } catch (error) {
      log.debug({ err: error }, 'terminal socket close failed');
    }
    setTimeout(() => {
      if (socket.readyState !== SOCKET_CLOSED) socket.terminate();
    }, timing.closeGraceMs).unref();
  };

  const sendJson = (client: Client, message: TerminalServerMessage): void => {
    if (client.socket.readyState === SOCKET_OPEN) client.socket.send(JSON.stringify(message));
  };

  const invalid = (client: Client, reason: string): void => {
    sendJson(client, { type: 'error', error: makeError('INVALID_MESSAGE', { reason }) });
    const at = Date.now();
    client.invalidAt = client.invalidAt.filter((t) => at - t < timing.invalidWindowMs);
    client.invalidAt.push(at);
    if (client.invalidAt.length > TERMINAL_SOCKET_LIMITS.maxInvalidMessages) {
      closeClient(client, TERMINAL_CLOSE_CODES.invalid, 'too many invalid messages');
    }
  };

  const sinkFor = (client: Client): TerminalSink => ({
    send: (message) => {
      sendJson(client, message);
    },
    sendFrame: (frame) => {
      if (client.socket.readyState === SOCKET_OPEN) client.socket.send(frame);
    },
    bufferedAmount: () => client.socket.bufferedAmount,
    close: (code, reason) => {
      closeClient(client, code, reason);
    },
  });

  const hello = (client: Client, message: Extract<TerminalClientMessage, { type: 'hello' }>): void => {
    if (client.helloTimer !== null) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    if (message.protocol !== TERMINAL_PROTOCOL_VERSION) {
      closeClient(client, TERMINAL_CLOSE_CODES.protocol, 'protocol not supported');
      return;
    }
    const result = service.connect(message.entryId, sinkFor(client));
    if (isErrorPayload(result)) {
      closeClient(client, TERMINAL_CLOSE_CODES.entryNotFound, 'entry not found');
      return;
    }
    // Closed while `welcome` went out (the service does not do that today): nothing to bind.
    if (!clients.has(client)) {
      result.disconnect();
      return;
    }
    client.state = 'open';
    client.connection = result;
  };

  const onMessage = (client: Client, data: RawData, isBinary: boolean): void => {
    if (client.state === 'closed') return;
    const parsed = parseMessage(data, isBinary);
    if (client.state === 'awaiting-hello') {
      if (parsed.ok && parsed.message.type === 'hello') {
        hello(client, parsed.message);
        return;
      }
      sendJson(client, {
        type: 'error',
        error: makeError('INVALID_MESSAGE', { reason: parsed.ok ? 'hello_required' : parsed.reason }),
      });
      closeClient(client, TERMINAL_CLOSE_CODES.invalid, 'hello required');
      return;
    }
    if (!parsed.ok) {
      invalid(client, parsed.reason);
      return;
    }
    if (parsed.message.type === 'hello') {
      invalid(client, 'duplicate_hello');
      return;
    }
    client.connection?.handle(parsed.message);
  };

  function handleSocket(socket: TerminalSocket): void {
    const client: Client = {
      socket,
      state: 'awaiting-hello',
      connection: null,
      helloTimer: null,
      invalidAt: [],
      alive: true,
    };
    clients.add(client);
    client.helloTimer = setTimeout(() => {
      client.helloTimer = null;
      if (client.state === 'awaiting-hello')
        closeClient(client, TERMINAL_CLOSE_CODES.invalid, 'hello timeout');
    }, timing.helloTimeoutMs);
    client.helloTimer.unref();
    socket.on('message', (data, isBinary) => {
      try {
        onMessage(client, data, isBinary);
      } catch (error) {
        log.error({ err: error }, 'terminal message handling failed');
        closeClient(client, CLOSE_INTERNAL, 'internal error');
      }
    });
    socket.on('close', () => {
      detach(client);
    });
    socket.on('error', (error) => {
      log.debug({ err: error }, 'terminal socket error');
    });
    socket.on('pong', () => {
      client.alive = true;
    });
    ensureHeartbeat();
  }

  const closeAll = (code: number, reason: string): void => {
    for (const client of [...clients]) closeClient(client, code, reason);
  };

  app.route({
    method: 'GET',
    url: API_PATHS.terminalWs,
    // Second line (R1-01): a rejected upgrade gets the HTTP error answer, never a 101.
    preValidation: (request, reply, done) => {
      const error = options.authorize(request);
      if (error !== null) {
        replyError(reply, error);
        return;
      }
      done();
    },
    handler: (_request, reply) =>
      sendError(reply, makeError('INVALID_MESSAGE', { reason: 'upgrade_required' })),
    wsHandler: (socket, request) => {
      // Last resort if hooks were ever bypassed: an unauthorized socket never reaches a shell.
      if (options.authorize(request) !== null) {
        log.error('unauthorized terminal WebSocket reached the WS handler – terminated');
        socket.terminate();
        return;
      }
      handleSocket(socket);
    },
  });

  const offRevoked = options.onRevoked?.(() => {
    closeAll(TERMINAL_CLOSE_CODES.unauthorized, 'auth revoked');
  });
  app.addHook('onClose', (_instance, done) => {
    offRevoked?.();
    stopHeartbeat();
    for (const client of [...clients]) detach(client);
    done();
  });

  return { handleSocket, closeAll, connections: () => clients.size };
}
