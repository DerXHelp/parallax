/**
 * Port: embedded terminal (WP-99, ADR-239). Types only; frozen like src/shared.
 *
 * Who uses it:
 * - `terminal/service.ts` implements `TerminalService`.
 * - `terminal/socket.ts` (route `API_PATHS.terminalWs`) bridges one WebSocket to a `TerminalConnection`.
 * - The composition (`app/compose.ts`) builds the service with `conpty.ts` (SDK backend) or `fakePty.ts`
 *   (FakeBackend), closes an entry's terminals on archive/remove and all of them on shutdown.
 *
 * Protocol and limits: `src/shared/terminal.ts`.
 */
import type { EntryId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ConsoleSettings } from '@shared/model';
import type { TerminalClientMessage, TerminalInfo, TerminalServerMessage } from '@shared/terminal';

/** One shell in a pseudo console. Every method returns quickly; none throws after `spawn`. */
export interface PtyProcess {
  /** OS process id of the shell; null for the fake. */
  readonly pid: number | null;
  /** Output waiting, at most `max` bytes; null = nothing waiting (never blocks). */
  read(max: number): Uint8Array | null;
  /** Input as UTF-8 text (keys as VT sequences), never blocking; false = the console is gone or the input was dropped. */
  write(data: string): boolean;
  resize(cols: number, rows: number): boolean;
  /** Exit code once the shell ended, null while it runs – also after `close()` (the service's liveness check). */
  exitCode(): number | null;
  /** Ends the console (and the processes attached to it), frees everything. Idempotent. */
  close(): void;
}

export interface PtySpawnOptions {
  /** Absolute `.exe`. */
  executablePath: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  cols: number;
  rows: number;
}

export interface PtyFactory {
  /** Starts the shell; throws if it cannot (the service answers TERMINAL_START_FAILED). */
  spawn(options: PtySpawnOptions): PtyProcess;
}

/** What the service needs about an entry; null = unknown entry. */
export interface TerminalEntryInfo {
  /** Exactly as stored. */
  cwd: string;
  /** Archived entries get no new terminal (SESSION_ARCHIVED). */
  archived: boolean;
}

/** Dependencies of `createTerminalService` (the composition wires them). */
export interface TerminalServiceDeps {
  /** null = no pseudo console here (`node:ffi` missing, not Windows) → `available: false`. */
  pty: PtyFactory | null;
  /** Why `pty` is null (`TERMINAL_UNAVAILABLE.params.reason`). */
  unavailableReason?: string;
  entry(entryId: EntryId): TerminalEntryInfo | null;
  /** Current console settings (Git folder, default shell). */
  settings(): ConsoleSettings;
}

/** One socket as the service sees it (no `ws` types). */
export interface TerminalSink {
  send(message: TerminalServerMessage): void;
  /** A binary output frame (`encodeTerminalFrame`). */
  sendFrame(frame: Uint8Array): void;
  /** Bytes queued on the socket and not yet sent (`ws.bufferedAmount`). */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
}

/** One socket bound to one entry (after `hello`). */
export interface TerminalConnection {
  /** Every client message after `hello` (already validated). */
  handle(message: Exclude<TerminalClientMessage, { type: 'hello' }>): void;
  /** The socket closed: detach everything (the shells keep running). */
  disconnect(): void;
}

export type TerminalEndReason = 'archived' | 'removed';

export interface TerminalService {
  /** True when shells can start here (`HostState.terminalAvailable`). */
  readonly available: boolean;
  /** Binds a socket to an entry and sends `welcome` + `terminals`; an error for an unknown entry. */
  connect(entryId: EntryId, sink: TerminalSink): TerminalConnection | ErrorPayload;
  /** The entry's terminals (oldest first). */
  list(entryId: EntryId): TerminalInfo[];
  /** Ends every terminal of the entry (`exit` with the reason) and forgets them. */
  closeEntry(entryId: EntryId, reason: TerminalEndReason): void;
  /** Ends every terminal (`exit` reason `shutdown`); resolves once all consoles are closed. */
  closeAll(): Promise<void>;
}
