import { parseClientMessage, type ClientMessage, type ServerMessage } from '@shared/protocol';

/**
 * Exchangeable message channel of one host connection (WP-02 §10.3): WebSocket in the app,
 * in-memory for tests and the playground. Text frames only (one JSON object per frame).
 */
export interface Transport {
  /**
   * Opens the channel (again). `onMessage` gets every text frame, `onClose` the close code once
   * the channel ends without `close()` (1006 = abnormal). The server speaks first (`hello`).
   */
  connect(onMessage: (text: string) => void, onClose: (code: number) => void): void;
  /** Sends one frame; throws if the channel is not open. */
  send(text: string): void;
  /** Closes deliberately; `onClose` is NOT called. */
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------

/** Minimal socket surface behind the WebSocket transport (tests inject a fake). */
export interface SocketLike {
  readonly isOpen: boolean;
  send(text: string): void;
  close(code?: number): void;
}

export interface SocketHandlers {
  onMessage(text: string): void;
  onClose(code: number): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

/** Browser WebSocket adapter. Cookies are sent automatically (same origin, architecture §5.1). */
export const browserSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  ws.addEventListener('close', (event) => {
    handlers.onClose(event.code);
  });
  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (text) => {
      ws.send(text);
    },
    close: (code) => {
      ws.close(code);
    },
  };
};

/** `ws://<host>/api/ws` of the page (Vite proxies it in dev). */
export function webSocketUrl(location: { protocol: string; host: string }, path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

export function createWebSocketTransport(
  url: string,
  createSocket: SocketFactory = browserSocketFactory,
): Transport {
  let socket: SocketLike | null = null;
  let generation = 0;
  return {
    connect(onMessage, onClose) {
      socket?.close(1000);
      const own = ++generation;
      socket = createSocket(url, {
        onMessage: (text) => {
          if (own === generation) onMessage(text);
        },
        onClose: (code) => {
          if (own !== generation) return;
          socket = null;
          onClose(code);
        },
      });
    },
    send(text) {
      if (socket?.isOpen !== true) throw new Error('WebSocket transport is not open');
      socket.send(text);
    },
    close() {
      generation++;
      const current = socket;
      socket = null;
      current?.close(1000);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// In memory (tests, playground)
// ---------------------------------------------------------------------------------------------

export interface MemoryTransport extends Transport {
  /** Delivers a server message to the client (synchronously). */
  serverSend(message: ServerMessage): void;
  /** Delivers raw text (invalid JSON / unknown types in tests). */
  serverSendRaw(text: string): void;
  /** Ends the channel from the "server" side: the client gets `onClose(code)` (default 1006). */
  serverClose(code?: number): void;
  /** Every message the client sent, parsed with the client schema (invalid ones throw in `send`). */
  readonly sent: ClientMessage[];
  /** Messages of one type, e.g. `sentOfType('subscribe')`. */
  sentOfType<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[];
  clearSent(): void;
  readonly connected: boolean;
  /** Number of `connect()` calls (reconnect tests). */
  readonly connectCount: number;
  /** Called for every client message (fake servers answer here). */
  onClientMessage(listener: (message: ClientMessage) => void): () => void;
  /** Called after every `connect()` (fake servers send `hello` here). */
  onConnect(listener: () => void): () => void;
}

export function createMemoryTransport(): MemoryTransport {
  let handlers: { onMessage: (text: string) => void; onClose: (code: number) => void } | null = null;
  let connectCount = 0;
  const sent: ClientMessage[] = [];
  const messageListeners = new Set<(message: ClientMessage) => void>();
  const connectListeners = new Set<() => void>();

  const transport: MemoryTransport = {
    connect(onMessage, onClose) {
      handlers = { onMessage, onClose };
      connectCount++;
      for (const listener of [...connectListeners]) listener();
    },
    send(text) {
      if (handlers === null) throw new Error('memory transport is not connected');
      const parsed = parseClientMessage(text);
      if (!parsed.ok) throw new Error(`invalid client message: ${parsed.error.message ?? parsed.error.code}`);
      sent.push(parsed.message);
      for (const listener of [...messageListeners]) listener(parsed.message);
    },
    close() {
      handlers = null;
    },
    serverSend(message) {
      transport.serverSendRaw(JSON.stringify(message));
    },
    serverSendRaw(text) {
      if (handlers === null) throw new Error('memory transport is not connected');
      handlers.onMessage(text);
    },
    serverClose(code = 1006) {
      const current = handlers;
      handlers = null;
      current?.onClose(code);
    },
    sent,
    sentOfType<T extends ClientMessage['type']>(type: T) {
      return sent.filter((message): message is Extract<ClientMessage, { type: T }> => message.type === type);
    },
    clearSent() {
      sent.length = 0;
    },
    get connected() {
      return handlers !== null;
    },
    get connectCount() {
      return connectCount;
    },
    onClientMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onConnect(listener) {
      connectListeners.add(listener);
      return () => {
        connectListeners.delete(listener);
      };
    },
  };
  return transport;
}
