import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import {
  SAMPLE_IDS,
  SAMPLE_REMOTE_HOST_ID,
  sampleHostState,
  sampleRemoteAccessState,
  sampleRemoteHost,
  sampleRemotePeer,
} from '@shared/samples';
import { canSendTo, selectHostLevel, selectManagedHosts, selectTerminalAvailable } from './hosts';
import { createClientStore, updateHost, type ClientStore } from './store';

const B = SAMPLE_REMOTE_HOST_ID;

function listRemote(store: ClientStore): void {
  updateHost(store, LOCAL_HOST_ID, (host) => ({
    hostState: { ...(host.hostState ?? sampleHostState()), remoteHosts: [sampleRemoteHost({ hostId: B })] },
  }));
}

/** What the other computer shows this window: its remote-access state only at `manage`. */
function remoteSees(store: ClientStore, level: 'control' | 'manage' | 'redacted'): void {
  const remoteAccess =
    level === 'redacted' ? null : sampleRemoteAccessState({ peer: sampleRemotePeer({ level }) });
  updateHost(store, B, () => ({ phase: 'open', hostState: sampleHostState({ remoteAccess }) }));
}

describe('selectTerminalAvailable (WP-99, WP-107)', () => {
  const local = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
  const remote = makeSessionKey(B, SAMPLE_IDS.entry);

  it('this computer: when its server has a pseudo console', () => {
    const store = createClientStore();
    expect(selectTerminalAvailable(store.getState(), local)).toBe(false);
    updateHost(store, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ terminalAvailable: false }) }));
    expect(selectTerminalAvailable(store.getState(), local)).toBe(false);
    updateHost(store, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ terminalAvailable: true }) }));
    expect(selectTerminalAvailable(store.getState(), local)).toBe(true);
    expect(selectTerminalAvailable(store.getState(), 'not a session key')).toBe(false);
  });

  it('another computer (E3): by its own HostState, only while coupled and its connection is open', () => {
    const store = createClientStore();
    updateHost(store, LOCAL_HOST_ID, () => ({ hostState: sampleHostState({ terminalAvailable: false }) }));
    updateHost(store, B, () => ({
      phase: 'connecting',
      hostState: sampleHostState({ terminalAvailable: true }),
    }));
    // Not in the list of computers: never.
    expect(selectTerminalAvailable(store.getState(), remote)).toBe(false);
    listRemote(store);
    expect(selectTerminalAvailable(store.getState(), remote)).toBe(false);
    updateHost(store, B, () => ({ phase: 'open' }));
    expect(selectTerminalAvailable(store.getState(), remote)).toBe(true);
    updateHost(store, B, () => ({ hostState: sampleHostState({ terminalAvailable: false }) }));
    expect(selectTerminalAvailable(store.getState(), remote)).toBe(false);
  });
});

describe('levels in the window (WP-107, §B.13)', () => {
  it('manage only when the other computer shows its coupling at manage; otherwise control', () => {
    const store = createClientStore();
    listRemote(store);
    expect(selectHostLevel(store.getState(), LOCAL_HOST_ID)).toBe('local');
    expect(selectHostLevel(store.getState(), B)).toBe('control');
    remoteSees(store, 'redacted');
    expect(selectHostLevel(store.getState(), B)).toBe('control');
    remoteSees(store, 'control');
    expect(selectHostLevel(store.getState(), B)).toBe('control');
    remoteSees(store, 'manage');
    expect(selectHostLevel(store.getState(), B)).toBe('manage');
    expect(selectManagedHosts(store.getState()).map((host) => host.hostId)).toEqual([B]);
  });

  it('canSendTo: manage commands only at manage; denied commands never; this computer everything', () => {
    const store = createClientStore();
    listRemote(store);
    remoteSees(store, 'redacted');
    expect(canSendTo(B, 'session.sendPrompt', store.getState())).toBe(true);
    expect(canSendTo(B, 'settings.update', store.getState())).toBe(false);
    remoteSees(store, 'manage');
    expect(canSendTo(B, 'settings.update', store.getState())).toBe(true);
    expect(canSendTo(B, 'update.apply', store.getState())).toBe(true);
    expect(canSendTo(B, 'file.open', store.getState())).toBe(false);
    expect(canSendTo(B, 'session.openExternal', store.getState())).toBe(false);
    expect(canSendTo(LOCAL_HOST_ID, 'file.open', store.getState())).toBe(true);
  });
});
