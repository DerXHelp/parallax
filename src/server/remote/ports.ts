/**
 * Port: remote access of a sharing computer (WP-76; normative: docs/wp/WP-76.md §B, WP-75 §4.2,
 * ADR-205 … 208, 225). Implemented in `src/server/remote/**` (WP-78); compose wires it (WP-82).
 * Frozen like src/shared.
 *
 * The listener is the only server part that listens on a non-loopback address (exception to R1-05,
 * ADR-205): HTTPS with the TLS profile of §B.3, mutual pins, only the REMOTE_PATHS of @shared/http.
 */
import type { RemoteAccessState, RemoteEvent, RemoteEventKind, RemotePeerRecord } from '@shared/model';
import type { HubSocket } from '../sync/hub';
import type { HostCommandHandler } from '../sync/ports';
import type { RoleSide } from '../multihost/ports';

/** Where a hub connection comes from. `remote` = through remote access (only REMOTE_ALLOWED_COMMANDS). */
export type ConnectionOrigin = 'local' | 'remote';

/** The remote end of a remote-access connection (for the connection log and presence). */
export interface RemoteConnectionInfo {
  /** IP address as the socket reports it (IPv4-mapped IPv6 normalized to IPv4). */
  address: string;
  port: number | null;
}

/**
 * The sync hub's side for remote connections (implemented by `sync/hub.ts`, WP-78). A remote socket
 * is a normal client with these differences: commands outside REMOTE_ALLOWED_COMMANDS →
 * REMOTE_NOT_ALLOWED; `clientHello.kind: 'relay'` is accepted only here (at most one; no
 * subscriptions, no commands); its presence carries `origin: 'remote'`.
 */
export interface RemoteHubAttach {
  handleRemoteConnection(socket: HubSocket, info: RemoteConnectionInfo): void;
  /** Open remote connections (windows + relay). */
  remoteConnections(): number;
  /** Closes every remote connection (unpair, key renewed, role left) with `code`. */
  closeRemote(code: number): void;
}

/** The sharing side of the role switch (`RoleSide.role === 'share'`). */
export interface RemoteAccessService extends RoleSide {
  readonly role: 'share';
  /** `HostState.remoteAccess` – null while the role is not `share`. */
  state(): RemoteAccessState | null;
  /** remoteAccess.* (REMOTE_ROLE_CONFLICT when the role is not `share`). */
  readonly commands: HostCommandHandler;
  /** State changed (listener, peer connected, new rejected attempt, pairing window) → HostState. */
  onChange(listener: () => void): () => void;
}

/** `<home>/remote/peer.json` – at most one coupled computer (§B.7 step 7, §B.8). */
export interface PeerStore {
  get(): RemotePeerRecord | null;
  /** Replaces the coupling (written before the pairing answer is sent). */
  set(peer: RemotePeerRecord): Promise<void>;
  clear(): Promise<void>;
  /** Last contact (debounced write). */
  touch(address: string, at: Date): void;
  flush(): Promise<void>;
}

/** One observation for the connection log; equal kinds from one address within a minute are merged. */
export interface RemoteEventInput {
  kind: RemoteEventKind;
  address: string;
  port: number | null;
  /** Unverified name from a pairing request, or the coupled computer's name. */
  claimedName?: string | null;
}

/** `<home>/remote/events.json` (ADR-225): ring buffer, LIMITS.remoteEventsMax / remoteEventsDays. */
export interface RemoteEventLog {
  record(event: RemoteEventInput, at?: Date): void;
  /** Newest first. */
  list(onlyRejected: boolean): RemoteEvent[];
  unseenRejected(): number;
  markSeen(at?: Date): void;
  flush(): Promise<void>;
}
