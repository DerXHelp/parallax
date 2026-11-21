/**
 * Test helpers for the controlling side (tests only): a real sharing computer (remote/testKit with a
 * real sync hub and memory source) and a hosts service with the memory key store. Everything on
 * 127.0.0.1 with port 0 and a temp home – never 0.0.0.0, never DPAPI.
 */
import type { Logger } from 'pino';
import type { ClientId, EntryId, HostId } from '@shared/common';
import type { RemoteHost, RemoteHostStatus } from '@shared/model';
import type { Notification } from '@shared/protocol';
import { makeTempHome } from '../http/testServer';
import type { RegisterRemoteContent } from '../remote/peerHttp';
import type { RemoteHubAttach } from '../remote/ports';
import { startHarness, testInstance, type Harness } from '../remote/testKit';
import { createMemoryKeyStore, type MemoryKeyStore } from '../secure/memoryKeyStore';
import { TEST_HOST } from '../secure/testKit';
import { createSyncHub, type SyncHub } from '../sync/hub';
import { createMemorySessionSource, type MemorySessionSource } from '../sync/memorySource';
import { CommandError } from '../sync/ports';
import type { TerminalService } from '../terminal/ports';
import { createHostsService, type Hosts, type HostsServiceOptions } from './service';

export { TEST_HOST };

/** Fast retries for tests. */
export const TEST_TIMING: NonNullable<HostsServiceOptions['timing']> = {
  backoffMs: [100, 200, 400, 800],
  revokeConfirmMs: 100,
  stableMs: 1_000,
  healthTimeoutMs: 3_000,
  unpairTimeoutMs: 2_000,
  requestIdleMs: 5_000,
};

export interface SharingSide {
  harness: Harness;
  hub: SyncHub;
  source: MemorySessionSource;
  version: string;
  port(): number;
  /** Opens a pairing window and returns its code. */
  code(): Promise<string>;
  /** Client id of the relay that is connected now (from the hub's presence), or null. */
  relayClientId(): ClientId | null;
  close(): Promise<void>;
}

/** A sharing computer with a real hub (frames and the relay are the real protocol). */
export async function startSharing(
  options: {
    version?: string;
    home?: string;
    registerContent?: RegisterRemoteContent;
    /** Puts something between the listener and the real hub (tests of odd sharing sides). */
    wrapHub?: (hub: SyncHub) => RemoteHubAttach;
    /** WP-107: the embedded terminal the coupled computer may use (E3). */
    terminal?: TerminalService;
    /** WP-107: the remote-access service's logger (log spies). */
    logger?: Logger;
  } = {},
): Promise<SharingSide> {
  const instance = {
    ...testInstance(),
    ...(options.version === undefined ? {} : { serverVersion: options.version }),
  };
  const source = createMemorySessionSource();
  const hub = createSyncHub({ source, instance, timing: { heartbeatMs: 0 } });
  const harness = await startHarness({
    instance,
    hub: options.wrapHub === undefined ? hub : options.wrapHub(hub),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.registerContent === undefined ? {} : { registerContent: options.registerContent }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return {
    harness,
    hub,
    source,
    version: instance.serverVersion,
    port: () => harness.port(),
    async code() {
      const opened = (await harness.command({ name: 'remoteAccess.pair' })) as { code: string };
      return opened.code;
    },
    relayClientId() {
      const latest = source.presenceUpdates.at(-1) ?? [];
      return latest.find((client) => client.kind === 'relay')?.clientId ?? null;
    },
    async close() {
      await harness.close();
      hub.dispose();
    },
  };
}

export interface Relayed {
  notify: { hostId: HostId; notification: Notification }[];
  clear: { hostId: HostId; entryId: EntryId }[];
}

export interface ControlSide {
  service: Hosts;
  keyStore: MemoryKeyStore;
  home: string;
  version: string;
  relayed: Relayed;
  /** Pairs with `sharing` (active role required) and returns the new host id. */
  add(sharing: SharingSide, displayName?: string): Promise<HostId>;
  /** Resolves when the computer reaches `status` (polling HostState). */
  waitFor(hostId: HostId, status: RemoteHostStatus, timeoutMs?: number): Promise<RemoteHost>;
  close(): Promise<void>;
}

export async function startControl(
  options: Partial<Omit<HostsServiceOptions, 'keyStore'>> & {
    keyStore?: MemoryKeyStore;
    version?: string;
    activate?: boolean;
  } = {},
): Promise<ControlSide> {
  const { keyStore: givenKeyStore, version: givenVersion, activate, ...serviceOptions } = options;
  const home = options.home ?? (await makeTempHome('wp79-hosts-'));
  const keyStore = givenKeyStore ?? createMemoryKeyStore();
  const version = givenVersion ?? testInstance().serverVersion;
  const relayed: Relayed = { notify: [], clear: [] };
  const service = createHostsService({
    home,
    instance: { serverVersion: version, buildId: 'test' },
    currentRole: () => 'control',
    deviceName: () => 'PC-A',
    timing: TEST_TIMING,
    agentOptions: { connectTimeoutMs: 3_000, proofTimeoutMs: 3_000 },
    ...serviceOptions,
    keyStore,
  });
  service.onRelay({
    notify: (hostId, notification) => relayed.notify.push({ hostId, notification }),
    clear: (hostId, entryId) => relayed.clear.push({ hostId, entryId }),
  });
  await service.prepare();
  if (activate !== false) await service.activate({ role: 'control', port: 4713, bindAddress: '0.0.0.0' });
  const waitFor = async (
    hostId: HostId,
    status: RemoteHostStatus,
    timeoutMs = 8_000,
  ): Promise<RemoteHost> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const host = service.list().find((entry) => entry.hostId === hostId);
      if (host?.status === status) return host;
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for ${status} (now ${host?.status ?? 'missing'}: ${JSON.stringify(host?.lastError)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    service,
    keyStore,
    home,
    version,
    relayed,
    async add(sharing, displayName = 'PC B') {
      const code = await sharing.code();
      const result = (await service.commands.handle(
        { name: 'hosts.add', address: TEST_HOST, port: sharing.port(), code, displayName },
        { clientId: 'cl_00000000000000000000000000000002', cmdId: '00000000-0000-4000-8000-000000000001' },
      )) as { hostId: HostId };
      return result.hostId;
    },
    waitFor,
    close: () => service.close(),
  };
}

/** Runs a host command of `control` (context of a local window). */
export function hostCommand(
  control: ControlSide,
  cmd: Parameters<Hosts['commands']['handle']>[0],
): Promise<unknown> {
  return control.service.commands.handle(cmd, {
    clientId: 'cl_00000000000000000000000000000002',
    cmdId: '00000000-0000-4000-8000-000000000002',
  });
}

/** The CommandError a promise rejects with (fails the test otherwise). */
export async function rejection(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}
