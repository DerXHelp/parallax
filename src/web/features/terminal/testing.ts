import { LOCAL_HOST_ID, makeSessionKey, type HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ShellKind } from '@shared/model';
import { SAMPLE_IDS, SAMPLE_TIME } from '@shared/samples';
import {
  TERMINAL_LIMITS,
  TERMINAL_PROTOCOL_VERSION,
  encodeTerminalFrame,
  terminalClientMessageSchema,
  type TerminalClientMessage,
  type TerminalExitReason,
  type TerminalId,
  type TerminalInfo,
  type TerminalServerMessage,
} from '@shared/terminal';
import type { EngineFactory } from './lib/engine';
import type { TerminalEnvironment } from './state/environment';
import type { TerminalSocketFactory, TerminalSocketHandlers, TerminalSocketLike } from './state/socket';

/**
 * Test helpers of the terminal feature (WP-99b): a fake WebSocket and a fake terminal server that
 * answers like `src/server/terminal` (protocol v1), plus sample terminals with fixed ids and times.
 */

export const TERMINAL_SESSION_KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
export const TERMINAL_SOCKET_URL = 'ws://127.0.0.1:4712/api/terminal/ws';

/** WP-105 (E3): the relay URL of another computer's terminal in the fake environment. */
export function remoteTerminalSocketUrl(hostId: HostId): string {
  return `ws://127.0.0.1:4712/api/hosts/${hostId}/terminal/ws`;
}

/** Deterministic terminal id `tm_<n as 32 hex>`. */
export function sampleTerminalId(n = 1): TerminalId {
  return `tm_${n.toString(16).padStart(32, '0')}`;
}

export function sampleTerminalInfo(p: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    terminalId: sampleTerminalId(1),
    entryId: SAMPLE_IDS.entry,
    shell: 'cmd',
    cwd: 'C:\\work\\sample',
    createdAt: SAMPLE_TIME,
    cols: 80,
    rows: 24,
    state: 'running',
    exitCode: null,
    title: null,
    command: 'shell',
    ...p,
  };
}

/** A socket the test drives: `open()`, `serverSend()`, `serverClose()`; `sent` holds parsed client messages. */
export class FakeTerminalSocket implements TerminalSocketLike {
  isOpen = false;
  /** Code of a client-side `close()` (null while not closed by the client). */
  closedWith: number | null = null;
  readonly sent: TerminalClientMessage[] = [];

  constructor(
    readonly url: string,
    private readonly handlers: TerminalSocketHandlers,
    private readonly onSend: (message: TerminalClientMessage) => void = () => undefined,
  ) {}

  /** The handshake finished (the client sends `hello` now). */
  open(): void {
    this.isOpen = true;
    this.handlers.onOpen();
  }

  send(text: string): void {
    if (!this.isOpen) throw new Error('fake terminal socket is not open');
    const message = terminalClientMessageSchema.parse(JSON.parse(text));
    this.sent.push(message);
    this.onSend(message);
  }

  close(code = 1000): void {
    this.isOpen = false;
    this.closedWith = code;
  }

  serverSend(message: TerminalServerMessage): void {
    this.handlers.onText(JSON.stringify(message));
  }

  serverSendRaw(text: string): void {
    this.handlers.onText(text);
  }

  serverBinary(channel: number, text: string): void {
    this.handlers.onBinary(encodeTerminalFrame(channel, new TextEncoder().encode(text)));
  }

  serverBinaryRaw(frame: Uint8Array): void {
    this.handlers.onBinary(frame);
  }

  /** The connection ended (default 1006 = abnormal). */
  serverClose(code = 1006): void {
    this.isOpen = false;
    this.handlers.onClose(code);
  }

  sentOfType<T extends TerminalClientMessage['type']>(
    type: T,
  ): Extract<TerminalClientMessage, { type: T }>[] {
    return this.sent.filter(
      (message): message is Extract<TerminalClientMessage, { type: T }> => message.type === type,
    );
  }
}

/** A factory of `FakeTerminalSocket`s that the test opens itself. */
export function createFakeSocketFactory(): { factory: TerminalSocketFactory; sockets: FakeTerminalSocket[] } {
  const sockets: FakeTerminalSocket[] = [];
  return {
    sockets,
    factory: (url, handlers) => {
      const socket = new FakeTerminalSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
  };
}

/**
 * A fake terminal server: opens every socket (microtask), answers `hello` with `welcome` + `terminals`,
 * `open` with `opened` + `terminals` (or `error` while `failOpen` is set), `attach` with `attached`
 * and the replay of `output`, `close`, `rename` and `move` with `terminals`. All answers arrive as
 * microtasks.
 */
export class FakeTerminalServer {
  available = true;
  unavailableError: ErrorPayload | null = null;
  /** The next `open` requests fail with this error. */
  failOpen: ErrorPayload | null = null;
  items: TerminalInfo[] = [];
  /** Scrollback per terminal, replayed after `attach`. */
  readonly output = new Map<TerminalId, string>();
  readonly sockets: FakeTerminalSocket[] = [];
  /** Channel of each attached terminal on the latest socket. */
  readonly channels = new Map<TerminalId, number>();
  private nextTerminal = 100;
  private nextChannel = 0;

  readonly factory: TerminalSocketFactory = (url, handlers) => {
    const socket: FakeTerminalSocket = new FakeTerminalSocket(url, handlers, (message) => {
      queueMicrotask(() => {
        this.receive(socket, message);
      });
    });
    this.sockets.push(socket);
    queueMicrotask(() => {
      socket.open();
    });
    return socket;
  };

  get socket(): FakeTerminalSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('no terminal socket yet');
    return socket;
  }

  /** Every client message on every socket, oldest first. */
  sent(): TerminalClientMessage[] {
    return this.sockets.flatMap((socket) => socket.sent);
  }

  sentOfType<T extends TerminalClientMessage['type']>(
    type: T,
  ): Extract<TerminalClientMessage, { type: T }>[] {
    return this.sockets.flatMap((socket) => socket.sentOfType(type));
  }

  /** The shell of a terminal ended. */
  exit(terminalId: TerminalId, exitCode: number | null, reason: TerminalExitReason = 'exited'): void {
    this.items = this.items.map((item): TerminalInfo =>
      item.terminalId === terminalId ? { ...item, state: 'exited', exitCode } : item,
    );
    this.socket.serverSend({ type: 'exit', terminalId, exitCode, reason });
    this.pushList(this.socket);
  }

  /** A terminal started elsewhere (WP-105: "Continue in terminal") – the list goes to the latest socket. */
  add(terminal: TerminalInfo): void {
    this.items = [...this.items, terminal];
    this.pushList(this.socket);
  }

  /** Live output of an attached terminal on the latest socket. */
  emit(terminalId: TerminalId, text: string): void {
    const channel = this.channels.get(terminalId);
    if (channel === undefined) throw new Error(`terminal ${terminalId} is not attached`);
    this.output.set(terminalId, (this.output.get(terminalId) ?? '') + text);
    this.socket.serverBinary(channel, text);
  }

  private receive(socket: FakeTerminalSocket, message: TerminalClientMessage): void {
    if (!socket.isOpen) return;
    switch (message.type) {
      case 'hello':
        socket.serverSend({
          type: 'welcome',
          protocol: TERMINAL_PROTOCOL_VERSION,
          available: this.available,
          error: this.available ? null : this.unavailableError,
          limits: { perEntry: TERMINAL_LIMITS.perEntry, total: TERMINAL_LIMITS.total },
        });
        this.pushList(socket);
        break;
      case 'open': {
        if (this.failOpen !== null) {
          socket.serverSend({ type: 'error', requestId: message.requestId, error: this.failOpen });
          break;
        }
        const terminal = this.create(message.shell, message.cols, message.rows);
        socket.serverSend({ type: 'opened', requestId: message.requestId, terminal });
        this.pushList(socket);
        break;
      }
      case 'attach': {
        const channel = this.nextChannel++;
        this.channels.set(message.terminalId, channel);
        socket.serverSend({ type: 'attached', terminalId: message.terminalId, channel });
        const replay = this.output.get(message.terminalId);
        if (replay !== undefined && replay !== '') socket.serverBinary(channel, replay);
        break;
      }
      case 'close':
        this.items = this.items.filter((item) => item.terminalId !== message.terminalId);
        this.channels.delete(message.terminalId);
        this.pushList(socket);
        break;
      case 'detach':
        this.channels.delete(message.terminalId);
        break;
      case 'rename': {
        const title = message.title?.trim() ?? '';
        this.items = this.items.map((item): TerminalInfo =>
          item.terminalId === message.terminalId ? { ...item, title: title === '' ? null : title } : item,
        );
        this.pushList(socket);
        break;
      }
      case 'move': {
        const moving = this.items.find((item) => item.terminalId === message.terminalId);
        if (moving === undefined) break;
        const rest = this.items.filter((item) => item !== moving);
        rest.splice(Math.min(message.index, rest.length), 0, moving);
        this.items = rest;
        this.pushList(socket);
        break;
      }
      case 'input':
      case 'resize':
        break;
    }
  }

  private create(shell: ShellKind, cols: number, rows: number): TerminalInfo {
    const terminal = sampleTerminalInfo({
      terminalId: sampleTerminalId(this.nextTerminal++),
      shell,
      cols,
      rows,
    });
    this.items = [...this.items, terminal];
    return terminal;
  }

  private pushList(socket: FakeTerminalSocket): void {
    if (socket.isOpen) socket.serverSend({ type: 'terminals', items: this.items });
  }
}

/**
 * A terminal environment for tests and the playground: the given engine and socket factories, a
 * clipboard that copies successfully and reads `clipboardText` (null = refused), fonts always ready.
 */
export function fakeTerminalEnvironment(
  createEngine: EngineFactory,
  createSocket: TerminalSocketFactory,
  overrides: Partial<TerminalEnvironment> = {},
  clipboardText: string | null = 'echo pasted',
): TerminalEnvironment {
  return {
    createEngine,
    createSocket,
    socketUrl: (hostId) => (hostId === LOCAL_HOST_ID ? TERMINAL_SOCKET_URL : remoteTerminalSocketUrl(hostId)),
    copyText: async () => Promise.resolve(true),
    readClipboard: async () => Promise.resolve(clipboardText),
    fontReady: () => true,
    loadFont: async () => Promise.resolve(),
    ...overrides,
  };
}
