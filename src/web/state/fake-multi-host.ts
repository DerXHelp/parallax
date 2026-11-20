import { LIMITS, type HostId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  HOST_COLORS,
  type HostColor,
  type HostState,
  type RemoteAccessState,
  type RemoteHost,
} from '@shared/model';
import { formatPairingCode, isValidPairingCode } from '@shared/pairing';
import type { Command, CommandOf } from '@shared/protocol';
import { sampleRemoteAccessState } from '@shared/samples';

/**
 * "Several computers" of the FakeHost (WP-80; opt-in `FakeHostOptions.multiHost`, so the WP-78b
 * test of the default path still sees NOT_IMPLEMENTED): `multiHost.configure`, a small
 * `remoteAccess.*` and `hosts.*` like the server – the list lands in `HostState.remoteHosts`
 * (`setHostState` broadcasts it, `startRemoteHosts` follows). The other computers themselves are
 * simulated by `fake-computers.ts`. Levers: `unreachableAddresses` (hosts.add/reconnect fail with
 * HOST_UNREACHABLE), `incompatibleAddresses` (HOST_INCOMPATIBLE). A wrong role answers
 * REMOTE_ROLE_CONFLICT, a code that is not a pairing code VALIDATION_FAILED {reason: 'code'}; the
 * lever `rejectedCodes` answers PAIRING_INVALID (a well-formed code the other side refuses).
 */

export type FakeMultiHostAck = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

export interface FakeMultiHostOptions {
  /** Addresses whose pairing fails with HOST_UNREACHABLE. */
  unreachableAddresses?: readonly string[];
  /** Addresses whose pairing fails with HOST_INCOMPATIBLE (`version` 9.9.9). */
  incompatibleAddresses?: readonly string[];
  /** Well-formed codes the other side refuses (PAIRING_INVALID). */
  rejectedCodes?: readonly string[];
  /** A pairing succeeded (also "pair again", `replaceHostId`) – fake-computers makes it reachable. */
  onPaired?: (hostId: HostId) => void;
}

/** What the module needs of the FakeHost (structural). */
export interface FakeMultiHostTarget {
  readonly hostState: HostState;
  setHostState(hostState: HostState): void;
}

export type MultiHostCommand = Extract<
  Command,
  { name: 'multiHost.configure' | `remoteAccess.${string}` | `hosts.${string}` }
>;

export function isMultiHostCommand(cmd: Command): cmd is MultiHostCommand {
  return (
    cmd.name === 'multiHost.configure' ||
    cmd.name.startsWith('remoteAccess.') ||
    cmd.name.startsWith('hosts.')
  );
}

function ok(result: unknown = {}): FakeMultiHostAck {
  return { ok: true, result };
}

function fail(error: ErrorPayload): FakeMultiHostAck {
  return { ok: false, error };
}

/** A host id from the name: lower case, `a-z0-9-`, unique in the list. */
export function fakeHostId(name: string, taken: readonly RemoteHost[]): HostId {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'computer';
  const used = new Set(taken.map((host) => host.hostId));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The first color no computer uses yet (else the colors repeat). */
function nextColor(hosts: readonly RemoteHost[]): HostColor {
  const used = new Set(hosts.map((host) => host.color));
  return (
    HOST_COLORS.find((color) => !used.has(color)) ?? HOST_COLORS[hosts.length % HOST_COLORS.length] ?? 'blue'
  );
}

function remoteAccessOf(state: HostState): RemoteAccessState {
  return state.remoteAccess ?? sampleRemoteAccessState({ port: state.multiHost.port, peer: null });
}

function configure(target: FakeMultiHostTarget, cmd: CommandOf<'multiHost.configure'>): FakeMultiHostAck {
  const state = target.hostState;
  const current = state.multiHost;
  const role = cmd.role ?? current.role;
  const switching = role !== current.role && current.role !== 'off' && role !== 'off';
  const coupled =
    current.role === 'control' ? state.remoteHosts.length > 0 : (state.remoteAccess?.peer ?? null) !== null;
  if (switching && coupled) return fail(makeError('REMOTE_ROLE_CONFLICT', { role: current.role }));
  const config = {
    role,
    port: cmd.port ?? current.port,
    bindAddress: cmd.bindAddress ?? current.bindAddress,
  };
  target.setHostState({
    ...state,
    multiHost: config,
    remoteAccess: role === 'share' ? { ...remoteAccessOf(state), port: config.port } : null,
  });
  return ok({ config });
}

function remoteAccess(target: FakeMultiHostTarget, cmd: MultiHostCommand): FakeMultiHostAck {
  const state = target.hostState;
  if (state.multiHost.role !== 'share')
    return fail(makeError('REMOTE_ROLE_CONFLICT', { role: state.multiHost.role }));
  const access = remoteAccessOf(state);
  const set = (patch: Partial<RemoteAccessState>) => {
    target.setHostState({ ...state, remoteAccess: { ...access, ...patch } });
  };
  switch (cmd.name) {
    case 'remoteAccess.pair': {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      set({ pairingExpiresAt: expiresAt });
      return ok({
        code: formatPairingCode(new Uint8Array(16).fill(7)),
        expiresAt,
        hostName: access.hostName,
        addresses: access.addresses,
        port: access.port,
      });
    }
    case 'remoteAccess.cancelPairing':
      set({ pairingExpiresAt: null });
      return ok();
    case 'remoteAccess.unpair':
    case 'remoteAccess.renewKey':
      set({ peer: null });
      return ok();
    case 'remoteAccess.check':
      return ok({ checks: access.checks });
    case 'remoteAccess.events':
      return ok({ events: [] });
    case 'remoteAccess.eventsSeen':
      set({ unseenRejected: 0 });
      return ok();
    case 'remoteAccess.setPeerLevel':
      if (access.peer === null) return fail(makeError('VALIDATION_FAILED', { reason: 'not_paired' }));
      set({ peer: { ...access.peer, level: cmd.level } });
      return ok();
    default:
      return fail(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
  }
}

function hosts(
  target: FakeMultiHostTarget,
  cmd: MultiHostCommand,
  options: FakeMultiHostOptions,
): FakeMultiHostAck {
  const state = target.hostState;
  if (state.multiHost.role !== 'control')
    return fail(makeError('REMOTE_ROLE_CONFLICT', { role: state.multiHost.role }));
  const list = state.remoteHosts;
  const write = (next: RemoteHost[]) => {
    target.setHostState({ ...state, remoteHosts: next });
  };
  const find = (hostId: HostId) => list.find((host) => host.hostId === hostId);
  switch (cmd.name) {
    case 'hosts.add': {
      if (!isValidPairingCode(cmd.code)) return fail(makeError('VALIDATION_FAILED', { reason: 'code' }));
      if (options.rejectedCodes?.includes(cmd.code) === true) return fail(makeError('PAIRING_INVALID'));
      if (list.length >= LIMITS.hostsMax) return fail(makeError('VALIDATION_FAILED', { reason: 'limit' }));
      if (options.unreachableAddresses?.includes(cmd.address) === true) {
        return fail(makeError('HOST_UNREACHABLE', { reason: 'refused' }));
      }
      if (options.incompatibleAddresses?.includes(cmd.address) === true) {
        return fail(makeError('HOST_INCOMPATIBLE', { version: '9.9.9', protocol: 999 }));
      }
      const now = new Date().toISOString();
      if (cmd.replaceHostId !== undefined) {
        const old = find(cmd.replaceHostId);
        if (old === undefined) return fail(makeError('HOST_NOT_FOUND', { hostId: cmd.replaceHostId }));
        // Pair again: id, color and place stay; name, address and port come from the new pairing.
        options.onPaired?.(old.hostId);
        write(
          list.map((item) =>
            item.hostId === old.hostId
              ? {
                  ...item,
                  name: cmd.displayName.trim(),
                  address: cmd.address,
                  port: cmd.port,
                  status: 'connected',
                  lastError: null,
                  lastConnectedAt: now,
                }
              : item,
          ),
        );
        return ok({ hostId: old.hostId });
      }
      const hostId = fakeHostId(cmd.displayName, list);
      options.onPaired?.(hostId);
      write([
        ...list,
        {
          hostId,
          name: cmd.displayName.trim(),
          color: nextColor(list),
          address: cmd.address,
          port: cmd.port,
          status: 'connected',
          appVersion: state.app?.version ?? null,
          protocolVersion: null,
          lastError: null,
          lastConnectedAt: now,
          addedAt: now,
        },
      ]);
      return ok({ hostId });
    }
    case 'hosts.update': {
      const host = find(cmd.hostId);
      if (host === undefined) return fail(makeError('HOST_NOT_FOUND', { hostId: cmd.hostId }));
      const next: RemoteHost = {
        ...host,
        ...(cmd.displayName === undefined ? {} : { name: cmd.displayName.trim() }),
        ...(cmd.color === undefined ? {} : { color: cmd.color }),
        ...(cmd.address === undefined ? {} : { address: cmd.address }),
        ...(cmd.port === undefined ? {} : { port: cmd.port }),
      };
      write(list.map((item) => (item.hostId === cmd.hostId ? next : item)));
      return ok();
    }
    case 'hosts.move': {
      const host = find(cmd.hostId);
      if (host === undefined) return fail(makeError('HOST_NOT_FOUND', { hostId: cmd.hostId }));
      const rest = list.filter((item) => item.hostId !== cmd.hostId);
      const index = Math.min(cmd.index, rest.length);
      write([...rest.slice(0, index), host, ...rest.slice(index)]);
      return ok();
    }
    case 'hosts.remove': {
      const removed = find(cmd.hostId);
      if (removed === undefined) return fail(makeError('HOST_NOT_FOUND', { hostId: cmd.hostId }));
      write(list.filter((item) => item.hostId !== cmd.hostId));
      // Like the server (§B.8): a computer that cannot be reached keeps its pairing.
      const reached =
        removed.status !== 'unreachable' && options.unreachableAddresses?.includes(removed.address) !== true;
      return ok({ peerNotified: reached });
    }
    case 'hosts.reconnect': {
      const host = find(cmd.hostId);
      if (host === undefined) return fail(makeError('HOST_NOT_FOUND', { hostId: cmd.hostId }));
      const unreachable = options.unreachableAddresses?.includes(host.address) === true;
      write(
        list.map((item) =>
          item.hostId === cmd.hostId
            ? {
                ...item,
                status: unreachable ? 'unreachable' : 'connected',
                lastError: unreachable ? makeError('HOST_UNREACHABLE', { reason: 'refused' }) : null,
                lastConnectedAt: unreachable ? item.lastConnectedAt : new Date().toISOString(),
              }
            : item,
        ),
      );
      return ok();
    }
    default:
      return fail(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
  }
}

/** Answers one command of "Several computers" against the target's host state. */
export function fakeMultiHostCommand(
  target: FakeMultiHostTarget,
  cmd: MultiHostCommand,
  options: FakeMultiHostOptions = {},
): FakeMultiHostAck {
  if (cmd.name === 'multiHost.configure') return configure(target, cmd);
  if (cmd.name.startsWith('remoteAccess.')) return remoteAccess(target, cmd);
  return hosts(target, cmd, options);
}
