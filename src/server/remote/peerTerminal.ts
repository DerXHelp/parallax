/**
 * The embedded terminal for the coupled computer (docs/wp/WP-76.md §B.13 "Terminal über den
 * Vermittler", decision E3): `peerHttp` hands every WebSocket upgrade on `REMOTE_PATHS.terminalWs` of a
 * proven `peer` socket to this bridge. The protocol is the local one (`terminal/socket.ts`: `hello`
 * within 10 s naming an entry of THIS computer, the same checks – known, not archived, not removed –,
 * limits, heartbeat); the route object comes from `registerTerminalRoute` on a private Fastify instance
 * that never listens (only its socket handler is used, never an HTTP route).
 *
 * Differences to a local socket:
 * - terminals it opens are started "through remote access" (`TerminalService.connect(…, 'remote')`):
 *   unpairing, a new key, a level change, "Share off" and a role change end them (`closeRemote`);
 * - every incoming frame is dropped (and the socket terminated) once the coupling generation of its
 *   connection is no longer current, and nothing is sent any more (second layer of §B.8);
 * - an `open` request is reported (`terminal_opened` in the connection log).
 * Never logs input or output – the route logs only kinds of failures.
 */
import { fastify, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RawData, WebSocket } from 'ws';
import { makeError } from '@shared/errors';
import { REMOTE_PATHS } from '@shared/http';
import { logger as rootLogger } from '../lib/logger';
import type { TerminalConnection, TerminalService } from '../terminal/ports';
import {
  registerTerminalRoute,
  type TerminalRoute,
  type TerminalSocket,
  type TerminalSocketTiming,
} from '../terminal/socket';

/** A terminal WebSocket of the coupled computer that goes silent once its generation is stale. */
export class GuardedTerminalSocket implements TerminalSocket {
  constructor(
    private readonly ws: WebSocket,
    private readonly current: () => boolean,
  ) {}

  get readyState(): number {
    return this.ws.readyState;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(data: string | Uint8Array): void {
    if (!this.current()) {
      this.ws.terminate();
      return;
    }
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  ping(): void {
    if (!this.current()) {
      this.ws.terminate();
      return;
    }
    this.ws.ping();
  }

  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'pong', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'message' | 'close' | 'pong' | 'error',
    listener:
      | ((data: RawData, isBinary: boolean) => void)
      | ((code: number, reason: Buffer) => void)
      | (() => void)
      | ((error: Error) => void),
  ): this {
    if (event === 'message') {
      const onMessage = listener as (data: RawData, isBinary: boolean) => void;
      this.ws.on('message', (data, isBinary) => {
        if (!this.current()) {
          this.ws.terminate();
          return;
        }
        onMessage(data, isBinary);
      });
    } else {
      this.ws.on(event, listener);
    }
    return this;
  }
}

/** `service` as the coupled computer sees it: every connection is `remote`; `open` is reported. */
export function remoteTerminalView(service: TerminalService, onOpen: () => void): TerminalService {
  return {
    get available() {
      return service.available;
    },
    connect(entryId, sink) {
      const connection = service.connect(entryId, sink, 'remote');
      if ('code' in connection) return connection;
      const wrapped: TerminalConnection = {
        handle(message) {
          if (message.type === 'open') onOpen();
          connection.handle(message);
        },
        disconnect() {
          connection.disconnect();
        },
      };
      return wrapped;
    },
    list: (entryId) => service.list(entryId),
    openClaude: (entryId, launch, _origin, since) => service.openClaude(entryId, launch, 'remote', since),
    remoteEpoch: () => service.remoteEpoch(),
    claudeState: (terminalId) => service.claudeState(terminalId),
    closeEntry: (entryId, reason) => {
      service.closeEntry(entryId, reason);
    },
    closeRemote: () => {
      service.closeRemote();
    },
    closeAll: () => service.closeAll(),
  };
}

export interface PeerTerminalBridge {
  /** Takes over a terminal WebSocket of a proven peer socket; `current` = its generation is current. */
  handle(ws: WebSocket, current: () => boolean): void;
  /** Open terminal sockets of the coupled computer. */
  connections(): number;
  close(): Promise<void>;
}

export interface PeerTerminalBridgeOptions {
  service: TerminalService;
  /** A terminal was requested through remote access (`terminal_opened`). */
  onOpen: () => void;
  logger?: Logger;
  timing?: Partial<TerminalSocketTiming>;
}

export async function createPeerTerminalBridge(
  options: PeerTerminalBridgeOptions,
): Promise<PeerTerminalBridge> {
  const log = (options.logger ?? rootLogger).child({ module: 'remotePeerTerminal' });
  // Never listens; only the socket handler of the route is used. Its HTTP route is refused anyway.
  const app: FastifyInstance = fastify({ logger: false });
  const route: TerminalRoute = registerTerminalRoute(app, {
    service: remoteTerminalView(options.service, options.onOpen),
    authorize: () => makeError('ROUTE_NOT_FOUND', { path: REMOTE_PATHS.terminalWs }),
    logger: log,
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });
  await app.ready();
  return {
    handle(ws, current) {
      route.handleSocket(new GuardedTerminalSocket(ws, current));
    },
    connections: () => route.connections(),
    async close() {
      route.closeAll(1001, 'remote access closed');
      await app.close();
    },
  };
}
