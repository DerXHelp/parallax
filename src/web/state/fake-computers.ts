import type { HostId } from '@shared/common';
import type { HostState, RemoteHost, RemoteHostStatus, SessionSummary } from '@shared/model';
import { WS_CLOSE, type SessionSnapshot } from '@shared/protocol';
import { sampleHostState } from '@shared/samples';
import { FakeHost } from './fake-host';
import { startRemoteHosts, type RemoteConnectionOptions } from './remote-hosts';
import { clientStore, type ClientStore } from './store';
import { createMemoryTransport } from './transport';

/**
 * Other computers for tests and the playground (WP-80): one FakeHost per computer behind its own
 * MemoryTransport – what the forwarder `hostWsPath(hostId)` of the real server would pass through.
 * `startFakeComputers` puts the list into the local FakeHost (`HostState.remoteHosts`, role
 * "control") and starts the window connections (`startRemoteHosts`, the same code path as the app).
 * Levers like the forwarder and its watcher: `setReachable` (close 4502), `makeIncompatible`
 * (4410), `revoke` (4403) – each also updates the list entry on this computer.
 */

export interface FakeComputerSpec {
  /** The list entry on this computer (`sampleRemoteHost({...})`). */
  remote: RemoteHost;
  summaries?: readonly SessionSummary[];
  sessions?: readonly SessionSnapshot[];
  hostState?: HostState;
}

export interface FakeComputers {
  /** The FakeHost of a computer (created on demand, e.g. after `hosts.add`). */
  get(hostId: HostId): FakeHost;
  setReachable(hostId: HostId, reachable: boolean): void;
  makeIncompatible(hostId: HostId, version?: string): void;
  revoke(hostId: HostId): void;
  stop(): void;
}

export interface FakeComputersOptions {
  store?: ClientStore;
  connectionOptions?: RemoteConnectionOptions;
}

export function startFakeComputers(
  local: FakeHost,
  specs: readonly FakeComputerSpec[],
  options: FakeComputersOptions = {},
): FakeComputers {
  const store = options.store ?? clientStore;
  const computers = new Map<HostId, FakeHost>();
  const specOf = new Map(specs.map((spec) => [spec.remote.hostId, spec]));

  const get = (hostId: HostId): FakeHost => {
    const known = computers.get(hostId);
    if (known !== undefined) return known;
    const spec = specOf.get(hostId);
    const host = new FakeHost({
      transport: createMemoryTransport(),
      hostState: spec?.hostState ?? sampleHostState(),
      summaries: spec?.summaries ?? [],
      sessions: spec?.sessions ?? [],
      replyToPrompts: true,
    });
    computers.set(hostId, host);
    return host;
  };

  const setStatus = (hostId: HostId, status: RemoteHostStatus, patch: Partial<RemoteHost> = {}) => {
    local.setHostState({
      ...local.hostState,
      remoteHosts: local.hostState.remoteHosts.map((host) =>
        host.hostId === hostId ? { ...host, ...patch, status } : host,
      ),
    });
  };

  const drop = (hostId: HostId, code: number) => {
    const host = get(hostId);
    host.online = false;
    host.offlineCloseCode = code;
    host.restart({ code });
  };

  // A successful pairing (also "pair again" with `replaceHostId`) makes that computer reachable again.
  if (local.multiHost !== false) {
    local.multiHost = {
      ...local.multiHost,
      onPaired: (hostId) => {
        get(hostId).online = true;
      },
    };
  }
  local.setHostState({
    ...local.hostState,
    multiHost: { ...local.hostState.multiHost, role: 'control' },
    remoteHosts: specs.map((spec) => spec.remote),
  });
  const stopRemote = startRemoteHosts({
    store,
    createTransport: (hostId) => get(hostId).transport,
    ...(options.connectionOptions === undefined ? {} : { connectionOptions: options.connectionOptions }),
  });

  return {
    get,
    setReachable(hostId, reachable) {
      if (!reachable) {
        drop(hostId, WS_CLOSE.HOST_UNREACHABLE);
        setStatus(hostId, 'unreachable');
        return;
      }
      get(hostId).online = true;
      setStatus(hostId, 'connected', { lastError: null });
    },
    makeIncompatible(hostId, version = '9.9.9') {
      drop(hostId, WS_CLOSE.HOST_INCOMPATIBLE);
      setStatus(hostId, 'incompatible', { appVersion: version });
    },
    revoke(hostId) {
      drop(hostId, WS_CLOSE.HOST_REVOKED);
      setStatus(hostId, 'revoked');
    },
    stop() {
      stopRemote();
      for (const host of computers.values()) host.dispose();
      computers.clear();
    },
  };
}
