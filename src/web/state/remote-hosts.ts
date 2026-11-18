import { LOCAL_HOST_ID, parseSessionKey, type HostId } from '@shared/common';
import type { RemoteHost, RemoteHostStatus } from '@shared/model';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type HostConnectionOptions,
  type ManagedHostConnection,
} from './connection';
import { setSelectedSession } from './selection';
import { clientStore, type ClientState, type ClientStore } from './store';
import type { Transport } from './transport';

/**
 * Window connections to the other computers (WP-80, WP-75 §4.4, ADR-205): the local connection
 * comes first (bootstrap.ts); its `HostState.remoteHosts` lists the computers this one controls.
 * For every entry one `ManagedHostConnection` with `remote: true` – the app's transport is the
 * forwarder `hostWsPath(hostId)` of this server, never another origin. Computers are added and
 * removed at runtime: a removed one is stopped and its records (host, sessions, notifications,
 * selection) leave the store. When the server reports a computer as `connected` again, a waiting,
 * incompatible or revoked window connection tries at once (`retryNow`) – no loop of its own.
 */

export type RemoteConnectionOptions = Partial<
  Omit<HostConnectionOptions, 'hostId' | 'createTransport' | 'store' | 'remote' | 'homeHost' | 'checkAuth'>
>;

export interface RemoteHostsOptions {
  store?: ClientStore;
  /** Transport of one computer's window connection (app: a WebSocket on `hostWsPath(hostId)`). */
  createTransport: (hostId: HostId) => Transport;
  /** Further options of every connection (tests: backoff, random, frames, client id). */
  connectionOptions?: RemoteConnectionOptions;
}

const NO_REMOTE_HOSTS: readonly RemoteHost[] = Object.freeze([]);

/** `HostState.remoteHosts` of this computer ([] before its `host.state` and for the other roles). */
export function selectRemoteHosts(state: ClientState): readonly RemoteHost[] {
  return state.hosts[LOCAL_HOST_ID]?.hostState?.remoteHosts ?? NO_REMOTE_HOSTS;
}

interface ActiveHost {
  connection: ManagedHostConnection;
  status: RemoteHostStatus;
}

/** Drops everything the store holds about one computer (after its connection was stopped). */
export function forgetHost(store: ClientStore, hostId: HostId): void {
  if (hostId === LOCAL_HOST_ID) return;
  const ofHost = (sessionKey: string) => parseSessionKey(sessionKey)?.hostId === hostId;
  const selected = store.getState().selectedSession;
  if (selected !== null && ofHost(selected)) setSelectedSession(null, { store });
  store.setState((state) => {
    const hosts = { ...state.hosts };
    Reflect.deleteProperty(hosts, hostId);
    const sessions = { ...state.sessions };
    for (const key of Object.keys(sessions)) if (ofHost(key)) Reflect.deleteProperty(sessions, key);
    return {
      hosts,
      sessions,
      notifications: state.notifications.filter((notification) => notification.hostId !== hostId),
    };
  });
}

/** Starts following `HostState.remoteHosts`; returns the stop function (stops every remote connection). */
export function startRemoteHosts(options: RemoteHostsOptions): () => void {
  const store = options.store ?? clientStore;
  const active = new Map<HostId, ActiveHost>();
  let stopped = false;

  const add = (host: RemoteHost) => {
    const connection = createHostConnection({
      ...options.connectionOptions,
      hostId: host.hostId,
      store,
      remote: true,
      createTransport: () => options.createTransport(host.hostId),
    });
    active.set(host.hostId, { connection, status: host.status });
    registerConnection(connection);
    connection.start();
  };

  const remove = (hostId: HostId) => {
    active.delete(hostId);
    unregisterConnection(hostId);
    forgetHost(store, hostId);
  };

  let seen: readonly RemoteHost[] | null = null;
  const sync = (state: ClientState) => {
    const hosts = selectRemoteHosts(state);
    if (stopped || hosts === seen) return;
    seen = hosts;
    const wanted = new Set(hosts.map((host) => host.hostId));
    for (const hostId of [...active.keys()]) if (!wanted.has(hostId)) remove(hostId);
    for (const host of hosts) {
      const current = active.get(host.hostId);
      if (current === undefined) {
        add(host);
        continue;
      }
      if (current.status === host.status) continue;
      current.status = host.status;
      // The server reaches the computer again (watcher): the window tries now, not after its backoff.
      if (host.status === 'connected' && current.connection.status() !== 'open')
        current.connection.retryNow();
    }
  };

  sync(store.getState());
  const unsubscribe = store.subscribe((state) => {
    sync(state);
  });
  return () => {
    stopped = true;
    unsubscribe();
    for (const hostId of [...active.keys()]) unregisterConnection(hostId);
    active.clear();
  };
}
