import type { EntryId } from '@shared/common';
import { API_PATHS } from '@shared/http';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_LIMITS,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
  terminalServerMessageSchema,
  type TerminalClientMessage,
  type TerminalId,
  type TerminalServerMessage,
} from '@shared/terminal';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from '@web/lib/backoff';
import { webSocketUrl } from '@web/state/transport';
import type { TerminalSize } from '../lib/size';

/**
 * Client of the terminal socket (`API_PATHS.terminalWs`, protocol v1 in `@shared/terminal`, WP-99b):
 * one socket per mounted panel, bound to one entry by `hello`.
 *
 * - Every text frame is parsed with zod; invalid JSON and unknown message types are ignored and
 *   counted (`ignored`). Binary frames go through `decodeTerminalFrame` and reach the view whose
 *   terminal got that channel with `attached`.
 * - Views register with `attachView`; once `welcome` says `available`, each gets an `attach` with its
 *   size. After a reconnect (`backoffDelay`) `hello` goes out again and every view is attached anew –
 *   it clears its screen on `attached`, the replay of the scrollback follows.
 * - The close codes 4404 (entry unknown) and 4426 (protocol) are final: no further attempt.
 */

/** Minimal socket surface (tests inject a fake). */
export interface TerminalSocketLike {
  readonly isOpen: boolean;
  send(text: string): void;
  close(code?: number): void;
}

export interface TerminalSocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onBinary(data: Uint8Array): void;
  onClose(code: number): void;
}

export type TerminalSocketFactory = (url: string, handlers: TerminalSocketHandlers) => TerminalSocketLike;

/** Browser WebSocket with binary frames as ArrayBuffer; the cookie travels automatically (same origin). */
export const browserTerminalSocketFactory: TerminalSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    handlers.onOpen();
  });
  ws.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (typeof data === 'string') handlers.onText(data);
    else if (data instanceof ArrayBuffer) handlers.onBinary(new Uint8Array(data));
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

/** `ws://<host>/api/terminal/ws` of the page, like the main connection (Vite proxies `/api` in dev). */
export function terminalSocketUrl(location: { protocol: string; host: string } = window.location): string {
  return webSocketUrl(location, API_PATHS.terminalWs);
}

/** connecting = until the first `welcome`; open; reconnecting = lost, next attempt pending; failed = final. */
export type TerminalConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

/** A mounted terminal view as the connection sees it. */
export interface TerminalViewSink {
  /** Current size (sent with every `attach`, also after a reconnect). */
  size(): TerminalSize;
  /** `attached` arrived: the replay of the scrollback follows – clear the screen. */
  onAttached(): void;
  onOutput(data: Uint8Array): void;
}

export interface TerminalConnectionOptions {
  entryId: EntryId;
  url: string;
  createSocket?: TerminalSocketFactory;
  backoff?: BackoffOptions;
  random?: () => number;
}

/** Close codes after which another attempt cannot succeed. */
const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  TERMINAL_CLOSE_CODES.entryNotFound,
  TERMINAL_CLOSE_CODES.protocol,
]);

/** Code reported when the socket could not even be created. */
const ABNORMAL_CLOSE = 1006;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `data` in pieces of at most `max` characters, never splitting a surrogate pair. */
export function splitInput(data: string, max: number = TERMINAL_LIMITS.inputMaxChars): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(data.length, start + max);
    if (end < data.length && end - start > 1 && isHighSurrogate(data.charCodeAt(end - 1))) end--;
    parts.push(data.slice(start, end));
    start = end;
  }
  return parts;
}

export class TerminalConnection {
  /** Text frames that were no valid server message (bad JSON, unknown type, invalid fields). */
  ignored = 0;
  private readonly createSocket: TerminalSocketFactory;
  private socket: TerminalSocketLike | null = null;
  private generation = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  /** `welcome` with `available` arrived on the current socket. */
  private ready = false;
  private statusValue: TerminalConnectionStatus = 'connecting';
  private closeCodeValue: number | null = null;
  private readonly views = new Map<TerminalId, TerminalViewSink>();
  private readonly channels = new Map<number, TerminalId>();
  private readonly messageListeners = new Set<(message: TerminalServerMessage) => void>();
  private readonly statusListeners = new Set<(status: TerminalConnectionStatus) => void>();

  constructor(private readonly options: TerminalConnectionOptions) {
    this.createSocket = options.createSocket ?? browserTerminalSocketFactory;
  }

  get status(): TerminalConnectionStatus {
    return this.statusValue;
  }

  /** Code of the last close (null before any). */
  get closeCode(): number | null {
    return this.closeCodeValue;
  }

  /** `welcome` with `available` arrived on the current socket: requests can go out. */
  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.connect();
  }

  /** Closes for good (no reconnect, no more callbacks). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.channels.clear();
    this.views.clear();
    this.messageListeners.clear();
    this.statusListeners.clear();
    socket?.close(1000);
  }

  /** Every valid server message (after the connection handled it). */
  onMessage(listener: (message: TerminalServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: (status: TerminalConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Sends one message; false when the socket is not open (the message is dropped). */
  send(message: TerminalClientMessage): boolean {
    const socket = this.socket;
    if (!socket?.isOpen) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Keys and pastes of a terminal, split to the limit of one `input` message. */
  input(terminalId: TerminalId, data: string): void {
    if (!this.ready) return;
    for (const part of splitInput(data)) this.send({ type: 'input', terminalId, data: part });
  }

  resize(terminalId: TerminalId, size: TerminalSize): void {
    if (!this.ready || !this.views.has(terminalId)) return;
    this.send({ type: 'resize', terminalId, cols: size.cols, rows: size.rows });
  }

  /**
   * Receives the output of a terminal: `attach` now (when ready) and after every reconnect. Returns
   * the detach function (`detach` goes out when the socket is open).
   */
  attachView(terminalId: TerminalId, sink: TerminalViewSink): () => void {
    this.views.set(terminalId, sink);
    if (this.ready) this.sendAttach(terminalId, sink);
    return () => {
      if (this.views.get(terminalId) !== sink) return;
      this.views.delete(terminalId);
      this.dropChannel(terminalId);
      if (this.ready) this.send({ type: 'detach', terminalId });
    };
  }

  private connect(): void {
    this.timer = null;
    const own = ++this.generation;
    const handlers: TerminalSocketHandlers = {
      onOpen: () => {
        if (own === this.generation) this.handleOpen();
      },
      onText: (text) => {
        if (own === this.generation) this.handleText(text);
      },
      onBinary: (data) => {
        if (own === this.generation) this.handleBinary(data);
      },
      onClose: (code) => {
        if (own === this.generation) this.handleClose(code);
      },
    };
    try {
      this.socket = this.createSocket(this.options.url, handlers);
    } catch {
      this.socket = null;
      this.handleClose(ABNORMAL_CLOSE);
    }
  }

  private handleOpen(): void {
    this.send({ type: 'hello', protocol: TERMINAL_PROTOCOL_VERSION, entryId: this.options.entryId });
  }

  private handleText(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.ignored++;
      return;
    }
    const parsed = terminalServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.ignored++;
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'welcome':
        this.attempt = 0;
        this.ready = message.available;
        this.setStatus('open');
        if (this.ready) for (const [terminalId, sink] of this.views) this.sendAttach(terminalId, sink);
        break;
      case 'attached': {
        this.dropChannel(message.terminalId);
        this.channels.set(message.channel, message.terminalId);
        this.views.get(message.terminalId)?.onAttached();
        break;
      }
      default:
        break;
    }
    for (const listener of [...this.messageListeners]) listener(message);
  }

  private handleBinary(frame: Uint8Array): void {
    const decoded = decodeTerminalFrame(frame);
    if (decoded === null) return;
    const terminalId = this.channels.get(decoded.channel);
    if (terminalId === undefined) return;
    this.views.get(terminalId)?.onOutput(decoded.data);
  }

  private handleClose(code: number): void {
    this.socket = null;
    this.ready = false;
    this.channels.clear();
    this.closeCodeValue = code;
    if (this.disposed) return;
    if (FINAL_CLOSE_CODES.has(code)) {
      this.setStatus('failed');
      return;
    }
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.attempt++, this.options.backoff ?? DEFAULT_BACKOFF, this.options.random);
    this.timer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private sendAttach(terminalId: TerminalId, sink: TerminalViewSink): void {
    const size = sink.size();
    this.send({ type: 'attach', terminalId, cols: size.cols, rows: size.rows });
  }

  private dropChannel(terminalId: TerminalId): void {
    for (const [channel, id] of this.channels) if (id === terminalId) this.channels.delete(channel);
  }

  private setStatus(status: TerminalConnectionStatus): void {
    this.statusValue = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
