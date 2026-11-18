/**
 * HTTP of the coupled computer (`peerHttp`, docs/wp/WP-76.md §B.6): a Fastify instance on its own
 * `http.Server` that never listens – the listener hands it proven sockets
 * (`server.emit('connection', socket)`).
 *
 * Before Fastify sees a request (and before every WebSocket upgrade):
 * 1. the socket must be a proven `peer` socket of the CURRENT coupling generation (else destroyed,
 *    no answer – second layer, default deny);
 * 2. `Origin`, `Sec-Fetch-*` or `Cookie` → 403 ORIGIN_REJECTED and close (`browser_rejected`);
 * 3. `parallax-version`/`parallax-protocol` must equal this server's → else 409 HOST_INCOMPATIBLE
 *    {version, protocol} and close (`version_mismatch`).
 *
 * Routes: only REMOTE_PATHS except `pair` (an `onRoute` allowlist refuses any other route, also
 * from `registerContent`); unknown → 404. The WebSocket upgrade exists only on REMOTE_PATHS.ws
 * (`ws`, `noServer`, no compression, `maxPayload`) and hands a guarded socket to the hub.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  fastify,
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';
import { LIMITS } from '@shared/common';
import { ERROR_CATALOG, makeError, type ErrorPayload } from '@shared/errors';
import { REMOTE_PATHS, type RemoteHealthResponse } from '@shared/http';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { ServerInstance } from '../config';
import { sendError } from '../http/reply';
import { logger as rootLogger } from '../lib/logger';
import { CommandError } from '../sync/ports';
import { hasBrowserHeaders, pathOf, remoteVersionOf } from './headers';
import { GuardedHubSocket } from './hubSocket';
import type { RemoteConnectionInfo, RemoteHubAttach } from './ports';

/** Methods allowed per route pattern (HEAD comes with GET). */
const PEER_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [REMOTE_PATHS.health, new Set(['GET', 'HEAD'])],
  [REMOTE_PATHS.blob, new Set(['GET', 'HEAD'])],
  [REMOTE_PATHS.file, new Set(['GET', 'HEAD'])],
  [REMOTE_PATHS.attachments, new Set(['POST'])],
  [REMOTE_PATHS.peerSelf, new Set(['DELETE'])],
]);

/** For the content routes of WP-78b (`src/server/http/content.ts`). */
export interface RemoteContentContext {
  /** The request's connection still belongs to the current coupling – check before EVERY effect (§B.8). */
  isCurrent(request: FastifyRequest): boolean;
}

/** Registers blob/file/attachments on the peer app (routes outside the allowlist are refused). */
export type RegisterRemoteContent = (
  app: FastifyInstance,
  context: RemoteContentContext,
) => void | Promise<void>;

export interface PeerHttpHooks {
  hub: RemoteHubAttach;
  /** Proven socket of the current generation. */
  isCurrent(socket: object): boolean;
  connectionInfo(socket: object): RemoteConnectionInfo;
  /** A request (or upgrade) of the coupled computer passed the browser check. */
  onVersion(socket: object, appVersion: string | null, compatible: boolean): void;
  onRejected(socket: object, kind: 'browser_rejected' | 'version_mismatch'): void;
  /** DELETE peer/self: unpair in the order of §B.8, sparing `socket` for the answer; throws CommandError. */
  unpairSelf(socket: object): Promise<void>;
  /** A WebSocket of the coupled computer opened (+1) or closed (-1). */
  onWebSocket(delta: 1 | -1): void;
}

export interface PeerHttpOptions {
  instance: ServerInstance;
  hostName: () => string;
  hooks: PeerHttpHooks;
  registerContent?: RegisterRemoteContent;
  logger?: Logger;
}

export interface PeerHttp {
  readonly app: FastifyInstance;
  /** Hands a proven socket to HTTP. */
  emit(socket: Duplex): void;
  close(): Promise<void>;
}

function body(error: ErrorPayload): string {
  return JSON.stringify(error);
}

/** Answers with `error` and closes the connection after the answer. */
function rejectRequest(res: ServerResponse, socket: Duplex, error: ErrorPayload): void {
  const text = body(error);
  res.writeHead(ERROR_CATALOG[error.code].http, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(text, () => {
    socket.destroy();
  });
}

function rejectUpgrade(socket: Duplex, error: ErrorPayload): void {
  const text = body(error);
  const status = ERROR_CATALOG[error.code].http;
  socket.end(
    `HTTP/1.1 ${String(status)} Rejected\r\nContent-Type: application/json; charset=utf-8\r\n` +
      `Content-Length: ${String(Buffer.byteLength(text))}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${text}`,
    () => {
      socket.destroy();
    },
  );
}

export async function createPeerHttp(options: PeerHttpOptions): Promise<PeerHttp> {
  const { hooks, instance } = options;
  const log = (options.logger ?? rootLogger).child({ module: 'remotePeerHttp' });
  const incompatible = (): ErrorPayload =>
    makeError('HOST_INCOMPATIBLE', { version: instance.serverVersion, protocol: PROTOCOL_VERSION });

  /** The checks before Fastify / the upgrade; false = already answered or destroyed. */
  const admit = (req: IncomingMessage, socket: Duplex, reject: (error: ErrorPayload) => void): boolean => {
    if (!hooks.isCurrent(socket)) {
      socket.destroy();
      return false;
    }
    if (hasBrowserHeaders(req.headers)) {
      hooks.onRejected(socket, 'browser_rejected');
      reject(makeError('ORIGIN_REJECTED'));
      return false;
    }
    const version = remoteVersionOf(req.headers, instance.serverVersion);
    hooks.onVersion(socket, version.version, version.compatible);
    if (!version.compatible) {
      hooks.onRejected(socket, 'version_mismatch');
      reject(incompatible());
      return false;
    }
    return true;
  };

  const holder: { server: Server | null } = { server: null };
  // Typed as the base logger so the app is a plain FastifyInstance (like http/app.ts).
  const fastifyLogger: FastifyBaseLogger = log;
  const app = fastify({
    loggerInstance: fastifyLogger,
    logController: new LogController({ disableRequestLogging: true }),
    serverFactory: (handler) => {
      const created = createServer((req, res) => {
        if (
          admit(req, req.socket, (error) => {
            rejectRequest(res, req.socket, error);
          })
        )
          handler(req, res);
      });
      holder.server = created;
      return created;
    },
  });

  app.addHook('onRoute', (route) => {
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).map((method) =>
      String(method).toUpperCase(),
    );
    const allowed = PEER_ROUTES.get(route.url);
    if (allowed === undefined || methods.some((method) => !allowed.has(method))) {
      throw new Error(`route not allowed on remote access: ${methods.join(',')} ${route.url}`);
    }
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, makeError('ROUTE_NOT_FOUND', { path: pathOf(request.url).slice(0, 200) })),
  );
  app.setErrorHandler((error: { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return sendError(reply, makeError('PAYLOAD_TOO_LARGE'));
    if (status >= 400 && status < 500)
      return sendError(reply, makeError('VALIDATION_FAILED', { reason: error.code ?? 'request' }));
    log.error({ err: error, path: pathOf(request.url) }, 'remote request failed');
    return sendError(reply, makeError('INTERNAL_ERROR'));
  });

  app.get(REMOTE_PATHS.health, (): RemoteHealthResponse => ({
    appVersion: instance.serverVersion,
    protocolVersion: PROTOCOL_VERSION,
    buildId: instance.buildId,
    hostName: options.hostName(),
    serverInstanceId: instance.serverInstanceId,
  }));

  app.delete(REMOTE_PATHS.peerSelf, async (request, reply) => {
    const socket = request.raw.socket;
    if (!hooks.isCurrent(socket)) {
      reply.hijack();
      socket.destroy();
      return reply;
    }
    void reply.header('connection', 'close');
    reply.raw.once('finish', () => {
      socket.destroy();
    });
    try {
      await hooks.unpairSelf(socket);
    } catch (error) {
      return sendError(
        reply,
        error instanceof CommandError ? error.error : makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }),
      );
    }
    return {};
  });

  if (options.registerContent !== undefined) {
    await options.registerContent(app, { isCurrent: (request) => hooks.isCurrent(request.raw.socket) });
  }
  await app.ready();
  const http = holder.server;
  if (http === null) throw new Error('peer HTTP server was not created');

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: LIMITS.wsMaxPayloadBytes,
    clientTracking: false,
  });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    if (
      !admit(req, socket, (error) => {
        rejectUpgrade(socket, error);
      })
    )
      return;
    if (pathOf(req.url) !== REMOTE_PATHS.ws || req.method !== 'GET') {
      rejectUpgrade(socket, makeError('ROUTE_NOT_FOUND', { path: pathOf(req.url).slice(0, 200) }));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!hooks.isCurrent(socket)) {
        ws.terminate();
        return;
      }
      hooks.onWebSocket(1);
      ws.once('close', () => {
        hooks.onWebSocket(-1);
      });
      hooks.hub.handleRemoteConnection(
        new GuardedHubSocket(ws, () => hooks.isCurrent(socket)),
        hooks.connectionInfo(socket),
      );
    });
  });
  http.on('connect', (_req: IncomingMessage, socket: Duplex) => {
    socket.destroy();
  });
  http.on('clientError', (_error: Error, socket: Duplex) => {
    socket.destroy();
  });

  return {
    app,
    emit(socket) {
      http.emit('connection', socket);
    },
    async close() {
      wss.close();
      await app.close();
    },
  };
}
