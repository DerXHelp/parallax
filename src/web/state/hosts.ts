import { useStore } from 'zustand';
import { LOCAL_HOST_ID, parseSessionKey, type HostId } from '@shared/common';
import type { MultiHostRole, RemoteAccessState, RemoteHost } from '@shared/model';
import type { Command, CommandResult } from '@shared/protocol';
import { getConnection } from './connection';
import { selectRemoteHosts } from './remote-hosts';
import { clientStore, type ClientState } from './store';

/**
 * Several computers in the client (WP-80, WP-75 §4.4): the computers this one controls
 * (`HostState.remoteHosts` of the local host, in display order), whether a computer can take
 * commands now, and host commands addressed to one computer (folder browser and profiles of "New
 * session" come from the chosen computer). Display settings always come from this computer
 * (settings.ts, hook-display.ts, transcript-view.ts); profiles and models from the session's one.
 */

export { selectRemoteHosts };

/** Computers this one controls, in display order (sidebar groups after this computer). */
export function useRemoteHosts(): readonly RemoteHost[] {
  return useStore(clientStore, selectRemoteHosts);
}

/** At least one other computer is part of this window (badge and "Group by computer" only then). */
export function useHasRemoteHosts(): boolean {
  return useStore(clientStore, (state) => selectRemoteHosts(state).length > 0);
}

export function selectRemoteHost(state: ClientState, hostId: HostId): RemoteHost | null {
  if (hostId === LOCAL_HOST_ID) return null;
  return selectRemoteHosts(state).find((host) => host.hostId === hostId) ?? null;
}

/** The list entry of another computer; null for this computer and unknown ids. */
export function useRemoteHost(hostId: HostId | null | undefined): RemoteHost | null {
  return useStore(clientStore, (state) =>
    hostId === null || hostId === undefined ? null : selectRemoteHost(state, hostId),
  );
}

/** Role of this computer under "Several computers" (`off` before the first `host.state`). */
export function useMultiHostRole(): MultiHostRole {
  return useStore(clientStore, (state) => state.hosts[LOCAL_HOST_ID]?.hostState?.multiHost.role ?? 'off');
}

/** `HostState.remoteAccess` of this computer (role "Share"); null otherwise. */
export function useRemoteAccess(): RemoteAccessState | null {
  return useStore(clientStore, (state) => state.hosts[LOCAL_HOST_ID]?.hostState?.remoteAccess ?? null);
}

/**
 * Whether the sessions of a computer can be used now (WP-75 §4.4 "Status"): this computer is
 * always `available` (its own banners cover a lost connection); another one is `available` while
 * its window connection is open, else what the connection or the server's list says.
 */
export type HostAvailability = 'available' | 'connecting' | 'unreachable' | 'incompatible' | 'revoked';

export function selectHostAvailability(state: ClientState, hostId: HostId): HostAvailability {
  if (hostId === LOCAL_HOST_ID) return 'available';
  const record = state.hosts[hostId];
  if (record?.phase === 'open') return 'available';
  const status = selectRemoteHost(state, hostId)?.status ?? null;
  if (record?.phase === 'revoked' || status === 'revoked') return 'revoked';
  if (record?.phase === 'incompatible' || status === 'incompatible') return 'incompatible';
  if (record?.error?.code === 'HOST_UNREACHABLE' || status === 'unreachable') return 'unreachable';
  return 'connecting';
}

export function useHostAvailability(hostId: HostId | null | undefined): HostAvailability {
  return useStore(clientStore, (state) =>
    hostId === null || hostId === undefined ? 'available' : selectHostAvailability(state, hostId),
  );
}

/** Host id of a session key (null for an invalid key). */
export function hostIdOf(sessionKey: string | null): HostId | null {
  if (sessionKey === null) return null;
  return parseSessionKey(sessionKey)?.hostId ?? null;
}

/**
 * A host command to one computer (`fs.listDirectory`, `session.create` … of "New session" on the
 * chosen computer). `link.open` and the commands of this computer's settings go to `local` (use
 * `sendCommand(null, …)`). Rejects with `ClientCommandError`.
 */
export function sendHostCommand<C extends Command>(
  hostId: HostId,
  cmd: C,
): Promise<CommandResult<C['name']>> {
  return getConnection(commandHost(hostId, cmd)).send(cmd);
}

/** ADR-208: `link.open` always goes to this computer – a link never opens on the other one. */
export function commandHost(hostId: HostId, cmd: Command): HostId {
  return cmd.name === 'link.open' ? LOCAL_HOST_ID : hostId;
}
