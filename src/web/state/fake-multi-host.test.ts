import { describe, expect, it } from 'vitest';
import type { HostState } from '@shared/model';
import { formatPairingCode } from '@shared/pairing';
import {
  sampleHostState,
  sampleRemoteHost,
  sampleRemotePeer,
  sampleRemoteAccessState,
} from '@shared/samples';
import { fakeHostId, fakeMultiHostCommand, type FakeMultiHostTarget } from './fake-multi-host';

/** WP-80: the FakeHost's "Several computers" (fake-multi-host.ts) behaves like the server's commands. */

const CODE = formatPairingCode(new Uint8Array(16).fill(7));

function target(state: HostState): FakeMultiHostTarget & { states: HostState[] } {
  const states: HostState[] = [];
  return {
    states,
    get hostState() {
      return states.at(-1) ?? state;
    },
    setHostState(next) {
      states.push(next);
    },
  };
}

function controlling(remoteHosts = [sampleRemoteHost()]): HostState {
  const base = sampleHostState();
  return { ...base, multiHost: { ...base.multiHost, role: 'control' }, remoteHosts };
}

describe('fake multi-host', () => {
  it('hosts.add pairs a computer: unique id from the name, next free color, connected', () => {
    const host = target(controlling());
    const ack = fakeMultiHostCommand(host, {
      name: 'hosts.add',
      address: '192.0.2.40',
      port: 4713,
      code: CODE,
      displayName: 'Computer B',
    });
    expect(ack).toEqual({ ok: true, result: { hostId: 'computer-b-2' } });
    const added = host.hostState.remoteHosts.at(-1);
    expect(added?.name).toBe('Computer B');
    expect(added?.status).toBe('connected');
    expect(added?.color).not.toBe(sampleRemoteHost().color);
  });

  it('hosts.add refuses a wrong code, a wrong role and unreachable or incompatible computers', () => {
    const add = {
      name: 'hosts.add',
      address: '192.0.2.40',
      port: 4713,
      code: CODE,
      displayName: 'X',
    } as const;
    expect(fakeMultiHostCommand(target(controlling()), { ...add, code: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'PAIRING_INVALID' },
    });
    expect(fakeMultiHostCommand(target(sampleHostState()), add)).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ROLE_CONFLICT' },
    });
    expect(
      fakeMultiHostCommand(target(controlling()), add, { unreachableAddresses: ['192.0.2.40'] }),
    ).toMatchObject({ ok: false, error: { code: 'HOST_UNREACHABLE' } });
    expect(
      fakeMultiHostCommand(target(controlling()), add, { incompatibleAddresses: ['192.0.2.40'] }),
    ).toMatchObject({ ok: false, error: { code: 'HOST_INCOMPATIBLE' } });
  });

  it('hosts.update, hosts.move, hosts.reconnect and hosts.remove change the list', () => {
    const b = sampleRemoteHost();
    const c = sampleRemoteHost({ hostId: 'computer-c', name: 'Computer C', status: 'unreachable' });
    const host = target(controlling([b, c]));
    fakeMultiHostCommand(host, {
      name: 'hosts.update',
      hostId: b.hostId,
      displayName: ' Build ',
      color: 'rose',
      port: 4800,
    });
    expect(host.hostState.remoteHosts[0]).toMatchObject({ name: 'Build', color: 'rose', port: 4800 });
    fakeMultiHostCommand(host, { name: 'hosts.move', hostId: 'computer-c', index: 0 });
    expect(host.hostState.remoteHosts.map((item) => item.hostId)).toEqual(['computer-c', b.hostId]);
    fakeMultiHostCommand(host, { name: 'hosts.reconnect', hostId: 'computer-c' });
    expect(host.hostState.remoteHosts[0]?.status).toBe('connected');
    fakeMultiHostCommand(host, { name: 'hosts.remove', hostId: b.hostId });
    expect(host.hostState.remoteHosts.map((item) => item.hostId)).toEqual(['computer-c']);
    expect(fakeMultiHostCommand(host, { name: 'hosts.remove', hostId: b.hostId })).toMatchObject({
      ok: false,
      error: { code: 'HOST_NOT_FOUND' },
    });
  });

  it('multiHost.configure switches roles but not away from a coupled one', () => {
    const host = target(sampleHostState());
    expect(fakeMultiHostCommand(host, { name: 'multiHost.configure', role: 'share' })).toMatchObject({
      ok: true,
    });
    expect(host.hostState.multiHost.role).toBe('share');
    expect(host.hostState.remoteAccess).not.toBeNull();
    const coupled = target({
      ...host.hostState,
      remoteAccess: sampleRemoteAccessState({ peer: sampleRemotePeer() }),
    });
    expect(fakeMultiHostCommand(coupled, { name: 'multiHost.configure', role: 'control' })).toMatchObject({
      ok: false,
      error: { code: 'REMOTE_ROLE_CONFLICT' },
    });
    expect(fakeMultiHostCommand(coupled, { name: 'multiHost.configure', role: 'off' })).toMatchObject({
      ok: true,
    });
    expect(coupled.hostState.remoteAccess).toBeNull();
  });

  it('remoteAccess.* answers on a sharing computer', () => {
    const base = sampleHostState();
    const host = target({
      ...base,
      multiHost: { ...base.multiHost, role: 'share' },
      remoteAccess: sampleRemoteAccessState({ unseenRejected: 3 }),
    });
    expect(fakeMultiHostCommand(host, { name: 'remoteAccess.pair' })).toMatchObject({ ok: true });
    expect(host.hostState.remoteAccess?.pairingExpiresAt).not.toBeNull();
    fakeMultiHostCommand(host, { name: 'remoteAccess.eventsSeen' });
    expect(host.hostState.remoteAccess?.unseenRejected).toBe(0);
  });

  it('fakeHostId keeps ids valid and unique', () => {
    expect(fakeHostId('  Office – PC 2 ', [])).toBe('office-pc-2');
    expect(fakeHostId('!!!', [])).toBe('computer');
    expect(fakeHostId('Computer B', [sampleRemoteHost()])).toBe('computer-b-2');
  });
});
