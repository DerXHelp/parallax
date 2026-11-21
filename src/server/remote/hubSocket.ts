/**
 * The WebSocket of the coupled computer as the sync hub sees it (`HubSocket`). Second layer of
 * §B.8: as soon as the coupling generation of its connection is no longer current, incoming
 * messages are dropped (and the socket is terminated) and nothing is sent any more – even if a
 * handler still runs after an unpair. The listener destroys the TCP socket anyway.
 *
 * WP-107 (§B.13): `remote` tells the hub the coupling level at the moment of each command (null once
 * the generation is stale) and takes the report of commands it ran (connection log).
 */
import type { RawData, WebSocket } from 'ws';
import type { HubSocket, RemoteSocketAccess } from '../sync/hub';

export class GuardedHubSocket implements HubSocket {
  constructor(
    private readonly ws: WebSocket,
    private readonly current: () => boolean,
    readonly remote?: RemoteSocketAccess,
  ) {}

  get readyState(): number {
    return this.ws.readyState;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** Still the connection of the current coupling (for the hub's own checks before an effect). */
  isCurrent(): boolean {
    return this.current();
  }

  send(data: string): void {
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
