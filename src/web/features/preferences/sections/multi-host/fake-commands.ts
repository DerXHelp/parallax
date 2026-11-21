import { makeError, type ErrorPayload } from '@shared/errors';
import {
  DEFAULT_MULTI_HOST_CONFIG,
  REJECTED_REMOTE_EVENT_KINDS,
  type HostState,
  type MultiHostConfig,
  type RemoteAccessCheck,
  type RemoteAccessState,
  type RemoteEvent,
  type RemoteEventKind,
  type RemotePeer,
  type RemotePeerLevel,
} from '@shared/model';
import { PAIRING_WINDOW_MS, formatPairingCode } from '@shared/pairing';
import {
  sampleRemoteAccessCheck,
  sampleRemoteAccessState,
  sampleRemoteEvent,
  sampleRemotePeer,
  sampleTime,
} from '@shared/samples';
import { ClientCommandError } from '@web/state/connection';
import type { MultiHostCommands } from './commands';

/**
 * A small sharing computer for playground demos and tests of the section "Several computers"
 * (WP-78b): answers `multiHost.configure` and `remoteAccess.*` like the server would and writes the
 * result into the host state of the FakeHost (`setHostState` broadcasts it). Sample data from
 * `@shared/samples`; levers: `failNext`, `completePairing`, `rejectAttempt`.
 */

/** What the fake needs of the FakeHost (structural – the FakeHost itself stays untouched). */
export interface FakeHostStateTarget {
  readonly hostState: HostState;
  setHostState(hostState: HostState): void;
}

export type MultiHostCommandName = keyof MultiHostCommands;

export interface FakeMultiHost {
  readonly commands: MultiHostCommands;
  /**
   * Every call in order, e.g. `configure:{"role":"share"}`, `pair` (level control), `pair:manage`,
   * `events:true`, `setPeerLevel:manage`.
   */
  readonly calls: string[];
  /** The next call of `name` fails with `error` (queued). */
  failNext(name: MultiHostCommandName, error: ErrorPayload): void;
  /** Calls of `name` wait until `release(name)` (busy states in tests). */
  hold(name: MultiHostCommandName): void;
  release(name: MultiHostCommandName): void;
  /**
   * The controlling computer typed the code: the window closes, the new pairing replaces the old one
   * (at the level of the last `pair`).
   */
  completePairing(name?: string): void;
  /** A rejected attempt arrives (log entry, unseen counter). */
  rejectAttempt(kind?: RemoteEventKind, claimedName?: string | null): void;
  /** Number of `remoteAccess.events` answers so far. */
  readonly eventLoads: number;
}

/** The checks of a freshly shared computer: all fine (the firewall is the user's, ADR-228). */
export function fakeChecks(): RemoteAccessCheck[] {
  return [
    sampleRemoteAccessCheck({ id: 'port', status: 'ok' }),
    sampleRemoteAccessCheck({ id: 'keys', status: 'ok', params: {} }),
    sampleRemoteAccessCheck({ id: 'keystore', status: 'ok', params: {} }),
    sampleRemoteAccessCheck({ id: 'tls', status: 'ok', params: {} }),
    sampleRemoteAccessCheck({ id: 'addresses', status: 'ok', params: {} }),
  ];
}

/** A connection log with accepted and rejected entries (newest first). */
export function fakeEvents(): RemoteEvent[] {
  return [
    sampleRemoteEvent({
      id: 'ev_0005',
      kind: 'connected',
      at: sampleTime(400),
      lastAt: sampleTime(400),
      address: '192.0.2.10',
      port: 50123,
      claimedName: 'Computer A',
      rejected: false,
    }),
    sampleRemoteEvent({
      id: 'ev_0004',
      kind: 'pair_failed',
      at: sampleTime(300),
      lastAt: sampleTime(330),
      count: 3,
      address: '192.0.2.77',
      port: 61000,
      claimedName: 'Unknown laptop',
    }),
    sampleRemoteEvent({
      id: 'ev_0003',
      kind: 'tls_failed',
      at: sampleTime(200),
      lastAt: sampleTime(250),
      count: 12,
      address: '192.0.2.99',
      port: null,
    }),
    sampleRemoteEvent({
      id: 'ev_0002',
      kind: 'pair_ok',
      at: sampleTime(100),
      lastAt: sampleTime(100),
      address: '192.0.2.10',
      port: 50100,
      claimedName: 'Computer A',
      rejected: false,
    }),
    sampleRemoteEvent({ id: 'ev_0001', kind: 'unknown_key', at: sampleTime(10), lastAt: sampleTime(10) }),
  ];
}

const REJECTED: ReadonlySet<RemoteEventKind> = new Set(REJECTED_REMOTE_EVENT_KINDS);
/** Fixed code bytes (the first character stays 0–7, the check characters are real). */
const CODE_BYTES = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) % 256);

export function createFakeMultiHost(
  host: FakeHostStateTarget,
  options: { now?: () => number; events?: RemoteEvent[] } = {},
): FakeMultiHost {
  const now = options.now ?? (() => Date.now());
  const calls: string[] = [];
  const failures = new Map<MultiHostCommandName, ErrorPayload[]>();
  const held = new Map<MultiHostCommandName, (() => void)[]>();
  const holding = new Set<MultiHostCommandName>();
  let events = options.events ?? fakeEvents();
  let eventLoads = 0;
  let nextEvent = 100;
  /**
   * The pairing survives a role change (the server keeps it in remote/peer.json); read from the
   * host state on first use (a demo attaches its FakeHost after creating the fake).
   */
  let storedPeer: RemotePeer | null | undefined;
  /** Level of the last pairing window (bound to the window like on the server). */
  let windowLevel: RemotePeerLevel = 'control';
  const currentPeer = (): RemotePeer | null => {
    storedPeer ??= host.hostState.remoteAccess?.peer ?? null;
    return storedPeer;
  };
  const setPeer = (next: RemotePeer | null): void => {
    storedPeer = next;
  };

  const config = (): MultiHostConfig => host.hostState.multiHost;
  const access = (): RemoteAccessState | null => host.hostState.remoteAccess;

  function write(multiHost: MultiHostConfig, remoteAccess: RemoteAccessState | null): void {
    host.setHostState({ ...host.hostState, multiHost, remoteAccess });
  }

  function patchAccess(change: Partial<RemoteAccessState>): void {
    const current = access();
    if (current !== null) write(config(), { ...current, ...change });
  }

  async function run<T>(name: MultiHostCommandName, detail: string, body: () => T): Promise<T> {
    calls.push(detail === '' ? name : `${name}:${detail}`);
    if (holding.has(name)) {
      await new Promise<void>((resolve) => {
        held.set(name, [...(held.get(name) ?? []), resolve]);
      });
    }
    const failure = failures.get(name)?.shift();
    if (failure !== undefined) throw new ClientCommandError(failure);
    return body();
  }

  function requireShare(): RemoteAccessState {
    const current = access();
    if (config().role !== 'share' || current === null) {
      throw new ClientCommandError(makeError('REMOTE_ROLE_CONFLICT', { role: config().role }));
    }
    return current;
  }

  function sharedState(next: MultiHostConfig): RemoteAccessState {
    return sampleRemoteAccessState({
      port: next.port,
      checks: fakeChecks(),
      peer: currentPeer(),
      unseenRejected: events.filter((event) => event.rejected).length > 0 ? 1 : 0,
    });
  }

  function addEvent(kind: RemoteEventKind, address: string, claimedName: string | null): void {
    nextEvent += 1;
    const at = new Date(now()).toISOString();
    events = [
      sampleRemoteEvent({
        id: `ev_${String(nextEvent)}`,
        kind,
        at,
        lastAt: at,
        address,
        port: 52000 + nextEvent,
        claimedName,
        rejected: REJECTED.has(kind),
      }),
      ...events,
    ];
  }

  const commands: MultiHostCommands = {
    configure: (change) =>
      run('configure', JSON.stringify(change), () => {
        const current = config();
        const role = change.role ?? current.role;
        if (
          role !== current.role &&
          current.role === 'share' &&
          role === 'control' &&
          currentPeer() !== null
        ) {
          throw new ClientCommandError(makeError('REMOTE_ROLE_CONFLICT', { role: 'share' }));
        }
        if (
          role !== current.role &&
          current.role === 'control' &&
          role === 'share' &&
          host.hostState.remoteHosts.length > 0
        ) {
          throw new ClientCommandError(makeError('REMOTE_ROLE_CONFLICT', { role: 'control' }));
        }
        const next: MultiHostConfig = {
          role,
          port: change.port ?? current.port,
          bindAddress: change.bindAddress ?? current.bindAddress,
        };
        const currentAccess = access();
        let remoteAccess: RemoteAccessState | null = null;
        if (role === 'share') {
          remoteAccess =
            currentAccess === null || current.role !== 'share'
              ? sharedState(next)
              : { ...currentAccess, port: next.port };
        }
        write(next, remoteAccess);
        return next;
      }),
    pair: (level) =>
      run('pair', level === 'control' ? '' : level, () => {
        const current = requireShare();
        windowLevel = level;
        const expiresAt = new Date(now() + PAIRING_WINDOW_MS).toISOString();
        patchAccess({ pairingExpiresAt: expiresAt });
        return {
          code: formatPairingCode(CODE_BYTES),
          expiresAt,
          hostName: current.hostName,
          addresses: current.addresses,
          port: current.port ?? config().port,
        };
      }),
    cancelPairing: () =>
      run('cancelPairing', '', () => {
        requireShare();
        patchAccess({ pairingExpiresAt: null });
      }),
    unpair: () =>
      run('unpair', '', () => {
        requireShare();
        const peer = currentPeer();
        if (peer !== null) addEvent('unpaired', peer.lastAddress ?? '192.0.2.10', peer.name);
        setPeer(null);
        patchAccess({ peer: null });
      }),
    renewKey: () =>
      run('renewKey', '', () => {
        requireShare();
        setPeer(null);
        patchAccess({ peer: null });
      }),
    check: () =>
      run('check', '', () => {
        requireShare();
        const checks = fakeChecks();
        patchAccess({ checks });
        return checks;
      }),
    events: (onlyRejected) =>
      run('events', String(onlyRejected), () => {
        requireShare();
        eventLoads += 1;
        return events.filter((event) => !onlyRejected || event.rejected);
      }),
    eventsSeen: () =>
      run('eventsSeen', '', () => {
        requireShare();
        patchAccess({ unseenRejected: 0 });
      }),
    setPeerLevel: (level) =>
      run('setPeerLevel', level, () => {
        requireShare();
        const peer = currentPeer();
        if (peer === null)
          throw new ClientCommandError(makeError('VALIDATION_FAILED', { reason: 'not_paired' }));
        if (peer.level === level) return;
        // Every connection of the coupling ends; it connects again with the new level.
        const next: RemotePeer = { ...peer, level, connected: false, connections: 0 };
        addEvent('level_changed', 'local', null);
        setPeer(next);
        patchAccess({ peer: next });
      }),
  };

  return {
    commands,
    calls,
    get eventLoads() {
      return eventLoads;
    },
    failNext(name, error) {
      failures.set(name, [...(failures.get(name) ?? []), error]);
    },
    hold(name) {
      holding.add(name);
    },
    release(name) {
      holding.delete(name);
      const waiting = held.get(name) ?? [];
      held.delete(name);
      for (const resolve of waiting) resolve();
    },
    completePairing(name = 'Computer A') {
      const at = new Date(now()).toISOString();
      const peer = sampleRemotePeer({
        name,
        level: windowLevel,
        pairedAt: at,
        lastSeenAt: at,
        connected: true,
        connections: 1,
      });
      setPeer(peer);
      addEvent('pair_ok', '192.0.2.10', name);
      patchAccess({ peer, pairingExpiresAt: null });
    },
    rejectAttempt(kind = 'unknown_key', claimedName = null) {
      addEvent(kind, '192.0.2.99', claimedName);
      const current = access();
      if (current !== null) patchAccess({ unseenRejected: current.unseenRejected + 1 });
    },
  };
}

/** Host state of a computer with the role "Share" (for demos and tests). */
export function sharingHostState(base: HostState, access: Partial<RemoteAccessState> = {}): HostState {
  return {
    ...base,
    multiHost: { ...DEFAULT_MULTI_HOST_CONFIG, role: 'share' },
    remoteAccess: sampleRemoteAccessState({ checks: fakeChecks(), ...access }),
  };
}
