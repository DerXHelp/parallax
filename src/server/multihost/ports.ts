/**
 * Port: the role of this computer in "Several computers" (WP-76, docs/wp/WP-75.md §4.1, ADR-224).
 * `off` (default), `share` (remote access, WP-78) or `control` (host list and forwarder, WP-79) –
 * exclusive. The role service (`src/server/multihost/**`, WP-78) stores `multi-host.json`, handles
 * `multiHost.configure` and switches the two sides; compose wires it (WP-82). Frozen like src/shared.
 */
import type { MultiHostConfig, MultiHostRole } from '@shared/model';
import type { HostCommandHandler } from '../sync/ports';

/** One side of the feature: remote access (`share`) or the host list (`control`). */
export interface RoleSide {
  readonly role: Exclude<MultiHostRole, 'off'>;
  /** Couplings this side still has (share: 0 or 1; control: number of computers). */
  couplings(): number;
  /**
   * The role became active, the listener settings changed, or the server started with this role;
   * idempotent. Throws CommandError (REMOTE_KEYSTORE_UNAVAILABLE, REMOTE_ACCESS_FAILED).
   */
  activate(config: MultiHostConfig): Promise<void>;
  /** The role was left (other role, `off`) or the server stops: close everything, keep couplings; idempotent. */
  deactivate(): Promise<void>;
}

export interface MultiHostService {
  config(): MultiHostConfig;
  /** `multiHost.configure` (REMOTE_ROLE_CONFLICT for share ↔ control while the old side has couplings). */
  readonly commands: HostCommandHandler;
  /** Activates the stored role (server start; a failure is logged and shown, never fatal). */
  start(): Promise<void>;
  /** Deactivates the active side (shutdown step). */
  stop(): Promise<void>;
  /** Config or side state changed → HostState. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}
