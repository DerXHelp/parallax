/**
 * HTTP of the pairing window (`pairingHttp`, docs/wp/WP-76.md §B.6, §B.10): a plain `http.Server`
 * that never listens. Only `POST /remote/v1/pair`, headers ≤ 4 KiB, body ≤ 4 KiB, 15 s idle
 * timeout, no upgrade, no CONNECT, exactly one request per socket – after the answer the socket is
 * closed; it never becomes a `peer` socket.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { ERROR_CATALOG, makeError, type ErrorPayload } from '@shared/errors';
import { REMOTE_PATHS } from '@shared/http';
import { REMOTE_LIMITS, type RemoteLimits } from './limits';
import { hasBrowserHeaders, pathOf } from './headers';

export interface PairingAnswer {
  status: number;
  payload: unknown;
}

export interface PairingHttpHooks {
  /** Decides the pairing (§B.7 steps 6–7). `body` is the parsed JSON or undefined. Never throws. */
  pair(socket: TLSSocket, body: unknown, headers: IncomingHttpHeaders): Promise<PairingAnswer | null>;
  onRejected(socket: TLSSocket, kind: 'browser_rejected'): void;
}

export interface PairingHttp {
  emit(socket: Duplex): void;
}

export function errorAnswer(error: ErrorPayload): PairingAnswer {
  return { status: ERROR_CATALOG[error.code].http, payload: error };
}

function answer(res: ServerResponse, socket: Duplex, result: PairingAnswer): void {
  const text = JSON.stringify(result.payload);
  res.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(text, () => {
    socket.destroy();
  });
}

export function createPairingHttp(options: { hooks: PairingHttpHooks; limits?: RemoteLimits }): PairingHttp {
  const limits = options.limits ?? REMOTE_LIMITS;
  const { hooks } = options;
  const used = new WeakSet<object>();

  const server = createServer(
    {
      maxHeaderSize: limits.pairingHeaderBytes,
      headersTimeout: limits.pairingIdleMs,
      requestTimeout: limits.pairingIdleMs,
      keepAliveTimeout: 1,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket;
      if (!(socket instanceof TLSSocket) || used.has(socket)) {
        socket.destroy();
        return;
      }
      used.add(socket);
      if (hasBrowserHeaders(req.headers)) {
        hooks.onRejected(socket, 'browser_rejected');
        answer(res, socket, errorAnswer(makeError('ORIGIN_REJECTED')));
        return;
      }
      if (req.method !== 'POST' || pathOf(req.url) !== REMOTE_PATHS.pair) {
        answer(
          res,
          socket,
          errorAnswer(makeError('ROUTE_NOT_FOUND', { path: pathOf(req.url).slice(0, 200) })),
        );
        return;
      }
      const declared = Number(req.headers['content-length'] ?? '0');
      if (!Number.isFinite(declared) || declared > limits.pairingBodyBytes) {
        answer(res, socket, errorAnswer(makeError('PAYLOAD_TOO_LARGE')));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.pairingBodyBytes) {
          socket.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (socket.destroyed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = undefined;
        }
        void hooks.pair(socket, parsed, req.headers).then(
          (result) => {
            if (result === null || socket.destroyed) socket.destroy();
            else answer(res, socket, result);
          },
          () => {
            socket.destroy();
          },
        );
      });
    },
  );
  // Idle sockets (no request, slow body) end after the idle time; no callback → destroyed.
  server.setTimeout(limits.pairingIdleMs);
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    socket.destroy();
  });
  server.on('connect', (_req: IncomingMessage, socket: Duplex) => {
    socket.destroy();
  });
  server.on('clientError', (_error: Error, socket: Duplex) => {
    socket.destroy();
  });

  return {
    emit(socket) {
      server.emit('connection', socket);
    },
  };
}
