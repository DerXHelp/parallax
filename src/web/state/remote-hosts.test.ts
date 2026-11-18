import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey, type HostId } from '@shared/common';
import { WS_CLOSE } from '@shared/protocol';
import {
  SAMPLE_IDS,
  SAMPLE_REMOTE_HOST_ID,
  sampleHello,
  sampleHostState,
  sampleRemoteHost,
  sampleSummary,
} from '@shared/samples';
import { getConnection, listConnections } from './connection';
import { sendCommand } from './hooks';
import { selectHostAvailability, sendHostCommand } from './hosts';
import { startRemoteHosts } from './remote-hosts';
import { createClientStore, updateHost, type ClientStore } from './store';
import { createMemoryTransport, type MemoryTransport } from './transport';

/**
 * WP-80: one window connection per computer of `HostState.remoteHosts` – added and removed at
 * runtime, commands addressed to the session's computer, `link.open` always local.
 */

const B = SAMPLE_REMOTE_HOST_ID;
const C = 'computer-c';

function setRemoteHosts(store: ClientStore, hosts: ReturnType<typeof sampleRemoteHost>[]): void {
  updateHost(store, LOCAL_HOST_ID, (host) => ({
    hostState: { ...(host.hostState ?? sampleHostState()), remoteHosts: hosts },
  }));
}

function setup() {
  const store = createClientStore();
  const transports = new Map<HostId, MemoryTransport[]>();
  const stop = startRemoteHosts({
    store,
    createTransport: (hostId) => {
      const transport = createMemoryTransport();
      transports.set(hostId, [...(transports.get(hostId) ?? []), transport]);
      return transport;
    },
    connectionOptions: {
      random: () => 0.5,
      clientId: SAMPLE_IDS.client,
      scheduleFrame: (callback) => {
        callback();
      },
    },
  });
  const transportOf = (hostId: HostId) => {
    const transport = transports.get(hostId)?.at(-1);
    if (transport === undefined) throw new Error(`no transport for ${hostId}`);
    return transport;
  };
  return { store, transports, transportOf, stop };
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
});

describe('startRemoteHosts', () => {
  it('opens one connection per listed computer, in addition to nothing else', () => {
    const { store, transports, stop } = setup();
    cleanup = stop;
    expect(transports.size).toBe(0);
    setRemoteHosts(store, [sampleRemoteHost(), sampleRemoteHost({ hostId: C, name: 'Computer C' })]);
    expect([...transports.keys()]).toEqual([B, C]);
    expect(listConnections().map((connection) => connection.hostId)).toEqual(expect.arrayContaining([B, C]));
  });

  it('adds and removes computers at runtime; a removed one leaves the store', () => {
    const { store, transportOf, stop } = setup();
    cleanup = stop;
    setRemoteHosts(store, [sampleRemoteHost()]);
    transportOf(B).serverSend(sampleHello());
    transportOf(B).serverSend({ type: 'summaries.snapshot', summaries: [sampleSummary()] });
    const key = makeSessionKey(B, SAMPLE_IDS.entry);
    store.setState({ selectedSession: key });
    expect(store.getState().hosts[B]?.summariesLoaded).toBe(true);

    setRemoteHosts(store, []);
    expect(store.getState().hosts[B]).toBeUndefined();
    expect(store.getState().selectedSession).toBeNull();
    expect(transportOf(B).connected).toBe(false);
    expect(listConnections().some((connection) => connection.hostId === B)).toBe(false);
  });

  it('retries at once when the server reports the computer connected again', () => {
    const { store, transports, transportOf, stop } = setup();
    cleanup = stop;
    setRemoteHosts(store, [sampleRemoteHost()]);
    transportOf(B).serverSend(sampleHello());
    transportOf(B).serverClose(WS_CLOSE.HOST_INCOMPATIBLE);
    setRemoteHosts(store, [sampleRemoteHost({ status: 'incompatible' })]);
    expect(transports.get(B)).toHaveLength(1);
    expect(selectHostAvailability(store.getState(), B)).toBe('incompatible');
    setRemoteHosts(store, [sampleRemoteHost({ status: 'connected' })]);
    expect(transports.get(B)).toHaveLength(2);
  });

  it('stop() ends every remote connection', () => {
    const { store, transportOf, stop } = setup();
    setRemoteHosts(store, [sampleRemoteHost()]);
    stop();
    expect(transportOf(B).connected).toBe(false);
    expect(listConnections().some((connection) => connection.hostId === B)).toBe(false);
  });
});

describe('commands per computer', () => {
  it('session commands go to their computer, link.open always to this one', async () => {
    const { store, transportOf, stop } = setup();
    cleanup = stop;
    setRemoteHosts(store, [sampleRemoteHost()]);
    transportOf(B).serverSend(sampleHello());
    const key = makeSessionKey(B, SAMPLE_IDS.entry);
    void sendCommand(key, { name: 'session.interrupt', entryId: SAMPLE_IDS.entry }).catch(() => undefined);
    expect(
      transportOf(B)
        .sentOfType('cmd')
        .map((message) => message.cmd.name),
    ).toEqual(['session.interrupt']);

    void sendHostCommand(B, { name: 'fs.listDirectory', path: null, showHidden: false }).catch(
      () => undefined,
    );
    expect(
      transportOf(B)
        .sentOfType('cmd')
        .map((message) => message.cmd.name),
    ).toContain('fs.listDirectory');

    // No local connection is registered here: `link.open` must not reach computer B.
    await expect(sendCommand(key, { name: 'link.open', url: 'https://example.com/' })).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
    expect(
      transportOf(B)
        .sentOfType('cmd')
        .some((message) => message.cmd.name === 'link.open'),
    ).toBe(false);
    expect(getConnection(LOCAL_HOST_ID).hostId).toBe(LOCAL_HOST_ID);
  });
});

describe('selectHostAvailability', () => {
  it('this computer is always available; another one follows its connection and list entry', () => {
    const store = createClientStore();
    expect(selectHostAvailability(store.getState(), LOCAL_HOST_ID)).toBe('available');
    setRemoteHosts(store, [sampleRemoteHost({ status: 'connecting' })]);
    expect(selectHostAvailability(store.getState(), B)).toBe('connecting');
    setRemoteHosts(store, [sampleRemoteHost({ status: 'unreachable' })]);
    expect(selectHostAvailability(store.getState(), B)).toBe('unreachable');
    setRemoteHosts(store, [sampleRemoteHost({ status: 'revoked' })]);
    expect(selectHostAvailability(store.getState(), B)).toBe('revoked');
    updateHost(store, B, () => ({ phase: 'open' }));
    expect(selectHostAvailability(store.getState(), B)).toBe('available');
  });
});
