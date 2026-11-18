/**
 * Port: the host list and forwarder of a controlling computer (WP-76; normative: docs/wp/WP-76.md §B,
 * WP-75 §4.3, ADR-206 … 209). Implemented in `src/server/hosts/**` (WP-79); the forwarding routes
 * `HOST_API_PATHS` live in `src/server/http/**` (WP-79); compose wires it (WP-82). Frozen like
 * src/shared.
 *
 * The browser never talks to another computer: every window connection and every content request
 * for another computer goes to this server's own origin (cookie, Origin, Host checks as for local
 * routes) and is passed on over a pinned mTLS connection (§B.6). Response headers are this
 * server's own, never the other computer's.
 */
import type { Readable } from 'node:stream';
import type { WebSocket } from 'ws';
import type { EntryId, HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteHost } from '@shared/model';
import type { Notification } from '@shared/protocol';
import type { RoleSide } from '../multihost/ports';
import type { HostCommandHandler } from '../sync/ports';

/** Thrown by the forwarder; `error.code` ∈ HOST_NOT_FOUND, HOST_UNREACHABLE, HOST_INCOMPATIBLE, HOST_REVOKED. */
export class HostForwarderError extends Error {
  readonly error: ErrorPayload;

  constructor(error: ErrorPayload) {
    super(error.message ?? error.code);
    this.name = 'HostForwarderError';
    this.error = error;
  }
}

/** A request to a REMOTE_PATHS route of another computer (version headers are added by the forwarder). */
export interface UpstreamRequest {
  method: 'GET' | 'HEAD' | 'POST';
  /** A REMOTE_PATHS path with its parameters filled in (e.g. `/remote/v1/blob/<blobId>`). */
  path: string;
  /** Raw query string without `?` ('' = none). */
  query: string;
  /** Only `content-type` and `content-length` are passed on. */
  headers: { 'content-type'?: string; 'content-length'?: string };
  body?: Readable | Buffer;
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  /** Lower-case header names as received; the HTTP layer picks the few it reproduces itself. */
  headers: Readonly<Record<string, string | undefined>>;
  body: Readable;
}

export interface HostForwarder {
  /**
   * Opens `wss://…/remote/v1/ws` to the computer for one browser window (open, version-checked);
   * the HTTP layer pipes frames 1:1 with LIMITS.wsMaxPayloadBytes. Throws HostForwarderError.
   */
  connectWindow(hostId: HostId, signal?: AbortSignal): Promise<WebSocket>;
  /** Throws HostForwarderError; an upstream 4xx/5xx is a normal response. */
  request(hostId: HostId, request: UpstreamRequest): Promise<UpstreamResponse>;
  /** Closes the open window connections of one computer (or all) with a WS_CLOSE code. */
  closeWindows(hostId: HostId | null, code: number): void;
}

/** What the relay (watcher) of a computer delivers (WP-81 shows it as a native toast here). */
export interface RelayEvents {
  notify(hostId: HostId, notification: Notification): void;
  clear(hostId: HostId, entryId: EntryId): void;
}

/** The controlling side of the role switch (`RoleSide.role === 'control'`). */
export interface HostsService extends RoleSide {
  readonly role: 'control';
  /** `HostState.remoteHosts` – [] while the role is not `control`. */
  list(): RemoteHost[];
  /** hosts.* (REMOTE_ROLE_CONFLICT when the role is not `control`). */
  readonly commands: HostCommandHandler;
  readonly forwarder: HostForwarder;
  /** Status, version or list changed → HostState. */
  onChange(listener: () => void): () => void;
  /** Relay events of all computers (WP-81); returns the unsubscribe function. */
  onRelay(listener: RelayEvents): () => void;
}
