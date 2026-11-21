import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { DEFAULT_CONSOLE_SETTINGS, type ShellKind } from '@shared/model';
import {
  TERMINAL_LIMITS,
  type TerminalId,
  type TerminalInfo,
  type TerminalServerMessage,
} from '@shared/terminal';
import { DEFAULT_TERMINAL_SIZE, type TerminalSize } from '../lib/size';
import {
  TerminalConnection,
  type TerminalConnectionStatus,
  type TerminalSocketFactory,
  type TerminalViewSink,
} from './socket';
import { assignNumbers, pickActive, resetConnection, terminalStore, type TerminalStore } from './terminals';

/**
 * One mounted terminal panel (WP-99b): runs a `TerminalConnection` while started and writes what the
 * server says into the session's store. Created per mount (`useMemo` in TerminalPanel); `start` and
 * `stop` may alternate (React StrictMode), each `start` opens a new socket.
 *
 * - The first `terminals` list after a start that is empty (and the terminal available) opens one
 *   terminal with the default shell – once per start: after the user closed all terminals the panel
 *   shows the empty state instead.
 * - `open` → the new terminal becomes active (and takes the focus) when `opened` names our request.
 * - Restart = `close`, then `open` with the same shell.
 * - Views register with `attachView`; the registration survives a stop/start (a new connection
 *   attaches them again).
 */

export interface TerminalControllerOptions {
  sessionKey: string;
  entryId: EntryId;
  url: string;
  createSocket?: TerminalSocketFactory;
}

let controllers = 0;

export class TerminalController {
  /** Owner mark of the store while this controller runs (`TerminalSessionState.owner`). */
  readonly id = ++controllers;
  readonly store: TerminalStore;
  private connection: TerminalConnection | null = null;
  private readonly cleanups: (() => void)[] = [];
  private readonly views = new Map<TerminalId, TerminalViewSink>();
  private readonly detachers = new Map<TerminalId, () => void>();
  private defaultShell: ShellKind = DEFAULT_CONSOLE_SETTINGS.defaultShell;
  private autoOpenChecked = false;
  private sequence = 0;
  private lastSize: TerminalSize = DEFAULT_TERMINAL_SIZE;

  constructor(private readonly options: TerminalControllerOptions) {
    this.store = terminalStore(options.sessionKey);
  }

  /** The session whose terminals this controller runs (WP-104: its host decides the pty kind). */
  get sessionKey(): string {
    return this.options.sessionKey;
  }

  /** The shell of the automatic first terminal (settings `console.defaultShell`). */
  setDefaultShell(shell: ShellKind): void {
    this.defaultShell = shell;
  }

  start(): void {
    if (this.connection !== null) return;
    resetConnection(this.store, this.id);
    this.autoOpenChecked = false;
    const connection = new TerminalConnection({
      entryId: this.options.entryId,
      url: this.options.url,
      createSocket: this.options.createSocket,
    });
    this.connection = connection;
    this.cleanups.push(
      connection.onMessage((message) => {
        this.handle(message);
      }),
      connection.onStatus((status) => {
        this.handleStatus(status, connection.closeCode);
      }),
    );
    for (const [terminalId, sink] of this.views) {
      this.detachers.set(terminalId, connection.attachView(terminalId, sink));
    }
    connection.start();
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    // `detach` for every view while the socket is still open (the views stay registered).
    for (const detach of this.detachers.values()) detach();
    this.detachers.clear();
    this.connection?.dispose();
    this.connection = null;
  }

  /** Starts a shell in the entry's folder; false when it cannot go out (limit, not available, offline). */
  open(shell: ShellKind, replacing = 0): boolean {
    const state = this.store.getState();
    const connection = this.connection;
    if (connection === null || !connection.isReady || state.available !== true) return false;
    if (state.items.length - replacing + state.pending.length >= state.limits.perEntry) return false;
    const requestId = `open-${String(++this.sequence)}`;
    const sent = connection.send({ type: 'open', requestId, shell, ...this.lastSize });
    if (!sent) return false;
    this.store.setState({ pending: [...state.pending, { requestId, shell }], error: null });
    return true;
  }

  /** Ends the shell (if running) and removes the terminal. */
  close(terminalId: TerminalId): void {
    this.connection?.send({ type: 'close', terminalId });
  }

  /** Close, then open the same shell (the new terminal becomes active). */
  restart(terminalId: TerminalId): void {
    const item = this.store.getState().items.find((candidate) => candidate.terminalId === terminalId);
    if (item === undefined || this.connection?.isReady !== true) return;
    this.close(terminalId);
    this.open(item.shell, 1);
  }

  /**
   * Names a terminal (empty = the default name again). Shown at once; the server trims the name and
   * pushes the list to every window.
   */
  rename(terminalId: TerminalId, title: string): void {
    const trimmed = title.trim().slice(0, TERMINAL_LIMITS.titleMaxChars);
    const next = trimmed === '' ? null : trimmed;
    const state = this.store.getState();
    const item = state.items.find((candidate) => candidate.terminalId === terminalId);
    if (item === undefined || item.title === next || this.connection?.isReady !== true) return;
    if (!this.connection.send({ type: 'rename', terminalId, title: next })) return;
    this.store.setState({
      items: state.items.map((candidate): TerminalInfo =>
        candidate.terminalId === terminalId ? { ...candidate, title: next } : candidate,
      ),
    });
  }

  /** Moves a terminal to position `index` of the tabs (shown at once; the server's list follows). */
  move(terminalId: TerminalId, index: number): void {
    const state = this.store.getState();
    const from = state.items.findIndex((candidate) => candidate.terminalId === terminalId);
    const moving = state.items[from];
    if (moving === undefined || this.connection?.isReady !== true) return;
    const to = Math.max(0, Math.min(Math.trunc(index), state.items.length - 1));
    if (from === to) return;
    if (!this.connection.send({ type: 'move', terminalId, index: to })) return;
    const items = state.items.filter((candidate) => candidate.terminalId !== terminalId);
    items.splice(to, 0, moving);
    this.store.setState({ items });
  }

  /** Shows another terminal (the focus stays where it is – arrow keys in the tab strip). */
  select(terminalId: TerminalId): void {
    const state = this.store.getState();
    if (!state.items.some((item) => item.terminalId === terminalId)) return;
    this.store.setState({ activeId: terminalId });
  }

  /** Moves the focus into the active terminal (a click on its tab). */
  focusActive(): void {
    this.store.setState((state) => ({ focusToken: state.focusToken + 1 }));
  }

  dismissError(): void {
    this.store.setState({ error: null });
  }

  /** Keys and pastes of a running terminal. */
  input(terminalId: TerminalId, data: string): void {
    this.connection?.input(terminalId, data);
  }

  /** A view's new size (also the size of the next `open`). */
  resize(terminalId: TerminalId, size: TerminalSize): void {
    this.lastSize = size;
    this.connection?.resize(terminalId, size);
  }

  /** The size a view measured (used for the next `open`). */
  noteSize(size: TerminalSize): void {
    this.lastSize = size;
  }

  /** See `TerminalConnection.attachView`; also attached to every later connection. */
  attachView(terminalId: TerminalId, sink: TerminalViewSink): () => void {
    this.detachers.get(terminalId)?.();
    this.views.set(terminalId, sink);
    if (this.connection !== null)
      this.detachers.set(terminalId, this.connection.attachView(terminalId, sink));
    return () => {
      if (this.views.get(terminalId) !== sink) return;
      this.views.delete(terminalId);
      this.detachers.get(terminalId)?.();
      this.detachers.delete(terminalId);
    };
  }

  private handleStatus(status: TerminalConnectionStatus, closeCode: number | null): void {
    if (status === 'failed') {
      this.store.setState({ connection: status, failure: closeCode, pending: [] });
    } else if (status === 'reconnecting') {
      this.store.setState({ connection: status, pending: [] });
    } else {
      this.store.setState({ connection: status });
    }
  }

  private handle(message: TerminalServerMessage): void {
    const state = this.store.getState();
    switch (message.type) {
      case 'welcome':
        this.store.setState({
          available: message.available,
          unavailable: message.available
            ? null
            : (message.error ?? makeError('TERMINAL_UNAVAILABLE', { reason: 'unknown' })),
          limits: message.limits,
        });
        break;
      case 'terminals': {
        const ids = new Set(message.items.map((item) => item.terminalId));
        const exitReasons = Object.fromEntries(
          Object.entries(state.exitReasons).filter(([terminalId]) => ids.has(terminalId)),
        );
        this.store.setState({
          items: message.items,
          activeId: pickActive(state.items, message.items, state.activeId),
          loaded: true,
          exitReasons,
          numbers: assignNumbers(state.numbers, message.items),
        });
        if (!this.autoOpenChecked) {
          this.autoOpenChecked = true;
          if (state.available === true && message.items.length === 0 && state.pending.length === 0) {
            this.open(this.defaultShell);
          }
        }
        break;
      }
      case 'opened': {
        const pending = state.pending.filter((request) => request.requestId !== message.requestId);
        const ours = pending.length !== state.pending.length;
        const known = state.items.some((item) => item.terminalId === message.terminal.terminalId);
        const items: readonly TerminalInfo[] = known ? state.items : [...state.items, message.terminal];
        const numbers = assignNumbers(state.numbers, items);
        this.store.setState(
          ours
            ? {
                pending,
                items,
                numbers,
                activeId: message.terminal.terminalId,
                focusToken: state.focusToken + 1,
              }
            : { pending, items, numbers },
        );
        break;
      }
      case 'exit':
        this.store.setState({
          items: state.items.map((item): TerminalInfo =>
            item.terminalId === message.terminalId
              ? { ...item, state: 'exited', exitCode: message.exitCode }
              : item,
          ),
          exitReasons: { ...state.exitReasons, [message.terminalId]: message.reason },
        });
        break;
      case 'error':
        this.store.setState({
          pending:
            message.requestId === undefined
              ? state.pending
              : state.pending.filter((request) => request.requestId !== message.requestId),
          error: message.error,
        });
        break;
      case 'attached':
        break;
    }
  }
}
